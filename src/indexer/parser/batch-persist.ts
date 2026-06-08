import { performance } from "node:perf_hooks";

import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-symbols.js";
import type { EdgeRow } from "../../db/ladybug-edges.js";
import type { SymbolReferenceRow } from "../../db/ladybug-embeddings.js";
import type { FileRow } from "../../db/ladybug-repos.js";
import { classifyDependencyTarget } from "../../db/symbol-placeholders.js";
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

export const BATCH_PERSIST_WRITE_PHASES = [
  "deleteOldSymbols",
  "deleteIncomingSymbols",
  "upsertFiles",
  "insertSymbolReferences",
  "upsertSymbols",
  "insertEdges",
] as const;

export const PASS1_KNOWN_ENDPOINT_COPY_THRESHOLD = 128;

export type BatchPersistWritePhase =
  (typeof BATCH_PERSIST_WRITE_PHASES)[number];

export interface BatchPersistPhaseDiagnostics {
  count: number;
  skipped: number;
  rows: number;
  totalMs: number;
  maxMs: number;
}

export interface BatchPersistBatchDiagnostics {
  rows: number;
  files: number;
  symbols: number;
  edges: number;
  refs: number;
  existingFiles: number;
  totalMs: number;
  phaseMs: Record<BatchPersistWritePhase, number>;
}

export interface BatchPersistDrainDiagnostics {
  batches: number;
  totalMs: number;
  rows: {
    total: number;
    files: number;
    symbols: number;
    edges: number;
    refs: number;
    existingFiles: number;
  };
  phases: Record<BatchPersistWritePhase, BatchPersistPhaseDiagnostics>;
  largestBatch: BatchPersistBatchDiagnostics | null;
}

