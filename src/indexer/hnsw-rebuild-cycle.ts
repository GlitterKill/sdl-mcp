import { runWalCheckpoint } from "../db/ladybug.js";
import { withExclusiveLadybugOperation } from "../db/ladybug-operation-gate.js";
import { withPostIndexWriteSession } from "../db/write-session.js";
import { DatabaseError } from "../domain/errors.js";

async function requireCheckpoint(
  phase: string,
  boundary: "pre" | "post",
): Promise<void> {
  if (await runWalCheckpoint(phase)) return;
  throw new DatabaseError(
    `HNSW rebuild ${boundary}-checkpoint failed during ${phase}`,
  );
}

/**
 * Isolate one destructive HNSW cycle between durable WAL boundaries.
 * One outer exclusive admission covers pre-checkpoint, the nested write
 * session, and post-checkpoint so no operation can enter between phases.
 */
export function runHnswRebuildCycle<T>(
  preCheckpointPhase: string,
  postCheckpointPhase: string,
  rebuild: () => Promise<T>,
  timeoutMs?: number,
  recordTiming?: (phaseName: string, durationMs: number) => void,
  /** Validated caller identity forwarded only to post-index telemetry. */
  repoId?: string,
): Promise<T> {
  return withExclusiveLadybugOperation(async () => {
    const measure = async (
      phaseName: string,
      fn: () => Promise<void>,
    ): Promise<void> => {
      const startedAt = Date.now();
      try {
        await fn();
      } finally {
        recordTiming?.(phaseName, Date.now() - startedAt);
      }
    };

    await measure("checkpoint.pre", () =>
      requireCheckpoint(preCheckpointPhase, "pre"),
    );

    let result!: T;
    let rebuildFailed = false;
    let rebuildError: unknown;
    try {
      result = await withPostIndexWriteSession(async () => rebuild(), {
        timeoutMs,
        repoId,
      });
    } catch (error) {
      rebuildFailed = true;
      rebuildError = error;
    }

    let postCheckpointFailed = false;
    let postCheckpointError: unknown;
    try {
      await measure("checkpoint.post", () =>
        requireCheckpoint(postCheckpointPhase, "post"),
      );
    } catch (error) {
      postCheckpointFailed = true;
      postCheckpointError = error;
    }

    if (rebuildFailed && postCheckpointFailed) {
      throw new AggregateError(
        [rebuildError, postCheckpointError],
        "HNSW rebuild and post-checkpoint both failed",
      );
    }
    if (rebuildFailed) throw rebuildError;
    if (postCheckpointFailed) throw postCheckpointError;
    return result;
  }, timeoutMs);
}
