import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";

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
): Promise<void> {
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens) return Promise.resolve();

  const uniqueTokens = new Set(tokens);
  const createdAt = new Date().toISOString();

  return (async () => {
    const conn = await getKuzuConn();
    for (const token of uniqueTokens) {
      await kuzuDb.insertSymbolReference(conn, {
        refId: `ref_${repoId}_${fileId}_${token}`,
        repoId,
        symbolName: token,
        fileId,
        lineNumber: null,
        createdAt,
      });
    }
  })();
}
