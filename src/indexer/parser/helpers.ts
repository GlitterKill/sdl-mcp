import type { Connection } from "kuzu";

import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import type { SymbolReferenceRow } from "../../db/kuzu-queries.js";

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
    const activeConn = conn ?? (await getKuzuConn());
    await kuzuDb.insertSymbolReferences(activeConn, references);
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
