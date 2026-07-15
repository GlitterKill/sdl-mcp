import { performance } from "node:perf_hooks";

import { withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolRow } from "../../db/ladybug-symbols.js";
import type {
  DependencyTargetEnsurePhaseName,
  EdgeRow,
  InsertEdgesPhaseName,
  KnownSymbolEdgesCopyPhaseName,
} from "../../db/ladybug-edges.js";
import type { SymbolReferenceRow } from "../../db/ladybug-embeddings.js";
import type { FileRow } from "../../db/ladybug-repos.js";
import { classifyDependencyTarget } from "../../db/symbol-placeholders.js";
import { logger } from "../../util/logger.js";
import { canonicalizeLanguageId } from "../language.js";

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
  "insertEdges.split",
  "insertEdges.knownEnsure",
  "insertEdges.knownEnsure.symbolMetadata.probeExisting",
  "insertEdges.knownEnsure.symbolMetadata.copyMissing.csvMaterialize",
  "insertEdges.knownEnsure.symbolMetadata.copyMissing.copyFrom",
  "insertEdges.knownEnsure.symbolMetadata.matchExisting",
  "insertEdges.knownEnsure.symbolMetadata.mergeFallback",
  "insertEdges.knownEnsure.repoLink",
  "insertEdges.knownCopy",
  "insertEdges.knownCopy.txnBegin",
  "insertEdges.knownCopy.txnBody",
  "insertEdges.knownCopy.txnCommit",
  "insertEdges.knownCopy.csvMaterialize",
  "insertEdges.knownCopy.copyFrom",
  "insertEdges.knownCopy.tempCleanup",
  "insertEdges.repair",
  "insertEdges.repair.dedupe",
  "insertEdges.repair.groupByRepo",
  "insertEdges.repair.prepareRows",
  "insertEdges.repair.sourceRepoLink.symbolMetadata",
  "insertEdges.repair.sourceRepoLink.repoLink",
  "insertEdges.repair.endpointMetadata",
  "insertEdges.repair.targetMetadata",
  "insertEdges.repair.targetRepoLink",
  "insertEdges.repair.relationshipCreate",
  "insertEdges.repair.relationshipUpdate",
] as const;

export const PASS1_KNOWN_ENDPOINT_COPY_THRESHOLD = 128;

export type BatchPersistWritePhase =
  (typeof BATCH_PERSIST_WRITE_PHASES)[number];

type BatchPersistTimePhase = (
  phase: BatchPersistWritePhase,
  rows: number,
  body: () => Promise<void>,
) => Promise<void>;

type LadybugConnection = Parameters<typeof ladybugDb.insertEdges>[0];

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

export interface BatchPersistEdgeDiagnostics {
  edgeStatsSchemaVersion: number;
  splitCalls: number;
  totalEdges: number;
  knownEndpointEdges: number;
  initialRepairEdges: number;
  belowThresholdKnownEdges: number;
  knownCopyFlushes: number;
  knownCopyEdges: number;
  repairCalls: number;
  repairEdges: number;
  repairCauseBelowThresholdKnownEdges: number;
  repairCauseUnresolvedSourceEdges: number;
  repairCauseBothEndpointsUnsafeEdges: number;
  repairCauseSourceEndpointUnsafeOnlyEdges: number;
  repairCauseTargetEndpointUnsafeOnlyEdges: number;
  repairCauseTargetRealNotKnownEdges: number;
  repairCauseTargetUnresolvedOrPlaceholderEdges: number;
  repairCauseOtherEdges: number;
  repairSourceKnownEdges: number;
  repairSourceUnknownOrUnsafeEdges: number;
  repairSourceKnownTargetOnlyEdges: number;
  repairSourceKnownTargetRealNotKnownEdges: number;
  repairSourceKnownTargetUnsafeEdges: number;
  repairSourceKnownTargetUnresolvedEdges: number;
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
  edgeStats: BatchPersistEdgeDiagnostics;
  largestBatch: BatchPersistBatchDiagnostics | null;
}

