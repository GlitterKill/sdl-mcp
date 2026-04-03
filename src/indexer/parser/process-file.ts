import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { prefetchFileExports } from "../../graph/prefetch.js";
import { logger } from "../../util/logger.js";
import {
  isTsCallResolutionFile,
  resolveImportTargets,
} from "../edge-builder.js";
import { extractConfigEdgesFromTree, type ConfigEdge } from "../configEdges.js";
import { buildSymbolAndEdgeRows } from "./build-rows.js";
import { resolveFileForIndexing } from "./early-exit.js";
import { createEmptyProcessFileResult } from "./helpers.js";
import { parseAndExtract } from "./parse-and-extract.js";
import {
  buildSymbolDetails,
  buildSymbolIndexMaps,
  computePass2HintPaths,
  loadExistingSymbols,
} from "./symbol-mapping.js";
import type { ProcessFileParams, ProcessFileResult } from "./types.js";

export type { ProcessFileParams, ProcessFileResult };

export async function processFile(
  params: ProcessFileParams,
): Promise<ProcessFileResult> {
  const {
    repoId,
    repoRoot,
    fileMeta,
    languages,
    mode,
    existingFile,
    symbolIndex,
    pendingCallEdges,
    createdCallEdges,
    tsResolver,
    config,
    allSymbolsByName,
    workerPool,
    skipCallResolution,
    globalNameToSymbolIds,
    globalPreferredSymbolId,
    supportsPass2FilePath = isTsCallResolutionFile,
  } = params;

  try {
    // ── Phase 1-2: Early exits + adapter resolution ──────────────
    const fileResult = await resolveFileForIndexing({
      repoId,
      repoRoot,
      fileMeta,
      languages,
      mode,
      existingFile,
    });
    if (fileResult.status === "skip") return fileResult.result;
    const { data: fileData, adapter } = fileResult;

    // ── Phase 3: Parse and extract ───────────────────────────────
    const parseResult = await parseAndExtract({
      filePath: fileData.filePath,
      fileMeta,
      content: fileData.content,
      extWithDot: fileData.extWithDot,
      adapter,
      workerPool,
      existingFile,
      repoId,
      relPath: fileData.relPath,
      contentHash: fileData.contentHash,
      fileId: fileData.fileId,
    });
    if (parseResult.status === "skip") return parseResult.result;
    const { data: parsed } = parseResult;

    const conn = await getLadybugConn();

    // ── Phase 4: Load existing symbols ───────────────────────────
    const { existingSymbols, existingSymbolsById } =
      await loadExistingSymbols(conn, existingFile);

    // ── Phase 5: Pass2 hint paths ────────────────────────────────
    const pass2HintPaths = await computePass2HintPaths({
      conn,
      mode,
      skipCallResolution,
      existingFile,
      existingSymbols,
      repoId,
      filePath: fileMeta.path,
      supportsPass2FilePath,
    });

    // ── Import resolution ────────────────────────────────────────
    const extensions = languages.map((lang) => `.${lang}`);
    const importResolution = await resolveImportTargets(
      repoId,
      repoRoot,
      fileMeta.path,
      parsed.imports,
      extensions,
      adapter.languageId,
      fileData.content,
    );

    // ── Phase 6: Symbol detail mapping ───────────────────────────
    const symbolDetails = buildSymbolDetails({
      symbolsWithNodeIds: parsed.symbolsWithNodeIds,
      tree: parsed.tree!,
      repoId,
      fileMeta,
    });
    const { nodeIdToSymbolId, nameToSymbolIds } =
      buildSymbolIndexMaps(symbolDetails);

    // Determine edge source symbols
    const exportSymbols = parsed.symbolsWithNodeIds.filter((s) => s.exported);
    const edgeSourceSymbols =
      exportSymbols.length > 0 ? exportSymbols : parsed.symbolsWithNodeIds;
    const edgeSourceNodeIds = new Set(edgeSourceSymbols.map((s) => s.nodeId));

    // ── Phase 7: Build symbol rows + edges ───────────────────────
    const {
      symbolsToUpsert,
      fileSymbols,
      edgesToInsert,
      symbolReferences,
      edgesCreated,
    } = await buildSymbolAndEdgeRows({
      repoId,
      relPath: fileData.relPath,
      fileId: fileData.fileId,
      filePath: fileMeta.path,
      content: fileData.content,
      ext: fileData.ext,
      languages,
      symbolDetails,
      nodeIdToSymbolId,
      nameToSymbolIds,
      existingSymbolsById,
      importResolution,
      calls: parsed.calls,
      edgeSourceNodeIds,
      languageId: adapter.languageId,
      symbolIndex,
      pendingCallEdges,
      createdCallEdges,
      tsResolver,
      skipCallResolution,
      globalNameToSymbolIds,
      globalPreferredSymbolId,
      adapter,
    });

    // ── Config edges (requires AST tree) ─────────────────────────
    let configEdges: ConfigEdge[] = [];
    if (config && allSymbolsByName && parsed.tree) {
      configEdges = extractConfigEdgesFromTree({
        repoId,
        repoRoot,
        relPath: fileData.relPath,
        config,
        tree: parsed.tree,
        fileSymbols,
        allSymbolsByName,
      });
    }

    // ── Phase 8: Persist ─────────────────────────────────────────
    await withWriteConn(async (wConn) => {
      await ladybugDb.withTransaction(wConn, async (txConn) => {
        await ladybugDb.upsertFile(txConn, {
          fileId: fileData.fileId,
          repoId,
          relPath: fileData.relPath,
          contentHash: fileData.contentHash,
          language: adapter?.languageId ?? fileData.ext,
          byteSize: fileMeta.size,
          lastIndexedAt: new Date().toISOString(),
        });

        if (existingFile) {
          await ladybugDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
          await ladybugDb.deleteSymbolReferencesByFileId(
            txConn,
            existingFile.fileId,
          );
        }

        await ladybugDb.insertSymbolReferences(txConn, symbolReferences);

        for (const symbol of symbolsToUpsert) {
          await ladybugDb.upsertSymbol(txConn, symbol);
        }

        await ladybugDb.insertEdges(txConn, edgesToInsert);
      });
    });

    prefetchFileExports(repoId, fileMeta.path);

    return {
      symbolsIndexed: symbolDetails.length,
      edgesCreated,
      changed: true,
      configEdges,
      pass2HintPaths,
      symbolMapFileUpdate: {
        fileId: fileData.fileId,
        relPath: fileData.relPath,
        symbols: fileSymbols.map((symbol) => ({
          symbolId: symbol.symbolId,
          repoId: symbol.repoId,
          fileId: symbol.fileId,
          name: symbol.name,
          kind: symbol.kind,
          exported: symbol.exported,
        })),
      },
    };
  } catch (error) {
    logger.error(`Error processing file ${fileMeta.path}:`, { error });
    return createEmptyProcessFileResult(false);
  }
}
