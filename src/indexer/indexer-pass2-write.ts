import type {
  CallResolutionTelemetry,
  SymbolIndex,
} from "./edge-builder.js";
import {
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
} from "./edge-builder.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { withWriteConn } from "../db/ladybug.js";
import { classifyDependencyTarget } from "../db/symbol-placeholders.js";
import type { LadybugConn } from "./indexer-init.js";
import type { SubmitEdgeWrite } from "./pass2/types.js";

const PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD = 512;
export const DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES = 8_192;
const PASS2_SEQUENTIAL_WRITE_BATCH_FILES = 256;
const PASS2_SEQUENTIAL_WRITE_BATCH_EDGES = 32_768;

/** @internal exported for benchmark tuning tests; do not import from product code. */
export function resolvePass2KnownEndpointCopyBufferMaxEdges(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SDL_MCP_PASS2_COPY_BUFFER_MAX_EDGES?.trim();
  if (!raw) return DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD
  ) {
    return DEFAULT_PASS2_KNOWN_ENDPOINT_COPY_BUFFER_MAX_EDGES;
  }
  return parsed;
}

/**
 * Build a `submitEdgeWrite` that flushes immediately on each call. Kept for
 * focused tests and any direct call sites that need explicit one-shot writes;
 * the normal pass-2 dispatcher uses a coalescing accumulator even when resolver
 * execution is sequential.
 */
/** @internal exported for tests; do not import from product code. */
export function makeImmediateSubmit(
  mode: "full" | "incremental",
  writeStats?: Pass2WriteStats,
): SubmitEdgeWrite {
  return async ({ symbolIdsToRefresh, edges }) => {
    if (!hasPass2WriteWork(symbolIdsToRefresh, edges, mode)) return;
    await withWriteConn(async (wConn) => {
      if (mode !== "full" && symbolIdsToRefresh.length > 0) {
        await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
          wConn,
          symbolIdsToRefresh,
          "call",
        );
      }
      if (edges.length > 0) {
        await insertPass2Edges(
          wConn,
          edges,
          mode,
          writeStats,
        );
      }
    });
  };
}

export interface BatchWriteAccumulator {
  symbolIdsToRefresh: string[];
  edges: ladybugDb.EdgeRow[];
}

export interface Pass2SmallKnownEndpointBuffer {
  edges: ladybugDb.EdgeRow[];
}

export interface Pass2WriteFlushResult {
  persistedEdges: number;
  deferredEdges: number;
  flushedBufferedEdges: number;
}

export interface BatchWriteFlushLimits {
  maxFiles: number;
  maxEdges: number;
}

export interface SequentialPass2TelemetryCredit {
  resolverId: string;
  edgesCreated: number;
  elapsedMs: number;
}

export function onlyZeroEdgeSequentialCredits(
  credits: readonly SequentialPass2TelemetryCredit[],
): boolean {
  return (
    credits.length > 0 &&
    credits.every((credit) => credit.edgesCreated === 0)
  );
}

export interface Pass2WriteStats {
  flushes: number;
  totalEdges: number;
  incrementalEdges: number;
  knownEndpointEdges: number;
  repairEdges: number;
  copyFlushes: number;
  copyEdges: number;
  copyPlaceholderTargets: number;
  copyPlaceholderRows: number;
  copyEnsuredPlaceholderRows: number;
  copySkippedPlaceholderRows: number;
  copyUnresolvedPlaceholderRows: number;
  copyExternalPlaceholderRows: number;
  copyEnsureMs: number;
  copyEnsureSymbolMetadataMs: number;
  copyEnsureSymbolProbeMs: number;
  copyEnsureSymbolCopyMissingCsvMs: number;
  copyEnsureSymbolCopyMissingFromMs: number;
  copyEnsureSymbolMatchExistingMs: number;
  copyEnsureSymbolMergeFallbackMs: number;
  copyEnsureRepoLinkMs: number;
  copyInsertMs: number;
  copyInsertTxnBeginMs: number;
  copyInsertTxnBodyMs: number;
  copyInsertTxnCommitMs: number;
  copyInsertCsvMaterializeMs: number;
  copyInsertCopyFromMs: number;
  copyInsertTempCleanupMs: number;
  smallKnownEndpointFlushes: number;
  smallKnownEndpointEdges: number;
  repairPrepareRowsMs: number;
  repairSourceRepoLinkSymbolMetadataMs: number;
  repairSourceRepoLinkRepoLinkMs: number;
  repairEndpointMetadataMs: number;
  repairTargetMetadataMs: number;
  repairTargetRepoLinkMs: number;
  repairRelationshipCreateMs: number;
  repairRelationshipUpdateMs: number;
  repairUnresolvedSourceEdges: number;
  repairUnsafeSourceEndpointEdges: number;
  repairUnsafeTargetEndpointEdges: number;
  repairUnsafeBothEndpointEdges: number;
  repairOtherCauseEdges: number;
  repairFlushes: number;
  repairInsertEdges: number;
  repairInsertMs: number;
}

