import type { PendingCallEdge, SymbolIndex } from "./edge-builder.js";
// =============================================================================
// indexer.ts — Repository indexing entry point and watcher orchestrator.
//
// Public exports (LLM-cost cheat sheet):
//   Functions:
//     - indexRepo(repoId, mode, onProgress?, signal?, options?) — full/incremental indexing run
//     - watchRepository(repoId) — start file watcher (delegates to watchRepositoryWithIndexer)
//     - derivePass1EngineTelemetry(acc) — surface per-language Pass-1 engine breakdown
//   Types:
//     - IndexResult, IndexRepoOptions, IndexTimingDiagnostics, IndexWatchHandle, WatcherHealth
//     - IndexProgress, IndexProgressSubstage (re-exported from ./indexer-init.js)
//     - ResolveParserWorkerPoolSizeParams, ProcessFileParams (re-exported from ./parser.js)
//   Re-exports from ./watcher.js:
//     - getWatcherHealth, getAllWatcherHealth, _setWatcherHealthForTesting, _clearWatcherHealthForTesting
//   Re-exports from ./parser.js:
//     - resolveParserWorkerPoolSize
//
// Heavy lifting is delegated to siblings: indexer-pass1.ts, indexer-pass2.ts,
// indexer-init.ts, indexer-version.ts, indexer-memory.ts, metrics-updater.ts,
// finalize-derived-state.ts, watcher.ts. This file is the sequencer.
// =============================================================================


import {
  isTsCallResolutionFile,
  resolveUnresolvedImportEdges,
} from "./edge-builder.js";
import { resolveParserWorkerPoolSize } from "./parser.js";
import { scanRepoForIndex } from "./scanner.js";
import {
  finalizeIndexing,
  type SummaryBatchResult,
} from "./metrics-updater.js";
import { finalizeDerivedState } from "./finalize-derived-state.js";
import { watchRepositoryWithIndexer } from "./watcher.js";
import type { RepoConfig } from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
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
import { createVersionAndSnapshot } from "./indexer-version.js";
import {
  runPass1WithRustEngine,
  runPass1WithTsEngine,
} from "./indexer-pass1.js";
import { runPass2Resolvers, finalizeEdges } from "./indexer-pass2.js";
import {
  applySymbolMapFileUpdates,
  syncSymbolIndexFromCache,
} from "./symbol-map-cache.js";
import {
  flagStaleMemoriesForChangedFiles,
  importMemoryFilesFromDisk,
} from "./indexer-memory.js";
import { withIndexingGate } from "../mcp/indexing-gate.js";
import { preIndexCheckpoint } from "../db/ladybug.js";

export type { IndexProgress, IndexProgressSubstage } from "./indexer-init.js";

export interface IndexTimingDiagnostics {
  totalMs: number;
  phases: Record<string, number>;
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
  await runScipIoPreRefreshForIndex(repoId, signal);

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

