import type { ConfigEdge } from "./configEdges.js";
import type {
  CallResolutionTelemetry,
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
  resolveUnresolvedImportEdges,
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
  type Pass2ResolverRegistry,
} from "./pass2/registry.js";
import { createTsCallResolver } from "./ts/tsParser.js";
import { ParserWorkerPool } from "./workerPool.js";
import { invalidateGraphSnapshot } from "../graph/graphSnapshotCache.js";
import { clearFingerprintCollisionLog } from "./fingerprints.js";
import { scanMemoryFiles, readMemoryFile } from "../memory/file-sync.js";
import type { FileMetadata } from "./fileScanner.js";
import crypto from "node:crypto";
import path from "node:path";

export interface IndexProgress {
  stage: "scanning" | "parsing" | "pass1" | "pass2" | "finalizing" | "summaries" | "embeddings" | "ann-index";
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LadybugConn = Awaited<ReturnType<typeof getLadybugConn>>;

interface Pass1Accumulator {
  filesProcessed: number;
  changedFiles: number;
  totalSymbolsIndexed: number;
  totalEdgesCreated: number;
  allConfigEdges: ConfigEdge[];
  changedFileIds: Set<string>;
  changedPass2FilePaths: Set<string>;
}

interface Pass1Params {
  repoId: string;
  repoRoot: string;
  config: RepoConfig;
  mode: "full" | "incremental";
  files: FileMetadata[];
  existingByPath: Map<string, ladybugDb.FileRow>;
  symbolIndex: SymbolIndex;
  pendingCallEdges: PendingCallEdge[];
  createdCallEdges: Set<string>;
  tsResolver: TsCallResolver | null;
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  supportsPass2FilePath: (relPath: string) => boolean;
  concurrency: number;
  workerPool?: ParserWorkerPool | null;
  onProgress: ((progress: IndexProgress) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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
  const readConn = await getLadybugConn();
  const symbols = await ladybugDb.getSymbolsByRepoForSnapshot(readConn, repoId);
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

// ---------------------------------------------------------------------------
// Pipeline phase helpers
// ---------------------------------------------------------------------------

/** Load existing symbols from DB and build name-to-symbol lookup maps. */
async function loadExistingSymbolMaps(
  conn: LadybugConn,
  repoId: string,
): Promise<{
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
}> {
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  const globalNameToSymbolIds = new Map<string, string[]>();
  const repoSymbols = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
  for (const symbol of repoSymbols) {
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push(symbol);
    allSymbolsByName.set(symbol.name, byName);
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
  }
  const globalPreferredSymbolId = buildGlobalPreferredSymbolIds(allSymbolsByName);
  return { allSymbolsByName, globalNameToSymbolIds, globalPreferredSymbolId };
}

/**
 * For names with multiple symbols, pre-compute a single preferred symbol ID.
 * Prefers exported symbols; if exactly one exported candidate exists among
 * multiple total candidates, it wins.  This resolves the common pattern where
 * a function is defined once in source (exported) but re-declared in test
 * files (non-exported `let`/`const`).
 */
function buildGlobalPreferredSymbolIds(
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>,
): Map<string, string> {
  const preferred = new Map<string, string>();
  for (const [name, symbols] of allSymbolsByName) {
    if (symbols.length <= 1) continue;
    const exported = symbols.filter((s) => s.exported);
    if (exported.length === 1) {
      preferred.set(name, exported[0].symbolId);
    }
  }
  return preferred;
}

/** Create the Pass 2 resolver registry, eligible file list, and telemetry object. */
function initPass2Context(
  repoId: string,
  mode: "full" | "incremental",
  files: FileMetadata[],
): {
  pass2ResolverRegistry: Pass2ResolverRegistry;
  pass2EligibleFiles: FileMetadata[];
  callResolutionTelemetry: CallResolutionTelemetry;
  supportsPass2FilePath: (relPath: string) => boolean;
} {
  const pass2ResolverRegistry = createDefaultPass2ResolverRegistry();
  const registeredPass2Resolvers = pass2ResolverRegistry
    .listResolvers()
    .map((r) => r.id);
  const pass2EligibleFiles = files.filter((f) =>
    pass2ResolverRegistry.supports(toPass2Target(f)),
  );
  const supportsPass2FilePath = (relPath: string): boolean =>
    pass2ResolverRegistry.supports(toPass2Target({ path: relPath }));
  const callResolutionTelemetry = createCallResolutionTelemetry({
    repoId,
    mode,
    pass2EligibleFileCount: pass2EligibleFiles.length,
    registeredResolvers: registeredPass2Resolvers,
  });
  return {
    pass2ResolverRegistry,
    pass2EligibleFiles,
    callResolutionTelemetry,
    supportsPass2FilePath,
  };
}

/**
 * Pass 1 — Rust engine path. Returns `usedRust: false` when the native addon
 * returns null, signalling the caller to re-run with the TypeScript engine.
 */
async function runPass1WithRustEngine(
  params: Pass1Params,
): Promise<{ acc: Pass1Accumulator; usedRust: boolean }> {
  const {
    repoId, repoRoot, config, mode, files, existingByPath, symbolIndex,
    pendingCallEdges, createdCallEdges, tsResolver, allSymbolsByName,
    globalNameToSymbolIds, globalPreferredSymbolId, pass2ResolverRegistry,
    supportsPass2FilePath, concurrency, onProgress,
  } = params;

  const acc: Pass1Accumulator = {
    filesProcessed: 0, changedFiles: 0, totalSymbolsIndexed: 0,
    totalEdgesCreated: 0, allConfigEdges: [], changedFileIds: new Set(),
    changedPass2FilePaths: new Set(),
  };
  const updateProgress = (currentFile?: string): void => {
    onProgress?.({
      stage: "pass1",
      current: Math.min(acc.filesProcessed, files.length),
      total: files.length,
      currentFile,
    });
  };

  let rustFiles = files;
  let skippedRustFiles = 0;
  if (mode === "incremental") {
    rustFiles = files.filter((file) => {
      const existing = existingByPath.get(file.path);
      return (
        !existing?.lastIndexedAt ||
        file.mtime > new Date(existing.lastIndexedAt).getTime()
      );
    });
    skippedRustFiles = files.length - rustFiles.length;
  }

  const rustResults = parseFilesRust(repoId, repoRoot, rustFiles, concurrency);
  logger.debug("Native parseFilesRust completed", {
    repoId,
    fileCount: rustFiles.length,
    resultCount: rustResults?.length ?? null,
  });

  if (!rustResults) {
    logger.warn("Rust engine returned null, falling back to TypeScript engine");
    return { acc, usedRust: false };
  }

  acc.filesProcessed += skippedRustFiles;
  const resultByPath = new Map<string, RustParseResult>();
  for (const result of rustResults) resultByPath.set(result.relPath, result);

  const tsFallbackFiles: FileMetadata[] = [];
  for (const file of rustFiles) {
    updateProgress(file.path);
    const rustResult = resultByPath.get(file.path);
    if (!rustResult) {
      acc.filesProcessed++;
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
        repoRoot,
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
        globalPreferredSymbolId,
        supportsPass2FilePath,
      });
      acc.filesProcessed++;
      if (result.changed) {
        acc.changedFiles++;
        acc.changedFileIds.add(
          fileIdForPath(repoId, file.path, existingByPath),
        );
        if (skipCallResolution) {
          acc.changedPass2FilePaths.add(file.path);
          for (const hinted of result.pass2HintPaths)
            acc.changedPass2FilePaths.add(hinted);
        }
      }
      acc.totalSymbolsIndexed += result.symbolsIndexed;
      acc.totalEdgesCreated += result.edgesCreated;
      acc.allConfigEdges.push(...result.configEdges);
    } catch (error) {
      acc.filesProcessed++;
      logger.error(`Error processing Rust result for ${file.path}`, { error });
    }
  }

