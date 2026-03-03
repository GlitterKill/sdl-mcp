import type { PendingCallEdge, SymbolIndex } from "./edge-builder.js";
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
import { watchRepositoryWithIndexer } from "./watcher.js";
import { finalizeIndexing, type SummaryBatchResult } from "./metrics-updater.js";
import {
  createSnapshotTransaction,
  createEdgeTransaction,
  getFileByRepoPath,
  getFilesByRepo,
  getLatestVersion,
  getRepo,
  getSymbolsByRepoForSnapshot,
  getSymbolsByRepo,
} from "../db/queries.js";
import type { SymbolRow } from "../db/schema.js";
import type { RepoConfig } from "../config/types.js";
import type { ConfigEdge } from "./configEdges.js";
import { loadConfig } from "../config/loadConfig.js";
import { createTsCallResolver } from "./ts/tsParser.js";
import { ParserWorkerPool } from "./workerPool.js";
import { logger } from "../util/logger.js";
import {
  parseFilesRust,
  isRustEngineAvailable,
  type RustParseResult,
} from "./rustIndexer.js";

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

export async function indexRepo(
  repoId: string,
  mode: "full" | "incremental",
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexResult> {
  const startTime = Date.now();

  const repoRow = getRepo(repoId);
  if (!repoRow) {
    throw new Error(`Repository ${repoId} not found`);
  }

  const config: RepoConfig = JSON.parse(repoRow.config_json);

  const { files, existingByPath, removedFiles } = await scanRepoForIndex({
    repoId,
    repoRoot: repoRow.root_path,
    config,
    onProgress,
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

  const runIndex = async (): Promise<IndexResult> => {

  const symbolIndex: SymbolIndex = new Map();
  const pendingCallEdges: PendingCallEdge[] = [];
  const createdCallEdges = new Set<string>();
  const tsResolver = createTsCallResolver(repoRow.root_path, files, {
    includeNodeModulesTypes: config.includeNodeModulesTypes,
  });

  const allSymbolsByName = new Map<string, SymbolRow[]>();
  const globalNameToSymbolIds = new Map<string, string[]>();
  const repoSymbols = getSymbolsByRepo(repoId);
  for (const symbol of repoSymbols) {
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    allSymbolsByName.set(symbol.name, byName);

    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbol_id);
    globalNameToSymbolIds.set(symbol.name, byId);
  }

  let filesProcessed = 0;
  let changedFiles = 0;
  let totalSymbolsIndexed = 0;
  let totalEdgesCreated = 0;
  let configEdgesCreated = 0;
  const allConfigEdges: ConfigEdge[] = [];
  const changedFileIds = new Set<number>();
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

  if (useRustEngine) {
    let rustFiles = files;
    let skippedRustFiles = 0;
    if (mode === "incremental") {
      rustFiles = files.filter((file) => {
        const existing = existingByPath.get(file.path);
        if (!existing?.last_indexed_at) {
          return true;
        }
        return file.mtime > new Date(existing.last_indexed_at).getTime();
      });
      skippedRustFiles = files.length - rustFiles.length;
    }

    // --- Rust engine: batch parse all files, then process results ---
    const rustResults = parseFilesRust(
      repoId,
      repoRow.root_path,
      rustFiles,
      concurrency,
    );

    if (rustResults) {
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
            repoRoot: repoRow.root_path,
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
            if (skipCallResolution) {
              changedTsFilePaths.add(file.path);
            }
            const fileRecord = getFileByRepoPath(repoId, file.path);
            if (fileRecord) {
              changedFileIds.add(fileRecord.file_id);
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
      // Rust engine returned null (addon not loadable) - fall through to TS
      logger.warn("Rust engine returned null, falling back to TypeScript engine");
    }
  }

  if (!useRustEngine || filesProcessed === 0) {
    // --- TypeScript engine: worker pool with concurrent processing ---
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
            repoRoot: repoRow.root_path,
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
            if (skipCallResolution) {
              changedTsFilePaths.add(file.path);
            }
            const fileRecord = getFileByRepoPath(repoId, file.path);
            if (fileRecord) {
              changedFileIds.add(fileRecord.file_id);
            }
          }
          totalSymbolsIndexed += result.symbolsIndexed;
          totalEdgesCreated += result.edgesCreated;
          allConfigEdges.push(...result.configEdges);
        } catch (error) {
          filesProcessed++;
          console.error(`Error processing file ${file.path}:`, error);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, files.length || 1) },
      () => runWorker(),
    );
    await Promise.all(workers);
  }

  const refreshedSymbolIndex: SymbolIndex = new Map();
  const allFilesAfterPass1 = getFilesByRepo(repoId);
  const filePathById = new Map(allFilesAfterPass1.map((file) => [file.file_id, file.rel_path]));
  const symbolsAfterPass1 = getSymbolsByRepo(repoId);
  for (const symbol of symbolsAfterPass1) {
    const filePath = filePathById.get(symbol.file_id);
    if (!filePath) continue;
    addToSymbolIndex(
      refreshedSymbolIndex,
      filePath,
      symbol.symbol_id,
      symbol.name,
      symbol.kind,
    );
  }

  symbolIndex.clear();
  for (const [filePath, names] of refreshedSymbolIndex) {
    symbolIndex.set(filePath, names);
  }

  const pass2Targets = resolvePass2Targets({
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
      repoRoot: repoRow.root_path,
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

  resolvePendingCallEdges(
    pendingCallEdges,
    symbolIndex,
    createdCallEdges,
    repoId,
  );

  cleanupUnresolvedEdges(repoId);

  const configWeight =
    appConfig.slice?.edgeWeights?.config !== undefined
      ? appConfig.slice.edgeWeights.config
      : 0.8;

  for (const edge of allConfigEdges) {
    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: edge.fromSymbolId,
      to_symbol_id: edge.toSymbolId,
      type: "config",
      weight: edge.weight ?? configWeight,
      provenance: edge.provenance ?? "config",
      created_at: new Date().toISOString(),
    });
    configEdgesCreated++;
  }

  const versionReason = mode === "full" ? "Full index" : "Incremental index";

  let versionId: string;
  if (changedFiles === 0 && mode === "incremental") {
    const latestVersion = getLatestVersion(repoId);
    versionId = latestVersion ? latestVersion.version_id : `v${Date.now()}`;

    if (!latestVersion) {
      const version = {
        version_id: versionId,
        repo_id: repoId,
        created_at: new Date().toISOString(),
        reason: versionReason,
        prev_version_hash: null,
        version_hash: null,
      };

      const symbols = getSymbolsByRepoForSnapshot(repoId);
      const snapshots = symbols.map((symbol) => ({
        version_id: versionId,
        symbol_id: symbol.symbol_id,
        ast_fingerprint: symbol.ast_fingerprint,
        signature_json: symbol.signature_json,
        summary: symbol.summary,
        invariants_json: symbol.invariants_json,
        side_effects_json: symbol.side_effects_json,
      }));

      createSnapshotTransaction(version, snapshots);
    }
  } else {
    versionId = `v${Date.now()}`;
    const version = {
      version_id: versionId,
      repo_id: repoId,
      created_at: new Date().toISOString(),
      reason: versionReason,
      prev_version_hash: null,
      version_hash: null,
    };

    const symbols = getSymbolsByRepoForSnapshot(repoId);
    const snapshots = symbols.map((symbol) => ({
      version_id: versionId,
      symbol_id: symbol.symbol_id,
      ast_fingerprint: symbol.ast_fingerprint,
      signature_json: symbol.signature_json,
      summary: symbol.summary,
      invariants_json: symbol.invariants_json,
      side_effects_json: symbol.side_effects_json,
    }));

    createSnapshotTransaction(version, snapshots);
  }

  const durationMs = Date.now() - startTime;

  const changedFileIdsParam = mode === "incremental" ? changedFileIds : undefined;
  const { summaryStats } = await finalizeIndexing({
    repoId,
    versionId,
    appConfig,
    changedFileIds: changedFileIdsParam,
    callResolutionTelemetry,
  });

  return {
    versionId,
    filesProcessed,
    changedFiles,
    removedFiles,
    symbolsIndexed: totalSymbolsIndexed,
    edgesCreated: totalEdgesCreated + configEdgesCreated,
    durationMs,
    summaryStats,
  };
  };

  try {
    return await runIndex();
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

export function watchRepository(repoId: string): IndexWatchHandle {
  return watchRepositoryWithIndexer(repoId, indexRepo);
}
