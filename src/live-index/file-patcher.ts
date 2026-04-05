import { readFileAsync } from "../util/asyncFs.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { RepoConfig } from "../config/types.js";
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";
import {
  buildDependencyFrontier,
  type DependencyFrontier,
} from "./dependency-frontier.js";
import { parseDraftFile, type DraftParseResult } from "./draft-parser.js";
import { IndexError } from "../domain/errors.js";
import { logger } from "../util/logger.js";
import {
  diffSymbols,
  toExistingSymbol,
  toNewSymbol,
} from "./symbol-diff.js";

export interface SavedFilePatchRequest {
  repoId: string;
  filePath: string;
  content?: string;
  language?: string;
  version?: number;
  parseResult?: DraftParseResult | null;
}

export interface SavedFilePatchResult {
  repoId: string;
  filePath: string;
  fileId: string;
  symbolsUpserted: number;
  symbolsAdded: number;
  symbolsRemoved: number;
  symbolsPreserved: number;
  edgesUpserted: number;
  referencesUpserted: number;
  parseResult: DraftParseResult;
  frontier: DependencyFrontier;
}

export async function patchSavedFile(
  request: SavedFilePatchRequest,
): Promise<SavedFilePatchResult> {
  const conn = await getLadybugConn();
  const repo = await ladybugDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new IndexError(`Repository ${request.repoId} not found`);
  }

  let repoConfig: RepoConfig;
  try {
    repoConfig = JSON.parse(repo.configJson) as RepoConfig;
  } catch {
    logger.error("Corrupt configJson for repo", { repoId: request.repoId });
    throw new IndexError(`Corrupt configJson for repo ${request.repoId}`);
  }
  const relPath = normalizePath(request.filePath);
  const existingFile = await ladybugDb.getFileByRepoPath(
    conn,
    request.repoId,
    relPath,
  );

  const parseResult =
    request.parseResult ??
    (await parseDraftFile({
      repoId: request.repoId,
      repoRoot: repo.rootPath,
      filePath: relPath,
      content:
        request.content ??
        (await readFileAsync(
          getAbsolutePathFromRepoRoot(repo.rootPath, relPath),
          "utf-8",
        )),
      languages: repoConfig.languages,
      language: request.language,
      version: request.version ?? 0,
    }));

  const frontier = await buildDependencyFrontier({
    conn,
    touchedSymbolIds: parseResult.symbols.map((symbol) => symbol.symbolId),
    outgoingEdges: parseResult.edges.map((edge) => ({
      toSymbolId: edge.toSymbolId,
      edgeType: edge.edgeType,
    })),
    currentFilePath: relPath,
  });

  const now = new Date().toISOString();
  const durableFile = {
    ...parseResult.file,
    lastIndexedAt: now,
  };

  // Load existing symbols for diff/merge when the file already exists in the DB
  const existingSymbols = existingFile
    ? await ladybugDb.getSymbolsByFile(conn, existingFile.fileId)
    : [];

  // Diff existing DB symbols against new tree-sitter-derived symbols
  const newSymbols = parseResult.symbols.map(toNewSymbol);
  const existingMapped = existingSymbols.map((row) =>
    toExistingSymbol(row as Parameters<typeof toExistingSymbol>[0]),
  );
  const diff = diffSymbols(existingMapped, newSymbols);

  await withWriteConn(async (wConn) => {
    await ladybugDb.withTransaction(wConn, async (txConn) => {
      await ladybugDb.upsertFile(txConn, durableFile);

      // Always refresh symbol references for this file
      await ladybugDb.deleteSymbolReferencesByFileId(
        txConn,
        durableFile.fileId,
      );
      await ladybugDb.insertSymbolReferences(txConn, parseResult.references);

      // --- Matched symbols: update properties, refresh non-SCIP edges ---
      if (diff.matched.length > 0) {
        const matchedOldIds = diff.matched.map((m) => m.old.symbolId);

        // Delete only non-SCIP outgoing edges for matched symbols.
        // SCIP edges (resolverId === "scip") are preserved.
        await ladybugDb.deleteNonScipOutgoingEdges(txConn, matchedOldIds);

        // Upsert each matched symbol with updated properties from tree-sitter.
        // Build a lookup from new symbolId -> parse result symbol for fast access.
        const newSymbolLookup = new Map(
          parseResult.symbols.map((s) => [s.symbolId, s]),
        );

        for (const { old: oldSym, new: newSym } of diff.matched) {
          const freshSymbol = newSymbolLookup.get(newSym.symbolId);
          if (!freshSymbol) continue;

          // If the old symbol came from SCIP, promote source to "both"
          // since tree-sitter also found it.  We preserve the old symbolId
          // so all existing edges, metrics, and embeddings remain linked.
          await ladybugDb.upsertSymbol(txConn, {
            ...freshSymbol,
            symbolId: oldSym.symbolId,
            updatedAt: now,
          });
        }

        // Insert fresh tree-sitter edges for matched symbols.
        // Filter to edges originating from matched old symbol IDs.
        const matchedNewToOldId = new Map(
          diff.matched.map((m) => [m.new.symbolId, m.old.symbolId]),
        );
        const matchedEdges = parseResult.edges
          .filter((edge) => matchedNewToOldId.has(edge.fromSymbolId))
          .map((edge) => ({
            ...edge,
            // Remap fromSymbolId to the old (stable) symbol ID
            fromSymbolId:
              matchedNewToOldId.get(edge.fromSymbolId) ?? edge.fromSymbolId,
            createdAt: now,
          }));
        if (matchedEdges.length > 0) {
          await ladybugDb.insertEdges(txConn, matchedEdges);
        }
      }

      // --- Added symbols: insert fresh ---
      if (diff.added.length > 0) {
        const addedIds = new Set(diff.added.map((s) => s.symbolId));
        for (const symbol of parseResult.symbols) {
          if (addedIds.has(symbol.symbolId)) {
            await ladybugDb.upsertSymbol(txConn, {
              ...symbol,
              updatedAt: now,
            });
          }
        }

        // Insert edges originating from added symbols
        const addedEdges = parseResult.edges
          .filter((edge) => addedIds.has(edge.fromSymbolId))
          .map((edge) => ({
            ...edge,
            createdAt: now,
          }));
        if (addedEdges.length > 0) {
          await ladybugDb.insertEdges(txConn, addedEdges);
        }
      }

      // --- Removed symbols: delete (source != "scip") ---
      if (diff.removed.length > 0) {
        const removedIds = diff.removed.map((s) => s.symbolId);
        await ladybugDb.deleteSymbolsByIds(txConn, removedIds);
      }

      // --- Preserved symbols: SCIP-only, leave untouched ---
      // (No action needed -- they survive reconciliation.)
      if (diff.preserved.length > 0) {
        logger.debug("SCIP-only symbols preserved during reconciliation", {
          repoId: request.repoId,
          filePath: relPath,
          preservedCount: diff.preserved.length,
          symbolIds: diff.preserved.map((s) => s.symbolId),
        });
      }
    });
  });

  return {
    repoId: request.repoId,
    filePath: relPath,
    fileId: durableFile.fileId,
    symbolsUpserted: diff.matched.length + diff.added.length,
    symbolsAdded: diff.added.length,
    symbolsRemoved: diff.removed.length,
    symbolsPreserved: diff.preserved.length,
    edgesUpserted: parseResult.edges.length,
    referencesUpserted: parseResult.references.length,
    parseResult: {
      ...parseResult,
      file: durableFile,
      symbols: parseResult.symbols.map((symbol) => ({
        ...symbol,
        updatedAt: now,
      })),
      edges: parseResult.edges.map((edge) => ({
        ...edge,
        createdAt: now,
      })),
    },
    frontier,
  };
}
