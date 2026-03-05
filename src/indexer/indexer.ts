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
  isTsCallResolutionFile,
  resolvePass2Targets,
  resolvePendingCallEdges,
  resolveTsCallEdgesPass2,
} from "./edge-builder.js";
import {
  processFile,
  processFileFromRustResult,
  resolveParserWorkerPoolSize,
} from "./parser.js";
import { scanRepoForIndex } from "./scanner.js";
import { finalizeIndexing, type SummaryBatchResult } from "./metrics-updater.js";
import { computeAndStoreClustersAndProcesses } from "./cluster-orchestrator.js";
import { watchRepositoryWithIndexer } from "./watcher.js";
import type { RepoConfig } from "../config/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import type { SymbolKind } from "../db/schema.js";
import { logger } from "../util/logger.js";
import { normalizePath } from "../util/paths.js";
import {
  isRustEngineAvailable,
  parseFilesRust,
  type RustParseResult,
} from "./rustIndexer.js";
import { createTsCallResolver } from "./ts/tsParser.js";
import { ParserWorkerPool } from "./workerPool.js";

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

export { resolveParserWorkerPoolSize, type ResolveParserWorkerPoolSizeParams } from "./parser.js";
export type { ProcessFileParams } from "./parser.js";

function computeFileId(repoId: string, relPath: string): string {
  return `${repoId}:${normalizePath(relPath)}`;
}

function fileIdForPath(
  repoId: string,
  relPath: string,
  existingByPath: Map<string, kuzuDb.FileRow>,
): string {
  return existingByPath.get(relPath)?.fileId ?? computeFileId(repoId, relPath);
}

async function createVersionAndSnapshot(params: {
  repoId: string;
  versionId: string;
  reason: string;
}): Promise<void> {
  const { repoId, versionId, reason } = params;
  const conn = await getKuzuConn();

  await kuzuDb.createVersion(conn, {
    versionId,
    repoId,
    createdAt: new Date().toISOString(),
    reason,
    prevVersionHash: null,
    versionHash: null,
  });

  const symbols = await kuzuDb.getSymbolsByRepoForSnapshot(conn, repoId);
  for (const symbol of symbols) {
    await kuzuDb.snapshotSymbolVersion(conn, {
      versionId,
      symbolId: symbol.symbolId,
      astFingerprint: symbol.astFingerprint,
      signatureJson: symbol.signatureJson,
      summary: symbol.summary,
      invariantsJson: symbol.invariantsJson,
      sideEffectsJson: symbol.sideEffectsJson,
    });
  }
}

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexResult> {
  const startTime = Date.now();
  const conn = await getKuzuConn();

  const repoRow = await kuzuDb.getRepo(conn, repoId);
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

    logger.debug("Initializing TS call resolver", { repoId });
    const tsResolver: TsCallResolver | null = createTsCallResolver(
      repoRow.rootPath,
      files,
      {
        includeNodeModulesTypes: config.includeNodeModulesTypes ?? true,
      },
    );
    logger.debug("TS call resolver initialized", {
      repoId,
      enabled: Boolean(tsResolver),
    });

    const allSymbolsByName = new Map<string, kuzuDb.SymbolRow[]>();
    const globalNameToSymbolIds = new Map<string, string[]>();
    logger.debug("Loading existing symbols", { repoId });
    const repoSymbols = await kuzuDb.getSymbolsByRepo(conn, repoId);
    logger.debug("Loaded existing symbols", { repoId, count: repoSymbols.length });
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
    const changedTsFilePaths = new Set<string>();
    const tsFiles = files.filter((file) => isTsCallResolutionFile(file.path));
    const callResolutionTelemetry = createCallResolutionTelemetry({
      repoId,
      mode,
      tsFileCount: tsFiles.length,
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

        for (const file of rustFiles) {
          updatePass1Progress(file.path);
          const rustResult = resultByPath.get(file.path);
          if (!rustResult) {
            filesProcessed++;
            continue;
          }

          const skipCallResolution = isTsCallResolutionFile(file.path);

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
            });
            filesProcessed++;
            if (result.changed) {
              changedFiles++;
              changedFileIds.add(fileIdForPath(repoId, file.path, existingByPath));
              if (skipCallResolution) {
                changedTsFilePaths.add(file.path);
                for (const hinted of result.pass2HintPaths) {
                  changedTsFilePaths.add(hinted);
                }
              }
            }
            totalSymbolsIndexed += result.symbolsIndexed;
            totalEdgesCreated += result.edgesCreated;
            allConfigEdges.push(...result.configEdges);
          } catch (error) {
            filesProcessed++;
            logger.error(`Error processing Rust result for ${file.path}: ${error}`);
          }
        }
      } else {
        logger.warn("Rust engine returned null, falling back to TypeScript engine");
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
          const skipCallResolution = isTsCallResolutionFile(file.path);

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
            });
            filesProcessed++;
            if (result.changed) {
              changedFiles++;
              changedFileIds.add(fileIdForPath(repoId, file.path, existingByPath));
              if (skipCallResolution) {
                changedTsFilePaths.add(file.path);
                for (const hinted of result.pass2HintPaths) {
                  changedTsFilePaths.add(hinted);
                }
              }
            }
            totalSymbolsIndexed += result.symbolsIndexed;
            totalEdgesCreated += result.edgesCreated;
            allConfigEdges.push(...result.configEdges);
          } catch (error) {
            filesProcessed++;
            logger.error(`Error processing file ${file.path}: ${error}`);
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
    const allFilesAfterPass1 = await kuzuDb.getFilesByRepo(conn, repoId);
    const filePathById = new Map(
      allFilesAfterPass1.map((file) => [file.fileId, file.relPath]),
    );
    const symbolsAfterPass1 = await kuzuDb.getSymbolsByRepo(conn, repoId);
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
      tsFiles,
      changedTsFilePaths,
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
      const pass2Edges = await resolveTsCallEdgesPass2({
        repoId,
        repoRoot: repoRow.rootPath,
        fileMeta,
        symbolIndex,
        tsResolver,
        languages: config.languages,
        createdCallEdges,
        globalNameToSymbolIds,
        telemetry: callResolutionTelemetry,
      });
      totalEdgesCreated += pass2Edges;
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
    const configEdgesToInsert: kuzuDb.EdgeRow[] = [];
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
    await kuzuDb.insertEdges(conn, configEdgesToInsert);
    configEdgesCreated += configEdgesToInsert.length;

    const versionReason = mode === "full" ? "Full index" : "Incremental index";

    let versionId: string;
    const latestVersion = await kuzuDb.getLatestVersion(conn, repoId);
    if (changedFiles === 0 && mode === "incremental") {
      versionId = latestVersion ? latestVersion.versionId : `v${Date.now()}`;
      if (!latestVersion) {
        await createVersionAndSnapshot({ repoId, versionId, reason: versionReason });
      }
    } else {
      versionId = `v${Date.now()}`;
      await createVersionAndSnapshot({ repoId, versionId, reason: versionReason });
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
        logger.warn("Cluster/process computation failed; continuing without it", {
          repoId,
          error,
        });
      }
    }

    return {
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

export async function watchRepository(repoId: string): Promise<IndexWatchHandle> {
  return watchRepositoryWithIndexer(repoId, indexRepo);
}