/** @internal exported for tests; do not import from product code. */
export function createPass2WriteStats(): Pass2WriteStats {
  return {
    flushes: 0,
    totalEdges: 0,
    incrementalEdges: 0,
    knownEndpointEdges: 0,
    repairEdges: 0,
    copyFlushes: 0,
    copyEdges: 0,
    copyPlaceholderTargets: 0,
    copyPlaceholderRows: 0,
    copyEnsuredPlaceholderRows: 0,
    copySkippedPlaceholderRows: 0,
    copyUnresolvedPlaceholderRows: 0,
    copyExternalPlaceholderRows: 0,
    copyEnsureMs: 0,
    copyEnsureSymbolMetadataMs: 0,
    copyEnsureSymbolProbeMs: 0,
    copyEnsureSymbolCopyMissingCsvMs: 0,
    copyEnsureSymbolCopyMissingFromMs: 0,
    copyEnsureSymbolMatchExistingMs: 0,
    copyEnsureSymbolMergeFallbackMs: 0,
    copyEnsureRepoLinkMs: 0,
    copyInsertMs: 0,
    copyInsertTxnBeginMs: 0,
    copyInsertTxnBodyMs: 0,
    copyInsertTxnCommitMs: 0,
    copyInsertCsvMaterializeMs: 0,
    copyInsertCopyFromMs: 0,
    copyInsertTempCleanupMs: 0,
    smallKnownEndpointFlushes: 0,
    smallKnownEndpointEdges: 0,
    repairPrepareRowsMs: 0,
    repairSourceRepoLinkSymbolMetadataMs: 0,
    repairSourceRepoLinkRepoLinkMs: 0,
    repairEndpointMetadataMs: 0,
    repairTargetMetadataMs: 0,
    repairTargetRepoLinkMs: 0,
    repairRelationshipCreateMs: 0,
    repairRelationshipUpdateMs: 0,
    repairUnresolvedSourceEdges: 0,
    repairUnsafeSourceEndpointEdges: 0,
    repairUnsafeTargetEndpointEdges: 0,
    repairUnsafeBothEndpointEdges: 0,
    repairOtherCauseEdges: 0,
    repairFlushes: 0,
    repairInsertEdges: 0,
    repairInsertMs: 0,
  };
}

const pass2EnsuredPlaceholderTargets = new WeakMap<Pass2WriteStats, Set<string>>();

export function emptyPass2WriteFlushResult(): Pass2WriteFlushResult {
  return { persistedEdges: 0, deferredEdges: 0, flushedBufferedEdges: 0 };
}

function hasPass2WriteWork(
  symbolIdsToRefresh: readonly string[],
  edges: readonly ladybugDb.EdgeRow[],
  mode: "full" | "incremental",
): boolean {
  return (
    edges.length > 0 || (mode !== "full" && symbolIdsToRefresh.length > 0)
  );
}

function isUnresolvedSymbolId(symbolId: string): boolean {
  return symbolId.startsWith("unresolved:");
}

