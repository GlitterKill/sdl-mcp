import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  resolveUnresolvedImportEdges,
} from "./edge-builder.js";
import {
  resolveParserWorkerPoolSize,
} from "./parser.js";
import { scanRepoForIndex } from "./scanner.js";
import {
  finalizeIndexing,
  type SummaryBatchResult,
} from "./metrics-updater.js";
import { computeAndStoreClustersAndProcesses } from "./cluster-orchestrator.js";
import { watchRepositoryWithIndexer } from "./watcher.js";
import type { RepoConfig } from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import {
  isRustEngineAvailable,
} from "./rustIndexer.js";
import { createTsCallResolver } from "./ts/tsParser.js";
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
import { runPass1WithRustEngine, runPass1WithTsEngine } from "./indexer-pass1.js";
import {
  refreshSymbolIndexFromDb,
  runPass2Resolvers,
  finalizeEdges,
} from "./indexer-pass2.js";
import {
  flagStaleMemoriesForChangedFiles,
  importMemoryFilesFromDisk,
} from "./indexer-memory.js";

export type { IndexProgress } from "./indexer-init.js";

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
  signal?: AbortSignal,
): Promise<IndexResult> {
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

  const resultPromise = indexRepoImpl(repoId, mode, onProgress, signal);
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
): Promise<IndexResult> {
  const startTime = Date.now();
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

  const { files, existingByPath, removedFiles } = await scanRepoForIndex({
    repoId,
    repoRoot: repoRow.rootPath,
    config,
    onProgress,
  });
  logger.debug("scanRepoForIndex complete", {
    repoId,
    fileCount: files.length,
    removedFiles,
  });

  onProgress?.({ stage: "parsing", current: 0, total: files.length });
  const appConfig = loadConfig();
  const concurrency = Math.max(
    1,
    Math.min(appConfig.indexing?.concurrency ?? 4, files.length || 1),
  );
  const useRustEngine =
    appConfig.indexing?.engine === "rust" && isRustEngineAvailable();

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

    logger.debug("Initializing TS call resolver", { repoId, useRustEngine });
    // When using the Rust engine for Pass 1, defer TS compiler resolver
    // creation until Pass 2 where it provides type-aware call resolution
    // that the import-based resolver cannot.
    let tsResolver: TsCallResolver | null = useRustEngine
      ? null
      : createTsCallResolver(repoRow.rootPath, files, {
          includeNodeModulesTypes: config.includeNodeModulesTypes ?? true,
        });
    logger.debug("TS call resolver initialized", {
      repoId,
      enabled: Boolean(tsResolver),
    });

    const { allSymbolsByName, globalNameToSymbolIds, globalPreferredSymbolId } =
      await loadExistingSymbolMaps(conn, repoId);
    const symbolIndex: SymbolIndex = new Map();
    const pendingCallEdges: PendingCallEdge[] = [];
    const createdCallEdges = new Set<string>();
    const {
      pass2ResolverRegistry,
      pass2EligibleFiles,
      callResolutionTelemetry,
      supportsPass2FilePath,
    } = initPass2Context(repoId, mode, files);

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

    let pass1Acc: Pass1Accumulator;
    if (useRustEngine) {
      const outcome = await runPass1WithRustEngine(pass1Params);
      pass1Acc = outcome.usedRust
        ? outcome.acc
        : await runPass1WithTsEngine(pass1Params);
    } else {
      pass1Acc = await runPass1WithTsEngine(pass1Params);
    }

    const {
      filesProcessed,
      changedFiles: changedFilesFromPass1,
      totalSymbolsIndexed,
      allConfigEdges,
      changedFileIds,
      changedPass2FilePaths,
    } = pass1Acc;
    let { totalEdgesCreated } = pass1Acc;
    // Refresh read connection after Pass 1 writes so subsequent reads observe
    // the latest committed state and avoid stale pages on the long-lived conn.
    let freshConn = await getLadybugConn();

    // --- Phase: refresh symbol index from DB (Pass 1 → Pass 2 bridge) ---

    await refreshSymbolIndexFromDb(
      freshConn,
      repoId,
      symbolIndex,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
    );

    // --- Phase: Pass 2 — cross-file call resolution ---

    // Lazily create TS compiler resolver for Pass 2 when Rust engine was used
    // for Pass 1.  The TS compiler provides type-aware call resolution that
    // complements the import-based resolver.
    if (!tsResolver && useRustEngine && pass2EligibleFiles.length > 0) {
      logger.debug("Creating deferred TS call resolver for Pass 2");
      tsResolver = createTsCallResolver(repoRow.rootPath, files, {
        includeNodeModulesTypes: config.includeNodeModulesTypes ?? true,
      });
      logger.debug("Deferred TS call resolver ready");
    }

    totalEdgesCreated += await runPass2Resolvers({
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
      createdCallEdges,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
      callResolutionTelemetry,
      onProgress,
      signal,
    });

    // --- Phase: re-resolve unresolved import edges ---

    const importReResolution = await resolveUnresolvedImportEdges(repoId);
    if (importReResolution.resolved > 0) {
      logger.info("Re-resolved unresolved import edges", {
        repoId,
        resolved: importReResolution.resolved,
        total: importReResolution.total,
      });
      totalEdgesCreated += importReResolution.resolved;
    }

    onProgress?.({
      stage: "finalizing",
      current: files.length,
      total: files.length,
    });
    const changedFiles = changedFilesFromPass1 + removedFiles;

    // --- Phase: finalize edges (pending calls + config edges) ---

    const configEdgeWeight =
      appConfig.slice?.edgeWeights?.config !== undefined
        ? appConfig.slice.edgeWeights.config
        : 0.8;
    const { configEdgesCreated } = await finalizeEdges({
      repoId,
      pendingCallEdges,
      symbolIndex,
      createdCallEdges,
      allConfigEdges,
      configEdgeWeight,
    });

    // --- Phase: version management ---

    const versionReason = mode === "full" ? "Full index" : "Incremental index";
    // Pass 2 + edge finalization perform many writes; refresh again before reads.
    freshConn = await getLadybugConn();
    const latestVersion = await ladybugDb.getLatestVersion(freshConn, repoId);
    let versionId: string;
    if (changedFiles === 0 && mode === "incremental") {
      versionId = latestVersion ? latestVersion.versionId : `v${Date.now()}`;
      if (!latestVersion)
        await createVersionAndSnapshot({
          repoId,
          versionId,
          reason: versionReason,
        });
    } else {
      versionId = `v${Date.now()}`;
      await createVersionAndSnapshot({
        repoId,
        versionId,
        reason: versionReason,
      });
    }

    const durationMs = Date.now() - startTime;

    // --- Phase: post-index metrics (summaries, clusters, processes) ---

    const changedFileIdsParam =
      mode === "incremental" ? changedFileIds : undefined;
    const { summaryStats } = await finalizeIndexing({
      repoId,
      versionId,
      appConfig,
      changedFileIds: changedFileIdsParam,
      callResolutionTelemetry,
      onProgress,
    });

    let clustersComputed = 0;
    let processesTraced = 0;
    // Refresh read connection again after version/metrics writes.
    freshConn = await getLadybugConn();
    if (!(mode === "incremental" && changedFiles === 0)) {
      try {
        const result = await computeAndStoreClustersAndProcesses({
          conn: freshConn,
          repoId,
          versionId,
        });
        clustersComputed = result.clustersComputed;
        processesTraced = result.processesTraced;
      } catch (error) {
        logger.warn(
          "Cluster/process computation failed; continuing without it",
          { repoId, error },
        );
      }
    }

    // --- Phase: memory management (staleness flagging + file import) ---

    await flagStaleMemoriesForChangedFiles(freshConn, repoId, changedFileIds, versionId);
    await importMemoryFilesFromDisk(repoRow.rootPath, repoId, versionId);

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
