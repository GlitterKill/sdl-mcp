/**
 * Background refresh queue for graph-derived state (clusters, processes, and
 * algorithms). Incremental index runs mark derived state dirty and enqueue here;
 * long-lived processes (serve/watch) drain the queue without blocking the
 * critical path. Semantic summaries and embeddings are tracked on the same
 * DerivedState row, but they are cleared only by semantic work that actually
 * refreshes those payloads.
 *
 * See devdocs/plans/2026-04-17-post-pass2-performance-and-feedback-plan.md §5.
 */

import { getLadybugConn } from "../db/ladybug.js";
import {
  markDerivedStateComputed,
  recordDerivedStateError,
} from "../db/ladybug-derived-state.js";
import { loadConfig } from "../config/loadConfig.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { runToolDispatch } from "../mcp/dispatch-limiter.js";
import { logger } from "../util/logger.js";
import {
  clearDeferredWorkStatus,
  getDeferredWorkStatuses,
  setDeferredWorkStatus,
  type DeferredWorkProgress,
} from "../runtime/deferred-work-state.js";
import type { IndexProgress } from "./indexer-init.js";
import type { AlgorithmRefreshDiagnostics } from "./cluster-orchestrator.js";

const DERIVED_REFRESH_PROGRESS_TOTAL = 4;

interface PendingEntry {
  repoId: string;
  targetVersionId: string;
  enqueuedAt: number;
}

interface RunningEntry {
  repoId: string;
  targetVersionId: string;
  abort: AbortController;
  promise: Promise<void>;
  startedAt: number;
}

// Module-local state. Long-lived processes carry this across incremental runs;
// one-shot CLI processes never drain because they exit before the microtask
// settles. That is intentional — marking dirty is enough on the CLI path.
const pending = new Map<string, PendingEntry>();
const running = new Map<string, RunningEntry>();
let enabled = true;
let shuttingDown = false;

const DEFAULT_DERIVED_REFRESH_TIMEOUT_MS = 120_000;

class DerivedRefreshTimeoutError extends Error {
  constructor(repoId: string, targetVersionId: string, timeoutMs: number) {
    super(
      `derived-refresh timed out after ${timeoutMs}ms for repo ${repoId} at version ${targetVersionId}`,
    );
    this.name = "DerivedRefreshTimeoutError";
    Object.setPrototypeOf(this, DerivedRefreshTimeoutError.prototype);
  }
}

interface RepoWriteHeavyTimeout {
  lockId: number;
  targetVersionId: string;
  timeoutMs: number;
  timedOutAt: number;
}

