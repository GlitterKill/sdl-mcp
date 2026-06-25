import { AsyncLocalStorage } from "node:async_hooks";

import {
  ConcurrencyLimiter,
  ConcurrencyQueueTimeoutError,
  type ConcurrencyLimiterStats,
} from "../util/concurrency.js";
import { logger } from "../util/logger.js";
import {
  formatDeferredWorkStatus,
  getActiveDeferredWorkStatus,
  type DeferredWorkStatus,
} from "../runtime/deferred-work-state.js";
import {
  INDEXING_DISPATCH_CAP,
  isIndexingActive,
  setIndexingStateListener,
} from "./indexing-gate.js";

let limiter: ConcurrencyLimiter | null = null;
const dispatchContext = new AsyncLocalStorage<boolean>();
/**
 * Normal (non-indexing) max concurrency. Reapplied when indexing finishes.
 * Tracked separately so `setMaxConcurrency(INDEXING_DISPATCH_CAP)` during
 * indexing doesn't permanently lower the configured value.
 */
let configuredMax = 8;

// Labels are dispatch-only diagnostics; keep them out of the generic limiter.
const activeDispatchLabels = new Map<string, number>();

function addActiveDispatchLabel(label: string): void {
  activeDispatchLabels.set(label, (activeDispatchLabels.get(label) ?? 0) + 1);
}

function deleteActiveDispatchLabel(label: string): void {
  const nextCount = (activeDispatchLabels.get(label) ?? 0) - 1;
  if (nextCount <= 0) {
    activeDispatchLabels.delete(label);
    return;
  }
  activeDispatchLabels.set(label, nextCount);
}

function getActiveDispatchLabels(): string[] {
  return Array.from(activeDispatchLabels.entries()).map(([label, count]) =>
    count > 1 ? `${label}x${count}` : label,
  );
}

export interface ToolDispatchStats extends ConcurrencyLimiterStats {
  configuredMax: number;
  indexingActive: boolean;
  activeLabels?: string[];
  deferredWork?: DeferredWorkStatus;
}

export class ToolDispatchQueueTimeoutError extends Error {
  readonly code = "RUNTIME_ERROR";
  readonly classification = "unavailable";
  readonly retryable = true;
  readonly suggestedRetryDelayMs = 1_000;
  readonly details: string[];

  constructor(timeoutMs: number, stats: ToolDispatchStats, label: string) {
    const activeLabels = stats.activeLabels?.length
      ? `, activeLabels=${stats.activeLabels.join(",")}`
      : "";
    super(
      `Tool dispatch queue timed out after ${timeoutMs}ms for ${label} ` +
        `(active=${stats.active}, queued=${stats.queued}, max=${stats.maxConcurrency}${activeLabels})`,
    );
    this.name = "ToolDispatchQueueTimeoutError";
    this.details = [
      `label=${label}`,
      `active=${stats.active}`,
      `queued=${stats.queued}`,
      `max=${stats.maxConcurrency}`,
      `indexingActive=${stats.indexingActive}`,
      ...(stats.activeLabels?.length
        ? [`activeLabels=${stats.activeLabels.join(",")}`]
        : []),
      ...(stats.deferredWork
        ? [
            `deferredWork=${stats.deferredWork.kind}`,
            `deferredRepoId=${stats.deferredWork.repoId}`,
            ...(stats.deferredWork.percent !== undefined
              ? [`deferredPercent=${stats.deferredWork.percent}`]
              : []),
          ]
        : []),
    ];
    Object.setPrototypeOf(this, ToolDispatchQueueTimeoutError.prototype);
  }
}

function applyIndexingShape(indexing: boolean): void {
  if (!limiter) return;
  const target = indexing
    ? Math.min(INDEXING_DISPATCH_CAP, configuredMax)
    : configuredMax;
  limiter.setMaxConcurrency(target);
}

/**
 * Get the singleton tool dispatch limiter.
 * Controls how many tool handler calls can execute concurrently
 * across all MCP sessions, preventing DB overload.
 *
 * While `sdl.index.refresh` is running, dispatch is narrowed to
 * `INDEXING_DISPATCH_CAP` so tool callers don't compete with the indexer
 * for read-pool connections.
 */
export function getToolDispatchLimiter(): ConcurrencyLimiter {
  if (!limiter) {
    limiter = new ConcurrencyLimiter({
      maxConcurrency: configuredMax,
      queueTimeoutMs: 30_000,
    });
    // Install the indexing-state listener once so gate transitions reshape
    // the limiter in-place without clearing the queue.
    setIndexingStateListener(applyIndexingShape);
    // Apply current state immediately in case indexing began before any
    // tool ever ran (e.g. CLI-triggered warm index).
    applyIndexingShape(isIndexingActive());
  }
  return limiter;
}