  // Process files that the Rust engine couldn't handle via the TS engine
  for (const file of tsFallbackFiles) {
    updateProgress(file.path);
    const skipCallResolution = pass2ResolverRegistry.supports(
      toPass2Target(file),
    );
    try {
      const result = await processFile({
        repoId,
        repoRoot,
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
        globalPreferredSymbolId,
        supportsPass2FilePath,
      });
      acc.filesProcessed++;
      if (result.changed) {
        acc.changedFiles++;
        acc.changedFileIds.add(
          fileIdForPath(repoId, file.path, existingByPath),
        );
        if (skipCallResolution) {
          acc.changedPass2FilePaths.add(file.path);
          for (const hinted of result.pass2HintPaths)
            acc.changedPass2FilePaths.add(hinted);
        }
      }
      acc.totalSymbolsIndexed += result.symbolsIndexed;
      acc.totalEdgesCreated += result.edgesCreated;
      acc.allConfigEdges.push(...result.configEdges);
    } catch (error) {
      acc.filesProcessed++;
      logger.error(`Error in TS fallback for ${file.path}`, { error });
    }
  }

  return { acc, usedRust: true };
}

/** Pass 1 — TypeScript engine path. Dispatches files to a worker pool. */
async function runPass1WithTsEngine(
  params: Pass1Params,
): Promise<Pass1Accumulator> {
  const {
    repoId, repoRoot, config, mode, files, existingByPath, symbolIndex,
    pendingCallEdges, createdCallEdges, tsResolver, allSymbolsByName,
    globalNameToSymbolIds, globalPreferredSymbolId, pass2ResolverRegistry,
    supportsPass2FilePath, concurrency, workerPool, onProgress,
  } = params;

  const acc: Pass1Accumulator = {
    filesProcessed: 0, changedFiles: 0, totalSymbolsIndexed: 0,
    totalEdgesCreated: 0, allConfigEdges: [], changedFileIds: new Set(),
    changedPass2FilePaths: new Set(),
  };
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const index = nextIndex++;
      if (index >= files.length) return;
      const file = files[index];
      onProgress?.({
        stage: "pass1",
        current: Math.min(acc.filesProcessed, files.length),
        total: files.length,
        currentFile: file.path,
      });
      const skipCallResolution = pass2ResolverRegistry.supports(
        toPass2Target(file),
      );
      try {
        const result = await processFile({
          repoId,
          repoRoot,
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
          globalPreferredSymbolId,
          supportsPass2FilePath,
        });
        acc.filesProcessed++;
        if (result.changed) {
          acc.changedFiles++;
          acc.changedFileIds.add(
            fileIdForPath(repoId, file.path, existingByPath),
          );
          if (skipCallResolution) {
            acc.changedPass2FilePaths.add(file.path);
            for (const hinted of result.pass2HintPaths)
              acc.changedPass2FilePaths.add(hinted);
          }
        }
        acc.totalSymbolsIndexed += result.symbolsIndexed;
        acc.totalEdgesCreated += result.edgesCreated;
        acc.allConfigEdges.push(...result.configEdges);
      } catch (error) {
        acc.filesProcessed++;
        logger.error(`Error processing file ${file.path}`, { error });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, files.length || 1) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return acc;
}

/**
 * Rebuild the in-memory `symbolIndex` and `globalNameToSymbolIds` from the DB
 * after Pass 1 so Pass 2 resolvers see all freshly indexed symbols.
 */
async function refreshSymbolIndexFromDb(
  conn: LadybugConn,
  repoId: string,
  symbolIndex: SymbolIndex,
  globalNameToSymbolIds: Map<string, string[]>,
  globalPreferredSymbolId?: Map<string, string>,
): Promise<void> {
  const refreshed: SymbolIndex = new Map();
  const allFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const filePathById = new Map(allFiles.map((f) => [f.fileId, f.relPath]));
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of symbols) {
    const filePath = filePathById.get(symbol.fileId);
    if (filePath)
      addToSymbolIndex(refreshed, filePath, symbol.symbolId, symbol.name, symbol.kind as SymbolKind);
  }
  symbolIndex.clear();
  for (const [fp, names] of refreshed) symbolIndex.set(fp, names);

