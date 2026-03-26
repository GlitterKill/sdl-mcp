
import {
  processFile,
  processFileFromRustResult,
} from "./parser.js";
import {
  parseFilesRust,
  type RustParseResult,
} from "./rustIndexer.js";
import {
  toPass2Target,
} from "./pass2/registry.js";
import { logger } from "../util/logger.js";
import type { FileMetadata } from "./fileScanner.js";
import {
  fileIdForPath,
  type Pass1Accumulator,
  type Pass1Params,
} from "./indexer-init.js";

/**
 * Pass 1 — Rust engine path. Returns `usedRust: false` when the native addon
 * returns null, signalling the caller to re-run with the TypeScript engine.
 */
export async function runPass1WithRustEngine(
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
    if (params.signal?.aborted) break;
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
    if (params.signal?.aborted) break;
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
export async function runPass1WithTsEngine(
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
  // SAFETY: nextIndex++ must remain synchronous — no `await` between reading
  // and incrementing. JavaScript's single-threaded event loop guarantees
  // atomicity only when there is no yield point between the read and write.
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
     
    while (true) {
      if (params.signal?.aborted) return;
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
