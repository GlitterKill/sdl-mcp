import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-symbols.js";
import type { EdgeRow } from "../../db/ladybug-edges.js";
import type { SymbolReferenceRow } from "../../db/ladybug-embeddings.js";
import type { FileRow } from "../../db/ladybug-repos.js";
import { logger } from "../../util/logger.js";

export interface FileUpsertEntry {
  file: Omit<FileRow, "directory">;
  existingFileId: string | null;
}

interface FlushBatch {
  files: FileUpsertEntry[];
  symbols: SymbolRow[];
  edges: EdgeRow[];
  refs: SymbolReferenceRow[];
  count: number;
}

function describeBatch(batch: FlushBatch): Record<string, number> {
  return {
    rows: batch.count,
    files: batch.files.length,
    symbols: batch.symbols.length,
    edges: batch.edges.length,
    refs: batch.refs.length,
  };
}

/**
 * Accumulates DB writes and drains them via a background write queue.
 *
 * Parsing threads call add*() which is synchronous. When the accumulator
 * reaches flushThreshold, it snapshots pending data into a FlushBatch
 * and enqueues it for the background writer. The writer processes batches
 * through the DB write pool but never blocks
 * the parsing/processing loop.
 */
/**
 * Snapshot delivered to a `BatchPersistAccumulator` progress callback after
 * each completed flush. `totalFlushed` counts all rows committed so far for
 * the lifetime of the accumulator; `queueDepth` is the number of pending
 * `FlushBatch` snapshots awaiting commit; `pending` is the row count not yet
 * snapshotted into a batch.
 */
export interface BatchPersistDrainProgress {
  totalFlushed: number;
  queueDepth: number;
  pending: number;
}

export class BatchPersistAccumulator {
  private files: FileUpsertEntry[] = [];
  private symbols: SymbolRow[] = [];
  private edges: EdgeRow[] = [];
  private symbolReferences: SymbolReferenceRow[] = [];
  private pendingCount = 0;
  private readonly flushThreshold: number;

  private writeQueue: FlushBatch[] = [];
  private drainPromise: Promise<void> | null = null;
  private draining = false;
  private _error: Error | null = null;
  private _totalFlushed = 0;
  private progressCallback:
    | ((state: BatchPersistDrainProgress) => void)
    | null = null;

  constructor(flushThreshold = 512) {
    this.flushThreshold = flushThreshold;
    activeAccumulators.add(this);
  }

  /**
   * Register a callback invoked after each `FlushBatch` commits. Used by the
   * pass-1 drain phase to drive a CLI progress bar — without periodic ticks
   * the user sees only the static "Flushing pass 1 writes" message for the
   * full drain duration. Callback errors are caught and logged so a faulty
   * progress consumer cannot abort the drain.
   */
  setProgressCallback(
    cb: ((state: BatchPersistDrainProgress) => void) | null,
  ): void {
    this.progressCallback = cb;
  }

  get pending(): number {
    return this.pendingCount;
  }

  get totalFlushed(): number {
    return this._totalFlushed;
  }

  get error(): Error | null {
    return this._error;
  }

  get queueDepth(): number {
    return this.writeQueue.length;
  }

  addFile(
    file: Omit<FileRow, "directory">,
    existingFileId: string | null,
  ): void {
    this.files.push({ file, existingFileId });
    this.pendingCount++;
    this.maybeEnqueue();
  }

  addSymbols(rows: SymbolRow[]): void {
    this.symbols.push(...rows);
    this.pendingCount += rows.length;
    this.maybeEnqueue();
  }

  addEdges(rows: EdgeRow[]): void {
    this.edges.push(...rows);
    this.pendingCount += rows.length;
    this.maybeEnqueue();
  }

  addSymbolReferences(rows: SymbolReferenceRow[]): void {
    this.symbolReferences.push(...rows);
    this.pendingCount += rows.length;
    this.maybeEnqueue();
  }

  shouldFlush(): boolean {
    return this.pendingCount >= this.flushThreshold;
  }

  /**
   * Snapshot pending data into the write queue if threshold reached.
   */
  private maybeEnqueue(): void {
    if (this.pendingCount < this.flushThreshold) return;
    this.enqueueSnapshot();
  }

