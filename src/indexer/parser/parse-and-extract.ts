import { withWriteConn } from "../../db/ladybug.js";
import { logger } from "../../util/logger.js";
import type { LanguageAdapter } from "../adapter/LanguageAdapter.js";
import type { FileMetadata } from "../fileScanner.js";
import type { ParserWorkerPool } from "../workerPool.js";
import type { SymbolWithNodeId } from "../worker.js";
import type { ExtractedCall } from "../treesitter/extractCalls.js";
import type { ExtractedImport } from "../treesitter/extractImports.js";
import { createEmptyProcessFileResult, persistSkippedFile } from "./helpers.js";
import type { ParseOutcome } from "./types.js";

/**
 * Phase 3: Parse file content using worker pool or sync adapter fallback.
 * Extracts symbols, imports, and calls. Returns the tree-sitter tree
 * (null when worker pool was used) for later fingerprinting / config edges.
 */
export async function parseAndExtract(params: {
  filePath: string;
  fileMeta: FileMetadata;
  content: string;
  extWithDot: string;
  adapter: LanguageAdapter;
  workerPool?: ParserWorkerPool | null;
  existingFile?: { fileId: string };
  repoId: string;
  relPath: string;
  contentHash: string;
  fileId: string;
}): Promise<ParseOutcome> {
  const {
    filePath,
    fileMeta,
    content,
    extWithDot,
    adapter,
    workerPool,
    existingFile,
    repoId,
    relPath,
    contentHash,
    fileId,
  } = params;

  let symbolsWithNodeIds: Array<SymbolWithNodeId> = [];
  let imports: ExtractedImport[] = [];
  let calls: ExtractedCall[] = [];
  let parseError: Error | null = null;
  let tree: ReturnType<LanguageAdapter["parse"]> = null;

  try {
    if (workerPool) {
      try {
        const result = await workerPool.parse(filePath, content, extWithDot);
        symbolsWithNodeIds = result.symbols;
        imports = result.imports;
        calls = result.calls;
        // tree remains null when using worker pool - fingerprinting uses
        // worker-provided values or metadata fallback
      } catch (workerError) {
        parseError =
          workerError instanceof Error
            ? workerError
            : new Error(String(workerError));
        logger.warn(
          `Worker pool parse failed for ${fileMeta.path}, falling back to sync: ${parseError.message}`,
        );
      }
    }

    if (parseError || !workerPool) {
      tree = adapter.parse(content, filePath);
      if (!tree) {
        await withWriteConn(async (wConn) => {
          await persistSkippedFile({
            conn: wConn,
            existingFileId: existingFile?.fileId,
            fileId,
            repoId,
            relPath,
            contentHash,
            language: adapter.languageId,
            byteSize: fileMeta.size,
          });
        });
        return { status: "skip", result: createEmptyProcessFileResult(true) };
      }

      let extractedSymbols: ReturnType<LanguageAdapter["extractSymbols"]>;
      try {
        extractedSymbols = adapter.extractSymbols(tree, content, filePath);
      } catch (error) {
        logger.warn(
          `Partial parse error for ${fileMeta.path}: ${error}, extracting available symbols`,
        );
        extractedSymbols = [];
      }
      imports = adapter.extractImports(tree, content, filePath);
      symbolsWithNodeIds = extractedSymbols.map((symbol) => ({
        ...symbol,
        astFingerprint: "",
      }));
      calls = adapter.extractCalls(
        tree,
        content,
        filePath,
        extractedSymbols,
      );
    }
  } catch (error) {
    logger.error(`Fatal parse error for ${fileMeta.path}: ${error}`);
    return { status: "skip", result: createEmptyProcessFileResult(false) };
  }
  // NOTE: tree is NOT deleted here — the orchestrator owns cleanup via its
  // own finally block, since tree is needed for fingerprinting and config edges.

  return {
    status: "parsed",
    data: { symbolsWithNodeIds, imports, calls, tree },
  };
}