interface RepoWriteHeavyTail {
  id: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

class RepoWriteHeavyLockTimedOutError extends Error {
  constructor(repoId: string, timeout: RepoWriteHeavyTimeout) {
    super(
      `derived-refresh write-heavy lock for repo ${repoId} timed out after ${timeout.timeoutMs}ms at version ${timeout.targetVersionId}; waiting for the stuck native work to settle before retrying`,
    );
    this.name = "RepoWriteHeavyLockTimedOutError";
    Object.setPrototypeOf(this, RepoWriteHeavyLockTimedOutError.prototype);
  }
}

function getDerivedRefreshTimeoutMs(): number {
  const raw = process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_DERIVED_REFRESH_TIMEOUT_MS;
}

/**
 * Per-repo serialization for write-heavy refresh phases (cluster/process
 * computation, SCIP auto-ingest). LadybugDB allows one write transaction at
 * a time and `writeLimiter` has a 30s queue timeout — running two long
 * write-heavy phases concurrently against the same repo starves both.
 *
 * Each map entry holds the *tail* of the per-repo queue. Acquirers append a
 * new promise, await the prior tail, run their critical section, then
 * resolve their promise so the next acquirer proceeds.
 */
const repoWriteHeavyTails = new Map<string, RepoWriteHeavyTail>();
const activeRepoWriteHeavyLocks = new Map<string, RepoWriteHeavyTail>();
const timedOutRepoWriteHeavyLocks = new Map<string, RepoWriteHeavyTimeout>();
let nextRepoWriteHeavyLockId = 1;

function getRepoWriteHeavyTimeoutError(repoId: string): Error | undefined {
  const timeout = timedOutRepoWriteHeavyLocks.get(repoId);
  return timeout ? new RepoWriteHeavyLockTimedOutError(repoId, timeout) : undefined;
}

function markActiveRepoWriteHeavyLockTimedOut(
  repoId: string,
  targetVersionId: string,
  timeoutMs: number,
): boolean {
  const active = activeRepoWriteHeavyLocks.get(repoId);
  if (!active) return false;
  const timeout: RepoWriteHeavyTimeout = {
    lockId: active.id,
    targetVersionId,
    timeoutMs,
    timedOutAt: Date.now(),
  };
  timedOutRepoWriteHeavyLocks.set(repoId, timeout);
  active.reject(new RepoWriteHeavyLockTimedOutError(repoId, timeout));
  return true;
}

export async function withRepoWriteHeavyLock<T>(
  repoId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const blocked = getRepoWriteHeavyTimeoutError(repoId);
  if (blocked) throw blocked;

  const prior = repoWriteHeavyTails.get(repoId);
  let releaseOurs!: () => void;
  let rejectOurs!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    releaseOurs = resolve;
    rejectOurs = reject;
  });
  // A timeout rejects the tail to wake queued waiters; attach a no-op handler
  // so an otherwise unobserved tail does not become an unhandled rejection.
  promise.catch(() => undefined);
  const ours: RepoWriteHeavyTail = {
    id: nextRepoWriteHeavyLockId++,
    promise,
    resolve: releaseOurs,
    reject: rejectOurs,
  };
  repoWriteHeavyTails.set(repoId, ours);
  try {
    await (prior?.promise ?? Promise.resolve());
    const timedOut = getRepoWriteHeavyTimeoutError(repoId);
    if (timedOut) throw timedOut;

    activeRepoWriteHeavyLocks.set(repoId, ours);
    try {
      return await fn();
    } finally {
      if (activeRepoWriteHeavyLocks.get(repoId) === ours) {
        activeRepoWriteHeavyLocks.delete(repoId);
      }
      const timeout = timedOutRepoWriteHeavyLocks.get(repoId);
      if (timeout?.lockId === ours.id) {
        timedOutRepoWriteHeavyLocks.delete(repoId);
      }
    }
  } finally {
    releaseOurs();
    if (repoWriteHeavyTails.get(repoId) === ours) {
      repoWriteHeavyTails.delete(repoId);
    }
  }
}

export interface DerivedRefreshHooks {
  refresh: (params: {
    repoId: string;
    versionId: string;
    signal: AbortSignal;
    onProgress?: (progress: IndexProgress) => void;
  }) => Promise<AlgorithmRefreshDiagnostics | void>;
}

// Overridable entry point so tests can swap in a lightweight stub.
let hooks: DerivedRefreshHooks = {
  refresh: defaultRefreshImpl,
};

async function markDerivedRefreshComputed(
  repoId: string,
  targetVersionId: string,
  algorithmRefresh?: AlgorithmRefreshDiagnostics | void,
): Promise<void> {
  if (!algorithmRefresh) {
    await markDerivedStateComputed(repoId, targetVersionId, {
      clusters: true,
      processes: true,
      algorithms: true,
    });
    return;
  }
  await markDerivedStateComputed(
    repoId,
    targetVersionId,
    {
      clusters: true,
      processes: true,
      algorithms: !algorithmRefresh.dirty,
    },
    { clearError: !algorithmRefresh.dirty },
  );
  if (algorithmRefresh.dirty) {
    await recordDerivedStateError(
      repoId,
      algorithmRefresh.failures.join("; ") || "algorithm refresh failed",
    );
  }
}

export function _setDerivedRefreshHooksForTesting(
  override: Partial<DerivedRefreshHooks> | null,
): void {
  if (override === null) {
    hooks = { refresh: defaultRefreshImpl };
    return;
  }
  hooks = { refresh: override.refresh ?? hooks.refresh };
}

export function disableDerivedRefreshQueue(): void {
  enabled = false;
}

