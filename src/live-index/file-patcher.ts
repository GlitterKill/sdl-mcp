import { readFileAsync } from "../util/asyncFs.js";
import { getKuzuConn } from "../db/kuzu.js";
import * as kuzuDb from "../db/kuzu-queries.js";
import type { RepoConfig } from "../config/types.js";
import { getAbsolutePathFromRepoRoot, normalizePath } from "../util/paths.js";
import { buildDependencyFrontier, type DependencyFrontier } from "./dependency-frontier.js";
import { parseDraftFile, type DraftParseResult } from "./draft-parser.js";
import { IndexError } from "../mcp/errors.js";

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
  edgesUpserted: number;
  referencesUpserted: number;
  parseResult: DraftParseResult;
  frontier: DependencyFrontier;
}

export async function patchSavedFile(
  request: SavedFilePatchRequest,
): Promise<SavedFilePatchResult> {
  const conn = await getKuzuConn();
  const repo = await kuzuDb.getRepo(conn, request.repoId);
  if (!repo) {
    throw new IndexError(`Repository ${request.repoId} not found`);
  }

  const repoConfig = JSON.parse(repo.configJson) as RepoConfig;
  const relPath = normalizePath(request.filePath);
  const existingFile = await kuzuDb.getFileByRepoPath(conn, request.repoId, relPath);

  const parseResult =
    request.parseResult ??
    (await parseDraftFile({
      repoId: request.repoId,
      repoRoot: repo.rootPath,
      filePath: relPath,
      content:
        request.content ??
        (await readFileAsync(getAbsolutePathFromRepoRoot(repo.rootPath, relPath), "utf-8")),
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

  await kuzuDb.withTransaction(conn, async (txConn) => {
    await kuzuDb.upsertFile(txConn, durableFile);
    if (existingFile) {
      await kuzuDb.deleteSymbolsByFileId(txConn, existingFile.fileId);
      await kuzuDb.deleteSymbolReferencesByFileId(txConn, existingFile.fileId);
    } else {
      await kuzuDb.deleteSymbolReferencesByFileId(txConn, durableFile.fileId);
    }

    await kuzuDb.insertSymbolReferences(txConn, parseResult.references);
    for (const symbol of parseResult.symbols) {
      await kuzuDb.upsertSymbol(txConn, {
        ...symbol,
        updatedAt: now,
      });
    }
    await kuzuDb.insertEdges(
      txConn,
      parseResult.edges.map((edge) => ({
        ...edge,
        createdAt: now,
      })),
    );
  });

  return {
    repoId: request.repoId,
    filePath: relPath,
    fileId: durableFile.fileId,
    symbolsUpserted: parseResult.symbols.length,
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
