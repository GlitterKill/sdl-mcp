import { withWriteConn } from "../db/ladybug.js";
import { execCheckpoint } from "../db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../db/ladybug-operation-gate.js";
import { withPostIndexWriteSession } from "../db/write-session.js";
import { DatabaseError } from "../domain/errors.js";

async function requireCheckpoint(
  phase: string,
  boundary: "pre" | "post",
): Promise<void> {
  try {
    // Required durability boundaries retain admission until native I/O settles.
    // The best-effort housekeeping deadline must not abort a rebuild checkpoint.
    await withWriteConn(execCheckpoint);
  } catch (cause) {
    const error = new DatabaseError(
      `HNSW rebuild ${boundary}-checkpoint failed during ${phase}`,
    );
    error.cause = cause;
    throw error;
  }
}

export interface HnswRebuildCycleOptions<T> {
  preCheckpointPhase: string;
  postCheckpointPhase: string;
  body: () => Promise<T>;
  onSuccess?: (result: T) => Promise<void> | void;
  onFailureInsideGate?: (error: unknown) => Promise<void> | void;
  timeoutMs?: number;
  recordTiming?: (phaseName: string, durationMs: number) => void;
  /** Validated caller identity forwarded only to post-index telemetry. */
  repoId?: string;
}

/**
 * Isolate one destructive HNSW cycle between durable WAL boundaries.
 * Failure finalization runs before exclusive admission reopens.
 */
export function runHnswRebuildCycle<T>(
  options: HnswRebuildCycleOptions<T>,
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
        options.recordTiming?.(phaseName, Date.now() - startedAt);
      }
    };

    try {
      await measure("checkpoint.pre", () =>
        requireCheckpoint(options.preCheckpointPhase, "pre"),
      );

      let result!: T;
      let bodyFailed = false;
      let bodyError: unknown;
      try {
        result = await withPostIndexWriteSession(options.body, {
          timeoutMs: options.timeoutMs,
          repoId: options.repoId,
        });
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
      }

      let postCheckpointFailed = false;
      let postCheckpointError: unknown;
      try {
        await measure("checkpoint.post", () =>
          requireCheckpoint(options.postCheckpointPhase, "post"),
        );
      } catch (error) {
        postCheckpointFailed = true;
        postCheckpointError = error;
      }

      if (bodyFailed && postCheckpointFailed) {
        throw new AggregateError(
          [bodyError, postCheckpointError],
          "HNSW rebuild and post-checkpoint both failed",
        );
      }
      if (bodyFailed) throw bodyError;
      if (postCheckpointFailed) throw postCheckpointError;

      await options.onSuccess?.(result);
      return result;
    } catch (error) {
      try {
        await options.onFailureInsideGate?.(error);
      } catch (finalizationError) {
        throw new AggregateError(
          [error, finalizationError],
          "HNSW rebuild and failure finalization both failed",
        );
      }
      throw error;
    }
  }, options.timeoutMs);
}