export function enableDerivedRefreshQueue(): void {
  enabled = true;
  shuttingDown = false;
}

function progressForIndexEvent(progress: IndexProgress): DeferredWorkProgress {
  const phase = progress.substage ?? progress.stage;
  const phaseCurrent =
    phase === "clusterRefresh"
      ? 1
      : phase === "processRefresh"
        ? 2
        : phase === "algorithmRefresh"
          ? 3
          : undefined;
  return {
    phase,
    ...(phaseCurrent !== undefined
      ? { current: phaseCurrent, total: DERIVED_REFRESH_PROGRESS_TOTAL }
      : {}),
    ...(progress.message ? { message: progress.message } : {}),
  };
}

function setDerivedRefreshProgress(
  repoId: string,
  targetVersionId: string,
  progress: DeferredWorkProgress,
): void {
  setDeferredWorkStatus({
    kind: "derived-refresh",
    repoId,
    targetVersionId,
    progress,
  });
}

/**
 * Queue a deferred derived-state refresh. Coalesces by repoId — if a newer
 * incremental lands while one is running for an older targetVersionId, the
 * in-flight refresh aborts cooperatively and the queue requeues.
 */
export function enqueueDerivedRefresh(
  repoId: string,
  targetVersionId: string,
): void {
  if (!enabled || shuttingDown) return;

  const existing = running.get(repoId);
  if (existing && existing.targetVersionId !== targetVersionId) {
    // A newer version arrived — abort the in-flight refresh so the drain loop
    // can pick up the newer targetVersionId after the abort lands.
    existing.abort.abort();
  }

  pending.set(repoId, {
    repoId,
    targetVersionId,
    enqueuedAt: Date.now(),
  });

  // Kick the drain loop. Safe to call while another drain is in progress —
  // the check below is idempotent per repo.
  void drain(repoId);
}

async function drain(repoId: string): Promise<void> {
  if (running.has(repoId)) return;
  const next = pending.get(repoId);
  if (!next) return;
  pending.delete(repoId);

  const abort = new AbortController();
  const entry: RunningEntry = {
    repoId,
    targetVersionId: next.targetVersionId,
    abort,
    startedAt: Date.now(),
    promise: runOne(repoId, next.targetVersionId, abort.signal).finally(() => {
      running.delete(repoId);
      clearDeferredWorkStatus("derived-refresh", repoId);
      // If a newer version was enqueued while we ran, drain again.
      if (pending.has(repoId)) {
        void drain(repoId);
      }
    }),
  };
  running.set(repoId, entry);
}

