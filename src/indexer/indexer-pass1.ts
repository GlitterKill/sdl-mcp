
import {
  processFile,
  processFileFromRustResult,
} from "./parser.js";
import {
  parseFilesRust,
  parseFilesRustAsync,
  type RustParseResult,
} from "./rustIndexer.js";
import { BatchPersistAccumulator } from "./parser/batch-persist.js";
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

  const batchAccumulator = new BatchPersistAccumulator(50);

  // --- Pipelined chunk processing ---
  // Parse chunk N+1 (async, on libuv thread) while processing chunk N's
  // results on the main thread. This overlaps Rust CPU work with JS DB writes.
  const chunks: FileMetadata[][] = [];
  for (let i = 0; i < rustFiles.length; i += CHUNK_SIZE) {
    chunks.push(rustFiles.slice(i, i + CHUNK_SIZE));
  }

  let pendingParse: Promise<RustParseResult[] | null> | null = null;
  let pendingChunkIdx = -1;

  // Kick off first chunk parse (async)
  if (chunks.length > 0) {
    pendingParse = parseFilesRustAsync(repoId, repoRoot, chunks[0], concurrency);
    pendingChunkIdx = 0;
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    if (params.signal?.aborted) break;

    // Await the parse that was kicked off previously
    let chunkResults: RustParseResult[] | null;
    if (pendingParse && pendingChunkIdx === ci) {
      chunkResults = await pendingParse;
      pendingParse = null;
    } else {
      chunkResults = parseFilesRust(repoId, repoRoot, chunks[ci], concurrency);
    }

    if (!chunkResults) {
      logger.warn("Rust engine returned null mid-run, falling back to TS for remaining files");
      for (let j = ci; j < chunks.length; j++) {
        for (const f of chunks[j]) tsFallbackFiles.push(f);
      }
      pendingParse = null;
      break;
    }

    // Kick off NEXT chunk parse after confirming current chunk succeeded
    if (ci + 1 < chunks.length) {
      pendingParse = parseFilesRustAsync(repoId, repoRoot, chunks[ci + 1], concurrency);
      pendingChunkIdx = ci + 1;
    }

    logger.debug("Native parseFilesRust chunk completed", {
      repoId,
      chunk: ci + 1,
      totalChunks: chunks.length,
      chunkSize: chunks[ci].length,
      totalFiles: rustFiles.length,
      resultCount: chunkResults.length,
    });

    const resultByPath = new Map<string, RustParseResult>();
    for (const r of chunkResults) resultByPath.set(r.relPath, r);
    const processable: Array<{ file: FileMetadata; rustResult: RustParseResult }> = [];
    for (let i = 0; i < chunks[ci].length; i++) {
      const file = chunks[ci][i];
      const rustResult = resultByPath.get(file.path);
      if (!rustResult) {
        acc.filesProcessed++;
        continue;
      }

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
          batchAccumulator,
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

    for (let i = 0; i < processable.length; i += CONCURRENCY_LIMIT) {
      if (params.signal?.aborted) break;
      const batch = processable.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(({ file, rustResult }) => processOne(file, rustResult)),
      );
    }

    // Flush accumulated DB writes for this chunk
    if (batchAccumulator.shouldFlush()) {
      await batchAccumulator.flush();
    }
  }

  // Flush any remaining batched writes
  await batchAccumulator.flush();

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