  private enqueueSnapshot(): void {
    if (this.pendingCount === 0) return;

    const batch: FlushBatch = {
      files: this.files.splice(0),
      symbols: this.symbols.splice(0),
      edges: this.edges.splice(0),
      refs: this.symbolReferences.splice(0),
      count: this.pendingCount,
    };
    this.pendingCount = 0;
    this.writeQueue.push(batch);

    this.ensureDraining();
  }

  private ensureDraining(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainPromise = this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const batch = this.writeQueue.shift()!;
      try {
        await this.writeBatch(batch);
        this._totalFlushed += batch.count;
        if (this.progressCallback) {
          try {
            this.progressCallback({
              totalFlushed: this._totalFlushed,
              queueDepth: this.writeQueue.length,
              pending: this.pendingCount,
            });
          } catch (cbErr) {
            logger.warn("BatchPersistAccumulator progress callback threw", {
              error: cbErr,
            });
          }
        }
      } catch (err) {
        this._error = err instanceof Error ? err : new Error(String(err));
        logger.error("BatchPersistAccumulator drain error", {
          error: err,
          batch: describeBatch(batch),
        });
        while (this.writeQueue.length > 0) {
          const dropped = this.writeQueue.shift()!;
          logger.warn(
            "BatchPersistAccumulator dropping queued batch after drain failure",
            {
              batch: describeBatch(dropped),
            },
          );
        }
        break;
      }
    }
    this.draining = false;
    this.drainPromise = null;
  }

  private async writeBatch(batch: FlushBatch): Promise<void> {
    logger.debug("BatchPersistAccumulator flushing", {
      files: batch.files.length,
      symbols: batch.symbols.length,
      edges: batch.edges.length,
      refs: batch.refs.length,
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        const existingFileIds = batch.files
          .map((e) => e.existingFileId)
          .filter((id): id is string => id !== null);

        if (existingFileIds.length > 0) {
          await ladybugDb.deleteSymbolsByFileIds(txConn, existingFileIds);
        }

        if (batch.files.length > 0) {
          await ladybugDb.upsertFileBatch(
            txConn,
            batch.files.map((entry) => entry.file),
          );
        }

        if (batch.refs.length > 0) {
          await ladybugDb.insertSymbolReferences(txConn, batch.refs);
        }

        if (batch.symbols.length > 0) {
          await ladybugDb.upsertSymbolBatch(txConn, batch.symbols);
        }

        if (batch.edges.length > 0) {
          await ladybugDb.insertEdges(txConn, batch.edges, {
            skipSourceRepoLink: true,
          });
        }
      });
    });

    logger.debug("BatchPersistAccumulator flush complete", {
      filesWritten: batch.files.length,
    });
  }

  /**
   * Flush remaining data and wait for all queued writes to complete.
   * Call at the end of indexing to ensure nothing is lost.
   * Throws if any background write failed.
   *
   * PRECONDITION: All add*() producers must have finished before calling.
   */
  async drain(): Promise<void> {
    try {
      this.enqueueSnapshot();

      if (this.draining && this.drainPromise) {
        await this.drainPromise;
      }

      if (this.writeQueue.length > 0 && !this._error) {
        this.ensureDraining();
        if (this.drainPromise) await this.drainPromise;
      }

      if (this._error) {
        throw this._error;
      }
    } finally {
      activeAccumulators.delete(this);
    }
  }

  /**
   * @deprecated Use drain() instead.
   */
  async flush(): Promise<void> {
    try {
      await this.drain();
    } finally {
      activeAccumulators.delete(this);
    }
  }
}

// Active-instance registry for observability probes.
// Kept module-internal except for the small `getActiveDrainStats` accessor.
const activeAccumulators: Set<BatchPersistAccumulator> = new Set();

export function getActiveDrainStats(): {
  queueDepth: number;
  drainFailures: number;
} {
  let queueDepth = 0;
  let drainFailures = 0;
  for (const acc of activeAccumulators) {
    queueDepth += acc.queueDepth;
    if (acc.error !== null) drainFailures += 1;
  }
  return { queueDepth, drainFailures };
}