  const resultPromise = withIndexingGate(async () => {
    // Flush WAL before large indexing runs open their own transactions.
    // Incremental refreshes are often tiny/no-op and can run frequently;
    // forcing CHECKPOINT on every incremental call can become a contention
    // hotspot under mixed read/write stress.
    if (mode === "full") {
      await preIndexCheckpoint();
    }
    return indexRepoImpl(repoId, mode, onProgress, signal, options);
  });
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
): Promise<IndexResult> {
  const startTime = Date.now();
  const phaseTimings: Record<string, number> | null = options?.includeTimings
    ? {}
    : null;
  // Keep timing capture opt-in so normal refreshes pay essentially no overhead.
  const measurePhase = async <T>(
    phaseName: string,
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    const phaseStart = Date.now();
    try {
      return await fn();
    } finally {
      const durationMs = Date.now() - phaseStart;
      if (phaseTimings) phaseTimings[phaseName] = durationMs;
      try { getObservabilityTap()?.indexPhase({ phase: phaseName, durationMs }); } catch { /* swallow */ }
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

  if (mode === "incremental" && scanAllFilesUnchanged) {
    return await measurePhase("shortCircuitNoOp", async () => {
      const versionId = await createOrReuseVersion("Incremental index");

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

      const totalMs = Date.now() - startTime;
      const result: IndexResult = {
        versionId,
        filesProcessed: files.length,
        changedFiles: 0,
        removedFiles: 0,
        symbolsIndexed: 0,
        edgesCreated: 0,
        clustersComputed: 0,
        processesTraced: 0,
        durationMs: totalMs,
        timings: phaseTimings ? { totalMs, phases: phaseTimings } : undefined,
        // Phase 1 Task 1.12 — no Pass-1 ran in this short-circuit, emit zeros
        // so downstream consumers see a stable shape.
        pass1Engine: {
          rustFiles: 0,
          tsFiles: 0,
          rustFallbackFiles: 0,
          perLanguageFallback: {},
        },
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
      await flushIndexEvent({
        repoId,
        versionId,
        stats: {
          filesScanned: result.filesProcessed,
          symbolsExtracted: result.symbolsIndexed,
          edgesExtracted: result.edgesCreated,
          durationMs: result.durationMs,
          errors: 0,
          pass1Engine: {
            rustFiles: 0,
            tsFiles: 0,
            rustFallbackFiles: 0,
            perLanguageFallback: {},
          },
        },
      });
      return result;
    });
  }

  onProgress?.({ stage: "parsing", current: 0, total: files.length });
  const appConfig = loadConfig();
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
      existingByPath,
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
    };

    const pass1Acc: Pass1Accumulator = await measurePhase("pass1", async () => {
      if (useRustEngine) {
        const outcome = await runPass1WithRustEngine(pass1Params);
        return outcome.usedRust
          ? outcome.acc
          : await runPass1WithTsEngine(pass1Params);
      }
      return await runPass1WithTsEngine(pass1Params);
    });

    const {
      filesProcessed,
      changedFiles: changedFilesFromPass1,
      totalSymbolsIndexed,
      allConfigEdges,
      changedFileIds,
      changedPass2FilePaths,
      symbolMapFileUpdates,
    } = pass1Acc;
    let { totalEdgesCreated } = pass1Acc;
    let freshConn = conn;

    // --- Phase: refresh symbol index from DB (Pass 1 → Pass 2 bridge) ---

    await measurePhase("refreshSymbolIndex", () => {
      applySymbolMapFileUpdates(symbolMapCache, symbolMapFileUpdates.values());
      syncSymbolIndexFromCache(symbolMapCache, symbolIndex);
    });

    // --- Phase: Pass 2 — cross-file call resolution ---

    // Fix 4: TS resolver created eagerly in initSharedState — no deferred creation needed.

    totalEdgesCreated += await measurePhase("pass2", async () =>
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
        pass2Concurrency: appConfig.indexing?.pass2Concurrency ?? 1,
        createdCallEdges,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
        callResolutionTelemetry,
        onProgress,
        signal,
      }),
    );

    // Emit finalizing immediately after Pass 2 so the user sees feedback
    // before the silent internal phases (import re-resolution, edge
    // finalization, metrics, clusters, processes) begin.
    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: files.length,
    });

    // --- Phase: re-resolve unresolved import edges ---

    onProgress?.({
      stage: "finalizing",
      current: 0,
      total: files.length,
      substage: "importReresolution",
    });
    const importReResolution = await measurePhase(
      "resolveUnresolvedImports",
      () =>
        resolveUnresolvedImportEdges(repoId, {
          includeTimings: Boolean(phaseTimings),
          affectedPaths: new Set<string>([
            ...changedPass2FilePaths,
            ...Array.from(
              symbolMapFileUpdates.values(),
              (update) => update.relPath,
            ),
          ]),
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
    // Clearing them before cluster computation prevents holding ~3 copies of
    // all symbols simultaneously (the OOM root cause for 10k+ file repos).
    pendingCallEdges.length = 0;
    createdCallEdges.clear();
    symbolIndex.clear();
    globalNameToSymbolIds.clear();
    globalPreferredSymbolId.clear();
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

    const durationMs = Date.now() - startTime;

    // --- Phase: post-index metrics (summaries, clusters, processes) ---

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
    const { summaryStats } = finalizeResult;
    if (phaseTimings && finalizeResult.timings) {
      for (const [phaseName, durationMs] of Object.entries(
        finalizeResult.timings,
      )) {
        phaseTimings[`finalizeIndexing.${phaseName}`] = durationMs;
      }
    }

    // Refresh read connection again after version/metrics writes.
    freshConn = await getLadybugConn();
    const { clustersComputed, processesTraced } = await finalizeDerivedState({
      mode,
      conn: freshConn,
      repoId,
      versionId,
      filesTotal: files.length,
      phaseTimings,
      onProgress,
      sharedGraph: finalizeResult.sharedGraph,
      measurePhase,
    });

    // --- Phase: build deferred indexes (fresh DB only) ---

    await measurePhase("buildDeferredIndexes", async () => {
      const { buildDeferredIndexes } = await import("../db/ladybug.js");
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

    const totalMs = Date.now() - startTime;

    const result: IndexResult = {
      versionId,
      filesProcessed,
      changedFiles,
      removedFiles,
      symbolsIndexed: totalSymbolsIndexed,
      edgesCreated: totalEdgesCreated + configEdgesCreated,
      clustersComputed,
      processesTraced,
      durationMs,
      summaryStats,
      timings: phaseTimings ? { totalMs, phases: phaseTimings } : undefined,
      // Phase 1 Task 1.12 — surface Pass-1 engine breakdown so tests and
      // tooling can inspect Rust coverage / fallback rates without scraping
      // the audit log.
      pass1Engine: derivePass1EngineTelemetry(pass1Acc),
    };

    invalidateGraphSnapshot(repoId);
    clearOverviewCache();
    clearSliceCache();
    clearFingerprintCollisionLog();

    // Phase 1 Task 1.12 — emit `index.refresh.complete` audit event
    // carrying per-language Pass-1 engine telemetry so users can
    // audit Rust engine coverage and fallback rates over time.
    // Keep the completion contract consistent across full and no-op
    // incremental refreshes: when indexRepo() resolves, index writes are done.
    await flushIndexEvent({
      repoId,
      versionId,
      stats: {
        filesScanned: result.filesProcessed,
        symbolsExtracted: result.symbolsIndexed,
        edgesExtracted: result.edgesCreated,
        durationMs: result.durationMs,
        errors: 0,
        pass1Engine: derivePass1EngineTelemetry(pass1Acc),
      },
    });
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
