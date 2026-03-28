import type { SymbolKind } from "../../domain/types.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizePath } from "../../util/paths.js";

import type { SymbolIndex } from "./types.js";

export function addToSymbolIndex(
  index: SymbolIndex,
  filePath: string,
  symbolId: string,
  name: string,
  kind: SymbolKind,
): void {
  const fileKey = normalizePath(filePath);
  let fileEntry = index.get(fileKey);
  if (!fileEntry) {
    fileEntry = new Map();
    index.set(fileKey, fileEntry);
  }

  let nameEntry = fileEntry.get(name);
  if (!nameEntry) {
    nameEntry = new Map();
    fileEntry.set(name, nameEntry);
  }

  const kindEntry = nameEntry.get(kind) ?? [];
  kindEntry.push(symbolId);
  nameEntry.set(kind, kindEntry);
}

export async function resolveSymbolIdFromIndex(
  index: SymbolIndex,
  repoId: string,
  filePath: string,
  name: string,
  kind: SymbolKind,
  callerLanguage?: string,
): Promise<string | null> {
  const fileEntry = index.get(normalizePath(filePath));
  if (!fileEntry) return null;
  const nameEntry = fileEntry.get(name);
  if (!nameEntry) return null;
  const candidates = nameEntry.get(kind);
  if (!candidates || candidates.length !== 1) return null;

  // ML-D.1: Language-aware symbol resolution
  // If callerLanguage is provided, check if the target file is the same language
  if (callerLanguage) {
    const conn = await getLadybugConn();
    const targetFile = await ladybugDb.getFileByRepoPath(conn, repoId, filePath);
    if (targetFile && targetFile.language !== callerLanguage) {
      // Cross-language call - return null to mark as unresolved
      return null;
    }
  }

  return candidates[0];
}