/**
 * Run a tool-like workload through the shared dispatch limiter and mark the
 * async context as owning a dispatch slot. Indexing uses this marker to avoid
 * deadlocking when an index refresh is itself invoked as an MCP tool.
 */
export async function runToolDispatch<T>(
  fn: () => Promise<T>,
  timeoutMs?: number,
  label = "tool-dispatch",
): Promise<T> {
  const deferredWork = label.startsWith("derived-refresh:")
    ? undefined
    : getActiveDeferredWorkStatus();
  const queueTimeoutMs = timeoutMs ?? (deferredWork ? 0 : undefined);
  if (deferredWork && timeoutMs === undefined) {
    logger.info("Tool dispatch waiting for deferred work", {
      label,
      message: formatDeferredWorkStatus(deferredWork),
      deferredWork,
    });
  }
  try {
    return await getToolDispatchLimiter().run(
      () =>
        dispatchContext.run(true, async () => {
          addActiveDispatchLabel(label);
          try {
            return await fn();
          } finally {
            deleteActiveDispatchLabel(label);
          }
        }),
      queueTimeoutMs,
    );
  } catch (error) {
    if (error instanceof ConcurrencyQueueTimeoutError) {
      const stats = getToolDispatchStats();
      logger.warn("Tool dispatch queue timed out", {
        label,
        timeoutMs: error.timeoutMs,
        active: stats.active,
        queued: stats.queued,
        maxConcurrency: stats.maxConcurrency,
        configuredMax: stats.configuredMax,
        activeLabels: stats.activeLabels,
        indexingActive: stats.indexingActive,
        deferredWork: stats.deferredWork,
      });
      throw new ToolDispatchQueueTimeoutError(error.timeoutMs, stats, label);
    }
    throw error;
  }
}

export function isInToolDispatch(): boolean {
  return dispatchContext.getStore() === true;
}

export function getToolDispatchStats(): ToolDispatchStats {
  const stats = limiter?.getStats();
  const maxConcurrency = limiter?.getMaxConcurrency() ?? configuredMax;
  const deferredWork = getActiveDeferredWorkStatus();
  return {
    active: stats?.active ?? 0,
    queued: stats?.queued ?? 0,
    maxConcurrency,
    configuredMax,
    activeLabels: getActiveDispatchLabels(),
    indexingActive: isIndexingActive(),
    totalActiveMs: stats?.totalActiveMs ?? 0,
    totalQueueMs: stats?.totalQueueMs ?? 0,
    totalRuns: stats?.totalRuns ?? 0,
    peakQueued: stats?.peakQueued ?? 0,
    peakActive: stats?.peakActive ?? 0,
    ...(deferredWork ? { deferredWork } : {}),
  };
}

export async function waitForToolDispatchIdle(params: {
  activeAllowance: number;
  timeoutMs: number;
  pollMs?: number;
  label: string;
}): Promise<boolean> {
  const pollMs = params.pollMs ?? 25;
  const deadline = Date.now() + params.timeoutMs;
  let announced = false;

  while (true) {
    const stats = getToolDispatchLimiter().getStats();
    if (stats.active <= params.activeAllowance) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    if (!announced) {
      announced = true;
      logger.debug("Waiting for tool dispatch idle", {
        label: params.label,
        active: stats.active,
        queued: stats.queued,
      });
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref();
    });
  }
}

/**
 * Configure the tool dispatch limiter.
 * Must be called before first tool invocation for settings to take effect.
 */
export function configureToolDispatchLimiter(opts: {
  maxConcurrency?: number;
  queueTimeoutMs?: number;
}): void {
  const nextMax = opts.maxConcurrency ?? 8;
  const nextTimeout = opts.queueTimeoutMs ?? 30_000;
  configuredMax = nextMax;

  if (limiter) {
    // Reshape in place rather than replacing — in-flight tool calls keep
    // running and queued callers stay queued. The queueTimeoutMs change
    // only affects future enqueues, which matches old behavior for
    // practical purposes (typical reconfigure happens once at startup).
    const effective = isIndexingActive()
      ? Math.min(INDEXING_DISPATCH_CAP, nextMax)
      : nextMax;
    limiter.setMaxConcurrency(effective);
    return;
  }

  limiter = new ConcurrencyLimiter({
    maxConcurrency: isIndexingActive()
      ? Math.min(INDEXING_DISPATCH_CAP, nextMax)
      : nextMax,
    queueTimeoutMs: nextTimeout,
  });
  setIndexingStateListener(applyIndexingShape);
}

/**
 * Reset the limiter (for testing).
 */
export function resetToolDispatchLimiter(): void {
  if (limiter) {
    limiter.clearQueue();
  }
  limiter = null;
  configuredMax = 8;
  activeDispatchLabels.clear();
  setIndexingStateListener(null);
}