  // Refresh global name index so Pass 2 can heuristically resolve cross-file calls.
  globalNameToSymbolIds.clear();
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  for (const symbol of symbols) {
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push({
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
    });
    allSymbolsByName.set(symbol.name, byName);
  }
  for (const ids of globalNameToSymbolIds.values()) {
    ids.sort();
    for (let i = ids.length - 1; i > 0; i--) {
      if (ids[i] === ids[i - 1]) ids.splice(i, 1);
    }
  }

  // Refresh preferred symbol disambiguation map
  if (globalPreferredSymbolId) {
    globalPreferredSymbolId.clear();
    const refreshedPreferred = buildGlobalPreferredSymbolIds(allSymbolsByName);
    for (const [name, id] of refreshedPreferred) {
      globalPreferredSymbolId.set(name, id);
    }
  }
}

/** Pass 2 — cross-file call resolution. Returns total new edges created. */
async function runPass2Resolvers(params: {
  repoId: string;
  repoRoot: string;
  mode: "full" | "incremental";
  pass2EligibleFiles: FileMetadata[];
  changedPass2FilePaths: Set<string>;
  supportsPass2FilePath: (relPath: string) => boolean;
  pass2ResolverRegistry: Pass2ResolverRegistry;
  symbolIndex: SymbolIndex;
  tsResolver: TsCallResolver | null;
  config: RepoConfig;
  createdCallEdges: Set<string>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  callResolutionTelemetry: CallResolutionTelemetry;
  onProgress: ((progress: IndexProgress) => void) | undefined;
}): Promise<number> {
  const {
    repoId, repoRoot, mode, pass2EligibleFiles, changedPass2FilePaths,
    supportsPass2FilePath, pass2ResolverRegistry, symbolIndex, tsResolver,
    config, createdCallEdges, globalNameToSymbolIds, globalPreferredSymbolId,
    callResolutionTelemetry, onProgress,
  } = params;

  const pass2Targets = await resolvePass2Targets({
    repoId,
    mode,
    pass2Files: pass2EligibleFiles,
    changedPass2FilePaths,
    supportsPass2FilePath,
  });
  callResolutionTelemetry.pass2Targets = pass2Targets.length;

  let totalEdgesCreated = 0;
  const pass2ResolverCache = new Map<string, unknown>();
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
        repoRoot,
        symbolIndex,
        tsResolver,
        languages: config.languages,
        createdCallEdges,
        globalNameToSymbolIds,
        globalPreferredSymbolId,
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
  return totalEdgesCreated;
}

