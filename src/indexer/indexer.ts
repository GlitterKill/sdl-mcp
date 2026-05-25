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
import { scanRepoForIndex } from "./scanner.js";
import {
  finalizeIndexing,
  materializeFileSummaries,
  type SummaryBatchResult,
} from "./metrics-updater.js";
import { finalizeDerivedState } from "./finalize-derived-state.js";
import type { AlgorithmRefreshDiagnostics } from "./cluster-orchestrator.js";
import { watchRepositoryWithIndexer } from "./watcher.js";
import type { AppConfig, RepoConfig } from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { buildDeferredIndexes, getLadybugConn } from "../db/ladybug.js";
import { withPostIndexWriteSession } from "../db/write-session.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  derivedStateIsStale,
  getDerivedState,
} from "../db/ladybug-derived-state.js";
import { logger } from "../util/logger.js";
import { flushIndexEvent } from "../mcp/telemetry.js";
import { getObservabilityTap } from "../observability/event-tap.js";
import { isRustEngineAvailable } from "./rustIndexer.js";
import {
  clearTsCallResolverCache,
  createTsCallResolver,
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
import { runPass2Resolvers, finalizeEdges } from "./indexer-pass2.js";
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
import { preIndexCheckpoint } from "../db/ladybug.js";
import {
  runScipIngestInsideIndex,
  scipIngestWillRun,
} from "../scip/ingestion.js";
import type {
  ScipFailureDiagnostic,
  ScipGeneratedIndexDiagnostic,
} from "../scip/diagnostics.js";
import type { BatchPersistDrainDiagnostics } from "./parser/batch-persist.js";
import { resolveProviderFirstPipeline } from "./provider-first/planner.js";
import type { ProviderFirstPipelineSelection } from "./provider-first/types.js";
export type { IndexProgress, IndexProgressSubstage } from "./indexer-init.js";
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
  };
  providerFirst?: ProviderFirstPipelineSelection;
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

