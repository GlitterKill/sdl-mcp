import type { Connection } from "kuzu";

import { loadConfig } from "../config/loadConfig.js";
import type { RepoConfig } from "../config/types.js";
import { getExtensionCapabilities } from "../db/extension-caps.js";
import { getLadybugConn, withWriteConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { readFileAsync } from "../util/asyncFs.js";
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";
import {
  buildDependencyFrontier,
  type DependencyFrontier,
} from "./dependency-frontier.js";
import { parseDraftFile, type DraftParseResult } from "./draft-parser.js";
import { IndexError } from "../domain/errors.js";
import { logger } from "../util/logger.js";
import {
  dropFtsIndex,
  ensureFtsIndexForNonEmptyTable,
  SYMBOL_FTS_INDEX_NAME,
  type DropFtsIndexResult,
  type EnsureFtsIndexResult,
} from "../retrieval/index-lifecycle.js";
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

export interface SymbolFtsPatchLifecycleConfig {
  enabled: boolean;
  indexName: string;
}

export interface SymbolFtsPatchLifecycleDependencies {
  getConfig: () => SymbolFtsPatchLifecycleConfig;
  drop: (
    conn: Connection,
    indexName: string,
  ) => Promise<DropFtsIndexResult>;
  ensure: (
    conn: Connection,
    indexName: string,
  ) => Promise<EnsureFtsIndexResult>;
  logRebuildFailure: (error: Error) => void;
}

function symbolFtsPatchLifecycleConfig(): SymbolFtsPatchLifecycleConfig {
  if (!getExtensionCapabilities().fts) {
    return { enabled: false, indexName: SYMBOL_FTS_INDEX_NAME };
  }

  try {
    const semantic = loadConfig().semantic;
    const fts = semantic?.retrieval?.fts;
    return {
      enabled: semantic?.enabled !== false && fts?.enabled !== false,
      indexName: fts?.indexName ?? SYMBOL_FTS_INDEX_NAME,
    };
  } catch (err) {
    logger.debug("Unable to read semantic config before Symbol FTS patch lifecycle", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { enabled: true, indexName: SYMBOL_FTS_INDEX_NAME };
  }
}

function symbolFtsLifecycleError(
  action: "drop" | "rebuild",
  indexName: string,
  error: unknown,
): IndexError {
  if (error instanceof IndexError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new IndexError(
    "Failed to " + action + " Symbol FTS index '" + indexName + "': " + message,
  );
}

function attachRebuildFailureToMutationError(
  mutationError: unknown,
  rebuildError: IndexError,
): unknown {
  const rebuildContext = `Symbol FTS may be absent: ${rebuildError.message}`;
  if (mutationError instanceof Error) {
    mutationError.message = `${mutationError.message}; ${rebuildContext}`;
    return mutationError;
  }
  return new IndexError(
    `Live-index mutation failed: ${String(mutationError)}; ${rebuildContext}`,
  );
}

const defaultSymbolFtsPatchLifecycleDependencies: SymbolFtsPatchLifecycleDependencies = {
  getConfig: symbolFtsPatchLifecycleConfig,
  drop: (conn, indexName) => dropFtsIndex(conn, "Symbol", indexName),
  ensure: (conn, indexName) =>
    ensureFtsIndexForNonEmptyTable(conn, "Symbol", indexName),
  logRebuildFailure: (error) => {
    logger.error("Symbol FTS rebuild failed after patch mutation failure", {
      error: error.message,
    });
  },
};

/**
 * Symbol FTS is paused while patchSavedFile mutates Symbol rows;
 * LadybugDB 0.16.1 can access-violate when FTS tracks repeated upserts.
 */
export async function withSymbolFtsPausedForPatch<T>(
  conn: Connection,
  mutate: () => Promise<T>,
  dependencies: SymbolFtsPatchLifecycleDependencies =
    defaultSymbolFtsPatchLifecycleDependencies,
): Promise<T> {
  const config = dependencies.getConfig();
  if (!config.enabled) {
    return mutate();
  }

  const dropResult = await dependencies.drop(conn, config.indexName);
  if (dropResult.status === "failed") {
    throw symbolFtsLifecycleError("drop", config.indexName, dropResult.error);
  }

  let result: T | undefined;
  let mutationFailed = false;
  let mutationError: unknown;
  try {
    result = await mutate();
  } catch (err) {
    mutationFailed = true;
    mutationError = err;
  }

  const shouldRebuild =
    dropResult.status === "dropped" || !mutationFailed;
  if (shouldRebuild) {
    try {
      const ensureResult = await dependencies.ensure(conn, config.indexName);
      if (ensureResult.status === "failed") {
        throw symbolFtsLifecycleError(
          "rebuild",
          config.indexName,
          ensureResult.error,
        );
      }
    } catch (err) {
      const rebuildError = symbolFtsLifecycleError(
        "rebuild",
        config.indexName,
        err,
      );
      if (mutationFailed) {
        dependencies.logRebuildFailure(rebuildError);
        mutationError = attachRebuildFailureToMutationError(
          mutationError,
          rebuildError,
        );
      } else {
        throw rebuildError;
      }
    }
  }

  if (mutationFailed) {
    throw mutationError;
  }
  return result as T;
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
    await withSymbolFtsPausedForPatch(wConn, async () => {
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