/** Resolve pending call edges, clean up dangling edges, and persist config edges. */
async function finalizeEdges(params: {
  repoId: string;
  pendingCallEdges: PendingCallEdge[];
  symbolIndex: SymbolIndex;
  createdCallEdges: Set<string>;
  allConfigEdges: ConfigEdge[];
  configEdgeWeight: number;
}): Promise<{ configEdgesCreated: number }> {
  const { repoId, pendingCallEdges, symbolIndex, createdCallEdges, allConfigEdges, configEdgeWeight } = params;

  await resolvePendingCallEdges(pendingCallEdges, symbolIndex, createdCallEdges, repoId);
  await cleanupUnresolvedEdges(repoId);

  const now = new Date().toISOString();
  const configEdgesToInsert: ladybugDb.EdgeRow[] = allConfigEdges.map(
    (edge) => ({
      repoId,
      fromSymbolId: edge.fromSymbolId,
      toSymbolId: edge.toSymbolId,
      edgeType: "config",
      weight: edge.weight ?? configEdgeWeight,
      confidence: 1.0,
      resolution: "exact",
      provenance: edge.provenance ?? "config",
      createdAt: now,
    }),
  );
  await withWriteConn(async (wConn) => {
    await ladybugDb.insertEdges(wConn, configEdgesToInsert);
  });
  return { configEdgesCreated: configEdgesToInsert.length };
}

