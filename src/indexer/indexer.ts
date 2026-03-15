import type { ConfigEdge } from "./configEdges.js";
import type {
  PendingCallEdge,
  SymbolIndex,
  TsCallResolver,
} from "./edge-builder.js";
import {
  addToSymbolIndex,
  cleanupUnresolvedEdges,
  createCallResolutionTelemetry,
  recordPass2ResolverResult,
  recordPass2ResolverTarget,
  resolvePass2Targets,
  resolvePendingCallEdges,
} from "./edge-builder.js";
import {
  processFile,
  processFileFromRustResult,
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
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { SymbolKind } from "../db/schema.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import {
  isRustEngineAvailable,
  parseFilesRust,
  type RustParseResult,
} from "./rustIndexer.js";
import {
  createDefaultPass2ResolverRegistry,
  toPass2Target,
} from "./pass2/registry.js";
import { createTsCallResolver } from "./ts/tsParser.js";
import { ParserWorkerPool } from "./workerPool.js";
import { invalidateGraphSnapshot } from "../graph/graphSnapshotCache.js";
import { clearFingerprintCollisionLog } from "./fingerprints.js";

export interface IndexProgress {
  stage: "scanning" | "parsing" | "pass1" | "pass2" | "finalizing";
  current: number;
  total: number;
  currentFile?: string;
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

function computeFileId(repoId: string, relPath: string): string {
  return `${repoId}:${normalizePath(relPath)}`;
}

/**
 * Per-repo mutex to prevent concurrent `indexRepo` invocations.
 * When the watcher fires rapid events (e.g. bulk deletes), multiple
 * `indexRepo("incremental")` calls can race and corrupt LadybugDB state.
 */
const indexLocks = new Map<string, Promise<IndexResult>>();

function fileIdForPath(
  repoId: string,
  relPath: string,
  existingByPath: Map<string, ladybugDb.FileRow>,
): string {
  return existingByPath.get(relPath)?.fileId ?? computeFileId(repoId, relPath);
}

async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
}): Promise<void> {
  const { repoId, versionId, reason } = params;

  // Read symbols using read connection
  const readConn = await getLadybugConn();
  const symbols = await ladybugDb.getSymbolsByRepoForSnapshot(readConn, repoId);

  // Write version + snapshots using serialized write connection
  await withWriteConn(async (wConn) => {
    await ladybugDb.createVersion(wConn, {
      versionId,
      repoId,
      createdAt: new Date().toISOString(),
      reason,
      prevVersionHash: null,
      versionHash: null,
    });

    for (const symbol of symbols) {
      await ladybugDb.snapshotSymbolVersion(wConn, {
        versionId,
        symbolId: symbol.symbolId,
        astFingerprint: symbol.astFingerprint,
        signatureJson: symbol.signatureJson,
        summary: symbol.summary,
        invariantsJson: symbol.invariantsJson,
        sideEffectsJson: symbol.sideEffectsJson,
      });
    }
  });
}

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexResult> {
  // Serialize concurrent indexRepo calls for the same repo to prevent
  // LadybugDB write conflicts and race conditions during rapid watcher events.
  // Loop-and-recheck: after awaiting a lock, another caller may have set a new
  // one before we proceed. Re-check until no lock exists.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = indexLocks.get(repoId);
    if (!existing) break;
    logger.debug("indexRepo already running, waiting for lock", {
      repoId,
      mode,
    });
    try {
      await existing;
    } catch {
      // Previous run failed — proceed with our own run.
    }
  }

  const resultPromise = indexRepoImpl(repoId, mode, onProgress);
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
): Promise<IndexResult> {
  const startTime = Date.now();
  const conn = await getLadybugConn();

  const repoRow = await ladybugDb.getRepo(conn, repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const config: RepoConfig = JSON.parse(repoRow.configJson);

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

  if (useRustEngine) {
    logger.info("Using native Rust indexer engine for Pass 1");
  }

  try {
    const symbolIndex: SymbolIndex = new Map();
    const pendingCallEdges: PendingCallEdge[] = [];
    const createdCallEdges = new Set<string>();

    // Skip TS call resolver when Rust engine is active � it starts a full
    // TypeScript compiler program which is expensive and unused in that path.
    logger.debug("Initializing TS call resolver", { repoId, useRustEngine });
    const tsResolver: TsCallResolver | null = useRustEngine
      ? null
      : createTsCallResolver(repoRow.rootPath, files, {
          includeNodeModulesTypes: config.includeNodeModulesTypes ?? true,
        });
    logger.debug("TS call resolver initialized", {
      repoId,
      enabled: Boolean(tsResolver),
    });

    const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
    const globalNameToSymbolIds = new Map<string, string[]>();
    logger.debug("Loading existing symbols", { repoId });
    const repoSymbols = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
    logger.debug("Loaded existing symbols", {
      repoId,
      count: repoSymbols.length,
    });
    for (const symbol of repoSymbols) {
      const byName = allSymbolsByName.get(symbol.name) ?? [];
      byName.push(symbol);
      allSymbolsByName.set(symbol.name, byName);

      const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
      byId.push(symbol.symbolId);
      globalNameToSymbolIds.set(symbol.name, byId);
    }

    let filesProcessed = 0;
    let changedFiles = 0;
    let totalSymbolsIndexed = 0;
    let totalEdgesCreated = 0;
    let configEdgesCreated = 0;
    const allConfigEdges: ConfigEdge[] = [];
    const changedFileIds = new Set<string>();
    const changedPass2FilePaths = new Set<string>();
    const pass2ResolverRegistry = createDefaultPass2ResolverRegistry();
    const registeredPass2Resolvers = pass2ResolverRegistry
      .listResolvers()
      .map((resolver) => resolver.id);
    const supportsPass2FilePath = (relPath: string): boolean =>
      pass2ResolverRegistry.supports(
        toPass2Target({
          path: relPath,
        }),
      );
    const pass2EligibleFiles = files.filter((file) =>
      pass2ResolverRegistry.supports(toPass2Target(file)),
    );
    const pass2ResolverCache = new Map<string, unknown>();
    const callResolutionTelemetry = createCallResolutionTelemetry({
      repoId,
      mode,
      pass2EligibleFileCount: pass2EligibleFiles.length,
      registeredResolvers: registeredPass2Resolvers,
    });

    let nextIndex = 0;
    const updatePass1Progress = (currentFile?: string): void => {
      onProgress?.({
        stage: "pass1",
        current: Math.min(filesProcessed, files.length),
        total: files.length,
        currentFile,
      });
    };

    let usedRust = false;
    if (useRustEngine) {
      let rustFiles = files;
      let skippedRustFiles = 0;
      if (mode === "incremental") {
        rustFiles = files.filter((file) => {
          const existing = existingByPath.get(file.path);
          if (!existing?.lastIndexedAt) {
            return true;
          }
          return file.mtime > new Date(existing.lastIndexedAt).getTime();
        });
        skippedRustFiles = files.length - rustFiles.length;
      }

      const rustResults = parseFilesRust(
        repoId,
        repoRow.rootPath,
        rustFiles,
        concurrency,
      );
      logger.debug("Native parseFilesRust completed", {
        repoId,
        fileCount: rustFiles.length,
        resultCount: rustResults?.length ?? null,
      });

      if (rustResults) {
        usedRust = true;
        filesProcessed += skippedRustFiles;

        const resultByPath = new Map<string, RustParseResult>();
        for (const result of rustResults) {
          resultByPath.set(result.relPath, result);
        }

        const tsFallbackFiles: typeof rustFiles = [];

        for (const file of rustFiles) {
          updatePass1Progress(file.path);
          const rustResult = resultByPath.get(file.path);
          if (!rustResult) {
            filesProcessed++;
            continue;
          }

          // Fall back to TS engine for languages the Rust engine doesn't support
          if (
            rustResult.parseError &&
            rustResult.symbols.length === 0 &&
            rustResult.parseError.includes("Unsupported language")
          ) {
            logger.info(
              `Rust engine does not support language for ${file.path}, falling back to TypeScript engine`,
            );
            tsFallbackFiles.push(file);
            continue;
          }

          const skipCallResolution = pass2ResolverRegistry.supports(
            toPass2Target(file),
          );

          try {
            const result = await processFileFromRustResult({
              repoId,
              repoRoot: repoRow.rootPath,
              fileMeta: file,
              rustResult,
              languages: config.languages,
              mode,
              existingFile: existingByPath.get(file.path),
              symbolIndex,
              pendingCallEdges,
              createdCallEdges,
              tsResolver,
              config,
              allSymbolsByName,
              skipCallResolution,
              globalNameToSymbolIds,
              supportsPass2FilePath,
            });
            filesProcessed++;
            if (result.changed) {
              changedFiles++;
              changedFileIds.add(
                fileIdForPath(repoId, file.path, existingByPath),
              );
              if (skipCallResolution) {
                changedPass2FilePaths.add(file.path);
                for (const hinted of result.pass2HintPaths) {
                  changedPass2FilePaths.add(hinted);
                }
              }
            }
            totalSymbolsIndexed += result.symbolsIndexed;
            totalEdgesCreated += result.edgesCreated;
            allConfigEdges.push(...result.configEdges);
          } catch (error) {
            filesProcessed++;
            logger.error(`Error processing Rust result for ${file.path}`, {
              error,
            });
          }
        }

        // Process files that the Rust engine couldn't handle via the TS engine
        for (const file of tsFallbackFiles) {
          updatePass1Progress(file.path);
          const skipCallResolution = pass2ResolverRegistry.supports(
            toPass2Target(file),
          );
          try {
            const result = await processFile({
              repoId,
              repoRoot: repoRow.rootPath,
              fileMeta: file,
              languages: config.languages,
              mode,
              existingFile: existingByPath.get(file.path),
              symbolIndex,
              pendingCallEdges,
              createdCallEdges,
              tsResolver,
              config,
              allSymbolsByName,
              workerPool: null,
              skipCallResolution,
              globalNameToSymbolIds,
              supportsPass2FilePath,
            });
            filesProcessed++;
            if (result.changed) {
              changedFiles++;
              changedFileIds.add(
                fileIdForPath(repoId, file.path, existingByPath),
              );
              if (skipCallResolution) {
                changedPass2FilePaths.add(file.path);
                for (const hinted of result.pass2HintPaths) {
                  changedPass2FilePaths.add(hinted);
                }
              }
            }
            totalSymbolsIndexed += result.symbolsIndexed;
            totalEdgesCreated += result.edgesCreated;
            allConfigEdges.push(...result.configEdges);
          } catch (error) {
            filesProcessed++;
            logger.error(`Error in TS fallback for ${file.path}`, { error });
          }
        }
      } else {
        logger.warn(
          "Rust engine returned null, falling back to TypeScript engine",
        );
      }
    }

    if (!usedRust) {
      const runWorker = async (): Promise<void> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const index = nextIndex++;
          if (index >= files.length) {
            return;
          }

          const file = files[index];
          updatePass1Progress(file.path);
          const skipCallResolution = pass2ResolverRegistry.supports(
            toPass2Target(file),
          );

          try {
            const result = await processFile({
              repoId,
              repoRoot: repoRow.rootPath,
              fileMeta: file,
              languages: config.languages,
              mode,
              existingFile: existingByPath.get(file.path),
              symbolIndex,
              pendingCallEdges,
              createdCallEdges,
              tsResolver,
              config,
              allSymbolsByName,
              onProgress,
              workerPool,
              skipCallResolution,
              globalNameToSymbolIds,
              supportsPass2FilePath,
            });
            filesProcessed++;
            if (result.changed) {
              changedFiles++;
              changedFileIds.add(
                fileIdForPath(repoId, file.path, existingByPath),
              );
              if (skipCallResolution) {
                changedPass2FilePaths.add(file.path);
                for (const hinted of result.pass2HintPaths) {
                  changedPass2FilePaths.add(hinted);
                }
              }
            }
            totalSymbolsIndexed += result.symbolsIndexed;
            totalEdgesCreated += result.edgesCreated;
            allConfigEdges.push(...result.configEdges);
          } catch (error) {
            filesProcessed++;
            logger.error(`Error processing file ${file.path}`, { error });
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(concurrency, files.length || 1) },
        () => runWorker(),
      );
      await Promise.all(workers);
    }

    // Refresh symbol index from DB after pass 1
    const refreshedSymbolIndex: SymbolIndex = new Map();
    const allFilesAfterPass1 = await ladybugDb.getFilesByRepo(conn, repoId);
    const filePathById = new Map(
      allFilesAfterPass1.map((file) => [file.fileId, file.relPath]),
    );
    const symbolsAfterPass1 = await ladybugDb.getSymbolsByRepo(conn, repoId);
    for (const symbol of symbolsAfterPass1) {
      const filePath = filePathById.get(symbol.fileId);
      if (!filePath) continue;
      addToSymbolIndex(
        refreshedSymbolIndex,
        filePath,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );
    }

    symbolIndex.clear();
    for (const [filePath, names] of refreshedSymbolIndex) {
      symbolIndex.set(filePath, names);
    }

    // Refresh global symbol-name index after Pass 1 so Pass 2 can heuristically
    // resolve cross-file calls in freshly indexed repositories.
    globalNameToSymbolIds.clear();
    for (const symbol of symbolsAfterPass1) {
      const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
      byId.push(symbol.symbolId);
      globalNameToSymbolIds.set(symbol.name, byId);
    }
    for (const ids of globalNameToSymbolIds.values()) {
      ids.sort();
      for (let i = ids.length - 1; i > 0; i--) {
        if (ids[i] === ids[i - 1]) {
          ids.splice(i, 1);
        }
      }
    }

    // Pass 2: TS call resolution for selected targets
    const pass2Targets = await resolvePass2Targets({
      repoId,
      mode,
      pass2Files: pass2EligibleFiles,
      changedPass2FilePaths,
      supportsPass2FilePath,
    });
    callResolutionTelemetry.pass2Targets = pass2Targets.length;

    let pass2Processed = 0;
    for (const fileMeta of pass2Targets) {
      callResolutionTelemetry.pass2FilesProcessed++;
      onProgress?.({
        stage: "pass2",
        current: pass2Processed,
        total: pass2Targets.length,
        currentFile: fileMeta.path,
      });
      const resolver = pass2ResolverRegistry.getResolver(
        toPass2Target({ ...fileMeta, repoId }),
      );
      if (!resolver) {
        pass2Processed++;
        continue;
      }
      recordPass2ResolverTarget(callResolutionTelemetry, resolver.id);
      const resolverStartedAt = Date.now();
      const pass2Result = await resolver.resolve(
        toPass2Target({ ...fileMeta, repoId }),
        {
          repoRoot: repoRow.rootPath,
          symbolIndex,
          tsResolver,
          languages: config.languages,
          createdCallEdges,
          globalNameToSymbolIds,
          telemetry: callResolutionTelemetry,
          cache: pass2ResolverCache,
        },
      );
      recordPass2ResolverResult(callResolutionTelemetry, resolver.id, {
        edgesCreated: pass2Result.edgesCreated,
        elapsedMs: Date.now() - resolverStartedAt,
      });
      totalEdgesCreated += pass2Result.edgesCreated;
      pass2Processed++;
    }
    if (pass2Targets.length > 0) {
      onProgress?.({
        stage: "pass2",
        current: pass2Targets.length,
        total: pass2Targets.length,
      });
    }

    onProgress?.({
      stage: "finalizing",
      current: files.length,
      total: files.length,
    });

    changedFiles += removedFiles;

    await resolvePendingCallEdges(
      pendingCallEdges,
      symbolIndex,
      createdCallEdges,
      repoId,
    );

    await cleanupUnresolvedEdges(repoId);

    const configWeight =
      appConfig.slice?.edgeWeights?.config !== undefined
        ? appConfig.slice.edgeWeights.config
        : 0.8;

    const now = new Date().toISOString();
    const configEdgesToInsert: ladybugDb.EdgeRow[] = [];
    for (const edge of allConfigEdges) {
      configEdgesToInsert.push({
        repoId,
        fromSymbolId: edge.fromSymbolId,
        toSymbolId: edge.toSymbolId,
        edgeType: "config",
        weight: edge.weight ?? configWeight,
        confidence: 1.0,
        resolution: "exact",
        provenance: edge.provenance ?? "config",
        createdAt: now,
      });
    }
    await withWriteConn(async (wConn) => {
      await ladybugDb.insertEdges(wConn, configEdgesToInsert);
    });
    configEdgesCreated += configEdgesToInsert.length;

    const versionReason = mode === "full" ? "Full index" : "Incremental index";

    let versionId: string;
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
    if (changedFiles === 0 && mode === "incremental") {
      versionId = latestVersion ? latestVersion.versionId : `v${Date.now()}`;
      if (!latestVersion) {
        await createVersionAndSnapshot({
          repoId,
          versionId,
          reason: versionReason,
        });
      }
    } else {
      versionId = `v${Date.now()}`;
      await createVersionAndSnapshot({
        repoId,
        versionId,
        reason: versionReason,
      });
    }

    const durationMs = Date.now() - startTime;

    const changedFileIdsParam =
      mode === "incremental" ? changedFileIds : undefined;
    const { summaryStats } = await finalizeIndexing({
      repoId,
      versionId,
      appConfig,
      changedFileIds: changedFileIdsParam,
      callResolutionTelemetry,
    });

    let clustersComputed = 0;
    let processesTraced = 0;

    if (!(mode === "incremental" && changedFiles === 0)) {
      try {
        const result = await computeAndStoreClustersAndProcesses({
          conn,
          repoId,
          versionId,
        });
        clustersComputed = result.clustersComputed;
        processesTraced = result.processesTraced;
      } catch (error) {
        logger.warn(
          "Cluster/process computation failed; continuing without it",
          {
            repoId,
            error,
          },
        );
      }
    }

    const result = {
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