function copyRelEndpointIsSafe(value: string): boolean {
  // LadybugDB relationship COPY resolves endpoints by primary-key literal.
  // Comma-bearing endpoint ids require CSV quoting, but relationship COPY can
  // misparse quoted endpoint cells and shift later relationship properties.
  return !/[",\r\n]/.test(value);
}

function sanitizeRelationshipCopyCell(value: string): string {
  // Relationship COPY in LadybugDB 0.16.0 can reject correctly quoted
  // relationship-property cells. Keep the fast path by making diagnostic
  // provenance readable but delimiter-free before COPY.
  return value.replace(/[",\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** @internal exported for tests; do not import from product code. */
export function toPass2KnownEndpointCopyEdge(
  edge: ladybugDb.EdgeRow,
): ladybugDb.EdgeRow {
  if (typeof edge.provenance !== "string") return edge;
  const provenance = sanitizeRelationshipCopyCell(edge.provenance);
  if (provenance === edge.provenance) return edge;
  return { ...edge, provenance };
}

function isPass2KnownEndpointCopyCandidate(edge: ladybugDb.EdgeRow): boolean {
  return (
    copyRelEndpointIsSafe(edge.fromSymbolId) &&
    copyRelEndpointIsSafe(edge.toSymbolId)
  );
}

/**
 * Full pass-2 runs after the source file's Symbol rows have been replaced.
 * Copy-safe call edges can therefore use the relationship COPY path. Safe
 * unresolved targets are bulk-repaired before COPY instead of forcing every
 * unresolved edge through the generic relationship writer.
 * Known-endpoint provenance is sanitized before COPY because LadybugDB
 * relationship COPY can reject quoted relationship-property cells even when
 * the CSV writer escapes them correctly.
 */
/** @internal exported for tests; do not import from product code. */
export function splitPass2EdgesForFullMode(
  edges: readonly ladybugDb.EdgeRow[],
): {
  knownEndpointEdges: ladybugDb.EdgeRow[];
  repairEdges: ladybugDb.EdgeRow[];
} {
  const knownEndpointEdges: ladybugDb.EdgeRow[] = [];
  const repairEdges: ladybugDb.EdgeRow[] = [];

  for (const edge of edges) {
    if (
      isUnresolvedSymbolId(edge.fromSymbolId) ||
      !isPass2KnownEndpointCopyCandidate(edge)
    ) {
      repairEdges.push(edge);
    } else {
      knownEndpointEdges.push(toPass2KnownEndpointCopyEdge(edge));
    }
  }

  return { knownEndpointEdges, repairEdges };
}

/** @internal exported for tests; do not import from product code. */
export async function insertPass2Edges(
  wConn: LadybugConn,
  edges: ladybugDb.EdgeRow[],
  mode: "full" | "incremental",
  writeStats?: Pass2WriteStats,
  smallKnownEndpointBuffer?: Pass2SmallKnownEndpointBuffer,
): Promise<Pass2WriteFlushResult> {
  if (edges.length === 0) return emptyPass2WriteFlushResult();
  if (writeStats) {
    writeStats.flushes++;
    writeStats.totalEdges += edges.length;
  }

  if (mode !== "full") {
    if (writeStats) writeStats.incrementalEdges += edges.length;
    const startedAt = Date.now();
    await ladybugDb.insertEdges(wConn, edges);
    if (writeStats) writeStats.repairInsertMs += Date.now() - startedAt;
    return {
      persistedEdges: edges.length,
      deferredEdges: 0,
      flushedBufferedEdges: 0,
    };
  }

  const { knownEndpointEdges, repairEdges } =
    splitPass2EdgesForFullMode(edges);
  let persistedEdges = 0;
  let deferredEdges = 0;
  let flushedBufferedEdges = 0;
  if (writeStats) {
    writeStats.knownEndpointEdges += knownEndpointEdges.length;
    writeStats.repairEdges += repairEdges.length;
    recordRepairCauseStats(writeStats, repairEdges);
  }

  if (
    smallKnownEndpointBuffer &&
    repairEdges.length > 0 &&
    smallKnownEndpointBuffer.edges.length > 0
  ) {
    const bufferedEdges = smallKnownEndpointBuffer.edges.splice(0);
    if (bufferedEdges.length >= PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD) {
      await insertPass2KnownEndpointCopyEdges(
        wConn,
        bufferedEdges,
        writeStats,
      );
      persistedEdges += bufferedEdges.length;
      flushedBufferedEdges += bufferedEdges.length;
    } else {
      repairEdges.unshift(...bufferedEdges);
    }
  }

  if (knownEndpointEdges.length > 0) {
    if (knownEndpointEdges.length < PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD) {
      if (writeStats) {
        writeStats.smallKnownEndpointFlushes++;
        writeStats.smallKnownEndpointEdges += knownEndpointEdges.length;
      }
    }
    if (smallKnownEndpointBuffer && repairEdges.length === 0) {
      smallKnownEndpointBuffer.edges.push(...knownEndpointEdges);
      if (
        smallKnownEndpointBuffer.edges.length >=
          resolvePass2KnownEndpointCopyBufferMaxEdges()
      ) {
        const bufferedEdges = smallKnownEndpointBuffer.edges.splice(0);
        await insertPass2KnownEndpointCopyEdges(
          wConn,
          bufferedEdges,
          writeStats,
        );
        persistedEdges += bufferedEdges.length;
        flushedBufferedEdges += bufferedEdges.length;
      } else {
        deferredEdges += knownEndpointEdges.length;
      }
    } else if (
      knownEndpointEdges.length >= PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD
    ) {
      await insertPass2KnownEndpointCopyEdges(
        wConn,
        knownEndpointEdges,
        writeStats,
      );
      persistedEdges += knownEndpointEdges.length;
    } else {
      repairEdges.unshift(...knownEndpointEdges);
    }
  }
  if (repairEdges.length > 0) {
    await insertPass2RepairEdges(wConn, repairEdges, writeStats);
    persistedEdges += repairEdges.length;
  }
  return { persistedEdges, deferredEdges, flushedBufferedEdges };
}

async function insertPass2RepairEdges(
  wConn: LadybugConn,
  repairEdges: ladybugDb.EdgeRow[],
  writeStats?: Pass2WriteStats,
): Promise<void> {
  if (repairEdges.length === 0) return;
  if (writeStats) {
    writeStats.repairFlushes++;
    writeStats.repairInsertEdges += repairEdges.length;
  }
  const startedAt = Date.now();
  await ladybugDb.insertEdges(wConn, repairEdges, {
    skipSourceRepoLink: true,
    skipExistingRelationshipUpdate: true,
    skipExistingRelationshipProbe: true,
    measurePhase: writeStats
      ? async (phaseName, fn) => {
          const phaseStartedAt = Date.now();
          try {
            return await fn();
          } finally {
            recordRepairInsertPhaseMs(
              writeStats,
              phaseName,
              Date.now() - phaseStartedAt,
            );
          }
        }
      : undefined,
  });
  if (writeStats) writeStats.repairInsertMs += Date.now() - startedAt;
  markRepairPlaceholderTargetsEnsured(writeStats, repairEdges);
}

function recordRepairInsertPhaseMs(
  writeStats: Pass2WriteStats,
  phaseName: ladybugDb.InsertEdgesPhaseName,
  elapsedMs: number,
): void {
  switch (phaseName) {
    case "prepareRows":
      writeStats.repairPrepareRowsMs += elapsedMs;
      break;
    case "sourceRepoLink.symbolMetadata":
      writeStats.repairSourceRepoLinkSymbolMetadataMs += elapsedMs;
      break;
    case "sourceRepoLink.repoLink":
      writeStats.repairSourceRepoLinkRepoLinkMs += elapsedMs;
      break;
    case "endpointMetadata":
      writeStats.repairEndpointMetadataMs += elapsedMs;
      break;
    case "targetMetadata":
      writeStats.repairTargetMetadataMs += elapsedMs;
      break;
    case "targetRepoLink":
      writeStats.repairTargetRepoLinkMs += elapsedMs;
      break;
    case "relationshipCreate":
      writeStats.repairRelationshipCreateMs += elapsedMs;
      break;
    case "relationshipUpdate":
      writeStats.repairRelationshipUpdateMs += elapsedMs;
      break;
    case "dedupe":
    case "groupByRepo":
      break;
  }
}

async function insertPass2KnownEndpointCopyEdges(
  wConn: LadybugConn,
  knownEndpointEdges: ladybugDb.EdgeRow[],
  writeStats?: Pass2WriteStats,
): Promise<void> {
  if (knownEndpointEdges.length === 0) return;
  if (writeStats) {
    writeStats.copyFlushes++;
    writeStats.copyEdges += knownEndpointEdges.length;
  }
  const placeholderRepair =
    writeStats === undefined
      ? { edgesToEnsure: knownEndpointEdges, targetIdsToMark: [] }
      : selectUnensuredPlaceholderTargets(writeStats, knownEndpointEdges);
  let startedAt = Date.now();
  await ladybugDb.ensureDependencyTargetsForKnownSourceEdges(
    wConn,
    placeholderRepair.edgesToEnsure,
    writeStats
      ? {
          measurePhase: async (phaseName, fn) => {
            const phaseStartedAt = Date.now();
            try {
              return await fn();
            } finally {
              const elapsedMs = Date.now() - phaseStartedAt;
              if (phaseName === "symbolMetadata") {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
              } else if (phaseName === "repoLink") {
                writeStats.copyEnsureRepoLinkMs += elapsedMs;
              } else if (phaseName === "symbolMetadata.probeExisting") {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
                writeStats.copyEnsureSymbolProbeMs += elapsedMs;
              } else if (
                phaseName === "symbolMetadata.copyMissing.csvMaterialize"
              ) {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
                writeStats.copyEnsureSymbolCopyMissingCsvMs += elapsedMs;
              } else if (phaseName === "symbolMetadata.copyMissing.copyFrom") {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
                writeStats.copyEnsureSymbolCopyMissingFromMs += elapsedMs;
              } else if (phaseName === "symbolMetadata.matchExisting") {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
                writeStats.copyEnsureSymbolMatchExistingMs += elapsedMs;
              } else {
                writeStats.copyEnsureSymbolMetadataMs += elapsedMs;
                writeStats.copyEnsureSymbolMergeFallbackMs += elapsedMs;
              }
            }
          },
        }
      : undefined,
  );
  if (writeStats && placeholderRepair.targetIdsToMark.length > 0) {
    const ensuredTargets = getEnsuredPlaceholderTargets(writeStats);
    for (const targetId of placeholderRepair.targetIdsToMark) {
      ensuredTargets.add(targetId);
    }
  }
  if (writeStats) writeStats.copyEnsureMs += Date.now() - startedAt;
  startedAt = Date.now();
  let copyInsertTempCleanupThisCallMs = 0;
  await ladybugDb.insertKnownSymbolEdges(
    wConn,
    knownEndpointEdges,
    writeStats
      ? {
          measurePhase: async (phaseName, fn) => {
            const phaseStartedAt = Date.now();
            try {
              return await fn();
            } finally {
              const elapsedMs = Date.now() - phaseStartedAt;
              if (phaseName === "txnBegin") {
                writeStats.copyInsertTxnBeginMs += elapsedMs;
              } else if (phaseName === "txnBody") {
                writeStats.copyInsertTxnBodyMs += Math.max(
                  0,
                  elapsedMs - copyInsertTempCleanupThisCallMs,
                );
              } else if (phaseName === "txnCommit") {
                writeStats.copyInsertTxnCommitMs += elapsedMs;
              } else if (phaseName === "csvMaterialize") {
                writeStats.copyInsertCsvMaterializeMs += elapsedMs;
              } else if (phaseName === "copyFrom") {
                writeStats.copyInsertCopyFromMs += elapsedMs;
              } else {
                copyInsertTempCleanupThisCallMs += elapsedMs;
                writeStats.copyInsertTempCleanupMs += elapsedMs;
              }
            }
          },
        }
      : undefined,
  );
  if (writeStats) writeStats.copyInsertMs += Date.now() - startedAt;
}

function recordRepairCauseStats(
  writeStats: Pass2WriteStats,
  edges: readonly ladybugDb.EdgeRow[],
): void {
  for (const edge of edges) {
    if (isUnresolvedSymbolId(edge.fromSymbolId)) {
      writeStats.repairUnresolvedSourceEdges++;
      continue;
    }
    const unsafeSource = !copyRelEndpointIsSafe(edge.fromSymbolId);
    const unsafeTarget = !copyRelEndpointIsSafe(edge.toSymbolId);
    if (unsafeSource && unsafeTarget) {
      writeStats.repairUnsafeBothEndpointEdges++;
    } else if (unsafeSource) {
      writeStats.repairUnsafeSourceEndpointEdges++;
    } else if (unsafeTarget) {
      writeStats.repairUnsafeTargetEndpointEdges++;
    } else {
      writeStats.repairOtherCauseEdges++;
    }
  }
}

function getEnsuredPlaceholderTargets(writeStats: Pass2WriteStats): Set<string> {
  let targetIds = pass2EnsuredPlaceholderTargets.get(writeStats);
  if (!targetIds) {
    targetIds = new Set();
    pass2EnsuredPlaceholderTargets.set(writeStats, targetIds);
  }
  return targetIds;
}

function markRepairPlaceholderTargetsEnsured(
  writeStats: Pass2WriteStats | undefined,
  edges: readonly ladybugDb.EdgeRow[],
): void {
  if (!writeStats || edges.length === 0) return;
  const ensuredTargets = getEnsuredPlaceholderTargets(writeStats);
  for (const edge of edges) {
    const targetMeta = edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
    if (targetMeta.symbolStatus !== "real") {
      ensuredTargets.add(edge.toSymbolId);
    }
  }
}

function selectUnensuredPlaceholderTargets(
  writeStats: Pass2WriteStats,
  edges: readonly ladybugDb.EdgeRow[],
): { edgesToEnsure: ladybugDb.EdgeRow[]; targetIdsToMark: string[] } {
  const rowsBySymbolId = new Map<
    string,
    {
      edge: ladybugDb.EdgeRow;
      meta: ReturnType<typeof classifyDependencyTarget>;
    }
  >();
  for (const edge of edges) {
    const meta = edge.targetMeta ?? classifyDependencyTarget(edge.toSymbolId);
    if (meta.symbolStatus === "real") continue;
    writeStats.copyPlaceholderTargets++;
    if (!rowsBySymbolId.has(edge.toSymbolId)) {
      rowsBySymbolId.set(edge.toSymbolId, { edge, meta });
    }
  }

  writeStats.copyPlaceholderRows += rowsBySymbolId.size;
  const ensuredTargets = getEnsuredPlaceholderTargets(writeStats);
  const edgesToEnsure: ladybugDb.EdgeRow[] = [];
  const targetIdsToMark: string[] = [];
  for (const [targetId, { edge, meta }] of rowsBySymbolId) {
    if (meta.symbolStatus === "unresolved") {
      writeStats.copyUnresolvedPlaceholderRows++;
    } else if (meta.symbolStatus === "external") {
      writeStats.copyExternalPlaceholderRows++;
    }
    if (ensuredTargets.has(targetId)) {
      writeStats.copySkippedPlaceholderRows++;
      continue;
    }
    writeStats.copyEnsuredPlaceholderRows++;
    edgesToEnsure.push(edge);
    targetIdsToMark.push(targetId);
  }
  return { edgesToEnsure, targetIdsToMark };
}

/**
 * Build a `submitEdgeWrite` that defers the write into a shared accumulator.
 * Used by the parallel pass-2 dispatch path so all files in one concurrency
 * batch issue a single combined `withWriteConn`. The accumulator is mutated
 * synchronously from each resolver's submit call — JS event-loop semantics
 * guarantee no torn writes between the `.push(...)` calls in concurrent
 * closures.
 */
/** @internal exported for tests; do not import from product code. */
export function makeBatchAccumulator(): {
  acc: BatchWriteAccumulator;
  submit: SubmitEdgeWrite;
} {
  const acc: BatchWriteAccumulator = { symbolIdsToRefresh: [], edges: [] };
  const submit: SubmitEdgeWrite = ({ symbolIdsToRefresh, edges }) => {
    if (symbolIdsToRefresh.length > 0) {
      acc.symbolIdsToRefresh.push(...symbolIdsToRefresh);
    }
    if (edges.length > 0) {
      acc.edges.push(...edges);
    }
  };
  return { acc, submit };
}

/** @internal exported for tests; do not import from product code. */
export function shouldFlushBatchAccumulator(
  acc: BatchWriteAccumulator,
  filesSinceFlush: number,
  limits: BatchWriteFlushLimits = {
    maxFiles: PASS2_SEQUENTIAL_WRITE_BATCH_FILES,
    maxEdges: PASS2_SEQUENTIAL_WRITE_BATCH_EDGES,
  },
): boolean {
  if (acc.symbolIdsToRefresh.length === 0 && acc.edges.length === 0) {
    return false;
  }
  return (
    filesSinceFlush >= limits.maxFiles || acc.edges.length >= limits.maxEdges
  );
}

function resetBatchAccumulator(acc: BatchWriteAccumulator): void {
  acc.symbolIdsToRefresh.length = 0;
  acc.edges.length = 0;
}

export function recordSequentialPass2TelemetryBatch(
  callResolutionTelemetry: CallResolutionTelemetry,
  resolverCredits: readonly SequentialPass2TelemetryCredit[],
  filesProcessed: number,
): void {
  callResolutionTelemetry.pass2FilesProcessed += filesProcessed;
  for (const credit of resolverCredits) {
    recordPass2ResolverTarget(callResolutionTelemetry, credit.resolverId);
    recordPass2ResolverResult(callResolutionTelemetry, credit.resolverId, {
      edgesCreated: credit.edgesCreated,
      elapsedMs: credit.elapsedMs,
    });
  }
}

export function hasExistingPass2SourceSymbols(
  symbolIndex: SymbolIndex,
  relPath: string,
): boolean {
  return (symbolIndex.get(relPath)?.size ?? 0) > 0;
}

export async function drainBatchAccumulator(
  acc: BatchWriteAccumulator,
  mode: "full" | "incremental",
  writeStats?: Pass2WriteStats,
  smallKnownEndpointBuffer?: Pass2SmallKnownEndpointBuffer,
): Promise<Pass2WriteFlushResult> {
  const result = await flushBatchAccumulator(
    acc,
    mode,
    writeStats,
    smallKnownEndpointBuffer,
  );
  resetBatchAccumulator(acc);
  return result;
}

/** @internal exported for tests; do not import from product code. */
export async function flushBatchAccumulator(
  acc: BatchWriteAccumulator,
  mode: "full" | "incremental",
  writeStats?: Pass2WriteStats,
  smallKnownEndpointBuffer?: Pass2SmallKnownEndpointBuffer,
): Promise<Pass2WriteFlushResult> {
  if (!hasPass2WriteWork(acc.symbolIdsToRefresh, acc.edges, mode)) {
    return emptyPass2WriteFlushResult();
  }
  const deferred = tryDeferSmallKnownEndpointEdges(
    acc,
    mode,
    writeStats,
    smallKnownEndpointBuffer,
  );
  if (deferred) return deferred;

  let result = emptyPass2WriteFlushResult();
  await withWriteConn(async (wConn) => {
    if (mode !== "full" && acc.symbolIdsToRefresh.length > 0) {
      await ladybugDb.deleteOutgoingEdgesByTypeForSymbols(
        wConn,
        acc.symbolIdsToRefresh,
        "call",
      );
    }
    if (acc.edges.length > 0) {
      result = await insertPass2Edges(
        wConn,
        acc.edges,
        mode,
        writeStats,
        smallKnownEndpointBuffer,
      );
    }
  });
  return result;
}

function tryDeferSmallKnownEndpointEdges(
  acc: BatchWriteAccumulator,
  mode: "full" | "incremental",
  writeStats: Pass2WriteStats | undefined,
  smallKnownEndpointBuffer: Pass2SmallKnownEndpointBuffer | undefined,
): Pass2WriteFlushResult | null {
  if (
    mode !== "full" ||
    !smallKnownEndpointBuffer ||
    acc.edges.length === 0
  ) {
    return null;
  }
  const { knownEndpointEdges, repairEdges } =
    splitPass2EdgesForFullMode(acc.edges);
  if (
    repairEdges.length > 0 ||
    knownEndpointEdges.length === 0 ||
    smallKnownEndpointBuffer.edges.length + knownEndpointEdges.length >=
      resolvePass2KnownEndpointCopyBufferMaxEdges()
  ) {
    return null;
  }
  if (writeStats) {
    writeStats.flushes++;
    writeStats.totalEdges += acc.edges.length;
    writeStats.knownEndpointEdges += knownEndpointEdges.length;
    writeStats.repairEdges += repairEdges.length;
    if (knownEndpointEdges.length < PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD) {
      writeStats.smallKnownEndpointFlushes++;
      writeStats.smallKnownEndpointEdges += knownEndpointEdges.length;
    }
  }
  smallKnownEndpointBuffer.edges.push(...knownEndpointEdges);
  return {
    persistedEdges: 0,
    deferredEdges: knownEndpointEdges.length,
    flushedBufferedEdges: 0,
  };
}

export async function flushSmallKnownEndpointBufferFinal(
  buffer: Pass2SmallKnownEndpointBuffer,
  writeStats?: Pass2WriteStats,
): Promise<Pass2WriteFlushResult> {
  if (buffer.edges.length === 0) return emptyPass2WriteFlushResult();
  const bufferedEdges = buffer.edges.splice(0);
  await withWriteConn(async (wConn) => {
    if (bufferedEdges.length >= PASS2_KNOWN_ENDPOINT_COPY_THRESHOLD) {
      await insertPass2KnownEndpointCopyEdges(
        wConn,
        bufferedEdges,
        writeStats,
      );
    } else {
      await insertPass2RepairEdges(wConn, bufferedEdges, writeStats);
    }
  });
  return {
    persistedEdges: bufferedEdges.length,
    deferredEdges: 0,
    flushedBufferedEdges: bufferedEdges.length,
  };
}
