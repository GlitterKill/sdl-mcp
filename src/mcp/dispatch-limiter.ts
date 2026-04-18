import { ConcurrencyLimiter } from "../util/concurrency.js";
import {
  INDEXING_DISPATCH_CAP,
  isIndexingActive,
  setIndexingStateListener,
} from "./indexing-gate.js";

let limiter: ConcurrencyLimiter | null = null;
/**
 * Normal (non-indexing) max concurrency. Reapplied when indexing finishes.
 * Tracked separately so `setMaxConcurrency(INDEXING_DISPATCH_CAP)` during
 * indexing doesn't permanently lower the configured value.
 */
let configuredMax = 8;

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
  setIndexingStateListener(null);
}
