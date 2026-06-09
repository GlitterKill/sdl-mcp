import type {
  CallResolutionTelemetry,
  PendingCallEdge,
  SymbolIndex,
} from "./edge-builder.js";
// Repository indexing entry point and watcher orchestrator. Heavy work stays in
// sibling modules; this file sequences scans, pass1/pass2, finalization, and
// watcher delegation.

import {
  createCallResolutionTelemetry,
  isTsCallResolutionFile,
  resolveUnresolvedImportEdges,
} from "./edge-builder.js";
import { resolveParserWorkerPoolSize } from "./parser.js";
import { scanRepoForIndex, type ScanRepoForIndexResult } from "./scanner.js";
import {
  buildPreloadedFileSummarySymbolFactsFromRows,
  finalizeIndexing,
  materializeFileSummaries,
  type SummaryBatchResult,
} from "./metrics-updater.js";
import { finalizeDerivedState } from "./finalize-derived-state.js";
import type { AlgorithmRefreshDiagnostics } from "./cluster-orchestrator.js";
import { watchRepositoryWithIndexer } from "./watcher.js";
import {
  IndexingConfigSchema,
  type AppConfig,
  type RepoConfig,
} from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import {
  buildDeferredIndexes,
  closeLadybugDb,
  flushStaleFinalizers,
  getLadybugConn,
  getLadybugDbPath,
  initLadybugDb,
  preIndexCheckpoint,
  withWriteConn,
} from "../db/ladybug.js";
import { withPostIndexWriteSession } from "../db/write-session.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  derivedStateIsStale,
  getDerivedState,
  markDerivedStateDirty,
  recordDerivedStateError,
} from "../db/ladybug-derived-state.js";
import { logger } from "../util/logger.js";
import { hashValue } from "../util/hashing.js";
import { normalizePath } from "../util/paths.js";
import { flushIndexEvent } from "../mcp/telemetry.js";
import { getObservabilityTap } from "../observability/event-tap.js";
import { isRustEngineAvailable } from "./rustIndexer.js";
import {
  clearTsCallResolverCache,
  createLazyTsCallResolver,
} from "./ts/tsParser.js";
import { ParserWorkerPool } from "./workerPool.js";
import { invalidateGraphSnapshot } from "../graph/graphSnapshotCache.js";
import { recoverMissingMetricsForRepo } from "../graph/metrics-recovery.js";
import { clearSliceCache } from "../graph/sliceCache.js";
import { clearOverviewCache } from "../graph/overview.js";
import { clearFingerprintCollisionLog } from "./fingerprints.js";
import {
  loadExistingSymbolMaps,
  initPass2Context,
  type IndexProgress,
  type IndexProgressSubstage,
  type Pass1Accumulator,
  type Pass1Params,
} from "./indexer-init.js";
import {
  createVersionAndSnapshot,
  snapshotCurrentSymbolsForVersion,
} from "./indexer-version.js";
import {
  runPass1WithRustEngine,
  runPass1WithTsEngine,
} from "./indexer-pass1.js";
import {
  buildPreloadedPass2ExportedSymbolsFromRows,
  runPass2Resolvers,
  finalizeEdges,
} from "./indexer-pass2.js";
import {
  applySymbolMapFileUpdates,
  clearSymbolMapCache,
  syncSymbolIndexFromCache,
} from "./symbol-map-cache.js";
import {
  flagStaleMemoriesForChangedFiles,
  importMemoryFilesFromDisk,
} from "./indexer-memory.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import {
  isInToolDispatch,
  runToolDispatch,
  waitForToolDispatchIdle,
} from "../mcp/dispatch-limiter.js";
import {
  runScipIngestInsideIndex,
  scipIngestWillRun,
} from "../scip/ingestion.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
} from "../scip/diagnostics.js";
import type { ScipGeneratorCacheDiagnostic } from "../scip/scip-io-runner.js";
import type { BatchPersistDrainDiagnostics } from "./parser/batch-persist.js";
import {
  executeProviderFirstScipFull,
  resolveProviderFirstExecutionPlan,
  type ProviderFirstCoverageSummary,
  type ProviderFirstExecutionSummary,
  type ProviderFirstProviderUnusableReasonCode,
} from "./provider-first/executor.js";
import {
  materializeProviderFacts,
  providerFirstGraphRowTotal,
  type MaterializeProviderFactsPhaseName,
  type ProviderFirstGraphRows,
} from "./provider-first/materializer.js";
import {
  collectLegacyFallbackShadowRows,
  mergeProviderFirstGraphRows,
} from "./provider-first/legacy-shadow-rows.js";
import { resolveProviderFirstPipeline } from "./provider-first/planner.js";
import { ProviderFirstGraphValidationError } from "./provider-first/graph-validation.js";
import {
  stageProviderFirstShadowBuild,
  type ProviderFirstShadowBuildSummary,
} from "./provider-first/shadow-build.js";
import {
  activateProviderFirstShadowDbWithHandoff,
  summarizeProviderFirstShadowActivationReadiness,
} from "./provider-first/shadow-activation.js";
import { finalizeProviderFirstShadowDb } from "./provider-first/shadow-finalization.js";
import {
  expandIdentifierText,
  hasInvocationCandidateAfterMismatch,
  isIdentifierContinue,
  isProvenClangLocationOnlyMacroReference,
  truncateCallProofSampleText,
} from "./provider-first/source-call-proof.js";
import {
  importAliasSourceTextCandidates,
  PROVIDER_FIRST_OCCURRENCE_FACT_RETENTION_LIMIT,
  sourceTextCandidatesForScipSymbol,
  type SourceLinesByPath,
} from "./provider-first/scip-normalizer.js";
import {
  isCppSemanticScanPath,
  providerPathCanBeIgnoredOutsideScanScope,
  resolveProviderFirstSemanticEligiblePaths,
} from "./provider-first/semantic-scope.js";
import type {
  CallProofUnavailableReasonCode,
  CallProofUnavailableReasonSampleFact,
  CallProofUnavailableSampleFact,
  CoverageLevel,
  ProviderFactSet,
  ProviderFirstPipelineSelection,
} from "./provider-first/types.js";
export type { IndexProgress, IndexProgressSubstage } from "./indexer-init.js";
export { resolveProviderFirstSemanticEligiblePaths } from "./provider-first/semantic-scope.js";
const CALL_PROOF_SUMMARY_SAMPLE_LIMIT = 5;
const PROVIDER_FIRST_COVERAGE_SAMPLE_SOURCE_PATH_LIMIT = 5_000;
const PROVIDER_FIRST_ACTIVE_STALE_DELETE_SYMBOL_LIMIT = 50_000;
const PROVIDER_FIRST_ACTIVE_INPUT_RECORD_PATH =
  "__providerFirstActiveScipInput__";
const PROVIDER_FIRST_ACTIVE_INPUT_FINGERPRINT_VERSION = 1;

function snapshotPass2ResolverBreakdown(
  telemetry: CallResolutionTelemetry,
): CallResolutionTelemetry["resolverBreakdown"] | undefined {
  const entries = Object.entries(telemetry.resolverBreakdown).filter(
    ([, resolver]) =>
      resolver.targets > 0 ||
      resolver.filesProcessed > 0 ||
      resolver.edgesCreated > 0 ||
      resolver.elapsedMs > 0,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([resolverId, resolver]) => [
      resolverId,
      { ...resolver },
    ]),
  );
}

