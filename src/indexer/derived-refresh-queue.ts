/**
 * Background refresh queue for derived-state (clusters, processes, algorithms,
 * semantic summaries, embeddings). Incremental index runs mark derived state
 * dirty and enqueue here; long-lived processes (serve/watch) drain the queue
 * without blocking the critical path.
 *
 * See devdocs/plans/2026-04-17-post-pass2-performance-and-feedback-plan.md §5.
 */

import { getLadybugConn } from "../db/ladybug.js";
import {
  markDerivedStateComputed,
  recordDerivedStateError,
} from "../db/ladybug-derived-state.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { logger } from "../util/logger.js";

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
}

// Module-local state. Long-lived processes carry this across incremental runs;
// one-shot CLI processes never drain because they exit before the microtask
// settles. That is intentional — marking dirty is enough on the CLI path.
const pending = new Map<string, PendingEntry>();
const running = new Map<string, RunningEntry>();
let enabled = true;
let shuttingDown = false;

export interface DerivedRefreshHooks {
  refresh: (params: {
    repoId: string;
    versionId: string;
    signal: AbortSignal;
  }) => Promise<void>;
}

// Overridable entry point so tests can swap in a lightweight stub.
let hooks: DerivedRefreshHooks = {
  refresh: defaultRefreshImpl,
};

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
    promise: runOne(repoId, next.targetVersionId, abort.signal).finally(() => {
      running.delete(repoId);
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
  try {
    await withIndexingGate(async () => {
      if (signal.aborted) return;
      await hooks.refresh({ repoId, versionId: targetVersionId, signal });
      if (signal.aborted) return;
      await markDerivedStateComputed(repoId, targetVersionId);
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

async function defaultRefreshImpl(params: {
  repoId: string;
  versionId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { repoId, versionId, signal } = params;
  if (signal.aborted) return;
  const { computeAndStoreClustersAndProcesses } =
    await import("./cluster-orchestrator.js");
  const conn = await getLadybugConn();
  if (signal.aborted) return;
  await computeAndStoreClustersAndProcesses({
    conn,
    repoId,
    versionId,
  });
  // Semantic summaries + embeddings are currently regenerated lazily via
  // index.refresh and the queries that depend on them; leave them to the next
  // full index for now. Dirty flags stay cleared by the caller on success.
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

export function _getDerivedRefreshQueueStateForTesting(): {
  pending: number;
  running: number;
} {
  return { pending: pending.size, running: running.size };
}
