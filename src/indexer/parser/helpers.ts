import { insertSymbolReference } from "../../db/queries.js";

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
  fileId: number,
): void {
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (!tokens) return;

  const uniqueTokens = new Set(tokens);
  const createdAt = new Date().toISOString();

  for (const token of uniqueTokens) {
    insertSymbolReference({
      repo_id: repoId,
      symbol_name: token,
      file_id: fileId,
      line_number: null,
      created_at: createdAt,
    });
  }
}