function emitProviderFirstProgress(
  onProgress: ((progress: IndexProgress) => void) | undefined,
  substage: IndexProgressSubstage,
  options: {
    current?: number;
    total?: number;
    stageCurrent?: number;
    stageTotal?: number;
    message?: string;
  } = {},
): void {
  const stageCurrent = options.stageCurrent ?? options.current;
  const stageTotal = options.stageTotal ?? options.total;
  onProgress?.({
    stage: "providerFirst",
    current: options.current ?? stageCurrent ?? 0,
    total: options.total ?? stageTotal ?? 0,
    substage,
    ...(stageCurrent !== undefined ? { stageCurrent } : {}),
    ...(stageTotal !== undefined ? { stageTotal } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
  });
}

function providerFirstShadowStageTotal(
  counts: ProviderFirstShadowBuildSummary["counts"],
): number {
  return counts.files + counts.symbols + counts.externalSymbols + counts.edges;
}

function providerFirstMaterializePhaseTotal(
  phaseName: MaterializeProviderFactsPhaseName,
  rows: ProviderFirstGraphRows,
  plan: ProviderFirstActiveMaterializationPlan,
): number {
  switch (phaseName) {
    case "deleteFileSymbols":
      return plan.deleteExistingFileSymbols
        ? rows.changedFileIds.size + rows.symbols.length
        : 0;
    case "upsertFiles":
      return rows.files.length;
    case "upsertSymbols":
    case "upsertSymbols.nodeAndRelCreate":
    case "upsertSymbols.nodeUpsert":
    case "upsertSymbols.fileRelCreate":
    case "upsertSymbols.repoRelCreate":
      return rows.symbols.length;
    case "pruneExternalSymbols":
    case "mergeExternalSymbols":
      return rows.externalSymbols.length;
    case "insertEdges":
      return plan.writeEdges ? rows.edges.length : 0;
  }
}

export interface ProviderFirstActiveMaterializationPlan {
  deleteExistingFileSymbols: boolean;
  useKnownFreshWriters: boolean;
  writeEdges: boolean;
  reuseExistingProviderRows: boolean;
}

/** @internal exported for tests; do not import from product code. */
export function countExistingProviderPrimaryFiles(params: {
  providerFiles: readonly { relPath: string }[];
  existingByPath: ReadonlyMap<string, unknown>;
}): number {
  let count = 0;
  for (const file of params.providerFiles) {
    if (params.existingByPath.has(normalizePath(file.relPath))) {
      count += 1;
    }
  }
  return count;
}

async function countExistingScipProviderSymbols(
  conn: Awaited<ReturnType<typeof getLadybugConn>>,
  repoId: string,
): Promise<number> {
  const row = await ladybugDb.querySingle<{ count: unknown }>(
    conn,
    `MATCH (s:Symbol)-[:SYMBOL_IN_REPO]->(:Repo {repoId: $repoId})
     WHERE s.source = 'scip'
     RETURN count(DISTINCT s) AS count`,
    { repoId },
  );
  return ladybugDb.toNumber(row?.count ?? 0);
}

export function resolveProviderFirstActiveMaterializationPlan(params: {
  existingProviderFileCount: number;
  providerSymbolCount: number;
  activeProviderInputMatches?: boolean;
  existingProviderSymbolCount?: number;
}): ProviderFirstActiveMaterializationPlan {
  const hasExistingProviderRows = params.existingProviderFileCount > 0;
  const deleteExistingFileSymbols =
    hasExistingProviderRows &&
    params.providerSymbolCount <=
      PROVIDER_FIRST_ACTIVE_STALE_DELETE_SYMBOL_LIMIT;
  const useKnownFreshWriters =
    !hasExistingProviderRows || deleteExistingFileSymbols;
  const existingProviderRowsMatchCurrentShape =
    hasExistingProviderRows &&
    params.existingProviderSymbolCount === params.providerSymbolCount;
  const canReuseExistingProviderRows =
    (params.activeProviderInputMatches ?? true) ||
    existingProviderRowsMatchCurrentShape;

  return {
    deleteExistingFileSymbols,
    useKnownFreshWriters,
    writeEdges: useKnownFreshWriters,
    reuseExistingProviderRows:
      hasExistingProviderRows &&
      !deleteExistingFileSymbols &&
      canReuseExistingProviderRows,
  };
}

/** @internal exported for tests; do not import from product code. */
export function shouldUseRustPass1Engine(params: {
  configuredEngine: string | undefined;
  rustEngineAvailable: boolean;
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    params.configuredEngine === "rust" &&
    params.rustEngineAvailable &&
    (!params.providerFirstLegacyFallbackActive ||
      params.providerFirstLegacyFallbackComplete)
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldCreateParserWorkerPool(params: {
  useRustEngine: boolean;
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    !params.useRustEngine &&
    (!params.providerFirstLegacyFallbackActive ||
      params.providerFirstLegacyFallbackComplete)
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldDeleteExistingFilesBeforeFullPass1(params: {
  mode: "full" | "incremental";
  providerFirstLegacyFallbackActive: boolean;
  existingFileCount: number;
}): boolean {
  return (
    params.mode === "full" &&
    params.providerFirstLegacyFallbackActive &&
    params.existingFileCount > 0
  );
}

/** @internal exported for tests; do not import from product code. */
export function shouldUseBatchPersistAccumulator(params: {
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): boolean {
  return (
    !params.providerFirstLegacyFallbackActive ||
    params.providerFirstLegacyFallbackComplete
  );
}

/** @internal exported for tests; do not import from product code. */
export function resolvePass1BatchSymbolWriteMode(params: {
  providerFirstLegacyFallbackActive: boolean;
}): "merge" | "fresh-copy" {
  return params.providerFirstLegacyFallbackActive ? "fresh-copy" : "merge";
}

/** @internal exported for tests; do not import from product code. */
export function resolveProviderFirstPass1Concurrency(params: {
  configuredConcurrency: number | undefined;
  fileCount: number;
  providerFirstLegacyFallbackActive: boolean;
  providerFirstLegacyFallbackComplete: boolean;
}): number {
  if (
    params.providerFirstLegacyFallbackActive &&
    !params.providerFirstLegacyFallbackComplete
  ) {
    return 1;
  }
  return Math.max(
    1,
    Math.min(params.configuredConcurrency ?? 4, params.fileCount || 1),
  );
}

function providerFirstActiveInputFingerprint(
  generatedIndexes: readonly ScipGeneratedIndexDiagnostic[],
): string | null {
  const acceptedGenerated = generatedIndexes
    .filter(
      (index) =>
        !index.skipped &&
        typeof index.contentHash === "string" &&
        index.contentHash.length > 0,
    )
    .map((index) => ({
      path: normalizePath(index.path),
      label: index.label,
      mode: index.mode,
      sizeBytes: index.sizeBytes,
      contentHash: index.contentHash,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (acceptedGenerated.length === 0) return null;
  return hashValue({
    schemaVersion: PROVIDER_FIRST_ACTIVE_INPUT_FINGERPRINT_VERSION,
    provider: "scip",
    generatedIndexes: acceptedGenerated,
  });
}

export interface ProviderFirstLegacyFallbackPlan {
  runLegacyFallback: boolean;
  parsedFiles: number;
  skippedFiles: number;
  fileLimit: number;
  semanticEligibleFallbackFiles?: number;
  semanticEligibleFileLimit?: number;
}

export function resolveProviderFirstLegacyFallbackPlan(params: {
  fallbackFileCount: number;
  semanticEligibleFallbackFileCount?: number;
  maxLegacyFallbackFiles: number;
  maxSemanticEligibleFallbackFiles?: number;
}): ProviderFirstLegacyFallbackPlan {
  const fallbackFileCount = Math.max(0, params.fallbackFileCount);
  const fileLimit = Math.max(0, params.maxLegacyFallbackFiles);
  const semanticEligibleFileLimit = Math.max(
    0,
    params.maxSemanticEligibleFallbackFiles ?? 0,
  );
  const semanticEligibleFallbackFileCount =
    params.semanticEligibleFallbackFileCount === undefined
      ? undefined
      : Math.min(
          fallbackFileCount,
          Math.max(0, params.semanticEligibleFallbackFileCount),
        );
  const runLegacyFallback =
    fallbackFileCount > 0 &&
    (fallbackFileCount <= fileLimit ||
      (semanticEligibleFallbackFileCount !== undefined &&
        semanticEligibleFallbackFileCount > 0 &&
        semanticEligibleFallbackFileCount <= fileLimit &&
        semanticEligibleFallbackFileCount <= semanticEligibleFileLimit));
  const parsedFiles =
    runLegacyFallback && fallbackFileCount <= fileLimit
      ? fallbackFileCount
      : runLegacyFallback
        ? (semanticEligibleFallbackFileCount ?? 0)
        : 0;

  return {
    runLegacyFallback,
    parsedFiles,
    skippedFiles: fallbackFileCount > 0 ? fallbackFileCount - parsedFiles : 0,
    fileLimit,
    ...(semanticEligibleFallbackFileCount === undefined
      ? {}
      : {
          semanticEligibleFallbackFiles: semanticEligibleFallbackFileCount,
          semanticEligibleFileLimit,
        }),
  };
}

/** @internal exported for tests; do not import from product code. */
export function isProviderFirstLegacyFallbackPlanComplete(
  plan: ProviderFirstLegacyFallbackPlan,
): boolean {
  return plan.runLegacyFallback && plan.skippedFiles === 0;
}

export interface IndexTimingDiagnostics {
  totalMs: number;
  phases: Record<string, number>;
  pass1Drain?: BatchPersistDrainDiagnostics;
}

export interface IndexRepoOptions {
  includeTimings?: boolean;
}
export interface IndexResult {
  versionId: string;
  filesProcessed: number;
  changedFiles: number;
  removedFiles: number;
  symbolsIndexed: number;
  edgesCreated: number;
  clustersComputed: number;
  processesTraced: number;
  durationMs: number;
  summaryStats?: SummaryBatchResult;
  timings?: IndexTimingDiagnostics;
  /**
   * Phase 1 Task 1.12 — per-language Pass-1 engine breakdown.
   *
   * Mirrors the `pass1Engine` block carried on the `index.refresh.complete`
   * audit event so callers (tests, tooling) can inspect Rust engine coverage
   * and fallback rates without scraping logs. Omitted when no Pass-1 was run
   * (e.g., the incremental no-op short-circuit returns all-zero counters via
   * the early-return path below).
   */
  pass1Engine?: {
    rustFiles: number;
    tsFiles: number;
    rustFallbackFiles: number;
    perLanguageFallback: Record<string, number>;
  };
  scip?: {
    generatedIndexes: ScipGeneratedIndexDiagnostic[];
    failures: ScipFailureDiagnostic[];
    generatorCache?: ScipGeneratorCacheDiagnostic;
  };
  providerFirst?: ProviderFirstPipelineSelection;
  providerFirstExecution?: ProviderFirstExecutionSummary;
  semanticDeferred?: boolean;
  algorithmRefresh?: AlgorithmRefreshDiagnostics;
}

export interface IndexWatchHandle {
  /** Resolves when the underlying file watcher has completed its initial scan. */
  ready: Promise<void>;
  close: () => Promise<void>;
}
export interface WatcherHealth {
  enabled: boolean;
  running: boolean;
  filesWatched: number;
  eventsReceived: number;
  eventsProcessed: number;
  errors: number;
  queueDepth: number;
  restartCount: number;
  stale: boolean;
  lastEventAt: string | null;
  lastSuccessfulReindexAt: string | null;
}

export {
  resolveParserWorkerPoolSize,
  type ResolveParserWorkerPoolSizeParams,
} from "./parser.js";
export type { ProcessFileParams } from "./parser.js";

/**
 * Per-repo mutex to prevent concurrent `indexRepo` invocations.
 * When the watcher fires rapid events (e.g. bulk deletes), multiple
 * `indexRepo("incremental")` calls can race and corrupt LadybugDB state.
 */
const indexLocks = new Map<string, Promise<IndexResult>>();

function collectDirtyTsResolverPaths(params: {
  mode: "full" | "incremental";
  files: Array<{ path: string; mtime: number }>;
  existingByPath: Map<string, ladybugDb.FileRow>;
}): string[] {
  const { mode, files, existingByPath } = params;
  const tsFiles = files.filter((file) => isTsCallResolutionFile(file.path));

  if (mode === "full") {
    return tsFiles.map((file) => file.path);
  }

  return tsFiles
    .filter((file) => {
      const existing = existingByPath.get(file.path);
      if (!existing?.lastIndexedAt) return true;
      const lastIndexedMs = new Date(existing.lastIndexedAt).getTime();
      return !Number.isFinite(lastIndexedMs) || file.mtime > lastIndexedMs;
    })
    .map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Phase 1 Task 1.12 — Derive the per-language Pass-1 engine telemetry
 * block that is surfaced on the `index.refresh.complete` audit event.
 *
 * Accepts a partially-populated accumulator (the short-circuit no-op
 * incremental path never runs Pass 1, so all counters are 0 in that case).
 */
export function derivePass1EngineTelemetry(acc: {
  rustFilesProcessed: number;
  tsFilesProcessed: number;
  rustFallbackFiles: number;
  rustFallbackByLanguage: Map<string, number>;
}): {
  rustFiles: number;
  tsFiles: number;
  rustFallbackFiles: number;
  perLanguageFallback: Record<string, number>;
} {
  return {
    rustFiles: acc.rustFilesProcessed,
    tsFiles: acc.tsFilesProcessed,
    rustFallbackFiles: acc.rustFallbackFiles,
    perLanguageFallback: Object.fromEntries(acc.rustFallbackByLanguage),
  };
}

interface NoOpIncrementalRecoveryAssessment {
  reasons: string[];
  symbolCount: number;
  versionedSymbolCount: number;
  metricsCount: number;
  fileSummaryCount: number;
  needsVersionSnapshot: boolean;
  needsDerivedState: boolean;
  needsMetrics: boolean;
  needsFileSummaries: boolean;
}

function emptyPass1EngineTelemetry(): NonNullable<IndexResult["pass1Engine"]> {
  return {
    rustFiles: 0,
    tsFiles: 0,
    rustFallbackFiles: 0,
    perLanguageFallback: {},
  };
}

function providerFirstFallbackSummary(
  reasons: readonly string[],
): ProviderFirstExecutionSummary {
  return {
    status: "fallback",
    reasons: [...reasons],
    filesProcessed: 0,
    symbolsIndexed: 0,
    edgesCreated: 0,
    externalSymbolsIndexed: 0,
  };
}

export function providerFirstFatalFailureReasons(params: {
  failures: readonly ScipFailureDiagnostic[];
  providerRowsAvailable: boolean;
}): string[] {
  return params.failures
    .filter((failure) =>
      providerFirstFailureIsFatal(failure, params.providerRowsAvailable),
    )
    .map(formatScipFailureReason);
}

function providerFirstFailureIsFatal(
  failure: ScipFailureDiagnostic,
  providerRowsAvailable: boolean,
): boolean {
  if (!providerRowsAvailable) return true;
  return failure.stage === "ingest";
}

function formatScipFailureReason(failure: ScipFailureDiagnostic): string {
  return failure.path
    ? `${failure.message} (${failure.path})`
    : failure.message;
}

function invalidateIndexResultCaches(repoId: string): void {
  invalidateGraphSnapshot(repoId);
  clearOverviewCache();
  clearSliceCache();
  clearFingerprintCollisionLog();
}

function skippedDerivedStateResult(reason: string): {
  clustersComputed: number;
  processesTraced: number;
  algorithmRefresh: AlgorithmRefreshDiagnostics;
} {
  return {
    clustersComputed: 0,
    processesTraced: 0,
    algorithmRefresh: {
      enabled: false,
      dirty: true,
      pageRank: { status: "skipped", count: 0, reason },
      kCore: { status: "skipped", count: 0, reason },
      louvain: { status: "skipped", count: 0, reason },
      failures: [reason],
    },
  };
}

async function markDeferredSemanticStateDirty(params: {
  repoId: string;
  versionId: string;
  appConfig: AppConfig;
}): Promise<void> {
  const { repoId, versionId, appConfig } = params;
  try {
    await markDerivedStateDirty(repoId, versionId, {
      summaries: appConfig.semantic?.generateSummaries === true,
      embeddings: true,
    });
  } catch (error) {
    logger.debug("markDerivedStateDirty semantic deferred skipped", {
      repoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface ProviderFirstCoverageReport {
  reasons: string[];
  fatalReasons: string[];
  fallbackPaths: Set<string>;
  callProofIncompletePaths: Set<string>;
  summary: ProviderFirstCoverageSummary;
}

interface ProviderFirstProviderUnusableReasonAccumulator {
  paths: Set<string>;
  skippedSymbolReasons: Map<
    string,
    {
      symbols: number;
      paths: Set<string>;
    }
  >;
}

export function analyzeProviderFirstCoverage(params: {
  scannedPaths: readonly string[];
  semanticEligiblePaths?: Iterable<string>;
  providerPaths: Iterable<string>;
  coverage: Iterable<{
    relPath: string;
    legacyFallback: string;
    symbolCoverage?: CoverageLevel;
    referenceCoverage?: CoverageLevel;
    callProofCoverage?: CoverageLevel;
    totalResolvedReferences?: number;
    callProofUnavailableReferences?: number;
    callProofUnavailableReasons?: Array<{
      code: CallProofUnavailableReasonCode;
      references: number;
    }>;
    callProofUnavailableSamples?: CallProofUnavailableReasonSampleFact[];
    skippedSymbolReasons?: Array<{
      reason: string;
      symbols: number;
    }>;
  }>;
  symbols: Iterable<{
    relPath: string;
    providerId: string;
    providerSymbolId: string;
    name?: string;
  }>;
  occurrences?: Iterable<{
    relPath: string;
    role: string;
    symbolId?: string;
    providerSymbolId: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  }>;
  sourceLinesByPath?: SourceLinesByPath;
}): ProviderFirstCoverageReport {
  const providerPathList = [...params.providerPaths];
  const providerPaths = new Set(providerPathList);
  const coverageEntries = [...params.coverage];
  const coverageByPath = new Map(
    Array.from(coverageEntries, (entry) => [entry.relPath, entry]),
  );
  const callProofSamples = mergeCallProofSamples(
    collectCallProofCoverageSamples(coverageEntries),
    collectCallProofMismatchSamples({
      occurrences: params.occurrences ?? [],
      symbols: params.symbols,
      sourceLinesByPath: params.sourceLinesByPath,
    }),
  );
  const scannedPathSet = new Set(params.scannedPaths);
  const semanticEligiblePaths =
    params.semanticEligiblePaths === undefined
      ? undefined
      : new Set(Array.from(params.semanticEligiblePaths, normalizePath));
  const seenProviderPaths = new Set<string>();
  const duplicateProviderPaths = new Set<string>();
  const seenProviderSymbols = new Set<string>();
  const duplicateProviderSymbols = new Set<string>();
  const missingPaths: string[] = [];
  const partialPaths: string[] = [];
  const callProofIncompletePaths = new Set<string>();
  const callProofIncompleteReasons = new Map<
    CallProofUnavailableReasonCode,
    {
      references: number;
      paths: Set<string>;
    }
  >();
  const fullFallbackPaths: string[] = [];
  const providerUnusableReasons = new Map<
    ProviderFirstProviderUnusableReasonCode,
    ProviderFirstProviderUnusableReasonAccumulator
  >();
  const extraProviderPaths: string[] = [];
  const fallbackPaths = new Set<string>();
  let fullyCoveredFiles = 0;
  let partialFiles = 0;
  let fullFallbackFiles = 0;

  for (const relPath of providerPathList) {
    if (seenProviderPaths.has(relPath)) {
      duplicateProviderPaths.add(relPath);
    } else {
      seenProviderPaths.add(relPath);
    }
  }
  for (const symbol of params.symbols) {
    const key = symbol.providerSymbolId;
    if (seenProviderSymbols.has(key)) {
      duplicateProviderSymbols.add(symbol.providerSymbolId);
    } else {
      seenProviderSymbols.add(key);
    }
  }

  for (const relPath of params.scannedPaths) {
    if (!providerPaths.has(relPath)) {
      missingPaths.push(relPath);
      fallbackPaths.add(relPath);
      continue;
    }
    const coverage = coverageByPath.get(relPath);
    if (coverage?.legacyFallback === "skip") {
      fullyCoveredFiles++;
      addCallProofIncompletePath(
        relPath,
        coverage,
        callProofIncompletePaths,
        callProofIncompleteReasons,
      );
      continue;
    }
    if (coverage?.legacyFallback === "targeted") {
      partialPaths.push(relPath);
      partialFiles++;
      addCallProofIncompletePath(
        relPath,
        coverage,
        callProofIncompletePaths,
        callProofIncompleteReasons,
      );
      continue;
    }
    fullFallbackPaths.push(relPath);
    fallbackPaths.add(relPath);
    fullFallbackFiles++;
    addProviderUnusableReason(relPath, coverage, providerUnusableReasons);
  }
  for (const relPath of providerPaths) {
    if (!scannedPathSet.has(relPath)) {
      extraProviderPaths.push(relPath);
    }
  }

  const reasons: string[] = [];
  const fatalReasons: string[] = [];
  if (missingPaths.length > 0) {
    const sample = missingPaths.slice(0, 5).join(", ");
    reasons.push(
      `SCIP provider did not cover ${missingPaths.length} scanned file(s): ${sample}`,
    );
  }
  if (partialPaths.length > 0) {
    const sample = partialPaths.slice(0, 5).join(", ");
    reasons.push(
      `SCIP provider references were partial for ${partialPaths.length} scanned file(s): ${sample}`,
    );
  }
  if (callProofIncompletePaths.size > 0) {
    const sample = [...callProofIncompletePaths].slice(0, 5).join(", ");
    reasons.push(
      `SCIP provider call proof was unavailable for ${callProofIncompletePaths.size} provider-primary file(s): ${sample}`,
    );
  }
  if (fullFallbackPaths.length > 0) {
    const sample = fullFallbackPaths.slice(0, 5).join(", ");
    reasons.push(
      `SCIP provider coverage was unusable for ${fullFallbackPaths.length} scanned file(s): ${sample}`,
    );
  }
  if (extraProviderPaths.length > 0) {
    const sample = extraProviderPaths.slice(0, 5).join(", ");
    const reason = `SCIP provider included ${extraProviderPaths.length} file(s) outside the scanned repo scope: ${sample}`;
    reasons.push(reason);
    fatalReasons.push(reason);
  }
  if (duplicateProviderPaths.size > 0) {
    const sample = [...duplicateProviderPaths].slice(0, 5).join(", ");
    const reason = `SCIP provider emitted duplicate document facts for ${duplicateProviderPaths.size} file(s): ${sample}`;
    reasons.push(reason);
    fatalReasons.push(reason);
  }
  if (duplicateProviderSymbols.size > 0) {
    const sample = [...duplicateProviderSymbols].slice(0, 5).join(", ");
    const reason = `SCIP provider emitted duplicate symbols for ${duplicateProviderSymbols.size} native provider symbol(s): ${sample}`;
    reasons.push(reason);
    fatalReasons.push(reason);
  }
  const callProofIncompleteReasonsSummary =
    callProofIncompleteReasons.size > 0
      ? summarizeCallProofIncompleteReasons(
          callProofIncompleteReasons,
          callProofSamples,
        )
      : undefined;
  const providerUnusableReasonsSummary =
    providerUnusableReasons.size > 0
      ? summarizeProviderUnusableReasons(providerUnusableReasons)
      : undefined;
  const summary: ProviderFirstCoverageSummary = {
    scannedFiles: params.scannedPaths.length,
    semanticEligibleFiles: semanticEligiblePaths?.size,
    providerFiles: providerPaths.size,
    providerCoveredFiles: providerPaths.size,
    providerPrimaryFiles: fullyCoveredFiles + partialFiles,
    fullyCoveredFiles,
    partialFiles,
    callProofIncompleteFiles: callProofIncompletePaths.size,
    fullFallbackFiles,
    uncoveredFiles: missingPaths.length,
    fallbackFiles: fallbackPaths.size,
  };
  if (callProofIncompleteReasonsSummary) {
    summary.callProofIncompleteReasons = callProofIncompleteReasonsSummary;
  }
  if (providerUnusableReasonsSummary) {
    summary.providerUnusableReasons = providerUnusableReasonsSummary;
  }
  const semanticEligibilityGap = summarizeSemanticEligibilityGap({
    semanticEligiblePaths,
    missingPaths,
    fullFallbackPaths,
  });
  if (semanticEligibilityGap) {
    summary.semanticEligibilityGap = semanticEligibilityGap;
  }

  return {
    reasons,
    fatalReasons,
    fallbackPaths,
    callProofIncompletePaths,
    summary,
  };
}

function summarizeSemanticEligibilityGap(params: {
  semanticEligiblePaths: ReadonlySet<string> | undefined;
  missingPaths: readonly string[];
  fullFallbackPaths: readonly string[];
}): ProviderFirstCoverageSummary["semanticEligibilityGap"] | undefined {
  const semanticEligiblePaths = params.semanticEligiblePaths;
  if (!semanticEligiblePaths) return undefined;

  const semanticEligibleUncoveredPaths = params.missingPaths.filter((relPath) =>
    semanticEligiblePaths.has(relPath),
  );
  const outsideSemanticEligibilityPaths = params.missingPaths.filter(
    (relPath) => !semanticEligiblePaths.has(relPath),
  );
  const semanticEligibleProviderUnusablePaths = params.fullFallbackPaths.filter(
    (relPath) => semanticEligiblePaths.has(relPath),
  );
  const totalFiles =
    semanticEligibleUncoveredPaths.length +
    semanticEligibleProviderUnusablePaths.length;

  if (totalFiles === 0 && outsideSemanticEligibilityPaths.length === 0) {
    return undefined;
  }

  return {
    totalFiles,
    uncoveredFiles: semanticEligibleUncoveredPaths.length,
    providerUnusableFiles: semanticEligibleProviderUnusablePaths.length,
    outsideSemanticEligibilityFiles: outsideSemanticEligibilityPaths.length,
    semanticEligibleUncoveredSamples: semanticEligibleUncoveredPaths.slice(0, 5),
    semanticEligibleProviderUnusableSamples:
      semanticEligibleProviderUnusablePaths.slice(0, 5),
    outsideSemanticEligibilitySamples: outsideSemanticEligibilityPaths.slice(
      0,
      5,
    ),
  };
}

function addProviderUnusableReason(
  relPath: string,
  coverage:
    | {
        symbolCoverage?: CoverageLevel;
        skippedSymbolReasons?: Array<{
          reason: string;
          symbols: number;
        }>;
      }
    | undefined,
  reasons: Map<
    ProviderFirstProviderUnusableReasonCode,
    ProviderFirstProviderUnusableReasonAccumulator
  >,
): void {
  const code = providerUnusableReasonCode(coverage);
  const existing = reasons.get(code) ?? {
    paths: new Set<string>(),
    skippedSymbolReasons: new Map(),
  };
  existing.paths.add(relPath);
  for (const reason of coverage?.skippedSymbolReasons ?? []) {
    if (reason.symbols <= 0) continue;
    const skipped = existing.skippedSymbolReasons.get(reason.reason) ?? {
      symbols: 0,
      paths: new Set<string>(),
    };
    skipped.symbols += reason.symbols;
    skipped.paths.add(relPath);
    existing.skippedSymbolReasons.set(reason.reason, skipped);
  }
  reasons.set(code, existing);
}

function providerUnusableReasonCode(
  coverage:
    | {
        symbolCoverage?: CoverageLevel;
      }
    | undefined,
): ProviderFirstProviderUnusableReasonCode {
  if (!coverage) return "missingCoverage";
  if (coverage.symbolCoverage === "none") return "noUsableProviderSymbols";
  return "unknown";
}

function addCallProofIncompletePath(
  relPath: string,
  coverage:
    | {
        callProofCoverage?: CoverageLevel;
        totalResolvedReferences?: number;
        callProofUnavailableReferences?: number;
        callProofUnavailableReasons?: Array<{
          code: CallProofUnavailableReasonCode;
          references: number;
        }>;
      }
    | undefined,
  target: Set<string>,
  reasons: Map<
    CallProofUnavailableReasonCode,
    {
      references: number;
      paths: Set<string>;
    }
  >,
): void {
  if (!coverage) return;
  if ((coverage.totalResolvedReferences ?? 0) === 0) return;
  if ((coverage.callProofUnavailableReferences ?? 0) === 0) return;
  if ((coverage.callProofCoverage ?? "full") === "full") return;
  target.add(relPath);
  const reasonFacts =
    coverage.callProofUnavailableReasons &&
    coverage.callProofUnavailableReasons.length > 0
      ? coverage.callProofUnavailableReasons
      : [
          {
            code: "unknown" as const,
            references: coverage.callProofUnavailableReferences ?? 1,
          },
        ];
  for (const reason of reasonFacts) {
    if (reason.references <= 0) continue;
    const existing = reasons.get(reason.code) ?? {
      references: 0,
      paths: new Set<string>(),
    };
    existing.references += reason.references;
    existing.paths.add(relPath);
    reasons.set(reason.code, existing);
  }
}

/** @internal exported for tests; do not import from product code. */
export function collectCallProofMismatchSamples(params: {
  occurrences: Iterable<{
    relPath: string;
    role: string;
    symbolId?: string;
    providerSymbolId: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  }>;
  symbols: Iterable<{
    providerSymbolId: string;
    name?: string;
  }>;
  sourceLinesByPath?: SourceLinesByPath;
}): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  if (!params.sourceLinesByPath) return new Map();

  const occurrences = [...params.occurrences];
  const sourceTextCandidatesBySymbol = new Map(
    Array.from(params.symbols, (symbol) => [
      symbol.providerSymbolId,
      symbol.name
        ? sourceTextCandidatesForScipSymbol(
            symbol.providerSymbolId,
            symbol.name,
          )
        : [],
    ]),
  );
  const localSourceTextCandidates = collectLocalImportAliasCandidates({
    occurrences,
    sourceLinesByPath: params.sourceLinesByPath,
    sourceTextCandidatesBySymbol,
  });
  const samplesByReason = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();

  for (const occurrence of occurrences) {
    if (occurrence.role !== "reference" || !occurrence.symbolId) continue;
    const expectedNames = mergeSourceTextCandidates(
      sourceTextCandidatesBySymbol.get(occurrence.providerSymbolId),
      localSourceTextCandidates
        .get(occurrence.relPath)
        ?.get(occurrence.providerSymbolId),
    );
    if (expectedNames.length === 0) continue;
    const primaryExpectedName = expectedNames[0] ?? "";
    if (occurrence.range.startLine !== occurrence.range.endLine) {
      const samplesForReason = samplesByReason.get("multiLineRange") ?? [];
      if (samplesForReason.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) {
        continue;
      }
      const actualText = multiLineRangeSampleText(
        params.sourceLinesByPath.get(occurrence.relPath),
        occurrence.range,
      );
      if (!actualText) continue;
      samplesForReason.push({
        relPath: occurrence.relPath,
        range: occurrence.range,
        expectedText: truncateCallProofSampleText(primaryExpectedName),
        actualText,
      });
      samplesByReason.set("multiLineRange", samplesForReason);
      continue;
    }
    const sourceLine = params.sourceLinesByPath
      .get(occurrence.relPath)
      ?.get(occurrence.range.startLine - 1);
    if (sourceLine === undefined) continue;
    if (occurrence.range.endCol > sourceLine.length) continue;

    const occurrenceText = sourceLine.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    if (
      isProvenClangLocationOnlyMacroReference(
        occurrence.providerSymbolId,
        occurrenceText,
        sourceLine,
        occurrence.range.endCol,
      )
    ) {
      continue;
    }
    const matchedName = expectedNames.find((name) => name === occurrenceText);
    const continuedIdentifier =
      occurrence.range.endCol < sourceLine.length &&
      isIdentifierContinue(sourceLine[occurrence.range.endCol] ?? "");
    const actualText =
      matchedName && continuedIdentifier
        ? expandIdentifierText(sourceLine, occurrence.range.startCol)
        : occurrenceText;
    const textMatches = Boolean(matchedName && !continuedIdentifier);
    const callCandidate = hasInvocationCandidateAfterMismatch(
      sourceLine,
      occurrence.range.endCol,
    );
    if (textMatches || !callCandidate) {
      continue;
    }

    const reason = "symbolTextMismatch" as const;
    const samplesForReason = samplesByReason.get(reason) ?? [];
    if (samplesForReason.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) {
      continue;
    }
    samplesForReason.push({
      relPath: occurrence.relPath,
      range: occurrence.range,
      expectedText: truncateCallProofSampleText(
        matchedName ?? primaryExpectedName,
      ),
      actualText: truncateCallProofSampleText(actualText),
    });
    samplesByReason.set(reason, samplesForReason);
  }

  return samplesByReason;
}

function collectCallProofCoverageSamples(
  coverageEntries: readonly {
    callProofUnavailableSamples?: readonly CallProofUnavailableReasonSampleFact[];
  }[],
): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  const samplesByReason = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();
  for (const coverage of coverageEntries) {
    for (const sample of coverage.callProofUnavailableSamples ?? []) {
      const samples = samplesByReason.get(sample.code) ?? [];
      if (samples.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) continue;
      samples.push({
        relPath: sample.relPath,
        range: sample.range,
        expectedText: sample.expectedText,
        actualText: sample.actualText,
      });
      samplesByReason.set(sample.code, samples);
    }
  }
  return samplesByReason;
}

function mergeCallProofSamples(
  left: ReadonlyMap<
    CallProofUnavailableReasonCode,
    readonly CallProofUnavailableSampleFact[]
  >,
  right: ReadonlyMap<
    CallProofUnavailableReasonCode,
    readonly CallProofUnavailableSampleFact[]
  >,
): Map<CallProofUnavailableReasonCode, CallProofUnavailableSampleFact[]> {
  const merged = new Map<
    CallProofUnavailableReasonCode,
    CallProofUnavailableSampleFact[]
  >();
  for (const [reason, samples] of [...left.entries(), ...right.entries()]) {
    const existing = merged.get(reason) ?? [];
    const existingKeys = new Set(existing.map(callProofSampleKey));
    for (const sample of samples) {
      if (existing.length >= CALL_PROOF_SUMMARY_SAMPLE_LIMIT) break;
      const key = callProofSampleKey(sample);
      if (existingKeys.has(key)) continue;
      existing.push(sample);
      existingKeys.add(key);
    }
    if (existing.length > 0) merged.set(reason, existing);
  }
  return merged;
}

function callProofSampleKey(sample: CallProofUnavailableSampleFact): string {
  return [
    normalizePath(sample.relPath),
    sample.range.startLine,
    sample.range.startCol,
    sample.range.endLine,
    sample.range.endCol,
    sample.expectedText,
    sample.actualText,
  ].join("\u0000");
}

function multiLineRangeSampleText(
  sourceLines: ReadonlyMap<number, string> | undefined,
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  },
): string | undefined {
  if (!sourceLines) return undefined;
  const fragments: string[] = [];
  for (
    let lineNumber = range.startLine;
    lineNumber <= range.endLine;
    lineNumber++
  ) {
    const sourceLine = sourceLines.get(lineNumber - 1);
    if (sourceLine === undefined) return undefined;
    if (lineNumber === range.startLine) {
      if (range.startCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(range.startCol));
      continue;
    }
    if (lineNumber === range.endLine) {
      if (range.endCol > sourceLine.length) return undefined;
      fragments.push(sourceLine.slice(0, range.endCol));
      continue;
    }
    fragments.push(sourceLine);
  }
  return truncateCallProofSampleText(fragments.join("\\n"));
}

function collectLocalImportAliasCandidates(params: {
  occurrences: readonly {
    relPath: string;
    symbolId?: string;
    providerSymbolId: string;
    range: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    };
  }[];
  sourceLinesByPath: SourceLinesByPath;
  sourceTextCandidatesBySymbol: ReadonlyMap<string, readonly string[]>;
}): Map<string, Map<string, string[]>> {
  const candidatesByPathAndSymbol = new Map<string, Map<string, string[]>>();

  for (const occurrence of params.occurrences) {
    if (!occurrence.symbolId) continue;
    if (occurrence.range.startLine !== occurrence.range.endLine) continue;
    const sourceLines = params.sourceLinesByPath.get(occurrence.relPath);
    if (!sourceLines) continue;
    const sourceLine = sourceLines.get(occurrence.range.startLine - 1);
    if (!sourceLine || !sourceLine.includes(" as ")) continue;
    if (occurrence.range.endCol > sourceLine.length) continue;

    const sourceText = sourceLine.slice(
      occurrence.range.startCol,
      occurrence.range.endCol,
    );
    const globalCandidates =
      params.sourceTextCandidatesBySymbol.get(occurrence.providerSymbolId) ??
      [];

    const candidatesBySymbol =
      candidatesByPathAndSymbol.get(occurrence.relPath) ?? new Map();
    const candidates =
      candidatesBySymbol.get(occurrence.providerSymbolId) ?? [];
    for (const candidate of importAliasSourceTextCandidates(
      sourceLines,
      occurrence.range.startLine - 1,
      sourceText,
    )) {
      if (globalCandidates.includes(candidate)) continue;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) continue;
    candidatesBySymbol.set(occurrence.providerSymbolId, candidates);
    candidatesByPathAndSymbol.set(occurrence.relPath, candidatesBySymbol);
  }

  return candidatesByPathAndSymbol;
}

function mergeSourceTextCandidates(
  globalCandidates: readonly string[] | undefined,
  localCandidates: readonly string[] | undefined,
): readonly string[] {
  const merged: string[] = [];
  for (const candidate of [
    ...(globalCandidates ?? []),
    ...(localCandidates ?? []),
  ]) {
    if (candidate.length === 0 || merged.includes(candidate)) continue;
    merged.push(candidate);
  }
  return merged;
}

function summarizeCallProofIncompleteReasons(
  reasons: ReadonlyMap<
    CallProofUnavailableReasonCode,
    {
      references: number;
      paths: ReadonlySet<string>;
    }
  >,
  samplesByReason: ReadonlyMap<
    CallProofUnavailableReasonCode,
    readonly CallProofUnavailableSampleFact[]
  >,
): NonNullable<ProviderFirstCoverageSummary["callProofIncompleteReasons"]> {
  return [...reasons.entries()]
    .map(([code, detail]) => {
      const samples = (samplesByReason.get(code) ?? []).slice(
        0,
        CALL_PROOF_SUMMARY_SAMPLE_LIMIT,
      );
      return {
        code,
        references: detail.references,
        files: detail.paths.size,
        samplePaths: [...detail.paths].slice(0, 5),
        ...(samples.length > 0 ? { samples } : {}),
      };
    })
    .sort((left, right) => {
      if (right.references !== left.references) {
        return right.references - left.references;
      }
      return left.code.localeCompare(right.code);
    });
}

function summarizeProviderUnusableReasons(
  reasons: ReadonlyMap<
    ProviderFirstProviderUnusableReasonCode,
    ProviderFirstProviderUnusableReasonAccumulator
  >,
): NonNullable<ProviderFirstCoverageSummary["providerUnusableReasons"]> {
  return [...reasons.entries()]
    .map(([code, detail]) => {
      const skippedSymbolReasons = summarizeSkippedSymbolReasons(
        detail.skippedSymbolReasons,
      );
      return {
        code,
        files: detail.paths.size,
        samplePaths: [...detail.paths].slice(0, 5),
        ...(skippedSymbolReasons.length > 0 ? { skippedSymbolReasons } : {}),
      };
    })
    .sort((left, right) => {
      if (right.files !== left.files) {
        return right.files - left.files;
      }
      return left.code.localeCompare(right.code);
    });
}

function summarizeSkippedSymbolReasons(
  reasons: ReadonlyMap<
    string,
    {
      symbols: number;
      paths: ReadonlySet<string>;
    }
  >,
): NonNullable<
  NonNullable<
    ProviderFirstCoverageSummary["providerUnusableReasons"]
  >[number]["skippedSymbolReasons"]
> {
  return [...reasons.entries()]
    .map(([reason, detail]) => ({
      reason,
      symbols: detail.symbols,
      samplePaths: [...detail.paths].slice(0, 5),
    }))
    .sort((left, right) => {
      if (right.symbols !== left.symbols) {
        return right.symbols - left.symbols;
      }
      return left.reason.localeCompare(right.reason);
    });
}

function callProofSkipDerivedStateReason(
  paths: ReadonlySet<string>,
): string | undefined {
  if (paths.size === 0) return undefined;
  const sample = [...paths].slice(0, 5).join(", ");
  return `provider-first SCIP call proof unavailable for ${paths.size} provider-primary file(s); derived graph algorithms remain dirty: ${sample}`;
}

function skippedProviderFirstLegacyFallbackReason(
  plan: ProviderFirstLegacyFallbackPlan,
): string | undefined {
  if (plan.skippedFiles === 0) return undefined;
  if (plan.runLegacyFallback && plan.parsedFiles > 0) {
    return (
      `same-run legacy fallback skipped for ${plan.skippedFiles} outside-semantic file(s) ` +
      `after parsing ${plan.parsedFiles} semantic-eligible fallback file(s) ` +
      `because providerFirst.maxLegacyFallbackFiles=${plan.fileLimit}`
    );
  }
  if (
    plan.semanticEligibleFallbackFiles !== undefined &&
    plan.semanticEligibleFallbackFiles > 0 &&
    plan.semanticEligibleFileLimit !== undefined &&
    plan.semanticEligibleFallbackFiles > plan.semanticEligibleFileLimit
  ) {
    return (
      `same-run legacy fallback skipped for ${plan.skippedFiles} file(s) ` +
      `because semantic-eligible fallback files=${plan.semanticEligibleFallbackFiles} ` +
      `exceeds providerFirst.maxSemanticEligibleFallbackFiles=${plan.semanticEligibleFileLimit} ` +
      `(full fallback cap providerFirst.maxLegacyFallbackFiles=${plan.fileLimit})`
    );
  }
  return `same-run legacy fallback skipped for ${plan.skippedFiles} file(s) because providerFirst.maxLegacyFallbackFiles=${plan.fileLimit}`;
}

function joinProviderFirstSkipDerivedStateReasons(
  reasons: Array<string | undefined>,
): string | undefined {
  const activeReasons = reasons.filter((reason): reason is string =>
    Boolean(reason),
  );
  return activeReasons.length > 0 ? activeReasons.join("; ") : undefined;
}

export interface ProviderFirstReadinessGates {
  skipDerivedStateReason?: string;
  shadowStagingSkipReason?: string;
}

export function resolveProviderFirstReadinessGates(params: {
  callProofSkipReason?: string;
  skippedLegacyFallbackReason?: string;
}): ProviderFirstReadinessGates {
  return {
    skipDerivedStateReason: joinProviderFirstSkipDerivedStateReasons([
      params.callProofSkipReason,
      params.skippedLegacyFallbackReason,
    ]),
    // Any derived-state blocker makes a staged shadow non-activatable in the
    // same run, so skip the shadow build instead of loading rows for inspection
    // that cannot be finalized or swapped into place.
    shadowStagingSkipReason:
      params.callProofSkipReason ?? params.skippedLegacyFallbackReason,
  };
}

function skippedProviderFirstShadowBuild(params: {
  generationId: string;
  rows: ProviderFirstGraphRows;
  activation: ProviderFirstShadowBuildSummary["activation"];
  requestedFormat: ProviderFirstShadowBuildSummary["requestedFormat"];
  reason: string;
}): ProviderFirstShadowBuildSummary {
  return {
    status: "skipped",
    activation: params.activation,
    requestedFormat: params.requestedFormat,
    generationId: params.generationId,
    counts: {
      files: params.rows.files.length,
      symbols: params.rows.symbols.length,
      externalSymbols: params.rows.externalSymbols.length,
      edges: params.rows.edges.length,
    },
    reasons: [params.reason],
  };
}

function applyScannedFileMetadataToProviderRows(params: {
  rows: Awaited<ReturnType<typeof executeProviderFirstScipFull>>["rows"];
  scannedFiles: readonly { path: string; size: number }[];
}): void {
  const scannedByPath = new Map(
    params.scannedFiles.map((file) => [file.path, file]),
  );
  for (const row of params.rows.files) {
    const scanned = scannedByPath.get(row.relPath);
    if (scanned) {
      row.byteSize = scanned.size;
    }
  }
}

export interface ProviderFirstScanScopeFilterResult {
  rows: ProviderFirstGraphRows;
  facts: ProviderFactSet;
  ignoredProviderPaths: string[];
}

export function filterProviderFirstDataToScannedScope(params: {
  rows: ProviderFirstGraphRows;
  facts: ProviderFactSet;
  scannedPaths: readonly string[];
}): ProviderFirstScanScopeFilterResult {
  const scannedPathSet = new Set(
    params.scannedPaths.map((path) => normalizePath(path)),
  );
  const ignoredProviderPaths = Array.from(
    new Set(
      params.rows.files
        .map((file) => normalizePath(file.relPath))
        .filter(
          (relPath) =>
            !scannedPathSet.has(relPath) &&
            providerPathCanBeIgnoredOutsideScanScope(relPath),
        ),
    ),
  ).sort((left, right) => left.localeCompare(right));

  if (ignoredProviderPaths.length === 0) {
    return {
      rows: params.rows,
      facts: params.facts,
      ignoredProviderPaths,
    };
  }

  const ignoredPathSet = new Set(ignoredProviderPaths);
  return {
    rows: filterProviderRowsByExcludedPaths(params.rows, ignoredPathSet),
    facts: filterProviderFactsByExcludedPaths(params.facts, ignoredPathSet),
    ignoredProviderPaths,
  };
}

/** @internal exported for tests; do not import from product code. */
export function selectProviderFirstLegacyFallbackPaths(params: {
  fallbackPaths: ReadonlySet<string>;
  semanticEligiblePaths: ReadonlySet<string> | undefined;
  parsedFiles: number;
}): Set<string> {
  if (params.parsedFiles <= 0) return new Set();
  if (params.parsedFiles >= params.fallbackPaths.size) {
    return new Set(params.fallbackPaths);
  }
  if (!params.semanticEligiblePaths) return new Set();

  const selected = new Set<string>();
  for (const relPath of params.fallbackPaths) {
    if (params.semanticEligiblePaths.has(relPath)) {
      selected.add(relPath);
    }
  }
  return selected;
}

function filterProviderRowsForFallback(
  rows: ProviderFirstGraphRows,
  fallbackPaths: ReadonlySet<string>,
): ProviderFirstGraphRows {
  return filterProviderRowsByExcludedPaths(rows, fallbackPaths);
}

export function clearProviderFactPayloadsForGc(facts: ProviderFactSet): void {
  facts.files.length = 0;
  facts.symbols.length = 0;
  facts.occurrences.length = 0;
  facts.edges.length = 0;
  facts.externalSymbols.length = 0;
  facts.diagnostics.length = 0;
  facts.coverage.length = 0;
  facts.providerRuns.length = 0;
  delete facts.sourceLinesByPath;
}

export function clearProviderFactPayloadsForCoverageAnalysis(
  facts: ProviderFactSet,
): void {
  facts.files.length = 0;
  facts.occurrences.length = 0;
  facts.edges.length = 0;
  facts.externalSymbols.length = 0;
  facts.diagnostics.length = 0;
  facts.providerRuns.length = 0;
  delete facts.sourceLinesByPath;
}

function providerFactsShouldDropCoveragePayloads(
  facts: ProviderFactSet,
): boolean {
  return (
    facts.occurrences.length > PROVIDER_FIRST_OCCURRENCE_FACT_RETENTION_LIMIT ||
    (facts.sourceLinesByPath?.size ?? 0) >
      PROVIDER_FIRST_COVERAGE_SAMPLE_SOURCE_PATH_LIMIT
  );
}

async function flushProviderFirstPayloadFinalizers(): Promise<void> {
  // Large SCIP indexes can leave multi-GB decoded occurrence/source-line
  // payloads pending finalization. A single GC pass drops live heap, but
  // LadybugDB remains fragile until V8 also releases more of the reserved
  // heap before the first large native write.
  await flushStaleFinalizers();
  await flushStaleFinalizers();
  await flushStaleFinalizers();
}

export function clearProviderGraphRowsForGc(
  rows: ProviderFirstGraphRows,
): void {
  rows.files.length = 0;
  rows.symbols.length = 0;
  rows.externalSymbols.length = 0;
  rows.edges.length = 0;
  rows.changedFileIds.clear();
}

function filterProviderRowsByExcludedPaths(
  rows: ProviderFirstGraphRows,
  excludedPaths: ReadonlySet<string>,
): ProviderFirstGraphRows {
  if (excludedPaths.size === 0) return rows;

  const files = rows.files.filter((file) => !excludedPaths.has(file.relPath));
  const keptFileIds = new Set(files.map((file) => file.fileId));
  const symbols = rows.symbols.filter((symbol) =>
    keptFileIds.has(symbol.fileId),
  );
  const internalSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  const externalSymbolIds = new Set(
    rows.externalSymbols.map((symbol) => symbol.symbolId),
  );
  const allowedSymbolIds = new Set([
    ...internalSymbolIds,
    ...externalSymbolIds,
  ]);
  const edges = rows.edges.filter(
    (edge) =>
      allowedSymbolIds.has(edge.fromSymbolId) &&
      allowedSymbolIds.has(edge.toSymbolId) &&
      (internalSymbolIds.has(edge.fromSymbolId) ||
        internalSymbolIds.has(edge.toSymbolId)),
  );
  const referencedExternalSymbolIds = new Set<string>();
  for (const edge of edges) {
    if (externalSymbolIds.has(edge.fromSymbolId)) {
      referencedExternalSymbolIds.add(edge.fromSymbolId);
    }
    if (externalSymbolIds.has(edge.toSymbolId)) {
      referencedExternalSymbolIds.add(edge.toSymbolId);
    }
  }
  const externalSymbols = rows.externalSymbols.filter((symbol) =>
    referencedExternalSymbolIds.has(symbol.symbolId),
  );

  return {
    files,
    symbols,
    externalSymbols,
    edges,
    changedFileIds: new Set(files.map((file) => file.fileId)),
  };
}

function filterProviderFactsByExcludedPaths(
  facts: ProviderFactSet,
  excludedPaths: ReadonlySet<string>,
): ProviderFactSet {
  const filePathAllowed = (relPath: string): boolean =>
    !excludedPaths.has(normalizePath(relPath));
  const files = facts.files.filter((fact) => filePathAllowed(fact.relPath));
  const symbols = facts.symbols.filter((fact) => filePathAllowed(fact.relPath));
  const internalSymbolIds = new Set(symbols.map((symbol) => symbol.symbolId));
  const externalSymbolIds = new Set(
    facts.externalSymbols.map((symbol) => symbol.symbolId),
  );
  const allowedSymbolIds = new Set([
    ...internalSymbolIds,
    ...externalSymbolIds,
  ]);
  const edges = facts.edges.filter(
    (edge) =>
      allowedSymbolIds.has(edge.sourceSymbolId) &&
      allowedSymbolIds.has(edge.targetSymbolId) &&
      (internalSymbolIds.has(edge.sourceSymbolId) ||
        internalSymbolIds.has(edge.targetSymbolId)),
  );
  const referencedExternalSymbolIds = new Set<string>();
  for (const edge of edges) {
    if (externalSymbolIds.has(edge.sourceSymbolId)) {
      referencedExternalSymbolIds.add(edge.sourceSymbolId);
    }
    if (externalSymbolIds.has(edge.targetSymbolId)) {
      referencedExternalSymbolIds.add(edge.targetSymbolId);
    }
  }
  const externalSymbols = facts.externalSymbols.filter((symbol) =>
    referencedExternalSymbolIds.has(symbol.symbolId),
  );
  const diagnostics = facts.diagnostics.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const coverage = facts.coverage.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const occurrences = facts.occurrences.filter((fact) =>
    filePathAllowed(fact.relPath),
  );
  const sourceLinesByPath =
    facts.sourceLinesByPath &&
    new Map(
      [...facts.sourceLinesByPath.entries()].filter(([relPath]) =>
        filePathAllowed(relPath),
      ),
    );
  const providerRuns = facts.providerRuns.map((run) => ({
    ...run,
    fileCount: files.length,
    symbolCount: symbols.length + externalSymbols.length,
    edgeCount: edges.length,
    diagnosticCount: diagnostics.length,
  }));

  return {
    files,
    symbols,
    occurrences,
    edges,
    externalSymbols,
    diagnostics,
    coverage,
    providerRuns,
    ...(sourceLinesByPath ? { sourceLinesByPath } : {}),
  };
}

function providerRowsHaveMaterialization(
  rows: ProviderFirstGraphRows,
): boolean {
  return (
    rows.files.length > 0 ||
    rows.symbols.length > 0 ||
    rows.externalSymbols.length > 0 ||
    rows.edges.length > 0
  );
}

function filterProviderFirstFallbackScan(
  scan: ScanRepoForIndexResult,
  fallbackPaths: ReadonlySet<string>,
): ScanRepoForIndexResult {
  const existingByPath = new Map<string, ladybugDb.FileRow>();
  for (const [relPath, file] of scan.existingByPath) {
    if (fallbackPaths.has(relPath)) {
      existingByPath.set(relPath, file);
    }
  }

  return {
    ...scan,
    files: scan.files.filter((file) => fallbackPaths.has(file.path)),
    existingByPath,
    removedFileIds: [],
    allFilesUnchanged: false,
  };
}

async function countSymbolVersionsForVersion(
  versionId: string,
): Promise<number> {
  const conn = await getLadybugConn();
  const row = await ladybugDb.querySingle<{ count: unknown }>(
    conn,
    `MATCH (sv:SymbolVersion {versionId: $versionId})
     RETURN count(sv) AS count`,
    { versionId },
  );
  return ladybugDb.toNumber(row?.count ?? 0);
}

async function countMetricsForRepo(repoId: string): Promise<number> {
  const conn = await getLadybugConn();
  const row = await ladybugDb.querySingle<{ count: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE coalesce(s.symbolStatus, 'real') = 'real'
     MATCH (m:Metrics)
     WHERE m.symbolId = s.symbolId
     RETURN count(m) AS count`,
    { repoId },
  );
  return ladybugDb.toNumber(row?.count ?? 0);
}

async function countFileSummariesForRepo(repoId: string): Promise<number> {
  const conn = await getLadybugConn();
  const row = await ladybugDb.querySingle<{ count: unknown }>(
    conn,
    `MATCH (fs:FileSummary {repoId: $repoId})
     RETURN count(fs) AS count`,
    { repoId },
  );
  return ladybugDb.toNumber(row?.count ?? 0);
}

async function assessNoOpIncrementalRecovery(params: {
  repoId: string;
  versionId: string;
  fileCount: number;
}): Promise<NoOpIncrementalRecoveryAssessment> {
  const { repoId, versionId, fileCount } = params;
  const conn = await getLadybugConn();
  const [symbolCount, versionedSymbolCount, metricsCount, fileSummaryCount] =
    await Promise.all([
      ladybugDb.getSymbolCount(conn, repoId),
      countSymbolVersionsForVersion(versionId),
      countMetricsForRepo(repoId),
      countFileSummariesForRepo(repoId),
    ]);
  const derivedState = await getDerivedState(repoId);
  const reasons: string[] = [];

  const needsVersionSnapshot = versionedSymbolCount < symbolCount;
  if (needsVersionSnapshot) {
    reasons.push(
      `version snapshot incomplete (${versionedSymbolCount}/${symbolCount})`,
    );
  }

  const needsDerivedState =
    !derivedState ||
    derivedStateIsStale(derivedState) ||
    derivedState.computedVersionId !== versionId;
  if (needsDerivedState) {
    reasons.push("derived state missing or stale");
  }
  const needsMetrics = metricsCount < symbolCount;
  if (needsMetrics) {
    reasons.push(`metrics incomplete (${metricsCount}/${symbolCount})`);
  }
  const needsFileSummaries = fileSummaryCount < fileCount;
  if (needsFileSummaries) {
    reasons.push(
      `file summaries incomplete (${fileSummaryCount}/${fileCount})`,
    );
  }

  return {
    reasons,
    symbolCount,
    versionedSymbolCount,
    metricsCount,
    fileSummaryCount,
    needsVersionSnapshot,
    needsDerivedState,
    needsMetrics,
    needsFileSummaries,
  };
}

function countScipEdgeMutations(
  result: Awaited<ReturnType<typeof runScipIngestInsideIndex>>,
): number {
  return result.results.reduce(
    (sum, item) =>
      sum + item.edgesCreated + item.edgesUpgraded + item.edgesReplaced,
    0,
  );
}

function scipIngestMutatedGraph(
  result: Awaited<ReturnType<typeof runScipIngestInsideIndex>>,
): boolean {
  return result.results.some((item) => item.status === "ingested");
}

const INDEX_DISPATCH_IDLE_TIMEOUT_MS = 30_000;

export function resolvePostIndexSessionTimeoutMs(
  repoId: string,
  liveRepos: RepoConfig[],
  storedRepoConfig: RepoConfig,
): number | undefined {
  // Prefer the live config file so timeout tuning does not require
  // re-registering an existing repository.
  return (
    liveRepos.find((repo) => repo.repoId === repoId)
      ?.postIndexSessionTimeoutMs ?? storedRepoConfig.postIndexSessionTimeoutMs
  );
}

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
  signal?: AbortSignal,
  options?: IndexRepoOptions,
): Promise<IndexResult> {
  // scip-io pre-refresh hook runs BEFORE acquiring indexLocks so a slow
  // scip-io run does not hold the per-repo lock and starve queued
  // refreshes. The runner coalesces concurrent calls per repo so two
  // scip-io processes never race on writing index.scip. See
  // src/scip/scip-io-runner.ts::runScipIoPreRefreshForIndex.
  const { runScipIoPreRefreshForIndex } =
    await import("../scip/scip-io-runner.js");
  const scipPreRefreshResult = await runScipIoPreRefreshForIndex(
    repoId,
    signal,
  );

  // Serialize concurrent indexRepo calls for the same repo to prevent
  // LadybugDB write conflicts and race conditions during rapid watcher events.
  // Loop-and-recheck: after awaiting a lock, another caller may have set a new
  // one before we proceed. Re-check until no lock exists.

  while (true) {
    const existing = indexLocks.get(repoId);
    if (!existing) break;
    logger.debug("indexRepo already running, waiting for lock", {
      repoId,
      mode,
    });
    try {
      await existing;
    } catch (err) {
      // Previous run failed — proceed with our own run.
      logger.debug("Previous indexing run failed, proceeding with new run", {
        repoId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const runIndex = async (): Promise<IndexResult> => {
    const idle = await waitForToolDispatchIdle({
      // MCP-triggered refreshes already occupy one dispatch slot. Watcher and
      // CLI refreshes reserve a synthetic slot through runToolDispatch below.
      activeAllowance: 1,
      timeoutMs: INDEX_DISPATCH_IDLE_TIMEOUT_MS,
      label: `index refresh for ${repoId}`,
    });
    if (!idle) {
      throw new Error(
        `Timed out waiting for active tool calls to drain before index refresh for ${repoId}`,
      );
    }

    // Flush WAL before large indexing runs open their own transactions.
    // Incremental refreshes are often tiny/no-op and can run frequently;
    // forcing CHECKPOINT on every incremental call can become a contention
    // hotspot under mixed read/write stress.
    if (mode === "full") {
      await preIndexCheckpoint();
    }
    return indexRepoImpl(
      repoId,
      mode,
      onProgress,
      signal,
      options,
      scipPreRefreshResult,
    );
  };

  const resultPromise = withIndexingGate(() =>
    isInToolDispatch() ? runIndex() : runToolDispatch(runIndex),
  );
  indexLocks.set(repoId, resultPromise);
  try {
    return await resultPromise;
  } finally {
    // Only clear if we're still the active lock holder.
    if (indexLocks.get(repoId) === resultPromise) {
      indexLocks.delete(repoId);
    }
  }
}

async function indexRepoImpl(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
  signal?: AbortSignal,
  options?: IndexRepoOptions,
  scipPreRefresh?: {
    generatedIndexes: ScipGeneratedIndexDiagnostic[];
    failures: ScipFailureDiagnostic[];
    cache?: ScipGeneratorCacheDiagnostic;
  },
): Promise<IndexResult> {
  // Auto-upgrade incremental → full on a fresh repo (no files indexed yet).
  // Callers (CLI delegated path, MCP `sdl.index.refresh`, watcher first-run)
  // can request "incremental" without checking DB state. Running as
  // incremental on empty data is a correctness no-op but defeats every
  // full-mode optimisation: pass-2 still does the per-file
  // `deleteOutgoingEdgesByTypeForSymbols` round-trip against an empty
  // edge table, the pass-1→pass-2 drain awaits instead of overlapping,
  // and `preIndexCheckpoint()` is skipped. Detecting fileCount===0 once
  // here lets every code path benefit without each caller duplicating
  // the check.
  if (mode === "incremental") {
    const probeConn = await getLadybugConn();
    const fileCount = await ladybugDb.getFileCount(probeConn, repoId);
    if (fileCount === 0) {
      logger.info(
        "indexRepo: upgrading mode 'incremental' → 'full' (repo has no indexed files)",
        { repoId },
      );
      mode = "full";
    }
  }

  const startTime = Date.now();
  const phaseTimings: Record<string, number> | null = options?.includeTimings
    ? {}
    : null;
  const providerFirstPhaseTimings: Record<string, number> = {};
  const providerFirstLegacyFallbackPhaseTimings: Record<string, number> = {};
  let providerFirstTimingStartedAt: number | undefined;
  let providerFirstLegacyFallbackStartedAt: number | undefined;
  let providerFirstLegacyFallbackComplete = false;
  let providerFirstLegacyFallbackFileCount = 0;
  let providerFirstLegacyFallbackSamplePaths: string[] = [];
  // Keep broad timing capture opt-in so normal refreshes pay essentially no
  // overhead. Provider-first phases are always timed separately because the
  // CLI uses them as the next optimization profile.
  const measurePhase = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
    meta?: { language?: string; engine?: "rust" | "ts" },
  ): Promise<T> => {
    const phaseStart = Date.now();
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`index phase ${phaseName} failed: ${message}`, {
        cause: err,
      });
    } finally {
      const durationMs = Date.now() - phaseStart;
      if (phaseTimings) phaseTimings[phaseName] = durationMs;
      if (providerFirstLegacyFallbackStartedAt !== undefined) {
        providerFirstLegacyFallbackPhaseTimings[phaseName] =
          (providerFirstLegacyFallbackPhaseTimings[phaseName] ?? 0) +
          durationMs;
      }
      try {
        getObservabilityTap()?.indexPhase({
          phase: phaseName,
          durationMs,
          repoId,
          ...(meta?.language ? { language: meta.language } : {}),
          ...(meta?.engine ? { engine: meta.engine } : {}),
        });
      } catch {
        /* swallow */
      }
    }
  };
  const recordProviderFirstPhaseTiming = (
    phaseName: string,
    durationMs: number,
  ): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    providerFirstPhaseTimings[phaseName] =
      (providerFirstPhaseTimings[phaseName] ?? 0) + durationMs;
  };
  const recordIndexSubphaseTiming = (
    phaseName: string,
    durationMs: number,
  ): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if (phaseTimings) {
      phaseTimings[phaseName] = (phaseTimings[phaseName] ?? 0) + durationMs;
    }
    if (providerFirstLegacyFallbackStartedAt !== undefined) {
      providerFirstLegacyFallbackPhaseTimings[phaseName] =
        (providerFirstLegacyFallbackPhaseTimings[phaseName] ?? 0) + durationMs;
    }
  };
  const recordPass2SubphaseTiming = (
    phaseName: string,
    durationMs: number,
  ): void => {
    recordIndexSubphaseTiming(phaseName, durationMs);
  };
  const measureIndexSubphase = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      recordIndexSubphaseTiming(phaseName, Date.now() - phaseStart);
    }
  };
  const shouldCollectPostIndexSubphaseTimings = (): boolean =>
    Boolean(phaseTimings) || providerFirstLegacyFallbackStartedAt !== undefined;
  const recordFinalizeIndexingSubphaseTimings = (
    timings?: Record<string, number>,
  ): void => {
    if (!timings) return;
    for (const [phaseName, phaseDurationMs] of Object.entries(timings)) {
      const key = `finalizeIndexing.${phaseName}`;
      if (phaseTimings) {
        phaseTimings[key] = phaseDurationMs;
      }
      if (providerFirstLegacyFallbackStartedAt !== undefined) {
        providerFirstLegacyFallbackPhaseTimings[key] =
          (providerFirstLegacyFallbackPhaseTimings[key] ?? 0) + phaseDurationMs;
      }
    }
  };
  const measureProviderFirstPhase = async <T>(
    providerPhaseName: string,
    phaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await measurePhase(phaseName, fn);
    } finally {
      recordProviderFirstPhaseTiming(providerPhaseName, Date.now() - startedAt);
    }
  };
  const withProviderFirstPhaseTimings = (
    summary: ProviderFirstExecutionSummary | undefined,
  ): ProviderFirstExecutionSummary | undefined => {
    if (!summary || summary.status !== "executed") return summary;
    const totalMs =
      providerFirstTimingStartedAt === undefined
        ? Object.values(providerFirstPhaseTimings).reduce(
            (sum, durationMs) => sum + durationMs,
            0,
          )
        : Date.now() - providerFirstTimingStartedAt;
    return {
      ...summary,
      phaseTimings: {
        totalMs,
        phases: { ...providerFirstPhaseTimings },
      },
    };
  };
  const measureNestedPhase = async <T>(
    parentPhaseName: string,
    childPhaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    if (!phaseTimings) {
      return await fn();
    }
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      phaseTimings[`${parentPhaseName}.${childPhaseName}`] =
        Date.now() - phaseStart;
    }
  };
  const conn = await getLadybugConn();

  const repoRow = await ladybugDb.getRepo(conn, repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  let config: RepoConfig;
  try {
    config = JSON.parse(repoRow.configJson);
  } catch {
    logger.error("Corrupt configJson for repo", { repoId });
    throw new Error(`Corrupt configJson for repo ${repoId}`);
  }
  const scopedSourceFileListActive = Boolean(config.sourceFileListPath);
  const scopedSourceFileListReason =
    "shadow staging skipped because repo.sourceFileListPath scopes this run to a benchmark subset";

  const appConfig: AppConfig = loadConfig();
  const providerFirstConfig =
    appConfig.indexing?.providerFirst ??
    IndexingConfigSchema.parse({}).providerFirst;
  const providerFirst = resolveProviderFirstPipeline({
    indexing: appConfig.indexing,
    scip: appConfig.scip,
    semanticEnrichment: appConfig.semanticEnrichment,
  });
  const providerFirstExecutionPlan = resolveProviderFirstExecutionPlan({
    selection: providerFirst,
    mode,
    scip: appConfig.scip,
  });
  let providerFirstExecutionFallback =
    providerFirst.selectedPipeline === "providerFirst" &&
    providerFirstExecutionPlan.shouldFallbackToLegacy
      ? providerFirstFallbackSummary(providerFirstExecutionPlan.reasons)
      : undefined;
  const skipLegacyScipIngest =
    providerFirst.selectedPipeline === "providerFirst" &&
    providerFirstExecutionPlan.shouldFallbackToLegacy &&
    providerFirst.sources.some((source) => source.type === "scip") &&
    providerFirstExecutionPlan.fallbackReasonCode === "incrementalUnsupported";
  let providerFirstExecutedSummary: ProviderFirstExecutionSummary | undefined;
  let providerFirstScipMaterialized = false;
  let providerFirstMaterializedFiles = 0;
  let providerFirstMaterializedSymbols = 0;
  let providerFirstMaterializedEdges = 0;
  let providerFirstSkipDerivedStateReason: string | undefined;
  let providerFirstShadowStagingSkipReason: string | undefined;
  let providerFirstProviderRows: ProviderFirstGraphRows | undefined;
  let providerFirstGenerationId: string | undefined;
  const providerFirstFallbackPaths = new Set<string>();
  const providerFirstChangedFileIds = new Set<string>();
  let providerFirstScan:
    | Awaited<ReturnType<typeof scanRepoForIndex>>
    | undefined;
  if (providerFirst.selectedPipeline === "providerFirst") {
    if (providerFirstExecutionPlan.canExecute) {
      logger.info("indexRepo: provider-first executor selected", {
        repoId,
        executor: providerFirstExecutionPlan.executor,
        sources: providerFirst.sources.map((source) => source.type),
        warnings: providerFirst.warnings,
      });
    } else if (providerFirstExecutionPlan.shouldFallbackToLegacy) {
      logger.warn(
        "indexRepo: provider-first unavailable, using legacy fallback",
        {
          repoId,
          reasons: providerFirstExecutionPlan.reasons,
        },
      );
    } else {
      throw new Error(
        `Provider-first indexing cannot execute for ${repoId}: ${providerFirstExecutionPlan.reasons.join("; ")}`,
      );
    }
  }
  const postIndexSessionTimeoutMs = resolvePostIndexSessionTimeoutMs(
    repoId,
    appConfig.repos,
    config,
  );

  const createOrReuseVersion = async (
    versionReason: string,
    forceNewVersion = false,
  ): Promise<string> =>
    measurePhase("versioning", async () => {
      const latestConn = await getLadybugConn();
      const latestVersion = await measureIndexSubphase(
        "versionSnapshot.latestVersion",
        () => ladybugDb.getLatestVersion(latestConn, repoId),
      );
      if (mode === "incremental" && !forceNewVersion) {
        const versionId = latestVersion
          ? latestVersion.versionId
          : `v${Date.now()}`;
        if (!latestVersion) {
          await createVersionAndSnapshot({
            repoId,
            versionId,
            reason: versionReason,
            recordTiming: recordIndexSubphaseTiming,
          });
        }
        return versionId;
      }

      const versionId = `v${Date.now()}`;
      await createVersionAndSnapshot({
        repoId,
        versionId,
        reason: versionReason,
        recordTiming: recordIndexSubphaseTiming,
      });
      return versionId;
    });

  const runPostIndexFinalization = async (params: {
    versionId: string;
    indexMode: "full" | "incremental";
    filesTotal: number;
    filesScanned: number;
    symbolsExtracted: number;
    edgesExtracted: number;
    changedFileIdsForFinalize?: Set<string>;
    changedTestFilePathsForFinalize?: Set<string>;
    changedFileIdsForMemory: Set<string>;
    hasIndexMutations: boolean;
    callResolutionTelemetry: CallResolutionTelemetry;
    pass1Engine: NonNullable<IndexResult["pass1Engine"]>;
    scip?: NonNullable<IndexResult["scip"]>;
    preloadedFileSummarySymbolFactsByFile?: ReadonlyMap<
      string,
      readonly ladybugDb.FileSummarySymbolFactRow[]
    >;
    preFinalize?: () => Promise<void>;
    skipDerivedStateReason?: string;
    deferSemanticRefresh?: boolean;
  }): Promise<{
    summaryStats?: SummaryBatchResult;
    semanticDeferred?: boolean;
    clustersComputed: number;
    processesTraced: number;
    algorithmRefresh: AlgorithmRefreshDiagnostics;
  }> =>
    withPostIndexWriteSession(
      async () => {
        await params.preFinalize?.();
        const finalizeResult = await measurePhase("finalizeIndexing", () =>
          finalizeIndexing({
            repoId,
            versionId: params.versionId,
            appConfig,
            changedFileIds: params.changedFileIdsForFinalize,
            changedTestFilePaths: params.changedTestFilePathsForFinalize,
            preloadedSymbolFactsByFile:
              params.preloadedFileSummarySymbolFactsByFile,
            hasIndexMutations: params.hasIndexMutations,
            includeTimings: shouldCollectPostIndexSubphaseTimings(),
            callResolutionTelemetry: params.callResolutionTelemetry,
            deferSemanticRefresh: params.deferSemanticRefresh,
            onProgress,
          }),
        );
        recordFinalizeIndexingSubphaseTimings(finalizeResult.timings);

        const freshConn = await getLadybugConn();
        const derivedResult = params.skipDerivedStateReason
          ? await measurePhase("skipDerivedState", async () => {
              await markDerivedStateDirty(repoId, params.versionId, {
                clusters: true,
                processes: true,
                algorithms: true,
              });
              await recordDerivedStateError(
                repoId,
                params.skipDerivedStateReason ?? "",
              );
              return skippedDerivedStateResult(
                params.skipDerivedStateReason ?? "",
              );
            })
          : await finalizeDerivedState({
              mode: params.indexMode,
              conn: freshConn,
              repoId,
              versionId: params.versionId,
              filesTotal: params.filesTotal,
              phaseTimings,
              algorithmRefresh: appConfig.indexing?.algorithmRefresh,
              onProgress,
              sharedGraph: finalizeResult.sharedGraph,
              measurePhase,
            });

        if (finalizeResult.semanticDeferred) {
          await markDeferredSemanticStateDirty({
            repoId,
            versionId: params.versionId,
            appConfig,
          });
        }

        await measurePhase("buildDeferredIndexes", async () => {
          await buildDeferredIndexes({
            deferSemanticVectorIndexes: finalizeResult.semanticDeferred,
            deferSemanticTextIndexes: finalizeResult.semanticDeferred,
            recordTiming: recordIndexSubphaseTiming,
          });
        });

        await measurePhase("memorySync", async () => {
          await flagStaleMemoriesForChangedFiles(
            freshConn,
            repoId,
            params.changedFileIdsForMemory,
            params.versionId,
          );
          await importMemoryFilesFromDisk(
            repoRow.rootPath,
            repoId,
            params.versionId,
          );
        });

        await flushIndexEvent({
          repoId,
          versionId: params.versionId,
          stats: {
            filesScanned: params.filesScanned,
            symbolsExtracted: params.symbolsExtracted,
            edgesExtracted: params.edgesExtracted,
            durationMs: Date.now() - startTime,
            errors: 0,
            pass1Engine: params.pass1Engine,
            fileSummaryEmbeddings: finalizeResult.fileSummaryEmbeddingStats,
            semanticDeferred: finalizeResult.semanticDeferred,
            quality: finalizeResult.qualityStats,
            scip: params.scip,
            algorithmRefresh: derivedResult.algorithmRefresh,
          },
        });

        return {
          summaryStats: finalizeResult.summaryStats,
          semanticDeferred: finalizeResult.semanticDeferred,
          clustersComputed: derivedResult.clustersComputed,
          processesTraced: derivedResult.processesTraced,
          algorithmRefresh: derivedResult.algorithmRefresh,
        };
      },
      { timeoutMs: postIndexSessionTimeoutMs },
    );

  const finalizeProviderFirstShadowBuild = async (
    shadowBuild: ProviderFirstShadowBuildSummary | undefined,
    versionId: string,
  ): Promise<ProviderFirstShadowBuildSummary | undefined> => {
    if (!shadowBuild) return undefined;
    let finalizedShadowBuild = shadowBuild;
    const shadowDbPath =
      shadowBuild.status === "staged" &&
      shadowBuild.shadowDb?.status === "loaded"
        ? shadowBuild.shadowDb.path
        : undefined;
    const activeDbPath = getLadybugDbPath();
    const graphDerivedStateReady =
      providerFirstSkipDerivedStateReason === undefined;
    if (shadowDbPath && graphDerivedStateReady) {
      emitProviderFirstProgress(onProgress, "shadowFinalize", {
        message: "finalizing provider-first shadow DB",
      });
      const finalization = await measureProviderFirstPhase(
        "shadowFinalize",
        "providerFirstShadowFinalize",
        async () => {
          const activeConn = await getLadybugConn();
          return finalizeProviderFirstShadowDb({
            activeConn,
            repoId,
            versionId,
            shadowDbPath,
          });
        },
      );
      emitProviderFirstProgress(onProgress, "shadowFinalize", {
        message: `shadow DB finalization ${finalization.status}`,
      });
      finalizedShadowBuild = {
        ...shadowBuild,
        finalization,
      };
    } else if (shadowDbPath) {
      finalizedShadowBuild = {
        ...shadowBuild,
        finalization: {
          status: "skipped",
          shadowDbPath,
          reasons: [
            providerFirstSkipDerivedStateReason ??
              "shadow DB finalization skipped because graph-derived state is not ready",
          ],
        },
      };
    }
    const finalizedGraphReady =
      finalizedShadowBuild.finalization?.status === "finalized";
    if (
      finalizedGraphReady &&
      graphDerivedStateReady &&
      activeDbPath &&
      shadowDbPath &&
      providerFirstConfig.activation === "shadowDb"
    ) {
      emitProviderFirstProgress(onProgress, "shadowActivate", {
        message: "activating finalized shadow DB",
      });
      finalizedShadowBuild.activationResult = await measureProviderFirstPhase(
        "shadowActivate",
        "providerFirstShadowActivate",
        () =>
          activateProviderFirstShadowDbWithHandoff({
            activeDbPath,
            shadowDbPath,
            generationId: finalizedShadowBuild.generationId,
            closeActiveDb: () => closeLadybugDb({ preserveCloseHooks: true }),
            reopenActiveDb: (path) =>
              initLadybugDb(path, {
                bufferPoolBytes:
                  appConfig.graphDatabase?.bufferPoolBytes ?? undefined,
              }),
          }),
      );
      emitProviderFirstProgress(onProgress, "shadowActivate", {
        message: `shadow DB activation ${finalizedShadowBuild.activationResult.status}`,
      });
    } else {
      finalizedShadowBuild.activationResult =
        summarizeProviderFirstShadowActivationReadiness({
          shadowBuild: finalizedShadowBuild,
          fallbackFiles: 0,
          graphDerivedStateReady,
          shadowContainsFinalizedGraph: finalizedGraphReady,
          finalizedGraphReasons:
            finalizedShadowBuild.finalization?.status === "finalized"
              ? undefined
              : finalizedShadowBuild.finalization?.reasons,
        });
    }
    return finalizedShadowBuild;
  };

  if (
    providerFirstExecutionPlan.canExecute &&
    providerFirstExecutionPlan.executor === "scipFull"
  ) {
    providerFirstTimingStartedAt = Date.now();
    emitProviderFirstProgress(onProgress, "coverageScan", {
      message: "scanning repository for provider-first coverage",
    });
    const providerCoverageScan = await measureProviderFirstPhase(
      "coverageScan",
      "providerFirstCoverageScan",
      () =>
        scanRepoForIndex({
          repoId,
          repoRoot: repoRow.rootPath,
          config,
          onProgress,
          deleteRemovedFiles: false,
        }),
    );
    emitProviderFirstProgress(onProgress, "coverageScan", {
      stageCurrent: providerCoverageScan.files.length,
      stageTotal: providerCoverageScan.files.length,
      message: `scanned ${providerCoverageScan.files.length} file(s) for provider-first coverage`,
    });
    let providerResult:
      | Awaited<ReturnType<typeof executeProviderFirstScipFull>>
      | undefined;
    try {
      providerResult = await measureProviderFirstPhase(
        "providerCollection",
        "providerFirstScipFull",
        () =>
          executeProviderFirstScipFull({
            repoId,
            repoRoot: repoRow.rootPath,
            config: appConfig,
            generatedIndexes: scipPreRefresh?.generatedIndexes,
            generatorFailures: scipPreRefresh?.failures,
            generatorCacheKey: scipPreRefresh?.cache?.key,
            scannedPaths: providerCoverageScan.files.map((file) => file.path),
            recordPhaseTiming: recordProviderFirstPhaseTiming,
            onProgress,
            signal,
          }),
      );
    } catch (err) {
      if (err instanceof ProviderFirstGraphValidationError) {
        throw err;
      }
      const reason =
        err instanceof Error
          ? err.message
          : `provider-first SCIP execution failed: ${String(err)}`;
      if (providerFirst.requestedMode === "auto") {
        logger.warn(
          "indexRepo: provider-first execution failed, using legacy fallback",
          {
            repoId,
            reason,
          },
        );
        providerFirstExecutionFallback = providerFirstFallbackSummary([reason]);
      } else {
        throw err;
      }
    }

    if (providerResult) {
      const executionFailureReasons = providerFirstFatalFailureReasons({
        failures: providerResult.failures,
        providerRowsAvailable: providerResult.rows.files.length > 0,
      });
      if (executionFailureReasons.length > 0) {
        if (providerFirst.requestedMode === "auto") {
          logger.warn(
            "indexRepo: provider-first execution had failures, using legacy fallback",
            {
              repoId,
              reasons: executionFailureReasons,
            },
          );
          providerFirstExecutionFallback = providerFirstFallbackSummary(
            executionFailureReasons,
          );
        } else {
          throw new Error(
            `Provider-first indexing cannot execute for ${repoId}: ${executionFailureReasons.join("; ")}`,
          );
        }
      } else {
        const providerScan = providerCoverageScan;
        providerFirstScan = providerScan;
        if (providerFactsShouldDropCoveragePayloads(providerResult.facts)) {
          clearProviderFactPayloadsForCoverageAnalysis(providerResult.facts);
          emitProviderFirstProgress(onProgress, "coverageAnalyze", {
            message: "large provider occurrence payloads released",
          });
        }
        const scanScopedProvider = filterProviderFirstDataToScannedScope({
          rows: providerResult.rows,
          facts: providerResult.facts,
          scannedPaths: providerScan.files.map((file) => file.path),
        });
        emitProviderFirstProgress(onProgress, "coverageAnalyze", {
          message: "provider rows filtered to scan scope",
        });
        const scanScopedProviderPaths = scanScopedProvider.rows.files.map(
          (file) => file.relPath,
        );
        const scanHasCppSemanticPaths = providerScan.files.some((file) =>
          isCppSemanticScanPath(file.path),
        );
        const semanticEligiblePaths = scanHasCppSemanticPaths
          ? await resolveProviderFirstSemanticEligiblePaths({
              repoRoot: repoRow.rootPath,
              scannedPaths: providerScan.files.map((file) => file.path),
              providerPaths: scanScopedProviderPaths,
            })
          : undefined;
        const coverageReport = analyzeProviderFirstCoverage({
          scannedPaths: providerScan.files.map((file) => file.path),
          semanticEligiblePaths:
            semanticEligiblePaths && semanticEligiblePaths.size > 0
              ? semanticEligiblePaths
              : undefined,
          providerPaths: scanScopedProviderPaths,
          coverage: scanScopedProvider.facts.coverage,
          symbols: scanScopedProvider.facts.symbols,
          occurrences: scanScopedProvider.facts.occurrences,
          sourceLinesByPath: scanScopedProvider.facts.sourceLinesByPath,
        });
        emitProviderFirstProgress(onProgress, "coverageAnalyze", {
          message: "provider coverage analyzed",
        });
        if (coverageReport.fatalReasons.length > 0) {
          throw new Error(
            `Provider-first indexing cannot execute for ${repoId}: ${coverageReport.fatalReasons.join("; ")}`,
          );
        } else {
          const legacyFallbackPlan = resolveProviderFirstLegacyFallbackPlan({
            fallbackFileCount: coverageReport.fallbackPaths.size,
            semanticEligibleFallbackFileCount:
              coverageReport.summary.semanticEligibilityGap?.totalFiles,
            maxLegacyFallbackFiles: providerFirstConfig.maxLegacyFallbackFiles,
            maxSemanticEligibleFallbackFiles:
              providerFirstConfig.maxSemanticEligibleFallbackFiles,
          });
          const skippedLegacyFallbackReason =
            skippedProviderFirstLegacyFallbackReason(legacyFallbackPlan);
          const readinessGates = resolveProviderFirstReadinessGates({
            callProofSkipReason: callProofSkipDerivedStateReason(
              coverageReport.callProofIncompletePaths,
            ),
            skippedLegacyFallbackReason,
          });
          providerFirstSkipDerivedStateReason =
            readinessGates.skipDerivedStateReason;
          providerFirstShadowStagingSkipReason =
            readinessGates.shadowStagingSkipReason;
          if (scopedSourceFileListActive) {
            providerFirstShadowStagingSkipReason =
              providerFirstShadowStagingSkipReason
                ? `${providerFirstShadowStagingSkipReason}; ${scopedSourceFileListReason}`
                : scopedSourceFileListReason;
          }
          const legacyFallbackPaths = selectProviderFirstLegacyFallbackPaths({
            fallbackPaths: coverageReport.fallbackPaths,
            semanticEligiblePaths,
            parsedFiles: legacyFallbackPlan.parsedFiles,
          });
          const providerRowsExcludedByLegacyFallback =
            legacyFallbackPlan.runLegacyFallback
              ? legacyFallbackPaths
              : new Set<string>();
          const materializedRows = filterProviderRowsForFallback(
            scanScopedProvider.rows,
            providerRowsExcludedByLegacyFallback,
          );
          // The provider fact set can include every SCIP occurrence and source
          // line. Drop it before legacy fallback and versioning so large repos
          // do not carry decoded provider payloads into post-index finalization.
          clearProviderFactPayloadsForGc(providerResult.facts);
          if (scanScopedProvider.facts !== providerResult.facts) {
            clearProviderFactPayloadsForGc(scanScopedProvider.facts);
          }
          if (providerResult.rows !== materializedRows) {
            clearProviderGraphRowsForGc(providerResult.rows);
          }
          if (
            scanScopedProvider.rows !== materializedRows &&
            scanScopedProvider.rows !== providerResult.rows
          ) {
            clearProviderGraphRowsForGc(scanScopedProvider.rows);
          }
          await measureProviderFirstPhase(
            "postProviderGc",
            "providerFirstPostProviderGc",
            () => flushProviderFirstPayloadFinalizers(),
          );
          emitProviderFirstProgress(onProgress, "coverageAnalyze", {
            message: "provider payload finalizers flushed",
          });
          providerFirstProviderRows = materializedRows;
          providerFirstGenerationId = providerResult.generationId;
          applyScannedFileMetadataToProviderRows({
            rows: materializedRows,
            scannedFiles: providerScan.files,
          });
          let shadowBuild: ProviderFirstExecutionSummary["shadowBuild"];
          if (!legacyFallbackPlan.runLegacyFallback) {
            if (providerFirstShadowStagingSkipReason) {
              const shadowStageTotal = providerFirstGraphRowTotal(materializedRows);
              emitProviderFirstProgress(onProgress, "shadowStage", {
                stageCurrent: 0,
                stageTotal: shadowStageTotal,
                message: `shadow staging skipped: ${providerFirstShadowStagingSkipReason}`,
              });
              shadowBuild = skippedProviderFirstShadowBuild({
                generationId: providerResult.generationId,
                activation: providerFirstConfig.activation,
                requestedFormat: providerFirstConfig.stagingFormat,
                rows: materializedRows,
                reason: providerFirstShadowStagingSkipReason,
              });
            } else {
              const shadowStageTotal = providerFirstGraphRowTotal(materializedRows);
              emitProviderFirstProgress(onProgress, "shadowStage", {
                stageCurrent: 0,
                stageTotal: shadowStageTotal,
                message: "staging provider rows for shadow bulk load",
              });
              shadowBuild = await measureProviderFirstPhase(
                "shadowStage",
                "providerFirstShadowStage",
                () =>
                  stageProviderFirstShadowBuild({
                    repoId,
                    generationId: providerResult.generationId,
                    activation: providerFirstConfig.activation,
                    requestedFormat: providerFirstConfig.stagingFormat,
                    activeDbPath: getLadybugDbPath(),
                    repoRoot: repoRow.rootPath,
                    repoConfigJson: repoRow.configJson,
                    rows: materializedRows,
                  }),
              );
              shadowBuild.activationResult =
                summarizeProviderFirstShadowActivationReadiness({
                  shadowBuild,
                  fallbackFiles: 0,
                  graphDerivedStateReady:
                    providerFirstSkipDerivedStateReason === undefined,
                  shadowContainsFinalizedGraph: false,
                  finalizedGraphReasons: providerFirstSkipDerivedStateReason
                    ? [providerFirstSkipDerivedStateReason]
                    : undefined,
                });
              if (shadowBuild.status === "staged") {
                const stagedTotal = providerFirstShadowStageTotal(
                  shadowBuild.counts,
                );
                emitProviderFirstProgress(onProgress, "shadowStage", {
                  stageCurrent: stagedTotal,
                  stageTotal: stagedTotal,
                  message: "provider rows staged for shadow bulk load",
                });
              }
            }
          }
          const activeProviderInputHash = scopedSourceFileListActive
            ? null
            : providerFirstActiveInputFingerprint(
                providerResult.generatedIndexes,
              );
          const activeProviderInputRecord = activeProviderInputHash
            ? await ladybugDb.getScipIngestionRecord(
                conn,
                repoId,
                PROVIDER_FIRST_ACTIVE_INPUT_RECORD_PATH,
              )
            : null;
          const activeProviderInputMatches = Boolean(
            activeProviderInputHash &&
              activeProviderInputRecord?.contentHash ===
                activeProviderInputHash &&
              activeProviderInputRecord.truncated !== true,
          );
          const existingProviderSymbolCount =
            await countExistingScipProviderSymbols(conn, repoId);
          const activeMaterializationPlan =
            resolveProviderFirstActiveMaterializationPlan({
              existingProviderFileCount: countExistingProviderPrimaryFiles({
                providerFiles: materializedRows.files,
                existingByPath: providerScan.existingByPath,
              }),
              providerSymbolCount: materializedRows.symbols.length,
              activeProviderInputMatches,
              existingProviderSymbolCount,
            });
          if (activeMaterializationPlan.reuseExistingProviderRows) {
            const deleteTotal = providerFirstMaterializePhaseTotal(
              "deleteFileSymbols",
              materializedRows,
              activeMaterializationPlan,
            );
            emitProviderFirstProgress(onProgress, "materialize.deleteFileSymbols", {
              stageCurrent: 0,
              stageTotal: deleteTotal,
              message:
                "provider active stale cleanup skipped for large symbol set",
            });
            const symbolTotal = providerFirstMaterializePhaseTotal(
              "upsertSymbols",
              materializedRows,
              activeMaterializationPlan,
            );
            emitProviderFirstProgress(onProgress, "materialize.upsertSymbols", {
              stageCurrent: symbolTotal,
              stageTotal: symbolTotal,
              message:
                "provider active rows reused for existing large symbol set",
            });
          }
          await measureProviderFirstPhase(
            "materialize",
            "providerFirstMaterialize",
            () => {
              if (activeMaterializationPlan.reuseExistingProviderRows) {
                return Promise.resolve();
              }
              return withWriteConn(async (conn) => {
                if (providerRowsHaveMaterialization(materializedRows)) {
                  // materializeProviderFacts owns its transaction. Wrapping it
                  // in another transaction makes large provider-first writes
                  // crash in LadybugDB's native transaction handling.
                  await materializeProviderFacts(conn, materializedRows, {
                    replaceFileSymbols: true,
                    deleteExistingFileSymbols:
                      activeMaterializationPlan.deleteExistingFileSymbols,
                    useKnownFreshWriters:
                      activeMaterializationPlan.useKnownFreshWriters,
                    writeEdges: activeMaterializationPlan.writeEdges,
                    pruneExternalSymbols: !scopedSourceFileListActive,
                    measurePhase: async (phaseName, fn) => {
                      const substage =
                        `materialize.${phaseName}` as IndexProgressSubstage;
                      const phaseTotal = providerFirstMaterializePhaseTotal(
                        phaseName,
                        materializedRows,
                        activeMaterializationPlan,
                      );
                      emitProviderFirstProgress(onProgress, substage, {
                        stageCurrent: 0,
                        stageTotal: phaseTotal,
                        message: `provider materialize ${phaseName} start`,
                      });
                      const startedAt = Date.now();
                      try {
                        return await fn();
                      } finally {
                        recordProviderFirstPhaseTiming(
                          `materialize.${phaseName}`,
                          Date.now() - startedAt,
                        );
                        emitProviderFirstProgress(onProgress, substage, {
                          stageCurrent: phaseTotal,
                          stageTotal: phaseTotal,
                          message: `provider materialize ${phaseName} done`,
                        });
                      }
                    },
                  });
                } else if (!scopedSourceFileListActive) {
                  await ladybugDb.withTransaction(conn, async (txConn) => {
                    await ladybugDb.pruneStaleScipExternalSymbols(
                      txConn,
                      repoId,
                      [],
                    );
                  });
                }
                if (providerScan.removedFileIds.length > 0) {
                  await ladybugDb.withTransaction(conn, async (txConn) => {
                    await ladybugDb.deleteFilesByIds(
                      txConn,
                      providerScan.removedFileIds,
                    );
                  });
                }
                if (activeProviderInputHash) {
                  await ladybugDb.mergeScipIngestionRecord(conn, {
                    id: hashValue({
                      repoId,
                      indexPath: PROVIDER_FIRST_ACTIVE_INPUT_RECORD_PATH,
                    }),
                    repoId,
                    indexPath: PROVIDER_FIRST_ACTIVE_INPUT_RECORD_PATH,
                    contentHash: activeProviderInputHash,
                    ingestedAt: new Date().toISOString(),
                    ledgerVersion: providerResult.generationId,
                    symbolCount: materializedRows.symbols.length,
                    edgeCount: activeMaterializationPlan.writeEdges
                      ? materializedRows.edges.length
                      : 0,
                    externalSymbolCount:
                      materializedRows.externalSymbols.length,
                    truncated: !activeMaterializationPlan.writeEdges,
                  });
                }
              }, postIndexSessionTimeoutMs);
            },
          );
          invalidateIndexResultCaches(repoId);
          providerFirstScipMaterialized = true;
          if (activeMaterializationPlan.reuseExistingProviderRows) {
            providerFirstMaterializedFiles = 0;
            providerFirstMaterializedSymbols = 0;
            providerFirstMaterializedEdges = 0;
          } else {
            providerFirstMaterializedFiles = materializedRows.files.length;
            providerFirstMaterializedSymbols =
              materializedRows.symbols.length +
              materializedRows.externalSymbols.length;
            providerFirstMaterializedEdges = materializedRows.edges.length;
            for (const fileId of materializedRows.changedFileIds) {
              providerFirstChangedFileIds.add(fileId);
            }
          }

          const executionReasons = [...coverageReport.reasons];
          if (scanScopedProvider.ignoredProviderPaths.length > 0) {
            const sample = scanScopedProvider.ignoredProviderPaths
              .slice(0, 5)
              .join(", ");
            executionReasons.push(
              `SCIP provider ignored ${scanScopedProvider.ignoredProviderPaths.length} repo-relative file(s) outside the configured scan scope: ${sample}`,
            );
          }
          if (activeMaterializationPlan.reuseExistingProviderRows) {
            executionReasons.push(
              `active provider rows reused for ${materializedRows.symbols.length} large existing symbol row(s); clean rebuild or shadow activation is required to physically retire stale provider rows`,
            );
          }
          if (scopedSourceFileListActive) {
            executionReasons.push(
              "repo.sourceFileListPath is set; provider-first active row reuse and shadow activation are disabled so this subset run cannot masquerade as a complete graph",
            );
          }
          if (coverageReport.fallbackPaths.size > 0) {
            if (legacyFallbackPlan.runLegacyFallback) {
              executionReasons.push(
                `legacy fallback indexed ${legacyFallbackPlan.parsedFiles} uncovered or provider-unusable file(s) after provider-first materialization`,
              );
            }
            if (skippedLegacyFallbackReason) {
              executionReasons.push(skippedLegacyFallbackReason);
            }
          }
          const coverageSummary: ProviderFirstCoverageSummary = {
            ...coverageReport.summary,
            fallbackFiles: legacyFallbackPlan.parsedFiles,
          };
          if (legacyFallbackPlan.skippedFiles > 0) {
            coverageSummary.legacyFallbackSkippedFiles =
              legacyFallbackPlan.skippedFiles;
            coverageSummary.legacyFallbackFileLimit =
              legacyFallbackPlan.fileLimit;
            if (
              legacyFallbackPlan.semanticEligibleFallbackFiles !== undefined &&
              legacyFallbackPlan.semanticEligibleFileLimit !== undefined
            ) {
              coverageSummary.semanticEligibleFallbackFiles =
                legacyFallbackPlan.semanticEligibleFallbackFiles;
              coverageSummary.semanticEligibleFallbackFileLimit =
                legacyFallbackPlan.semanticEligibleFileLimit;
            }
          }
          if (scanScopedProvider.ignoredProviderPaths.length > 0) {
            coverageSummary.ignoredProviderFiles =
              scanScopedProvider.ignoredProviderPaths.length;
            coverageSummary.ignoredProviderFileSamples =
              scanScopedProvider.ignoredProviderPaths.slice(0, 5);
          }
          providerFirstExecutedSummary = {
            ...providerResult.summary,
            filesProcessed: materializedRows.files.length,
            symbolsIndexed:
              materializedRows.symbols.length +
              materializedRows.externalSymbols.length,
            edgesCreated: materializedRows.edges.length,
            externalSymbolsIndexed: materializedRows.externalSymbols.length,
            shadowBuild,
            coverage: coverageSummary,
            reasons: executionReasons,
          };

          if (legacyFallbackPlan.runLegacyFallback) {
            logger.info(
              "indexRepo: provider-first materialized; using legacy fallback for uncovered files",
              {
                repoId,
                fallbackFiles: legacyFallbackPlan.parsedFiles,
                reasons: executionReasons,
              },
            );
            providerFirstScan = filterProviderFirstFallbackScan(
              providerScan,
              legacyFallbackPaths,
            );
            for (const file of providerFirstScan.files) {
              providerFirstFallbackPaths.add(file.path);
            }
            providerFirstLegacyFallbackComplete =
              isProviderFirstLegacyFallbackPlanComplete(legacyFallbackPlan);
            providerFirstLegacyFallbackFileCount =
              legacyFallbackPlan.parsedFiles;
            providerFirstLegacyFallbackSamplePaths = [
              ...legacyFallbackPaths,
            ].slice(0, 10);
            providerFirstLegacyFallbackStartedAt = Date.now();
          } else {
            if (activeMaterializationPlan.reuseExistingProviderRows) {
              providerFirstExecutedSummary = withProviderFirstPhaseTimings(
                providerFirstExecutedSummary,
              );
              const result: IndexResult = {
                versionId: providerResult.generationId,
                filesProcessed: 0,
                changedFiles: 0,
                removedFiles: 0,
                symbolsIndexed: 0,
                edgesCreated: 0,
                clustersComputed: 0,
                processesTraced: 0,
                durationMs: Date.now() - startTime,
                pass1Engine: emptyPass1EngineTelemetry(),
                scip: {
                  generatedIndexes: providerResult.generatedIndexes,
                  failures: providerResult.failures,
                  generatorCache: scipPreRefresh?.cache,
                },
                providerFirst,
                providerFirstExecution: providerFirstExecutedSummary,
                semanticDeferred: true,
                algorithmRefresh: skippedDerivedStateResult(
                  "provider-first active rows reused",
                ).algorithmRefresh,
              };
              clearProviderGraphRowsForGc(materializedRows);
              return result;
            }

            const versionId = await createOrReuseVersion(
              "Provider-first SCIP index",
              true,
            );
            const pass1Engine = emptyPass1EngineTelemetry();
            const scip = {
              generatedIndexes: providerResult.generatedIndexes,
              failures: providerResult.failures,
              generatorCache: scipPreRefresh?.cache,
            };
            const post = await runPostIndexFinalization({
              versionId,
              indexMode: "full",
              filesTotal: materializedRows.files.length,
              filesScanned: materializedRows.files.length,
              symbolsExtracted:
                materializedRows.symbols.length +
                materializedRows.externalSymbols.length,
              edgesExtracted: materializedRows.edges.length,
              changedFileIdsForFinalize: scopedSourceFileListActive
                ? materializedRows.changedFileIds
                : undefined,
              changedTestFilePathsForFinalize: new Set(),
              changedFileIdsForMemory: materializedRows.changedFileIds,
              hasIndexMutations: true,
              callResolutionTelemetry: createCallResolutionTelemetry({
                repoId,
                mode: "full",
                pass2EligibleFileCount: 0,
                registeredResolvers: [],
              }),
              pass1Engine,
              scip,
              preloadedFileSummarySymbolFactsByFile:
                buildPreloadedFileSummarySymbolFactsFromRows({
                  files: materializedRows.files,
                  symbols: materializedRows.symbols,
                }),
              deferSemanticRefresh: true,
              skipDerivedStateReason: providerFirstSkipDerivedStateReason,
            });
            providerFirstExecutedSummary = {
              ...providerFirstExecutedSummary,
              shadowBuild: await finalizeProviderFirstShadowBuild(
                providerFirstExecutedSummary.shadowBuild,
                versionId,
              ),
            };
            providerFirstExecutedSummary = withProviderFirstPhaseTimings(
              providerFirstExecutedSummary,
            );

            const result: IndexResult = {
              versionId,
              filesProcessed: materializedRows.files.length,
              changedFiles: materializedRows.changedFileIds.size,
              removedFiles: providerScan.removedFiles,
              symbolsIndexed:
                materializedRows.symbols.length +
                materializedRows.externalSymbols.length,
              edgesCreated: materializedRows.edges.length,
              clustersComputed: post.clustersComputed,
              processesTraced: post.processesTraced,
              durationMs: Date.now() - startTime,
              summaryStats: post.summaryStats,
              timings: phaseTimings
                ? {
                    totalMs: Date.now() - startTime,
                    phases: phaseTimings,
                  }
                : undefined,
              pass1Engine,
              scip,
              providerFirst,
              providerFirstExecution: providerFirstExecutedSummary,
              semanticDeferred: post.semanticDeferred,
              algorithmRefresh: post.algorithmRefresh,
            };
            return result;
          }
        }
      }
    }
  }

  const {
    files,
    existingByPath,
    removedFiles,
    removedFileIds,
    allFilesUnchanged: scanAllFilesUnchanged,
  } = providerFirstScan ??
  (await measurePhase("scanRepo", () =>
    scanRepoForIndex({
      repoId,
      repoRoot: repoRow.rootPath,
      config,
      onProgress,
    }),
  ));
  logger.debug("scanRepoForIndex complete", {
    repoId,
    fileCount: files.length,
    removedFiles,
  });

  const LARGE_REPO_THRESHOLD = 5000;
  if (files.length > LARGE_REPO_THRESHOLD) {
    logger.warn(
      `Large repository detected (${files.length} files). ` +
        "If indexing runs out of memory, set " +
        'NODE_OPTIONS="--max-old-space-size=8192" before running sdl-mcp.',
      { repoId, fileCount: files.length },
    );
  }

  if (mode === "incremental" && scanAllFilesUnchanged) {
    return await measurePhase("shortCircuitNoOp", async () => {
      const versionId = await createOrReuseVersion("Incremental index");
      const pass1Engine = emptyPass1EngineTelemetry();
      const recovery = await measurePhase("noOpRecoveryAssess", () =>
        assessNoOpIncrementalRecovery({
          repoId,
          versionId,
          fileCount: files.length,
        }),
      );

      if (recovery.needsVersionSnapshot) {
        await measurePhase("versionSnapshotRepair", () =>
          snapshotCurrentSymbolsForVersion({
            repoId,
            versionId,
            recordTiming: recordIndexSubphaseTiming,
          }),
        );
      }

      const scipResult =
        !skipLegacyScipIngest && scipIngestWillRun({ scip: appConfig.scip })
          ? await measurePhase("scipIngest", () =>
              runScipIngestInsideIndex({
                repoId,
                repoRoot: repoRow.rootPath,
                config: appConfig,
                generatedIndexes: scipPreRefresh?.generatedIndexes,
                generatorFailures: scipPreRefresh?.failures,
                onProgress,
              }),
            )
          : {
              results: [],
              fullyCoveredPaths: new Set<string>(),
              generatedIndexes: scipPreRefresh?.generatedIndexes ?? [],
              failures: scipPreRefresh?.failures ?? [],
            };
      if (scipResult.results.length > 0) {
        const { maybeCleanupGeneratedScipIndex } =
          await import("../scip/cleanup.js");
        await maybeCleanupGeneratedScipIndex({
          generatorEnabled: Boolean(appConfig.scip?.generator?.enabled),
          cleanupAfterIngest: Boolean(
            appConfig.scip?.generator?.cleanupAfterIngest,
          ),
          args: appConfig.scip?.generator?.args ?? [],
          repoRootPath: repoRow.rootPath,
          generatedPaths: scipResult.generatedIndexes
            .filter((index) => !index.skipped)
            .map((index) => index.path),
        });
      }

      const scipEdgeMutations = countScipEdgeMutations(scipResult);
      const scipMutatedGraph = scipIngestMutatedGraph(scipResult);
      const recoveryReasons = [...recovery.reasons];
      if (scipMutatedGraph) {
        recoveryReasons.push("configured SCIP index ingested");
      }

      let summaryStats: SummaryBatchResult | undefined;
      let clustersComputed = 0;
      let processesTraced = 0;
      let algorithmRefresh: AlgorithmRefreshDiagnostics | undefined;
      const needsFullPostIndexFinalize = scipMutatedGraph;
      const needsDirectPostIndexRepair =
        !needsFullPostIndexFinalize &&
        (recovery.needsMetrics || recovery.needsFileSummaries);
      const needsDerivedRecovery =
        recovery.needsDerivedState ||
        needsDirectPostIndexRepair ||
        needsFullPostIndexFinalize;
      if (needsDerivedRecovery) {
        logger.info("Recovering incomplete no-op incremental index state", {
          repoId,
          versionId,
          reasons: recoveryReasons,
          symbolCount: recovery.symbolCount,
          versionedSymbolCount: recovery.versionedSymbolCount,
          metricsCount: recovery.metricsCount,
          fileSummaryCount: recovery.fileSummaryCount,
        });
        const postIndexResult = await runPostIndexFinalization({
          versionId,
          indexMode: "incremental",
          filesTotal: files.length,
          filesScanned: files.length,
          symbolsExtracted: 0,
          edgesExtracted: scipEdgeMutations,
          // Undefined scopes force full post-index repair without reparsing
          // source files when SCIP changed the graph. Empty sets intentionally
          // skip the full metrics path after direct missing-row repair.
          changedFileIdsForFinalize: needsFullPostIndexFinalize
            ? undefined
            : new Set<string>(),
          changedTestFilePathsForFinalize: undefined,
          changedFileIdsForMemory: new Set<string>(),
          hasIndexMutations: needsFullPostIndexFinalize,
          callResolutionTelemetry: createCallResolutionTelemetry({
            repoId,
            mode,
            pass2EligibleFileCount: 0,
          }),
          pass1Engine,
          scip: {
            generatedIndexes: scipResult.generatedIndexes,
            failures: scipResult.failures,
            generatorCache: scipPreRefresh?.cache,
          },
          preFinalize: needsDirectPostIndexRepair
            ? async () => {
                if (recovery.needsMetrics) {
                  await measurePhase("recoverMissingMetrics", () =>
                    recoverMissingMetricsForRepo(repoId, { onProgress }),
                  );
                }
                if (recovery.needsFileSummaries) {
                  await measurePhase("recoverFileSummaries", async () => {
                    const fsConn = await getLadybugConn();
                    await materializeFileSummaries(fsConn, repoId);
                  });
                }
              }
            : undefined,
        });
        summaryStats = postIndexResult.summaryStats;
        clustersComputed = postIndexResult.clustersComputed;
        processesTraced = postIndexResult.processesTraced;
        algorithmRefresh = postIndexResult.algorithmRefresh;
      } else {
        await measurePhase("memorySync", async () => {
          const memoryConn = await getLadybugConn();
          await flagStaleMemoriesForChangedFiles(
            memoryConn,
            repoId,
            new Set<string>(),
            versionId,
          );
          await importMemoryFilesFromDisk(repoRow.rootPath, repoId, versionId);
        });
      }

      const totalMs = Date.now() - startTime;
      const result: IndexResult = {
        versionId,
        filesProcessed: files.length,
        changedFiles: 0,
        removedFiles: 0,
        symbolsIndexed: 0,
        edgesCreated: scipEdgeMutations,
        clustersComputed,
        processesTraced,
        durationMs: totalMs,
        summaryStats,
        timings: phaseTimings ? { totalMs, phases: phaseTimings } : undefined,
        // Phase 1 Task 1.12 — no Pass-1 ran in this short-circuit, emit zeros
        // so downstream consumers see a stable shape.
        pass1Engine,
        scip: {
          generatedIndexes: scipResult.generatedIndexes,
          failures: scipResult.failures,
          generatorCache: scipPreRefresh?.cache,
        },
        providerFirst,
        providerFirstExecution: providerFirstExecutionFallback,
        algorithmRefresh,
      };

      invalidateIndexResultCaches(repoId);

      // Phase 1 Task 1.12 — emit `index.refresh.complete` audit event with
      // zero-valued Pass-1 engine telemetry (Pass 1 never ran in this
      // short-circuit no-op incremental path).
      // Ensure indexRepo() does not resolve while its own audit write is still
      // holding LadybugDB's single-writer slot.
      if (!needsDerivedRecovery) {
        await flushIndexEvent({
          repoId,
          versionId,
          stats: {
            filesScanned: result.filesProcessed,
            symbolsExtracted: result.symbolsIndexed,
            edgesExtracted: result.edgesCreated,
            durationMs: result.durationMs,
            errors: 0,
            pass1Engine,
            scip: result.scip,
            algorithmRefresh: result.algorithmRefresh,
          },
        });
      }
      return result;
    });
  }

  const providerFirstLegacyFallbackActive =
    providerFirstLegacyFallbackStartedAt !== undefined;
  const providerFirstLegacyFallbackCompleteForPass =
    providerFirstLegacyFallbackActive &&
    providerFirstLegacyFallbackComplete;
  let pass1ExistingByPath = existingByPath;
  if (mode === "full" && existingByPath.size > 0) {
    const existingFileIds = [
      ...new Set(Array.from(existingByPath.values(), (file) => file.fileId)),
    ];
    if (
      shouldDeleteExistingFilesBeforeFullPass1({
        mode,
        providerFirstLegacyFallbackActive,
        existingFileCount: existingFileIds.length,
      })
    ) {
      // Provider-first fallback can be rerun after a partial, versionless
      // attempt already wrote fallback File rows. Rebuild those rows from
      // scratch so LadybugDB does not collide while recreating relationships.
      await measurePhase("preDeleteExistingSymbols", () =>
        ladybugDb.deleteFilesByIds(conn, existingFileIds),
      );
    } else {
      await measurePhase("preDeleteExistingSymbols", () =>
        ladybugDb.deleteSymbolsByFileIds(conn, existingFileIds),
      );
    }
    // Full refresh has already replaced the old symbol graph up front, so the
    // pass-1 flush batches can skip per-file stale deletes. File IDs are stable
    // (`repoId:relPath`), so an empty map still reconstructs the same IDs.
    pass1ExistingByPath = new Map();
  }

  const concurrency = resolveProviderFirstPass1Concurrency({
    configuredConcurrency: appConfig.indexing?.concurrency,
    fileCount: files.length,
    providerFirstLegacyFallbackActive,
    providerFirstLegacyFallbackComplete:
      providerFirstLegacyFallbackCompleteForPass,
  });
  const useRustEngine = shouldUseRustPass1Engine({
    configuredEngine: appConfig.indexing?.engine,
    rustEngineAvailable: isRustEngineAvailable(),
    providerFirstLegacyFallbackActive,
    providerFirstLegacyFallbackComplete:
      providerFirstLegacyFallbackCompleteForPass,
  });
  const dirtyTsResolverPaths = collectDirtyTsResolverPaths({
    mode,
    files,
    existingByPath,
  });
  const createParserWorkerPool = shouldCreateParserWorkerPool({
    useRustEngine,
    providerFirstLegacyFallbackActive,
    providerFirstLegacyFallbackComplete:
      providerFirstLegacyFallbackCompleteForPass,
  });
  const useBatchPersist = shouldUseBatchPersistAccumulator({
    providerFirstLegacyFallbackActive,
    providerFirstLegacyFallbackComplete:
      providerFirstLegacyFallbackCompleteForPass,
  });
  const batchSymbolWriteMode = resolvePass1BatchSymbolWriteMode({
    providerFirstLegacyFallbackActive,
  });
  const stabilizeProviderFirstFallbackPass1 =
    providerFirstLegacyFallbackActive && useBatchPersist;
  const emitProviderFallbackInitProgress = (message: string): void => {
    if (!providerFirstLegacyFallbackActive) return;
    emitProviderFirstProgress(onProgress, "legacyFallbackInit", { message });
  };

  // Partial provider-first fallback stays inline because this bounded mixed
  // provider/fallback path has hit hard worker/native exits on large C++ repos.
  // Complete fallback can use the tuned legacy engines because there is no
  // intentionally skipped tail preventing a full graph handoff.
  let workerPool: ParserWorkerPool | null = null;
  let workerPoolSize = 0;
  if (createParserWorkerPool) {
    workerPoolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: appConfig.indexing?.workerPoolSize ?? undefined,
      concurrency,
      fileCount: files.length,
    });
    workerPool = new ParserWorkerPool(workerPoolSize);
  }
  if (useRustEngine) {
    logger.info("Using native Rust indexer engine for Pass 1");
  } else if (providerFirstLegacyFallbackActive) {
    logger.info(
      "Using TypeScript indexer engine for provider-first legacy fallback Pass 1",
      { files: files.length },
    );
  }
  emitProviderFallbackInitProgress(
    `pass 1 engine=${useRustEngine ? "rust" : "typescript"} ` +
      `fallback=${providerFirstLegacyFallbackCompleteForPass ? "complete" : "partial"} ` +
      `concurrency=${concurrency} workers=${workerPoolSize} ` +
      `batchPersist=${useBatchPersist ? "on" : "off"} ` +
      `autoDrain=${stabilizeProviderFirstFallbackPass1 ? "off" : "on"} ` +
      `nativeChunks=${stabilizeProviderFirstFallbackPass1 ? "serial" : "default"} ` +
      `drainBetweenChunks=${stabilizeProviderFirstFallbackPass1 ? "on" : "off"}`,
  );

  try {
    // --- Phase: initialize shared indexing state ---

    emitProviderFallbackInitProgress("initializing shared pass-1 state");
    const {
      tsResolver: initialTsResolver,
      allSymbolsByName,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
      symbolMapCache,
      symbolIndex,
      pendingCallEdges,
      createdCallEdges,
      pass2ResolverRegistry,
      pass2EligibleFiles,
      callResolutionTelemetry,
      supportsPass2FilePath,
    } = await measurePhase("initSharedState", async () => {
      logger.debug("Initializing TS call resolver", { repoId, useRustEngine });
      emitProviderFallbackInitProgress("initializing TS resolver");
      // Keep a lazy TS resolver handle available for Pass 2 without building
      // the heavy ts.Program during Pass 1. Large TS monorepos can otherwise
      // overlap the compiler program with Rust parse batches and hit V8's heap
      // ceiling before parsing finishes.
      const tsResolverTimings: Record<string, number> = {};
      const tsResolver = await measureNestedPhase(
        "initSharedState",
        "tsResolver",
        () => {
          return createLazyTsCallResolver(repoRow.rootPath, files, {
            includeNodeModulesTypes: config.includeNodeModulesTypes ?? true,
            dirtyRelPaths: dirtyTsResolverPaths,
            timingsOut: phaseTimings ? tsResolverTimings : undefined,
          });
        },
      );
      if (phaseTimings) {
        for (const [phaseName, durationMs] of Object.entries(
          tsResolverTimings,
        )) {
          phaseTimings[`initSharedState.tsResolver.${phaseName}`] = durationMs;
        }
      }
      logger.debug("TS call resolver initialized", {
        repoId,
        enabled: Boolean(tsResolver),
      });

      emitProviderFallbackInitProgress("loading existing symbol maps");
      const {
        symbolMapCache,
        allSymbolsByName,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
      } = await measureNestedPhase("initSharedState", "symbolMaps", () =>
        loadExistingSymbolMaps(conn, repoId, removedFileIds),
      );
      const symbolIndex: SymbolIndex = new Map();
      const pendingCallEdges: PendingCallEdge[] = [];
      const createdCallEdges = new Set<string>();
      emitProviderFallbackInitProgress("initializing pass-2 context");
      const {
        pass2ResolverRegistry,
        pass2EligibleFiles,
        callResolutionTelemetry,
        supportsPass2FilePath,
      } = await measureNestedPhase("initSharedState", "pass2Context", () =>
        initPass2Context(repoId, mode, files),
      );

      return {
        tsResolver,
        allSymbolsByName,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
        symbolMapCache,
        symbolIndex,
        pendingCallEdges,
        createdCallEdges,
        pass2ResolverRegistry,
        pass2EligibleFiles,
        callResolutionTelemetry,
        supportsPass2FilePath,
      };
    });
    emitProviderFallbackInitProgress("starting pass 1");
    let tsResolver = initialTsResolver;

    // --- Phase: Pass 1 — parse all files and extract symbols/edges ---
    onProgress?.({ stage: "parsing", current: 0, total: files.length });

    const pass1Params: Pass1Params = {
      repoId,
      repoRoot: repoRow.rootPath,
      config,
      mode,
      files,
      existingByPath: pass1ExistingByPath,
      symbolIndex,
      pendingCallEdges,
      createdCallEdges,
      tsResolver,
      allSymbolsByName,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
      pass2ResolverRegistry,
      supportsPass2FilePath,
      concurrency,
      workerPool,
      useBatchPersist,
      batchSymbolWriteMode,
      serializeNativePass1Chunks: stabilizeProviderFirstFallbackPass1,
      drainBatchPersistBetweenNativeChunks: stabilizeProviderFirstFallbackPass1,
      autoDrainBatchPersist: !stabilizeProviderFirstFallbackPass1,
      onProgress,
      signal,
      includeTimings: shouldCollectPostIndexSubphaseTimings(),
    };

    let pass1EngineUsed: "rust" | "ts" = useRustEngine ? "rust" : "ts";
    const pass1Acc: Pass1Accumulator = await measurePhase(
      "pass1",
      async () => {
        if (useRustEngine) {
          const outcome = await runPass1WithRustEngine(pass1Params);
          if (outcome.usedRust) return outcome.acc;
          // Native addon returned null — fall back to TS engine.
          pass1EngineUsed = "ts";
          return await runPass1WithTsEngine(pass1Params);
        }
        return await runPass1WithTsEngine(pass1Params);
      },
      { engine: useRustEngine ? "rust" : "ts" },
    );
    // Record actual engine used so engineDispatch reflects fallbacks.
    try {
      getObservabilityTap()?.indexPhase({
        phase: "_meta.pass1Engine",
        durationMs: 0,
        repoId,
        engine: pass1EngineUsed,
      });
    } catch {
      /* swallow */
    }

    const {
      filesProcessed,
      changedFiles: changedFilesFromPass1,
      totalSymbolsIndexed,
      allConfigEdges,
      changedFileIds: pass1ChangedFileIds,
      changedPass2FilePaths,
      symbolMapFileUpdates,
      drainPromise: pass1DrainPromise,
    } = pass1Acc;
    const changedFileIds = new Set(pass1ChangedFileIds);
    for (const fileId of providerFirstChangedFileIds) {
      changedFileIds.add(fileId);
    }
    let totalEdgesCreated =
      pass1Acc.totalEdgesCreated + providerFirstMaterializedEdges;
    let freshConn = conn;

    // --- Phase: refresh symbol index from DB (Pass 1 → Pass 2 bridge) ---
    //
    // Pass 1 returns with its BatchPersistAccumulator drain still in flight
    // (see indexer-pass1.ts). The two helpers below mutate ONLY in-memory
    // structures (symbolMapCache, symbolIndex) so they can run in parallel
    // with the still-flushing pass-1 writes — saves ~5-15s on repos where
    // the drain queue is non-trivial.
    await measurePhase("refreshSymbolIndex", () => {
      applySymbolMapFileUpdates(symbolMapCache, symbolMapFileUpdates.values());
      syncSymbolIndexFromCache(symbolMapCache, symbolIndex);
    });

    // --- Phase: SCIP ingest (between pass 1 and pass 2) ---
    //
    // SCIP overlays compiler-grade exact cross-references onto the heuristic
    // graph pass 1 just wrote. Running it BEFORE pass 2 means:
    //   1. Pass 2's heuristic resolvers see SCIP exact edges already in DB.
    //      `insertEdges` carries a confidence-aware guard so pass 2 cannot
    //      downgrade `resolution: "exact"` rows to its lower-confidence
    //      heuristic resolutions (see ladybug-edges.ts).
    //   2. Embeddings (later in finalize) build their import/call labels off
    //      exact resolutions instead of `unresolved:call:*` strings, so
    //      first-run cardhashes match what the next refresh would produce.
    //   3. SCIP-created external Symbol nodes (npm packages etc.) become
    //      visible to the embedding pre-pass and get embedded immediately
    //      rather than waiting for the next index run.
    //
    // SCIP must observe pass-1 writes — it MERGEs against symbolIds pass 1
    // just wrote. So we need pass1DrainPromise settled before SCIP starts.
    //
    // When SCIP is not configured (`scipIngestWillRun === false`), preserve
    // the previous full-mode optimisation: pass-1 drain ↔ pass-2 overlap via
    // Promise.all. SCIP-not-configured repos see no behaviour change beyond
    // an unconditional drain await in incremental mode (matches prior code).
    const willRunScip =
      scipIngestWillRun({ scip: appConfig.scip }) &&
      !providerFirstScipMaterialized &&
      !skipLegacyScipIngest;
    let pass2Edges: number;
    let scipDiagnostics = {
      generatedIndexes: scipPreRefresh?.generatedIndexes ?? [],
      failures: scipPreRefresh?.failures ?? [],
      generatorCache: scipPreRefresh?.cache,
    };
    const preloadedPass2ExportedSymbols =
      providerFirstScipMaterialized && providerFirstProviderRows
        ? buildPreloadedPass2ExportedSymbolsFromRows({
            files: providerFirstProviderRows.files,
            symbols: providerFirstProviderRows.symbols,
          })
        : undefined;
    if (willRunScip) {
      // SCIP path: drain → SCIP → pass 2 (sequential, all writeLimiter-bound).
      await measurePhase("pass1Drain", () => pass1DrainPromise);
      const scipResult = await measurePhase("scipIngest", () =>
        runScipIngestInsideIndex({
          repoId,
          repoRoot: repoRow.rootPath,
          config: appConfig,
          generatedIndexes: scipPreRefresh?.generatedIndexes,
          generatorFailures: scipPreRefresh?.failures,
          onProgress,
        }),
      );
      scipDiagnostics = {
        generatedIndexes: scipResult.generatedIndexes,
        failures: scipResult.failures,
        generatorCache: scipPreRefresh?.cache,
      };
      // After ingest, delete the generator-produced `<repoRoot>/index.scip`
      // when the user has enabled both the generator and cleanup. Skipped
      // when `--output` is in args (we can't safely guess the location);
      // those users opt out by setting `cleanupAfterIngest: false`.
      const { maybeCleanupGeneratedScipIndex } =
        await import("../scip/cleanup.js");
      await maybeCleanupGeneratedScipIndex({
        generatorEnabled: Boolean(appConfig.scip?.generator?.enabled),
        cleanupAfterIngest: Boolean(
          appConfig.scip?.generator?.cleanupAfterIngest,
        ),
        args: appConfig.scip?.generator?.args ?? [],
        repoRootPath: repoRow.rootPath,
        generatedPaths: scipResult.generatedIndexes
          .filter((index) => !index.skipped)
          .map((index) => index.path),
      });
      // Per-file coverage feeds the pass-2 file-skip optimisation:
      // resolver work avoided on files SCIP fully resolved. The
      // `insertEdges` confidence guard already protected SCIP exact edges
      // from being downgraded; this skip avoids the wasted CPU of running
      // resolvers whose writes the guard would have ignored anyway.
      pass2Edges = await measurePhase("pass2", async () =>
        runPass2Resolvers({
          repoId,
          repoRoot: repoRow.rootPath,
          mode,
          pass2EligibleFiles,
          changedPass2FilePaths,
          supportsPass2FilePath,
          pass2ResolverRegistry,
          symbolIndex,
          tsResolver,
          config,
          pass2Concurrency: appConfig.indexing?.pass2Concurrency ?? 4,
          createdCallEdges,
          globalNameToSymbolIds,
          globalPreferredSymbolId,
          callResolutionTelemetry,
          onProgress,
          signal,
          scipFullyCoveredPaths: scipResult.fullyCoveredPaths,
          pass1Extractions: pass1Acc.pass1Extractions,
          preloadedExportedSymbols: preloadedPass2ExportedSymbols,
          recordTiming: recordPass2SubphaseTiming,
        }),
      );
    } else {
      // No-SCIP path. Pass 2 calls getFileByRepoPath/getSymbolsByFile per file. Those
      // reads must see pass-1's File/Symbol writes settled or pass 2 returns
      // 0 edges. The previous full-mode `resolvePass2Targets is a no-op so
      // skip the drain` shortcut was incorrect — the per-file DB reads still
      // need pass-1 settled regardless of mode.
      await measurePhase("pass1Drain", () => pass1DrainPromise);
      const pass2Task = measurePhase("pass2", async () =>
        runPass2Resolvers({
          repoId,
          repoRoot: repoRow.rootPath,
          mode,
          pass2EligibleFiles,
          changedPass2FilePaths,
          supportsPass2FilePath,
          pass2ResolverRegistry,
          symbolIndex,
          tsResolver,
          config,
          pass2Concurrency: appConfig.indexing?.pass2Concurrency ?? 4,
          createdCallEdges,
          globalNameToSymbolIds,
          globalPreferredSymbolId,
          callResolutionTelemetry,
          onProgress,
          signal,
          pass1Extractions: pass1Acc.pass1Extractions,
          preloadedExportedSymbols: preloadedPass2ExportedSymbols,
          recordTiming: recordPass2SubphaseTiming,
        }),
      );
      // Always settle the drain before moving past pass 2 — finalizeEdges
      // and every downstream phase reads the persisted graph state.
      [pass2Edges] = await Promise.all([pass2Task, pass1DrainPromise]);
    }
    if (phaseTimings && pass1Acc.pass1DrainDiagnostics) {
      for (const [phaseName, phase] of Object.entries(
        pass1Acc.pass1DrainDiagnostics.phases,
      )) {
        phaseTimings[`pass1Drain.write.${phaseName}`] = phase.totalMs;
      }
    }
    if (
      providerFirstLegacyFallbackStartedAt !== undefined &&
      pass1Acc.pass1DrainDiagnostics
    ) {
      for (const [phaseName, phase] of Object.entries(
        pass1Acc.pass1DrainDiagnostics.phases,
      )) {
        const key = `pass1Drain.write.${phaseName}`;
        providerFirstLegacyFallbackPhaseTimings[key] =
          (providerFirstLegacyFallbackPhaseTimings[key] ?? 0) + phase.totalMs;
      }
    }
    totalEdgesCreated += pass2Edges;

    // Emit finalizing immediately after Pass 2 so the user sees feedback
    // before the silent internal phases (import re-resolution, edge
    // finalization, metrics, clusters, processes) begin.
    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: files.length,
    });

    // --- Phase: re-resolve unresolved import edges ---
    //
    // Initial emit uses 0/0 so the CLI shows `Import re-resolution...` until
    // we know the actual edge count. The resolver fires per-chunk progress
    // updates via `onChunkComplete` as it processes batches; that's the bar
    // the user actually watches advance.
    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: 0,
      substage: "importReresolution",
    });
    const importReResolution = await measurePhase(
      "resolveUnresolvedImports",
      () =>
        resolveUnresolvedImportEdges(repoId, {
          includeTimings: Boolean(phaseTimings),
          // Skip path filter on full reindex — listing every file becomes
          // O(N) STARTS WITH OR-clauses inside fetchEdges, often slower than
          // an unfiltered scan once the change set covers most of the repo.
          affectedPaths:
            mode === "incremental"
              ? new Set<string>([
                  ...changedPass2FilePaths,
                  ...Array.from(
                    symbolMapFileUpdates.values(),
                    (update) => update.relPath,
                  ),
                ])
              : undefined,
          onChunkComplete: (current, total) => {
            onProgress?.({
              stage: "finalizing",
              current,
              total,
              substage: "importReresolution",
              stageCurrent: current,
              stageTotal: total,
            });
          },
        }),
    );
    if (phaseTimings && importReResolution.timings) {
      for (const [phaseName, durationMs] of Object.entries(
        importReResolution.timings,
      )) {
        phaseTimings[`resolveUnresolvedImports.${phaseName}`] = durationMs;
      }
    }
    if (importReResolution.resolved > 0) {
      logger.info("Re-resolved unresolved import edges", {
        repoId,
        resolved: importReResolution.resolved,
        total: importReResolution.total,
      });
      totalEdgesCreated += importReResolution.resolved;
    }
    const changedFiles =
      changedFilesFromPass1 + providerFirstChangedFileIds.size + removedFiles;
    const totalFilesProcessed = filesProcessed + providerFirstMaterializedFiles;
    const totalSymbolsIndexedAll =
      totalSymbolsIndexed + providerFirstMaterializedSymbols;

    // --- Phase: release pass2 memory before edge finalization ---

    // Keep the TS compiler cache warm across incremental refreshes so repeated
    // no-op or small refreshes do not repay full program startup. Full reindex
    // runs still clear the repo-scoped cache to cap memory for large repos.
    if (mode === "full") {
      clearTsCallResolverCache(repoRow.rootPath);
    }
    tsResolver = null;

    // --- Phase: finalize edges (pending calls + config edges) ---

    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: files.length,
      substage: "edgeFinalize",
    });
    const configEdgeWeight =
      appConfig.slice?.edgeWeights?.config !== undefined
        ? appConfig.slice.edgeWeights.config
        : 0.8;
    const { configEdgesCreated } = await measurePhase("finalizeEdges", () =>
      finalizeEdges({
        repoId,
        pendingCallEdges,
        symbolIndex,
        createdCallEdges,
        allConfigEdges,
        configEdgeWeight,
        measurePhase: <T>(
          phaseName: string,
          fn: () => Promise<T> | T,
        ): Promise<T> => measureNestedPhase("finalizeEdges", phaseName, fn),
      }),
    );

    // --- Phase: release edge-building memory before version/cluster phases ---

    // These accumulators are no longer needed after edge finalization.
    // Clearing them before versioning/cluster computation prevents holding
    // several full-repo symbol maps while the version snapshot reads symbols.
    pendingCallEdges.length = 0;
    createdCallEdges.clear();
    symbolIndex.clear();
    symbolMapFileUpdates.clear();
    pass1Acc.pass1Extractions.clear();
    symbolMapCache.symbolsByFileId.clear();
    symbolMapCache.filePathById.clear();
    allSymbolsByName.clear();
    globalNameToSymbolIds.clear();
    globalPreferredSymbolId.clear();
    symbolMapCache.symbolIndex.clear();
    clearSymbolMapCache(repoId);
    allConfigEdges.length = 0;

    // --- Phase: version management ---

    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: files.length,
      substage: "versionSnapshot",
    });
    const versionReason = mode === "full" ? "Full index" : "Incremental index";
    const hasActualChanges = changedFiles > 0 || totalEdgesCreated > 0;
    const versionId = await measurePhase("versionSnapshot", () =>
      createOrReuseVersion(
        versionReason,
        mode === "incremental" && hasActualChanges,
      ),
    );

    // --- Phase: post-index metrics (summaries, clusters, processes,
    // deferred indexes, memory sync, audit flush) ---
    //
    // All DB writes from finalizeIndexing through the index-event audit log
    // are routed through a single post-index session that holds the
    // writeLimiter end-to-end. Other writers (audit logs from interactive
    // tools, live-index reconcile) detect the session via
    // getActivePostIndexSession() and buffer rather than racing for a write
    // txn. Inside the session body, withWriteConn() reuses the session conn
    // directly via AsyncLocalStorage so nested write paths don't deadlock
    // waiting for the limiter slot they already own.
    const sessionEdgeTotal = totalEdgesCreated + configEdgesCreated;
    const phaseOutcome = await withPostIndexWriteSession(
      async () => {
        const changedFileIdsParam =
          mode === "incremental" || scopedSourceFileListActive
            ? changedFileIds
            : undefined;
        const changedTestFilePathsParam =
          mode === "incremental" ? changedPass2FilePaths : undefined;
        const hasIndexMutations = changedFiles > 0 || totalEdgesCreated > 0;
        const deferSemanticRefresh = providerFirstScipMaterialized;
        const finalizeResult = await measurePhase("finalizeIndexing", () =>
          finalizeIndexing({
            repoId,
            versionId,
            appConfig,
            changedFileIds: changedFileIdsParam,
            changedTestFilePaths: changedTestFilePathsParam,
            preloadedSymbolFactsByFile:
              providerFirstScipMaterialized && providerFirstProviderRows
                ? buildPreloadedFileSummarySymbolFactsFromRows({
                    files: providerFirstProviderRows.files,
                    symbols: providerFirstProviderRows.symbols,
                  })
                : undefined,
            hasIndexMutations,
            includeTimings: shouldCollectPostIndexSubphaseTimings(),
            callResolutionTelemetry,
            deferSemanticRefresh,
            onProgress,
          }),
        );
        recordFinalizeIndexingSubphaseTimings(finalizeResult.timings);

        // Refresh read connection again after version/metrics writes.
        freshConn = await getLadybugConn();
        const derivedResult = providerFirstSkipDerivedStateReason
          ? await measurePhase("skipDerivedState", async () => {
              await markDerivedStateDirty(repoId, versionId, {
                clusters: true,
                processes: true,
                algorithms: true,
              });
              await recordDerivedStateError(
                repoId,
                providerFirstSkipDerivedStateReason ?? "",
              );
              return skippedDerivedStateResult(
                providerFirstSkipDerivedStateReason ?? "",
              );
            })
          : await finalizeDerivedState({
              mode,
              conn: freshConn,
              repoId,
              versionId,
              filesTotal: files.length + providerFirstMaterializedFiles,
              phaseTimings,
              algorithmRefresh: appConfig.indexing?.algorithmRefresh,
              onProgress,
              extraPhaseTimings:
                providerFirstLegacyFallbackStartedAt !== undefined
                  ? providerFirstLegacyFallbackPhaseTimings
                  : undefined,
              sharedGraph: finalizeResult.sharedGraph,
              measurePhase,
            });

        if (finalizeResult.semanticDeferred) {
          await markDeferredSemanticStateDirty({
            repoId,
            versionId,
            appConfig,
          });
        }

        // --- Phase: build deferred indexes (fresh DB only) ---
        await measurePhase("buildDeferredIndexes", async () => {
          await buildDeferredIndexes({
            deferSemanticVectorIndexes: finalizeResult.semanticDeferred,
            deferSemanticTextIndexes: finalizeResult.semanticDeferred,
            recordTiming: recordIndexSubphaseTiming,
          });
        });

        // --- Phase: memory management (staleness flagging + file import) ---
        await measurePhase("memorySync", async () => {
          await flagStaleMemoriesForChangedFiles(
            freshConn,
            repoId,
            changedFileIds,
            versionId,
          );
          await importMemoryFilesFromDisk(repoRow.rootPath, repoId, versionId);
        });

        // --- Phase: index-event audit flush ---
        // Kept inside the session so it doesn't race writers that may run
        // immediately after we release the limiter.
        await flushIndexEvent({
          repoId,
          versionId,
          stats: {
            filesScanned: totalFilesProcessed,
            symbolsExtracted: totalSymbolsIndexedAll,
            edgesExtracted: sessionEdgeTotal,
            // Wall-clock from indexRepo start through the audit-flush call —
            // captured here (not before the session) so the recorded duration
            // includes finalizeIndexing, embeddings, deferred indexes, etc.
            durationMs: Date.now() - startTime,
            errors: 0,
            pass1Engine: derivePass1EngineTelemetry(pass1Acc),
            fileSummaryEmbeddings: finalizeResult.fileSummaryEmbeddingStats,
            semanticDeferred: finalizeResult.semanticDeferred,
            quality: finalizeResult.qualityStats,
            scip: scipDiagnostics,
            algorithmRefresh: derivedResult.algorithmRefresh,
          },
        });

        return {
          summaryStats: finalizeResult.summaryStats,
          semanticDeferred: finalizeResult.semanticDeferred,
          clustersComputed: derivedResult.clustersComputed,
          processesTraced: derivedResult.processesTraced,
          algorithmRefresh: derivedResult.algorithmRefresh,
        };
      },
      { timeoutMs: postIndexSessionTimeoutMs },
    );

    const {
      summaryStats,
      semanticDeferred,
      clustersComputed,
      processesTraced,
      algorithmRefresh,
    } = phaseOutcome;
    if (providerFirstLegacyFallbackStartedAt !== undefined) {
      const legacyFallbackDurationMs =
        Date.now() - providerFirstLegacyFallbackStartedAt;
      recordProviderFirstPhaseTiming(
        "legacyFallback",
        legacyFallbackDurationMs,
      );
      if (providerFirstExecutedSummary) {
        const files = providerFirstLegacyFallbackFileCount;
        providerFirstExecutedSummary = {
          ...providerFirstExecutedSummary,
          legacyFallbackDiagnostics: {
            files,
            durationMs: legacyFallbackDurationMs,
            averageMsPerFile:
              files > 0 ? Math.round(legacyFallbackDurationMs / files) : 0,
            samplePaths: providerFirstLegacyFallbackSamplePaths,
            omittedPathCount: Math.max(
              0,
              files - providerFirstLegacyFallbackSamplePaths.length,
            ),
            phases: { ...providerFirstLegacyFallbackPhaseTimings },
            resolverBreakdown:
              snapshotPass2ResolverBreakdown(callResolutionTelemetry),
          },
        };
      }
      providerFirstLegacyFallbackStartedAt = undefined;
      providerFirstLegacyFallbackComplete = false;
    }
    if (
      providerFirstScipMaterialized &&
      providerFirstExecutedSummary &&
      providerFirstProviderRows &&
      providerFirstGenerationId &&
      providerFirstFallbackPaths.size > 0
    ) {
      const shadowBuild = providerFirstShadowStagingSkipReason
        ? (() => {
            const shadowStageTotal =
              providerFirstGraphRowTotal(providerFirstProviderRows);
            emitProviderFirstProgress(onProgress, "shadowStage", {
              stageCurrent: 0,
              stageTotal: shadowStageTotal,
              message: `shadow staging skipped: ${providerFirstShadowStagingSkipReason}`,
            });
            return skippedProviderFirstShadowBuild({
              generationId: providerFirstGenerationId,
              activation: providerFirstConfig.activation,
              requestedFormat: providerFirstConfig.stagingFormat,
              rows: providerFirstProviderRows,
              reason: providerFirstShadowStagingSkipReason,
            });
          })()
        : await (async () => {
            emitProviderFirstProgress(onProgress, "shadowStage", {
              message: "collecting fallback rows for shadow bulk load",
            });
            return await measureProviderFirstPhase(
              "shadowStageFinal",
              "providerFirstShadowStageFinal",
              async () => {
                const shadowConn = await getLadybugConn();
                const fallbackRows = await collectLegacyFallbackShadowRows({
                  conn: shadowConn,
                  repoId,
                  relPaths: providerFirstFallbackPaths,
                  providerRows: providerFirstProviderRows,
                });
                const combinedRows = mergeProviderFirstGraphRows(
                  providerFirstProviderRows,
                  fallbackRows,
                );
                const shadowStageTotal =
                  providerFirstGraphRowTotal(combinedRows);
                emitProviderFirstProgress(onProgress, "shadowStage", {
                  stageCurrent: 0,
                  stageTotal: shadowStageTotal,
                  message:
                    "staging provider and fallback rows for shadow bulk load",
                });
                const staged = await stageProviderFirstShadowBuild({
                  repoId,
                  generationId: providerFirstGenerationId,
                  activation: providerFirstConfig.activation,
                  requestedFormat: providerFirstConfig.stagingFormat,
                  activeDbPath: getLadybugDbPath(),
                  repoRoot: repoRow.rootPath,
                  repoConfigJson: repoRow.configJson,
                  rows: combinedRows,
                });
                if (staged.status === "staged") {
                  const stagedTotal = providerFirstShadowStageTotal(
                    staged.counts,
                  );
                  emitProviderFirstProgress(onProgress, "shadowStage", {
                    stageCurrent: stagedTotal,
                    stageTotal: stagedTotal,
                    message:
                      "provider and fallback rows staged for shadow bulk load",
                  });
                }
                return staged;
              },
            );
          })();
      const finalizedShadowBuild = await finalizeProviderFirstShadowBuild(
        shadowBuild,
        versionId,
      );
      providerFirstExecutedSummary = {
        ...providerFirstExecutedSummary,
        shadowBuild: finalizedShadowBuild,
      };
    }
    providerFirstExecutedSummary = withProviderFirstPhaseTimings(
      providerFirstExecutedSummary,
    );
    const totalMs = Date.now() - startTime;

    const result: IndexResult = {
      versionId,
      filesProcessed: totalFilesProcessed,
      changedFiles,
      removedFiles,
      symbolsIndexed: totalSymbolsIndexedAll,
      edgesCreated: sessionEdgeTotal,
      clustersComputed,
      processesTraced,
      // Full wall-clock from indexRepo start through the post-index session
      // (finalizeIndexing, embeddings, summaries, deferred indexes, memory
      // sync, audit flush). Earlier this captured Date.now() right after the
      // versionSnapshot phase, which silently excluded the entire post-index
      // session — visible to users as a "Duration" several minutes shorter
      // than the actual wall time on full reindexes with embeddings.
      durationMs: totalMs,
      summaryStats,
      timings: phaseTimings
        ? {
            totalMs,
            phases: phaseTimings,
            pass1Drain: pass1Acc.pass1DrainDiagnostics,
          }
        : undefined,
      // Phase 1 Task 1.12 — surface Pass-1 engine breakdown so tests and
      // tooling can inspect Rust coverage / fallback rates without scraping
      // the audit log.
      pass1Engine: derivePass1EngineTelemetry(pass1Acc),
      scip: scipDiagnostics,
      providerFirst,
      providerFirstExecution:
        providerFirstExecutedSummary ?? providerFirstExecutionFallback,
      semanticDeferred,
      algorithmRefresh,
    };

    invalidateIndexResultCaches(repoId);

    return result;
  } finally {
    if (workerPool) {
      await workerPool.shutdown();
    }
  }
}

export {
  getWatcherHealth,
  getAllWatcherHealth,
  _setWatcherHealthForTesting,
  _clearWatcherHealthForTesting,
} from "./watcher.js";

export async function watchRepository(
  repoId: string,
): Promise<IndexWatchHandle> {
  return watchRepositoryWithIndexer(repoId, indexRepo);
}
