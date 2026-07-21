import {
  WATCHER_REINDEX_MAX_ATTEMPTS,
  WATCHER_REINDEX_RETRY_BASE_MS,
  WATCHER_REINDEX_RETRY_MAX_MS,
} from "../../config/constants.js";
import {
  listPendingGraphIntegrityRevisions,
  markGraphIntegrityFailedIfVerifying,
  type GraphIntegrityPendingRevision,
} from "../../db/ladybug-derived-state.js";
import { logger } from "../../util/logger.js";
import {
  GRAPH_INTEGRITY_VERIFICATION_FAILURE,
  verifyPersistedGraphIntegrityRevision,
} from "./persisted-graph-integrity.js";

const RECOVERY_SWEEP_MS = 5_000;

class VerificationCancelledError extends Error {}

interface WorkerCancellation {
  controller: AbortController | undefined;
  stopRequested: boolean;
}

interface WorkerEntry {
  cancellation: WorkerCancellation;
  task: Promise<void>;
  wakePending: boolean;
}

const workers = new Map<string, WorkerEntry>();
let recoveryTimer: NodeJS.Timeout | undefined;
let recoveryStart: Promise<void> | undefined;

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new VerificationCancelledError();
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function verifyWithRetry(
  pending: GraphIntegrityPendingRevision,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < WATCHER_REINDEX_MAX_ATTEMPTS; attempt += 1) {
    try {
      checkCancelled(signal);
      await verifyPersistedGraphIntegrityRevision(
        pending.repoId,
        pending.versionId,
        pending.revision,
        { checkCancelled: () => checkCancelled(signal) },
      );
      return;
    } catch (error) {
      if (error instanceof VerificationCancelledError) return;
      if (attempt + 1 >= WATCHER_REINDEX_MAX_ATTEMPTS) {
        if (signal.aborted) return;
        logger.error("Background graph integrity verification exhausted retries", {
          repoId: pending.repoId,
          versionId: pending.versionId,
          revision: pending.revision,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await markGraphIntegrityFailedIfVerifying(
            pending.repoId,
            pending.versionId,
            pending.revision,
            GRAPH_INTEGRITY_VERIFICATION_FAILURE,
          );
        } catch (publicationError) {
          logger.error("Failed to publish graph integrity retry exhaustion", {
            repoId: pending.repoId,
            versionId: pending.versionId,
            revision: pending.revision,
            error:
              publicationError instanceof Error
                ? publicationError.message
                : String(publicationError),
          });
        }
        return;
      }
      const delayMs = Math.min(
        WATCHER_REINDEX_RETRY_MAX_MS,
        WATCHER_REINDEX_RETRY_BASE_MS * 2 ** attempt,
      );
      await waitForRetry(delayMs, signal);
    }
  }
}

async function runWorker(repoId: string, entry: WorkerEntry): Promise<void> {
  while (!entry.cancellation.stopRequested) {
    entry.wakePending = false;
    let pending: GraphIntegrityPendingRevision | undefined;
    try {
      pending = (await listPendingGraphIntegrityRevisions()).find(
        (revision) => revision.repoId === repoId,
      );
    } catch (error) {
      logger.error("Failed to load pending graph integrity revision", {
        repoId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (entry.cancellation.stopRequested) return;
    // A wake arriving during the durable read may represent a newer commit.
    if (entry.wakePending) continue;
    if (!pending) return;

    const controller = new AbortController();
    entry.cancellation.controller = controller;
    await verifyWithRetry(pending, controller.signal);
    entry.cancellation.controller = undefined;
    // Always reload DerivedState after completion, cancellation, or stale CAS.
  }
}

function startWorker(repoId: string): void {
  const entry: WorkerEntry = {
    cancellation: { controller: undefined, stopRequested: false },
    task: Promise.resolve(),
    wakePending: false,
  };
  workers.set(repoId, entry);
  entry.task = runWorker(repoId, entry).finally(() => {
    if (workers.get(repoId) === entry) workers.delete(repoId);
  });
}

export function notifyGraphIntegrityVerifier(repoId: string): void {
  const entry = workers.get(repoId);
  if (!entry) {
    startWorker(repoId);
    return;
  }
  if (entry.cancellation.stopRequested) return;
  entry.wakePending = true;
  entry.cancellation.controller?.abort();
}

export async function cancelAndWaitForGraphIntegrityVerifier(
  repoId: string,
): Promise<void> {
  const entry = workers.get(repoId);
  if (!entry) return;
  entry.wakePending = false;
  entry.cancellation.stopRequested = true;
  entry.cancellation.controller?.abort();
  await entry.task;
}

export async function cancelAndWaitForAllGraphIntegrityVerifiers(): Promise<void> {
  const entries = [...workers.entries()];
  for (const [, entry] of entries) {
    entry.wakePending = false;
    entry.cancellation.stopRequested = true;
    entry.cancellation.controller?.abort();
  }
  await Promise.all(entries.map(([, entry]) => entry.task));
}

/** @internal Deterministic recovery hook; production uses the fixed sweep. */
export async function runGraphIntegrityVerifierRecoverySweep(): Promise<void> {
  const pending = await listPendingGraphIntegrityRevisions();
  for (const revision of pending) {
    if (!workers.has(revision.repoId)) {
      notifyGraphIntegrityVerifier(revision.repoId);
    }
  }
}

export async function startGraphIntegrityVerifierRecovery(): Promise<void> {
  if (recoveryTimer) {
    await recoveryStart;
    return;
  }
  recoveryStart = runGraphIntegrityVerifierRecoverySweep();
  recoveryTimer = setInterval(() => {
    void runGraphIntegrityVerifierRecoverySweep().catch((error: unknown) => {
      logger.error("Graph integrity recovery sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, RECOVERY_SWEEP_MS);
  recoveryTimer.unref();
  await recoveryStart;
}

export function stopGraphIntegrityVerifierRecovery(): void {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = undefined;
  recoveryStart = undefined;
}