async function countSymbolVersionsForVersion(versionId: string): Promise<number> {
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
    reasons.push(`file summaries incomplete (${fileSummaryCount}/${fileCount})`);
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
  // Keep timing capture opt-in so normal refreshes pay essentially no overhead.
  const measurePhase = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
    meta?: { language?: string; engine?: "rust" | "ts" },
  ): Promise<T> => {
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      const durationMs = Date.now() - phaseStart;
      if (phaseTimings) phaseTimings[phaseName] = durationMs;
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

  const appConfig: AppConfig = loadConfig();
  const providerFirst = resolveProviderFirstPipeline({
    indexing: appConfig.indexing,
    scip: appConfig.scip,
    semanticEnrichment: appConfig.semanticEnrichment,
  });
  if (providerFirst.selectedPipeline === "providerFirst") {
    logger.info(
      "indexRepo: provider-first plan selected; legacy materializer remains the fallback path for this refresh",
      {
        repoId,
        sources: providerFirst.sources.map((source) => source.type),
        warnings: providerFirst.warnings,
      },
    );
  }
  const postIndexSessionTimeoutMs = resolvePostIndexSessionTimeoutMs(
    repoId,
    appConfig.repos,
    config,
  );

  const {
    files,
    existingByPath,
    removedFiles,
    removedFileIds,
    allFilesUnchanged: scanAllFilesUnchanged,
  } = await measurePhase("scanRepo", () =>
    scanRepoForIndex({
      repoId,
      repoRoot: repoRow.rootPath,
      config,
      onProgress,
    }),
  );
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

  const createOrReuseVersion = async (
    versionReason: string,
    forceNewVersion = false,
  ): Promise<string> =>
    measurePhase("versioning", async () => {
      const latestConn = await getLadybugConn();
      const latestVersion = await ladybugDb.getLatestVersion(
        latestConn,
        repoId,
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
          });
        }
        return versionId;
      }

      const versionId = `v${Date.now()}`;
      await createVersionAndSnapshot({
        repoId,
        versionId,
        reason: versionReason,
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
    preFinalize?: () => Promise<void>;
  }): Promise<{
    summaryStats?: SummaryBatchResult;
    clustersComputed: number;
    processesTraced: number;
    algorithmRefresh: AlgorithmRefreshDiagnostics;
  }> =>
    withPostIndexWriteSession(async () => {
      await params.preFinalize?.();
      const finalizeResult = await measurePhase("finalizeIndexing", () =>
        finalizeIndexing({
          repoId,
          versionId: params.versionId,
          appConfig,
          changedFileIds: params.changedFileIdsForFinalize,
          changedTestFilePaths: params.changedTestFilePathsForFinalize,
          hasIndexMutations: params.hasIndexMutations,
          includeTimings: Boolean(phaseTimings),
          callResolutionTelemetry: params.callResolutionTelemetry,
          onProgress,
        }),
      );
      if (phaseTimings && finalizeResult.timings) {
        for (const [phaseName, phaseDurationMs] of Object.entries(
          finalizeResult.timings,
        )) {
          phaseTimings[`finalizeIndexing.${phaseName}`] = phaseDurationMs;
        }
      }

      const freshConn = await getLadybugConn();
      const derivedResult = await finalizeDerivedState({
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

      await measurePhase("buildDeferredIndexes", async () => {
        await buildDeferredIndexes();
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
          quality: finalizeResult.qualityStats,
          scip: params.scip,
          algorithmRefresh: derivedResult.algorithmRefresh,
        },
      });

      return {
        summaryStats: finalizeResult.summaryStats,
        clustersComputed: derivedResult.clustersComputed,
        processesTraced: derivedResult.processesTraced,
        algorithmRefresh: derivedResult.algorithmRefresh,
      };
    }, { timeoutMs: postIndexSessionTimeoutMs });

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
          snapshotCurrentSymbolsForVersion({ repoId, versionId }),
        );
      }

      const scipResult = scipIngestWillRun({ scip: appConfig.scip })
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
        },
        providerFirst,
        algorithmRefresh,
      };

      invalidateGraphSnapshot(repoId);
      clearOverviewCache();
      clearSliceCache();
      clearFingerprintCollisionLog();

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

  let pass1ExistingByPath = existingByPath;
  if (mode === "full" && existingByPath.size > 0) {
    const existingFileIds = [
      ...new Set(Array.from(existingByPath.values(), (file) => file.fileId)),
    ];
    await measurePhase("preDeleteExistingSymbols", () =>
      ladybugDb.deleteSymbolsByFileIds(conn, existingFileIds),
    );
    // Full refresh has already replaced the old symbol graph up front, so the
    // pass-1 flush batches can skip per-file stale deletes. File IDs are stable
    // (`repoId:relPath`), so an empty map still reconstructs the same IDs.
    pass1ExistingByPath = new Map();
  }

  onProgress?.({ stage: "parsing", current: 0, total: files.length });
  const concurrency = Math.max(
    1,
    Math.min(appConfig.indexing?.concurrency ?? 4, files.length || 1),
  );
  const useRustEngine =
    appConfig.indexing?.engine === "rust" && isRustEngineAvailable();
  const dirtyTsResolverPaths = collectDirtyTsResolverPaths({
    mode,
    files,
    existingByPath,
  });

  // Only create worker pool for TypeScript engine
  let workerPool: ParserWorkerPool | null = null;
  if (!useRustEngine) {
    const workerPoolSize = resolveParserWorkerPoolSize({
      configuredWorkerPoolSize: appConfig.indexing?.workerPoolSize ?? undefined,
      concurrency,
      fileCount: files.length,
    });
    workerPool = new ParserWorkerPool(workerPoolSize);
  }
  if (useRustEngine) logger.info("Using native Rust indexer engine for Pass 1");

  try {
    // --- Phase: initialize shared indexing state ---

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
      // When using the Rust engine for Pass 1, defer TS compiler resolver
      // creation until Pass 2 where it provides type-aware call resolution
      // that the import-based resolver cannot.
      const tsResolverTimings: Record<string, number> = {};
      const tsResolver = await measureNestedPhase(
        "initSharedState",
        "tsResolver",
        // Fix 4: Create TS resolver eagerly when repo has TS/JS files,
        // so it is warm for Pass 1 call resolution and avoids cold-start
        // penalty before Pass 2. Skip for pure non-TS repos.
        // Fix 4: TS resolver created eagerly in initSharedState — no deferred
        // creation needed downstream.
        () => {
          const hasTsFiles = files.some((f) => /.[cm]?[jt]sx?$/.test(f.path));
          if (!hasTsFiles) return null;
          return createTsCallResolver(repoRow.rootPath, files, {
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
    let tsResolver = initialTsResolver;

    // --- Phase: Pass 1 — parse all files and extract symbols/edges ---

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
      onProgress,
      signal,
      includeTimings: Boolean(phaseTimings),
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
      changedFileIds,
      changedPass2FilePaths,
      symbolMapFileUpdates,
      drainPromise: pass1DrainPromise,
    } = pass1Acc;
    let { totalEdgesCreated } = pass1Acc;
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
    const willRunScip = scipIngestWillRun({ scip: appConfig.scip });
    let pass2Edges: number;
    let scipDiagnostics = {
      generatedIndexes: scipPreRefresh?.generatedIndexes ?? [],
      failures: scipPreRefresh?.failures ?? [],
    };
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
    const changedFiles = changedFilesFromPass1 + removedFiles;

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
    const phaseOutcome = await withPostIndexWriteSession(async () => {
      const changedFileIdsParam =
        mode === "incremental" ? changedFileIds : undefined;
      const changedTestFilePathsParam =
        mode === "incremental" ? changedPass2FilePaths : undefined;
      const hasIndexMutations = changedFiles > 0 || totalEdgesCreated > 0;
      const finalizeResult = await measurePhase("finalizeIndexing", () =>
        finalizeIndexing({
          repoId,
          versionId,
          appConfig,
          changedFileIds: changedFileIdsParam,
          changedTestFilePaths: changedTestFilePathsParam,
          hasIndexMutations,
          includeTimings: Boolean(phaseTimings),
          callResolutionTelemetry,
          onProgress,
        }),
      );
      if (phaseTimings && finalizeResult.timings) {
        for (const [phaseName, phaseDurationMs] of Object.entries(
          finalizeResult.timings,
        )) {
          phaseTimings[`finalizeIndexing.${phaseName}`] = phaseDurationMs;
        }
      }

      // Refresh read connection again after version/metrics writes.
      freshConn = await getLadybugConn();
      const derivedResult = await finalizeDerivedState({
        mode,
        conn: freshConn,
        repoId,
        versionId,
        filesTotal: files.length,
        phaseTimings,
        algorithmRefresh: appConfig.indexing?.algorithmRefresh,
        onProgress,
        sharedGraph: finalizeResult.sharedGraph,
        measurePhase,
      });

      // --- Phase: build deferred indexes (fresh DB only) ---
      await measurePhase("buildDeferredIndexes", async () => {
        await buildDeferredIndexes();
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
          filesScanned: filesProcessed,
          symbolsExtracted: totalSymbolsIndexed,
          edgesExtracted: sessionEdgeTotal,
          // Wall-clock from indexRepo start through the audit-flush call —
          // captured here (not before the session) so the recorded duration
          // includes finalizeIndexing, embeddings, deferred indexes, etc.
          durationMs: Date.now() - startTime,
          errors: 0,
          pass1Engine: derivePass1EngineTelemetry(pass1Acc),
          fileSummaryEmbeddings: finalizeResult.fileSummaryEmbeddingStats,
          quality: finalizeResult.qualityStats,
          scip: scipDiagnostics,
          algorithmRefresh: derivedResult.algorithmRefresh,
        },
      });

      return {
        summaryStats: finalizeResult.summaryStats,
        clustersComputed: derivedResult.clustersComputed,
        processesTraced: derivedResult.processesTraced,
        algorithmRefresh: derivedResult.algorithmRefresh,
      };
    }, { timeoutMs: postIndexSessionTimeoutMs });

    const {
      summaryStats,
      clustersComputed,
      processesTraced,
      algorithmRefresh,
    } = phaseOutcome;
    const totalMs = Date.now() - startTime;

    const result: IndexResult = {
      versionId,
      filesProcessed,
      changedFiles,
      removedFiles,
      symbolsIndexed: totalSymbolsIndexed,
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
      algorithmRefresh,
    };

    invalidateGraphSnapshot(repoId);
    clearOverviewCache();
    clearSliceCache();
    clearFingerprintCollisionLog();

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