export interface BatchPersistAccumulatorOptions {
  collectDiagnostics?: boolean;
  knownSymbolIdsForEdgeCopy?: ReadonlySet<string>;
  symbolWriteMode?: "merge" | "fresh-copy";
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

function createPhaseDiagnostics(): Record<
  BatchPersistWritePhase,
  BatchPersistPhaseDiagnostics
> {
  return Object.fromEntries(
    BATCH_PERSIST_WRITE_PHASES.map((phase) => [
      phase,
      { count: 0, skipped: 0, rows: 0, totalMs: 0, maxMs: 0 },
    ]),
  ) as Record<BatchPersistWritePhase, BatchPersistPhaseDiagnostics>;
}

function createEmptyPhaseMs(): Record<BatchPersistWritePhase, number> {
  return Object.fromEntries(
    BATCH_PERSIST_WRITE_PHASES.map((phase) => [phase, 0]),
  ) as Record<BatchPersistWritePhase, number>;
}

function createDrainDiagnostics(): BatchPersistDrainDiagnostics {
  return {
    batches: 0,
    totalMs: 0,
    rows: {
      total: 0,
      files: 0,
      symbols: 0,
      edges: 0,
      refs: 0,
      existingFiles: 0,
    },
    phases: createPhaseDiagnostics(),
    largestBatch: null,
  };
}

function cloneDrainDiagnostics(
  diagnostics: BatchPersistDrainDiagnostics,
): BatchPersistDrainDiagnostics {
  return {
    batches: diagnostics.batches,
    totalMs: diagnostics.totalMs,
    rows: { ...diagnostics.rows },
    phases: Object.fromEntries(
      BATCH_PERSIST_WRITE_PHASES.map((phase) => [
        phase,
        { ...diagnostics.phases[phase] },
      ]),
    ) as Record<BatchPersistWritePhase, BatchPersistPhaseDiagnostics>,
    largestBatch: diagnostics.largestBatch
      ? {
          ...diagnostics.largestBatch,
          phaseMs: { ...diagnostics.largestBatch.phaseMs },
        }
      : null,
  };
}

function isUnresolvedSymbolId(symbolId: string): boolean {
  return symbolId.startsWith("unresolved:");
}

/**
 * Pass 1 replaces a file's symbols before writing its dependency edges. Edges
 * whose endpoints are both real symbols inserted by the same batch can skip
 * generic endpoint repair and use the relationship COPY path; everything else
 * must keep the slower repair writer so unresolved/external placeholders stay
 * correct.
 */
/** @internal exported for tests; do not import from product code. */
export function splitPass1EdgesForKnownEndpointCopy(
  edges: readonly EdgeRow[],
  sameBatchSymbolIds: ReadonlySet<string>,
  knownPersistedSymbolIds: ReadonlySet<string> = new Set(),
): {
  knownEndpointEdges: EdgeRow[];
  repairEdges: EdgeRow[];
} {
  const knownEndpointEdges: EdgeRow[] = [];
  const repairEdges: EdgeRow[] = [];

  for (const edge of edges) {
    const targetMeta =
      edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
    if (
      !isUnresolvedSymbolId(edge.fromSymbolId) &&
      sameBatchSymbolIds.has(edge.fromSymbolId) &&
      (sameBatchSymbolIds.has(edge.toSymbolId) ||
        knownPersistedSymbolIds.has(edge.toSymbolId) ||
        targetMeta.symbolStatus !== "real")
    ) {
      knownEndpointEdges.push(edge);
    } else {
      repairEdges.push(edge);
    }
  }

  return { knownEndpointEdges, repairEdges };
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
  private readonly collectDiagnostics: boolean;
  private readonly diagnostics: BatchPersistDrainDiagnostics;
  private readonly knownSymbolIdsForEdgeCopy: ReadonlySet<string>;
  private readonly symbolWriteMode: "merge" | "fresh-copy";

  constructor(
    flushThreshold = 512,
    options: BatchPersistAccumulatorOptions = {},
  ) {
    this.flushThreshold = flushThreshold;
    this.collectDiagnostics = options.collectDiagnostics === true;
    this.diagnostics = createDrainDiagnostics();
    this.knownSymbolIdsForEdgeCopy =
      options.knownSymbolIdsForEdgeCopy ?? new Set<string>();
    this.symbolWriteMode = options.symbolWriteMode ?? "merge";
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

  getDiagnostics(): BatchPersistDrainDiagnostics {
    return cloneDrainDiagnostics(this.diagnostics);
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
    const batchStart = performance.now();
    const phaseMs = createEmptyPhaseMs();
    const existingFileIds = batch.files
      .map((e) => e.existingFileId)
      .filter((id): id is string => id !== null);

    logger.debug("BatchPersistAccumulator flushing", {
      files: batch.files.length,
      symbols: batch.symbols.length,
      edges: batch.edges.length,
      refs: batch.refs.length,
      rows: batch.count,
      existingFiles: existingFileIds.length,
    });

    const timePhase = async (
      phase: BatchPersistWritePhase,
      rows: number,
      body: () => Promise<void>,
    ): Promise<void> => {
      if (rows === 0) {
        if (this.collectDiagnostics) {
          this.diagnostics.phases[phase].skipped += 1;
        }
        return;
      }

      const phaseStart = performance.now();
      try {
        await body();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `BatchPersistAccumulator ${phase} failed while writing ${rows} row(s): ${message}`,
          { cause: err },
        );
      } finally {
        const durationMs = Math.round(performance.now() - phaseStart);
        phaseMs[phase] += durationMs;
        if (this.collectDiagnostics) {
          const target = this.diagnostics.phases[phase];
          target.count += 1;
          target.rows += rows;
          target.totalMs += durationMs;
          target.maxMs = Math.max(target.maxMs, durationMs);
        }
      }
    };

    if (this.symbolWriteMode === "fresh-copy") {
      await this.writeFreshCopyBatch(batch, existingFileIds, timePhase);
    } else {
      await this.writeMergeBatch(batch, existingFileIds, timePhase);
    }

    const durationMs = Math.round(performance.now() - batchStart);
    if (this.collectDiagnostics) {
      const batchDiagnostics: BatchPersistBatchDiagnostics = {
        rows: batch.count,
        files: batch.files.length,
        symbols: batch.symbols.length,
        edges: batch.edges.length,
        refs: batch.refs.length,
        existingFiles: existingFileIds.length,
        totalMs: durationMs,
        phaseMs,
      };
      this.diagnostics.batches += 1;
      this.diagnostics.totalMs += durationMs;
      this.diagnostics.rows.total += batch.count;
      this.diagnostics.rows.files += batch.files.length;
      this.diagnostics.rows.symbols += batch.symbols.length;
      this.diagnostics.rows.edges += batch.edges.length;
      this.diagnostics.rows.refs += batch.refs.length;
      this.diagnostics.rows.existingFiles += existingFileIds.length;
      if (
        !this.diagnostics.largestBatch ||
        batch.count > this.diagnostics.largestBatch.rows
      ) {
        this.diagnostics.largestBatch = batchDiagnostics;
      }
    }

    logger.debug("BatchPersistAccumulator flush complete", {
      filesWritten: batch.files.length,
      rows: batch.count,
      existingFiles: existingFileIds.length,
      durationMs,
      phaseMs,
    });
  }

  private async writeMergeBatch(
    batch: FlushBatch,
    existingFileIds: string[],
    timePhase: (
      phase: BatchPersistWritePhase,
      rows: number,
      body: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await timePhase("deleteOldSymbols", existingFileIds.length, async () => {
          await ladybugDb.deleteSymbolsByFileIds(txConn, existingFileIds);
        });

        await timePhase("deleteIncomingSymbols", 0, async () => {});

        await timePhase("upsertFiles", batch.files.length, async () => {
          await ladybugDb.upsertFileBatch(
            txConn,
            batch.files.map((entry) => entry.file),
          );
        });

        await timePhase(
          "insertSymbolReferences",
          batch.refs.length,
          async () => {
            await ladybugDb.insertSymbolReferences(txConn, batch.refs);
          },
        );

        await timePhase("upsertSymbols", batch.symbols.length, async () => {
          await ladybugDb.upsertSymbolBatch(txConn, batch.symbols);
        });

        await this.writeBatchEdges(txConn, batch, timePhase);
      });
    });
  }

  private async writeFreshCopyBatch(
    batch: FlushBatch,
    existingFileIds: string[],
    timePhase: (
      phase: BatchPersistWritePhase,
      rows: number,
      body: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    // Provider-first fallback needs the duplicate-key-safe COPY writers from
    // the direct path, but batching keeps LadybugDB's single writer from
    // thrashing through several transactions per parsed file.
    const incomingSymbolIds = [
      ...new Set(batch.symbols.map((symbol) => symbol.symbolId)),
    ];

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await timePhase("deleteOldSymbols", existingFileIds.length, async () => {
          await ladybugDb.deleteSymbolsByFileIds(txConn, existingFileIds);
        });
      });
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await timePhase(
          "deleteIncomingSymbols",
          incomingSymbolIds.length,
          async () => {
            await ladybugDb.deleteSymbolsByIds(txConn, incomingSymbolIds);
          },
        );
      });
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await timePhase("upsertFiles", batch.files.length, async () => {
          await ladybugDb.upsertFileBatch(
            txConn,
            batch.files.map((entry) => entry.file),
          );
        });

        await timePhase(
          "insertSymbolReferences",
          batch.refs.length,
          async () => {
            await ladybugDb.insertSymbolReferences(txConn, batch.refs);
          },
        );
      });
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await timePhase("upsertSymbols", batch.symbols.length, async () => {
          await ladybugDb.upsertKnownFileSymbols(txConn, batch.symbols);
        });
      });
    });

    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await this.writeBatchEdges(txConn, batch, timePhase);
      });
    });
  }

  private async writeBatchEdges(
    txConn: Parameters<typeof ladybugDb.insertEdges>[0],
    batch: FlushBatch,
    timePhase: (
      phase: BatchPersistWritePhase,
      rows: number,
      body: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    await timePhase("insertEdges", batch.edges.length, async () => {
      const sameBatchSymbolIds = new Set(
        batch.symbols.map((symbol) => symbol.symbolId),
      );
      const { knownEndpointEdges, repairEdges } =
        splitPass1EdgesForKnownEndpointCopy(
          batch.edges,
          sameBatchSymbolIds,
          this.knownSymbolIdsForEdgeCopy,
        );

      if (knownEndpointEdges.length >= PASS1_KNOWN_ENDPOINT_COPY_THRESHOLD) {
        await ladybugDb.ensureDependencyTargetsForKnownSourceEdges(
          txConn,
          knownEndpointEdges,
        );
        await ladybugDb.insertKnownSymbolEdges(txConn, knownEndpointEdges);
      } else if (knownEndpointEdges.length > 0) {
        repairEdges.unshift(...knownEndpointEdges);
      }

      await ladybugDb.insertEdges(txConn, repairEdges, {
        skipSourceRepoLink: true,
        skipExistingRelationshipUpdate: true,
      });
    });
  }

  /**
   * Flush remaining data and wait for all queued writes to complete.
   * Unlike drain(), this keeps the accumulator active so producers can add more
   * rows afterwards. Provider-first fallback uses it between native parse
   * chunks to avoid overlapping LadybugDB COPY work with native tree-sitter
   * parsing in the same Node process.
   *
   * PRECONDITION: No add*() calls may run concurrently with this wait.
   */
  async waitForIdle(): Promise<void> {
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
      await this.waitForIdle();
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