export interface BatchPersistAccumulatorOptions {
  collectDiagnostics?: boolean;
  knownSymbolIdsForEdgeCopy?: ReadonlySet<string>;
  symbolWriteMode?: "merge" | "fresh-copy";
  autoDrain?: boolean;
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
    edgeStats: {
      edgeStatsSchemaVersion: 2,
      splitCalls: 0,
      totalEdges: 0,
      knownEndpointEdges: 0,
      initialRepairEdges: 0,
      belowThresholdKnownEdges: 0,
      knownCopyFlushes: 0,
      knownCopyEdges: 0,
      repairCalls: 0,
      repairEdges: 0,
      repairCauseBelowThresholdKnownEdges: 0,
      repairCauseUnresolvedSourceEdges: 0,
      repairCauseBothEndpointsUnsafeEdges: 0,
      repairCauseSourceEndpointUnsafeOnlyEdges: 0,
      repairCauseTargetEndpointUnsafeOnlyEdges: 0,
      repairCauseTargetRealNotKnownEdges: 0,
      repairCauseTargetUnresolvedOrPlaceholderEdges: 0,
      repairCauseOtherEdges: 0,
      repairSourceKnownEdges: 0,
      repairSourceUnknownOrUnsafeEdges: 0,
      repairSourceKnownTargetOnlyEdges: 0,
      repairSourceKnownTargetRealNotKnownEdges: 0,
      repairSourceKnownTargetUnsafeEdges: 0,
      repairSourceKnownTargetUnresolvedEdges: 0,
    },
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
    edgeStats: { ...diagnostics.edgeStats },
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

function copyRelEndpointIsSafe(value: string): boolean {
  return value.length > 0 && !/[",\r\n]/.test(value);
}

function sanitizeRelationshipCopyCell(value: string): string {
  return value.replace(/[",\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function toPass1RepairCopyEdge(edge: EdgeRow): EdgeRow {
  if (typeof edge.provenance !== "string") return edge;
  const provenance = sanitizeRelationshipCopyCell(edge.provenance);
  return provenance === edge.provenance ? edge : { ...edge, provenance };
}

type Pass1RepairCause =
  | "belowThresholdKnown"
  | "unresolvedSource"
  | "unsafeBoth"
  | "unsafeSourceOnly"
  | "unsafeTargetOnly"
  | "targetRealNotKnown"
  | "targetUnresolvedOrPlaceholder"
  | "other";

function isPass1SourceKnown(
  edge: EdgeRow,
  sameBatchSymbolIds: ReadonlySet<string>,
  knownPersistedSymbolIds: ReadonlySet<string>,
): boolean {
  return (
    !isUnresolvedSymbolId(edge.fromSymbolId) &&
    copyRelEndpointIsSafe(edge.fromSymbolId) &&
    (sameBatchSymbolIds.has(edge.fromSymbolId) ||
      knownPersistedSymbolIds.has(edge.fromSymbolId))
  );
}

function pass1TargetMeta(edge: EdgeRow): ReturnType<typeof classifyDependencyTarget> {
  return edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
}

function isPass1TargetRealNotKnown(
  edge: EdgeRow,
  sameBatchSymbolIds: ReadonlySet<string>,
  knownPersistedSymbolIds: ReadonlySet<string>,
): boolean {
  const targetMeta = pass1TargetMeta(edge);
  return (
    targetMeta.symbolStatus === "real" &&
    !sameBatchSymbolIds.has(edge.toSymbolId) &&
    !knownPersistedSymbolIds.has(edge.toSymbolId)
  );
}

function classifyPass1RepairCause(
  edge: EdgeRow,
  sameBatchSymbolIds: ReadonlySet<string>,
  knownPersistedSymbolIds: ReadonlySet<string>,
  belowThresholdKnownEdges: ReadonlySet<EdgeRow>,
): Pass1RepairCause {
  if (belowThresholdKnownEdges.has(edge)) {
    return "belowThresholdKnown";
  }
  if (isUnresolvedSymbolId(edge.fromSymbolId)) {
    return "unresolvedSource";
  }

  const unsafeSource = !copyRelEndpointIsSafe(edge.fromSymbolId);
  const unsafeTarget = !copyRelEndpointIsSafe(edge.toSymbolId);
  if (unsafeSource && unsafeTarget) {
    return "unsafeBoth";
  }
  if (unsafeSource) {
    return "unsafeSourceOnly";
  }
  if (unsafeTarget) {
    return "unsafeTargetOnly";
  }

  if (isPass1TargetRealNotKnown(edge, sameBatchSymbolIds, knownPersistedSymbolIds)) {
    return "targetRealNotKnown";
  }

  if (pass1TargetMeta(edge).symbolStatus !== "real") {
    return "targetUnresolvedOrPlaceholder";
  }

  return "other";
}

function addPass1RepairCause(
  stats: BatchPersistEdgeDiagnostics,
  cause: Pass1RepairCause,
): void {
  switch (cause) {
    case "belowThresholdKnown":
      stats.repairCauseBelowThresholdKnownEdges += 1;
      break;
    case "unresolvedSource":
      stats.repairCauseUnresolvedSourceEdges += 1;
      break;
    case "unsafeSourceOnly":
      stats.repairCauseSourceEndpointUnsafeOnlyEdges += 1;
      break;
    case "unsafeTargetOnly":
      stats.repairCauseTargetEndpointUnsafeOnlyEdges += 1;
      break;
    case "unsafeBoth":
      stats.repairCauseBothEndpointsUnsafeEdges += 1;
      break;
    case "targetRealNotKnown":
      stats.repairCauseTargetRealNotKnownEdges += 1;
      break;
    case "targetUnresolvedOrPlaceholder":
      stats.repairCauseTargetUnresolvedOrPlaceholderEdges += 1;
      break;
    case "other":
      stats.repairCauseOtherEdges += 1;
      break;
  }
}

function recordPass1RepairCauses(
  stats: BatchPersistEdgeDiagnostics,
  repairEdges: readonly EdgeRow[],
  sameBatchSymbolIds: ReadonlySet<string>,
  knownPersistedSymbolIds: ReadonlySet<string>,
  belowThresholdKnownEdges: ReadonlySet<EdgeRow>,
): void {
  for (const edge of repairEdges) {
    addPass1RepairCause(
      stats,
      classifyPass1RepairCause(
        edge,
        sameBatchSymbolIds,
        knownPersistedSymbolIds,
        belowThresholdKnownEdges,
      ),
    );

    const sourceKnown = isPass1SourceKnown(
      edge,
      sameBatchSymbolIds,
      knownPersistedSymbolIds,
    );
    if (sourceKnown) {
      stats.repairSourceKnownEdges += 1;
    } else {
      stats.repairSourceUnknownOrUnsafeEdges += 1;
    }

    const targetRealNotKnown = isPass1TargetRealNotKnown(
      edge,
      sameBatchSymbolIds,
      knownPersistedSymbolIds,
    );
    const targetUnsafe = !copyRelEndpointIsSafe(edge.toSymbolId);
    const targetUnresolvedOrPlaceholder = pass1TargetMeta(edge).symbolStatus !== "real";
    if (
      sourceKnown &&
      (belowThresholdKnownEdges.has(edge) ||
        targetRealNotKnown ||
        targetUnsafe ||
        targetUnresolvedOrPlaceholder)
    ) {
      stats.repairSourceKnownTargetOnlyEdges += 1;
    }
    if (sourceKnown && targetRealNotKnown) {
      stats.repairSourceKnownTargetRealNotKnownEdges += 1;
    }
    if (sourceKnown && targetUnsafe) {
      stats.repairSourceKnownTargetUnsafeEdges += 1;
    }
    if (sourceKnown && targetUnresolvedOrPlaceholder) {
      stats.repairSourceKnownTargetUnresolvedEdges += 1;
    }
  }
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
      copyRelEndpointIsSafe(edge.fromSymbolId) &&
      copyRelEndpointIsSafe(edge.toSymbolId) &&
      (sameBatchSymbolIds.has(edge.toSymbolId) ||
        knownPersistedSymbolIds.has(edge.toSymbolId) ||
        targetMeta.symbolStatus !== "real")
    ) {
      knownEndpointEdges.push(toPass1RepairCopyEdge(edge));
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
  private readonly autoDrain: boolean;

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
    this.autoDrain = options.autoDrain ?? true;
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
    this.files.push({
      file: {
        ...file,
        language: canonicalizeLanguageId(file.language, file.relPath),
      },
      existingFileId,
    });
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

    if (this.autoDrain) {
      this.ensureDraining();
    }
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

    const timePhase: BatchPersistTimePhase = (phase, rows, body) =>
      this.timeWritePhase(phase, rows, body, phaseMs);

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
    timePhase: BatchPersistTimePhase,
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
    timePhase: BatchPersistTimePhase,
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
        // Delete every incoming ID on the serialized writer. A separate
        // existence probe can become stale between fresh-copy flushes.
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
    txConn: LadybugConnection,
    batch: FlushBatch,
    timePhase: BatchPersistTimePhase,
  ): Promise<void> {
    await timePhase("insertEdges", batch.edges.length, async () => {
      const sameBatchSymbolIds = new Set(
        batch.symbols.map((symbol) => symbol.symbolId),
      );
      let splitEdges: {
        knownEndpointEdges: EdgeRow[];
        repairEdges: EdgeRow[];
      } = { knownEndpointEdges: [], repairEdges: [] };
      await timePhase(
        "insertEdges.split",
        batch.edges.length,
        async () => {
          splitEdges = splitPass1EdgesForKnownEndpointCopy(
            batch.edges,
            sameBatchSymbolIds,
            this.knownSymbolIdsForEdgeCopy,
          );
        },
      );
      const { knownEndpointEdges, repairEdges } = splitEdges;
      if (this.collectDiagnostics) {
        this.diagnostics.edgeStats.splitCalls += 1;
        this.diagnostics.edgeStats.totalEdges += batch.edges.length;
        this.diagnostics.edgeStats.knownEndpointEdges += knownEndpointEdges.length;
        this.diagnostics.edgeStats.initialRepairEdges += repairEdges.length;
      }

      const measureKnownEnsurePhase = async <T>(
        phaseName: DependencyTargetEnsurePhaseName,
        fn: () => Promise<T>,
      ): Promise<T> => {
        let result: T | undefined;
        await timePhase(
          `insertEdges.knownEnsure.${phaseName}` as BatchPersistWritePhase,
          knownEndpointEdges.length,
          async () => {
            result = await fn();
          },
        );
        return result as T;
      };

      const measureKnownCopyPhase = async <T>(
        phaseName: KnownSymbolEdgesCopyPhaseName,
        fn: () => Promise<T> | T,
      ): Promise<T> => {
        let result: T | undefined;
        await timePhase(
          `insertEdges.knownCopy.${phaseName}` as BatchPersistWritePhase,
          knownEndpointEdges.length,
          async () => {
            result = await fn();
          },
        );
        return result as T;
      };

      const measureRepairPhase = async <T>(
        phaseName: InsertEdgesPhaseName,
        rows: number,
        fn: () => Promise<T> | T,
      ): Promise<T> => {
        let result: T | undefined;
        await timePhase(
          `insertEdges.repair.${phaseName}` as BatchPersistWritePhase,
          rows,
          async () => {
            result = await fn();
          },
        );
        return result as T;
      };

      if (knownEndpointEdges.length >= PASS1_KNOWN_ENDPOINT_COPY_THRESHOLD) {
        if (this.collectDiagnostics) {
          this.diagnostics.edgeStats.knownCopyFlushes += 1;
          this.diagnostics.edgeStats.knownCopyEdges += knownEndpointEdges.length;
        }
        await timePhase(
          "insertEdges.knownEnsure",
          knownEndpointEdges.length,
          async () => {
            await ladybugDb.ensureDependencyTargetsForKnownSourceEdges(
              txConn,
              knownEndpointEdges,
              { measurePhase: measureKnownEnsurePhase },
            );
          },
        );
        await timePhase(
          "insertEdges.knownCopy",
          knownEndpointEdges.length,
          async () => {
            await ladybugDb.insertKnownSymbolEdges(txConn, knownEndpointEdges, {
              measurePhase: measureKnownCopyPhase,
            });
          },
        );
      } else if (knownEndpointEdges.length > 0) {
        if (this.collectDiagnostics) {
          this.diagnostics.edgeStats.belowThresholdKnownEdges +=
            knownEndpointEdges.length;
        }
        repairEdges.unshift(...knownEndpointEdges);
      }

      const belowThresholdKnownEdgeSet =
        knownEndpointEdges.length > 0 &&
        knownEndpointEdges.length < PASS1_KNOWN_ENDPOINT_COPY_THRESHOLD
          ? new Set<EdgeRow>(knownEndpointEdges)
          : new Set<EdgeRow>();

      if (this.collectDiagnostics && repairEdges.length > 0) {
        this.diagnostics.edgeStats.repairCalls += 1;
        this.diagnostics.edgeStats.repairEdges += repairEdges.length;
        recordPass1RepairCauses(
          this.diagnostics.edgeStats,
          repairEdges,
          sameBatchSymbolIds,
          this.knownSymbolIdsForEdgeCopy,
          belowThresholdKnownEdgeSet,
        );
      }
      await timePhase("insertEdges.repair", repairEdges.length, async () => {
        await ladybugDb.insertEdges(txConn, repairEdges, {
          skipSourceRepoLink: true,
          skipExistingRelationshipUpdate: true,
          measurePhase: async (phaseName, fn) =>
            measureRepairPhase(phaseName, repairEdges.length, fn),
        });
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

  private async timeWritePhase(
    phase: BatchPersistWritePhase,
    rows: number,
    body: () => Promise<void>,
    phaseMs?: Record<BatchPersistWritePhase, number>,
  ): Promise<void> {
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
      if (phaseMs) phaseMs[phase] += durationMs;
      if (this.collectDiagnostics) {
        const target = this.diagnostics.phases[phase];
        target.count += 1;
        target.rows += rows;
        target.totalMs += durationMs;
        target.maxMs = Math.max(target.maxMs, durationMs);
      }
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
