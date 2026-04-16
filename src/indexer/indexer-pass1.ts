
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
    symbolMapFileUpdates: new Map(),
    rustFilesProcessed: 0, tsFilesProcessed: 0, rustFallbackFiles: 0,
    rustFallbackByLanguage: new Map(),
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

  // Fix 3: Process in chunks — parse a chunk with Rust, then process results
  // before starting next chunk. Reduces peak memory and enables progress.
  // Fix 2: Process each chunk's results concurrently (up to CONCURRENCY_LIMIT
  // parallel processFileFromRustResult calls) to overlap DB I/O.
  const CHUNK_SIZE = 200;
  const CONCURRENCY_LIMIT = Math.min(8, concurrency || 4);
  acc.filesProcessed += skippedRustFiles;
  const tsFallbackFiles: FileMetadata[] = [];

  for (let chunkStart = 0; chunkStart < rustFiles.length; chunkStart += CHUNK_SIZE) {
    if (params.signal?.aborted) break;

    const chunk = rustFiles.slice(chunkStart, chunkStart + CHUNK_SIZE);
    const chunkResults = parseFilesRust(repoId, repoRoot, chunk, concurrency);

    if (!chunkResults) {
      // Issue 1 fix: Do not return usedRust:false after partial work committed.
      // Instead, add all remaining unprocessed files to TS fallback.
      logger.warn("Rust engine returned null mid-run, falling back to TS for remaining files");
      for (let j = chunkStart; j < rustFiles.length; j++) {
        tsFallbackFiles.push(rustFiles[j]);
      }
      break;
    }

    logger.debug("Native parseFilesRust chunk completed", {
      repoId,
      chunkStart,
      chunkSize: chunk.length,
      totalFiles: rustFiles.length,
      resultCount: chunkResults.length,
    });

    // Separate results into processable and fallback.
    // Issue 2 fix: Use relPath lookup instead of positional indexing because
    // parseFilesRust filters out null entries, breaking index alignment.
    const resultByPath = new Map<string, RustParseResult>();
    for (const r of chunkResults) resultByPath.set(r.relPath, r);
    const processable: Array<{ file: FileMetadata; rustResult: RustParseResult }> = [];
    for (let i = 0; i < chunk.length; i++) {
      const file = chunk[i];
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
        acc.rustFallbackFiles++;
        const fbExt = file.path.split(".").pop()?.toLowerCase() ?? "";
        acc.rustFallbackByLanguage.set(
          fbExt,
          (acc.rustFallbackByLanguage.get(fbExt) ?? 0) + 1,
        );
        tsFallbackFiles.push(file);
        continue;
      }

      processable.push({ file, rustResult });
    }

    // Process this chunk's results concurrently with a limiter
    // SAFETY: processOne captures shared mutable state (pendingCallEdges,
    // createdCallEdges, symbolIndex, acc). This is safe because JS is
    // single-threaded — all synchronous mutations within processFileFromRustResult
    // complete atomically between microtasks. Do NOT insert awaits before
    // any push/add to these shared collections.
    const processOne = async (file: FileMetadata, rustResult: RustParseResult): Promise<void> => {
      updateProgress(file.path);
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
        acc.rustFilesProcessed++;
        if (result.changed) {
          acc.changedFiles++;
          acc.changedFileIds.add(
            fileIdForPath(repoId, file.path, existingByPath),
          );
          if (result.symbolMapFileUpdate) {
            acc.symbolMapFileUpdates.set(
              result.symbolMapFileUpdate.fileId,
              result.symbolMapFileUpdate,
            );
          }
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
    };

    // Dispatch with concurrency limit using sliding window
    for (let i = 0; i < processable.length; i += CONCURRENCY_LIMIT) {
      if (params.signal?.aborted) break;
      const batch = processable.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(({ file, rustResult }) => processOne(file, rustResult)),
      );
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
      acc.tsFilesProcessed++;
      if (result.changed) {
        acc.changedFiles++;
        acc.changedFileIds.add(
          fileIdForPath(repoId, file.path, existingByPath),
        );
        if (result.symbolMapFileUpdate) {
          acc.symbolMapFileUpdates.set(
            result.symbolMapFileUpdate.fileId,
            result.symbolMapFileUpdate,
          );
        }
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

  logger.info("Pass 1 engine breakdown", {
    rustFiles: acc.rustFilesProcessed,
    tsFiles: acc.tsFilesProcessed,
    rustFallbackFiles: acc.rustFallbackFiles,
    perLanguageFallback: Object.fromEntries(acc.rustFallbackByLanguage),
  });

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
    symbolMapFileUpdates: new Map(),
    rustFilesProcessed: 0, tsFilesProcessed: 0, rustFallbackFiles: 0,
    rustFallbackByLanguage: new Map(),
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
        acc.tsFilesProcessed++;
        if (result.changed) {
          acc.changedFiles++;
          acc.changedFileIds.add(
            fileIdForPath(repoId, file.path, existingByPath),
          );
          if (result.symbolMapFileUpdate) {
            acc.symbolMapFileUpdates.set(
              result.symbolMapFileUpdate.fileId,
              result.symbolMapFileUpdate,
            );
          }
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