async function runOne(
  repoId: string,
  targetVersionId: string,
  signal: AbortSignal,
): Promise<void> {
  setDerivedRefreshProgress(repoId, targetVersionId, {
    phase: "starting",
    current: 0,
    total: DERIVED_REFRESH_PROGRESS_TOTAL,
    message: "starting",
  });
  try {
    await withIndexingGate(async () => {
      await runToolDispatch(
        async () => {
          let writeLockHeld = false;
          await runWithDerivedRefreshTimeout(
            repoId,
            targetVersionId,
            signal,
            async (refreshSignal) => {
              if (refreshSignal.aborted) return;
              let algorithmRefresh: AlgorithmRefreshDiagnostics | void =
                undefined;
              // The dispatch slot is intentional: while indexing narrows dispatch
              // concurrency to one, the background refresh must occupy that one slot
              // so foreground read tools cannot overlap its LadybugDB writes.
              await withRepoWriteHeavyLock(repoId, async () => {
                writeLockHeld = true;
                try {
                  if (refreshSignal.aborted) return;
                  algorithmRefresh = await hooks.refresh({
                    repoId,
                    versionId: targetVersionId,
                    signal: refreshSignal,
                    onProgress: (progress) => {
                      setDerivedRefreshProgress(
                        repoId,
                        targetVersionId,
                        progressForIndexEvent(progress),
                      );
                    },
                  });
                } finally {
                  writeLockHeld = false;
                }
              });
              if (refreshSignal.aborted) return;
              setDerivedRefreshProgress(repoId, targetVersionId, {
                phase: "complete",
                current: DERIVED_REFRESH_PROGRESS_TOTAL,
                total: DERIVED_REFRESH_PROGRESS_TOTAL,
                message: "marking derived state complete",
              });
              await markDerivedRefreshComputed(
                repoId,
                targetVersionId,
                algorithmRefresh,
              );
            },
            (timeoutMs) => {
              if (!writeLockHeld) return;
              const marked = markActiveRepoWriteHeavyLockTimedOut(
                repoId,
                targetVersionId,
                timeoutMs,
              );
              if (marked) {
                logger.warn("derived-refresh write-heavy lock timed out", {
                  repoId,
                  targetVersionId,
                  timeoutMs,
                });
              }
            },
          );
        },
        undefined,
        `derived-refresh:${repoId}`,
      );
    });
  } catch (err) {
    if (signal.aborted) {
      logger.debug("derived-refresh aborted", { repoId, targetVersionId });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("derived-refresh failed", {
      repoId,
      targetVersionId,
      error: msg,
    });
    await recordDerivedStateError(repoId, msg);
  }
}

async function runWithDerivedRefreshTimeout(
  repoId: string,
  targetVersionId: string,
  parentSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<void>,
  onTimeout?: (timeoutMs: number) => void,
): Promise<void> {
  if (parentSignal.aborted) return;

  const timeoutMs = getDerivedRefreshTimeoutMs();
  const timeoutAbort = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let rejectParentAbort: ((err: Error) => void) | undefined;
  let timedOut = false;

  const parentAbort = (): void => {
    timeoutAbort.abort();
    rejectParentAbort?.(new Error("derived-refresh aborted"));
  };
  const parentAbortPromise = new Promise<never>((_, reject) => {
    rejectParentAbort = reject;
  });
  parentSignal.addEventListener("abort", parentAbort, { once: true });

  let workPromise: Promise<void> | undefined;
  try {
    if (parentSignal.aborted) {
      parentAbort();
      await parentAbortPromise;
    }
    workPromise = Promise.resolve().then(() => work(timeoutAbort.signal));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAbort.abort();
        onTimeout?.(timeoutMs);
        reject(
          new DerivedRefreshTimeoutError(repoId, targetVersionId, timeoutMs),
        );
      }, timeoutMs);
      timeoutHandle.unref();
    });
    await Promise.race([workPromise, timeoutPromise, parentAbortPromise]);
  } catch (err) {
    if (timedOut && workPromise) {
      void workPromise.then(
        () => {
          logger.info("derived-refresh timed-out work settled", {
            repoId,
            targetVersionId,
            timeoutMs,
          });
        },
        (settledErr) => {
          logger.debug("derived-refresh timed-out work rejected later", {
            repoId,
            targetVersionId,
            timeoutMs,
            error:
              settledErr instanceof Error
                ? settledErr.message
                : String(settledErr),
          });
        },
      );
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener("abort", parentAbort);
  }
}

export function _getDerivedRefreshTimeoutMsForTesting(): number {
  return getDerivedRefreshTimeoutMs();
}

export async function _runWithDerivedRefreshTimeoutForTesting(
  repoId: string,
  targetVersionId: string,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<void>,
  options: { markActiveWriteLockOnTimeout?: boolean } = {},
): Promise<void> {
  return runWithDerivedRefreshTimeout(
    repoId,
    targetVersionId,
    signal,
    work,
    options.markActiveWriteLockOnTimeout
      ? (timeoutMs) => {
          markActiveRepoWriteHeavyLockTimedOut(
            repoId,
            targetVersionId,
            timeoutMs,
          );
        }
      : undefined,
  );
}

