import type { Connection } from "kuzu";

import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import type { SymbolReferenceRow } from "../../db/ladybug-queries.js";
import type { ConfigEdge } from "../configEdges.js";

interface PersistSkippedFileParams {
  conn: Connection;
  existingFileId?: string;
  fileId: string;
  repoId: string;
  relPath: string;
  contentHash: string;
  language: string;
  byteSize: number;
}

export function isTestFile(relPath: string, languages: string[]): boolean {
  const ext = relPath.split(".").pop() || "";
  if (!languages.includes(ext)) return false;

  const fileName = relPath.split("/").pop() || relPath.split("\\").pop() || "";
  const hasTestSuffix =
    fileName.includes(".test.") || fileName.includes(".spec.");
  const isInTestDir =
    relPath.includes("/tests/") ||
    relPath.includes("\\tests\\") ||
    relPath.includes("/__tests__/") ||
    relPath.includes("\\__tests__\\");

  return hasTestSuffix || isInTestDir;
}

export function extractSymbolReferences(
  content: string,
  repoId: string,
  fileId: string,
  conn?: Connection,
): Promise<void> {
  const references = buildSymbolReferences(content, repoId, fileId);
  if (references.length === 0) return Promise.resolve();

  return (async () => {
    const activeConn = conn ?? (await getLadybugConn());
    await ladybugDb.insertSymbolReferences(activeConn, references);
  })();
}

export function buildSymbolReferences(
  content: string,
  repoId: string,
  fileId: string,
): SymbolReferenceRow[] {
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens) return [];

  const uniqueTokens = new Set(tokens);
  const createdAt = new Date().toISOString();

  return Array.from(uniqueTokens, (token) => ({
    refId: `ref_${repoId}_${fileId}_${token}`,
    repoId,
    symbolName: token,
    fileId,
    lineNumber: null,
    createdAt,
  }));
}

export async function persistSkippedFile({
  conn,
  existingFileId,
  fileId,
  repoId,
  relPath,
  contentHash,
  language,
  byteSize,
}: PersistSkippedFileParams): Promise<void> {
  await ladybugDb.withTransaction(conn, async (txConn) => {
    if (existingFileId) {
      await ladybugDb.deleteSymbolsByFileId(txConn, existingFileId);
    }
    await ladybugDb.upsertFile(txConn, {
      fileId,
      repoId,
      relPath,
      contentHash,
      language,
      byteSize,
      lastIndexedAt: new Date().toISOString(),
    });
  });
}

export function createEmptyProcessFileResult(changed: boolean): {
  symbolsIndexed: number;
  edgesCreated: number;
  changed: boolean;
  configEdges: ConfigEdge[];
  pass2HintPaths: string[];
} {
  return {
    symbolsIndexed: 0,
    edgesCreated: 0,
    changed,
    configEdges: [],
    pass2HintPaths: [],
  };
}
