import { addToSymbolIndex, type SymbolIndex } from "./edge-builder.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import type { SymbolKind } from "../domain/types.js";
import { buildGlobalPreferredSymbolIds, type LadybugConn } from "./indexer-init.js";

export async function refreshSymbolIndexFromDb(
  conn: LadybugConn,
  repoId: string,
  symbolIndex: SymbolIndex,
  globalNameToSymbolIds: Map<string, string[]>,
  globalPreferredSymbolId?: Map<string, string>,
): Promise<void> {
  const refreshed: SymbolIndex = new Map();
  const allFiles = await ladybugDb.getFilesByRepo(conn, repoId);
  const filePathById = new Map(allFiles.map((f) => [f.fileId, f.relPath]));
  const symbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
  for (const symbol of symbols) {
    const filePath = filePathById.get(symbol.fileId);
    if (filePath)
      addToSymbolIndex(
        refreshed,
        filePath,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );
  }
  symbolIndex.clear();
  for (const [fp, names] of refreshed) symbolIndex.set(fp, names);

  // Refresh global name index so Pass 2 can heuristically resolve cross-file calls.
  globalNameToSymbolIds.clear();
  const allSymbolsByName = new Map<string, ladybugDb.SymbolLiteRow[]>();
  for (const symbol of symbols) {
    const byId = globalNameToSymbolIds.get(symbol.name) ?? [];
    byId.push(symbol.symbolId);
    globalNameToSymbolIds.set(symbol.name, byId);
    const byName = allSymbolsByName.get(symbol.name) ?? [];
    byName.push({
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      name: symbol.name,
      kind: symbol.kind,
      exported: symbol.exported,
    });
    allSymbolsByName.set(symbol.name, byName);
  }
  for (const ids of globalNameToSymbolIds.values()) {
    ids.sort();
    for (let i = ids.length - 1; i > 0; i--) {
      if (ids[i] === ids[i - 1]) ids.splice(i, 1);
    }
  }

  // Refresh preferred symbol disambiguation map
  if (globalPreferredSymbolId) {
    globalPreferredSymbolId.clear();
    const refreshedPreferred = buildGlobalPreferredSymbolIds(allSymbolsByName);
    for (const [name, id] of refreshedPreferred) {
      globalPreferredSymbolId.set(name, id);
    }
  }
}