async function defaultRefreshImpl(params: {
  repoId: string;
  versionId: string;
  signal: AbortSignal;
  onProgress?: (progress: IndexProgress) => void;
}): Promise<AlgorithmRefreshDiagnostics | void> {
  const { repoId, versionId, signal, onProgress } = params;
  if (signal.aborted) return;
  const appConfig = loadConfig();
  const { computeAndStoreClustersAndProcesses } =
    await import("./cluster-orchestrator.js");
  const conn = await getLadybugConn();
  if (signal.aborted) return;
  onProgress?.({
    stage: "finalizing",
    current: 0,
    total: 0,
    substage: "clusterRefresh",
    message: "loading graph",
  });
  const result = await computeAndStoreClustersAndProcesses({
    conn,
    repoId,
    versionId,
    algorithmRefresh: appConfig.indexing?.algorithmRefresh,
    onProgress,
  });
  return result.algorithmRefresh;
  // Semantic summaries + embeddings are currently regenerated lazily via
  // index.refresh and the queries that depend on them. This queue must not
  // clear their dirty flags because it did not refresh those payloads.
}

/**
 * Cooperative shutdown. Signals all in-flight refreshes to abort and waits
 * for them to settle. New enqueues are rejected.
 */
export async function shutdownDerivedRefreshQueue(): Promise<void> {
  shuttingDown = true;
  pending.clear();
  const outstanding = [...running.values()];
  for (const entry of outstanding) {
    entry.abort.abort();
  }
  await Promise.allSettled(outstanding.map((e) => e.promise));
}

/**
 * Block until the derived-refresh queue has no pending or running entries
 * for `repoId`. Used by post-refresh hooks (SCIP auto-ingest) to avoid
 * racing the cluster/process write transaction for the single LadybugDB
 * write connection — concurrent writers exceeded the 30s queue timeout.
 *
 * Times out (logs warn + returns) after `timeoutMs` so a wedged background
 * task cannot stall the foreground refresh response indefinitely.
 */
export async function waitForDerivedRefreshIdle(
  repoId: string,
  timeoutMs = 120_000,
  pollIntervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (running.has(repoId) || pending.has(repoId)) {
    if (Date.now() >= deadline) {
      logger.warn("waitForDerivedRefreshIdle timed out", {
        repoId,
        timeoutMs,
        pending: pending.has(repoId),
        running: running.has(repoId),
      });
      return;
    }
    if (!announced) {
      logger.info("Waiting for derived-refresh idle before proceeding", {
        repoId,
        timeoutMs,
      });
      announced = true;
    }
    if (pending.has(repoId) && !running.has(repoId)) {
      // Kick the drain so the pending entry transitions to running and we
      // can observe completion. drain() is idempotent per repo.
      void drain(repoId);
    }
    // Poll on a short cadence rather than awaiting `inFlight.promise`
    // directly: a rejection in `runOne` (from a future refactor) would
    // abort the caller, and a Promise.race leg leaks if the loser never
    // settles. Polling tolerates both and respects the deadline.
    const remaining = deadline - Date.now();
    const sleepMs = Math.min(pollIntervalMs, Math.max(remaining, 0));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, sleepMs);
    });
  }
}

export function _getDerivedRefreshQueueStateForTesting(): {
  pending: number;
  running: number;
  details: ReturnType<typeof getDeferredWorkStatuses>;
} {
  return {
    pending: pending.size,
    running: running.size,
    details: getDeferredWorkStatuses().filter(
      (status) => status.kind === "derived-refresh",
    ),
  };
}

/**
 * Test-only: synthesize a `running` entry whose promise resolves when the
 * returned `release` callback is invoked. Lets unit tests exercise
 * `waitForDerivedRefreshIdle` without bringing up LadybugDB or threading
 * through `runOne`'s real DB-bound finalization.
 */
export function _seedRunningForTesting(
  repoId: string,
  targetVersionId = "test",
  progress: DeferredWorkProgress = {
    phase: "starting",
    current: 0,
    total: DERIVED_REFRESH_PROGRESS_TOTAL,
    message: "starting",
  },
): () => void {
  let resolveRun!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  const abort = new AbortController();
  setDerivedRefreshProgress(repoId, targetVersionId, progress);
  const entry: RunningEntry = {
    repoId,
    targetVersionId,
    abort,
    startedAt: Date.now(),
    promise: promise.finally(() => {
      running.delete(repoId);
      clearDeferredWorkStatus("derived-refresh", repoId);
    }),
  };
  running.set(repoId, entry);
  return resolveRun;
}