/** Flag memories linked to symbols in changed files as stale. Failures are swallowed. */
async function flagStaleMemoriesForChangedFiles(
  conn: LadybugConn,
  repoId: string,
  changedFileIds: Set<string>,
  versionId: string,
): Promise<void> {
  if (changedFileIds.size === 0) return;
  try {
    const changedSymbolIds: string[] = [];
    for (const symbol of await ladybugDb.getSymbolsByRepo(conn, repoId)) {
      if (changedFileIds.has(symbol.fileId))
        changedSymbolIds.push(symbol.symbolId);
    }
    if (changedSymbolIds.length > 0) {
      await withWriteConn(async (wConn) => {
        const flagged = await ladybugDb.flagMemoriesStale(
          wConn,
          changedSymbolIds,
          versionId,
        );
        if (flagged > 0) {
          logger.info("Flagged stale memories", {
            repoId,
            memoriesFlagged: flagged,
            changedSymbols: changedSymbolIds.length,
          });
        }
      });
    }
  } catch (error) {
    logger.warn("Memory staleness flagging failed; continuing", {
      repoId,
      error,
    });
  }
}

/** Read `.sdl-memory/` files from disk and upsert them into the graph. Failures are swallowed. */
async function importMemoryFilesFromDisk(
  repoRoot: string,
  repoId: string,
  versionId: string,
): Promise<void> {
  try {
    const memoryFiles = await scanMemoryFiles(repoRoot);
    if (memoryFiles.length === 0) return;
    let imported = 0;
    await withWriteConn(async (wConn) => {
      for (const filePath of memoryFiles) {
        const data = await readMemoryFile(filePath);
        if (!data || data.deleted) continue;
        const contentHash = crypto
          .createHash("sha256")
          .update(repoId + data.type + data.title + data.content)
          .digest("hex");
        const relPath = normalizePath(path.relative(repoRoot, filePath));
        await ladybugDb.upsertMemory(wConn, {
          memoryId: data.memoryId,
          repoId,
          type: data.type,
          title: data.title,
          content: data.content,
          contentHash,
          searchText: data.title + " " + data.content,
          tagsJson: JSON.stringify(data.tags),
          confidence: data.confidence,
          createdAt: data.createdAt,
          updatedAt: new Date().toISOString(),
          createdByVersion: versionId,
          stale: false,
          staleVersion: null,
          sourceFile: relPath,
          deleted: false,
        });
        await ladybugDb.deleteMemoryEdges(wConn, data.memoryId);
        await ladybugDb.createHasMemoryEdge(wConn, repoId, data.memoryId);
        for (const symbolId of data.symbols) {
          await ladybugDb.createMemoryOfEdge(wConn, data.memoryId, symbolId);
        }
        for (const fileRelPath of data.files) {
          const file = await ladybugDb.getFileByRepoPath(
            wConn,
            repoId,
            fileRelPath,
          );
          if (file)
            await ladybugDb.createMemoryOfFileEdge(
              wConn,
              data.memoryId,
              file.fileId,
            );
        }
        imported++;
      }
    });
    if (imported > 0) {
      logger.info("Imported memory files", {
        repoId,
        imported,
        total: memoryFiles.length,
      });
    }
  } catch (error) {
    logger.warn("Memory file import failed; continuing", { repoId, error });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
    } catch (err) {
      // Previous run failed — proceed with our own run.
      logger.debug("Previous indexing run failed, proceeding with new run", {
        repoId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      });
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

    // --- Phase: refresh symbol index from DB (Pass 1 → Pass 2 bridge) ---

    await refreshSymbolIndexFromDb(conn, repoId, symbolIndex, globalNameToSymbolIds, globalPreferredSymbolId);

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
    const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
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
          { repoId, error },
        );
      }
    }

    // --- Phase: memory management (staleness flagging + file import) ---

    await flagStaleMemoriesForChangedFiles(conn, repoId, changedFileIds, versionId);
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
