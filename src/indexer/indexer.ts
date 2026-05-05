import type { PendingCallEdge, SymbolIndex } from "./edge-builder.js";
// Repository indexing entry point and watcher orchestrator. Heavy work stays in
// sibling modules; this file sequences scans, pass1/pass2, finalization, and
// watcher delegation.

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
import { buildDeferredIndexes, getLadybugConn } from "../db/ladybug.js";
import { withPostIndexWriteSession } from "../db/write-session.js";
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
import {
  runScipIngestInsideIndex,
  scipIngestWillRun,
} from "../scip/ingestion.js";
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
    if (willRunScip) {
      // SCIP path: drain → SCIP → pass 2 (sequential, all writeLimiter-bound).
      await measurePhase("pass1Drain", () => pass1DrainPromise);
      const scipResult = await measurePhase("scipIngest", () =>
        runScipIngestInsideIndex({
          repoId,
          repoRoot: repoRow.rootPath,
          config: appConfig,
          onProgress,
        }),
      );
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
      await pass1DrainPromise;
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
        },
      });

      return {
        summaryStats: finalizeResult.summaryStats,
        clustersComputed: derivedResult.clustersComputed,
        processesTraced: derivedResult.processesTraced,
      };
    });

    const { summaryStats, clustersComputed, processesTraced } = phaseOutcome;
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
