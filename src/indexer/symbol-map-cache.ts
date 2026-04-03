import type { Connection } from "kuzu";

import * as ladybugDb from "../db/ladybug-queries.js";
import { registerDbCloseHook } from "../db/ladybug.js";
import type { SymbolKind } from "../domain/types.js";
import { normalizePath } from "../util/paths.js";
import { addToSymbolIndex } from "./edge-builder.js";
import type { SymbolIndex } from "./edge-builder.js";

export interface SymbolMapFileUpdate {
  fileId: string;
  relPath: string;
  symbols: ladybugDb.SymbolLiteRow[];
}

export interface SymbolMapCache {
  repoId: string;
  symbolsByFileId: Map<string, ladybugDb.SymbolLiteRow[]>;
  filePathById: Map<string, string>;
  allSymbolsByName: Map<string, ladybugDb.SymbolLiteRow[]>;
  globalNameToSymbolIds: Map<string, string[]>;
  globalPreferredSymbolId: Map<string, string>;
  symbolIndex: SymbolIndex;
}

const symbolMapCacheByRepo = new Map<string, SymbolMapCache>();

// Register cache cleanup with the DB close lifecycle so that db/ does not
// need to import from indexer/ (preserves hexagonal dependency direction).
registerDbCloseHook(clearSymbolMapCache);

export function getCachedSymbolMap(repoId: string): SymbolMapCache | undefined {
  return symbolMapCacheByRepo.get(repoId);
}

export async function getOrLoadSymbolMapCache(
  conn: Connection,
  repoId: string,
): Promise<SymbolMapCache> {
  const cached = symbolMapCacheByRepo.get(repoId);
  if (cached) {
    return cached;
  }

  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  const symbols = await ladybugDb.getSymbolsByRepoLite(conn, repoId);
  return buildSymbolMapCacheFromRows({ repoId, files, symbols });
}

export function buildSymbolMapCacheFromRows(params: {
  repoId: string;
  files: ladybugDb.FileRow[];
  symbols: ladybugDb.SymbolLiteRow[];
}): SymbolMapCache {
  const { repoId, files, symbols } = params;
  const cache: SymbolMapCache = {
    repoId,
    symbolsByFileId: new Map(),
    filePathById: new Map(),
    allSymbolsByName: new Map(),
    globalNameToSymbolIds: new Map(),
    globalPreferredSymbolId: new Map(),
    symbolIndex: new Map(),
  };

  for (const file of files) {
    cache.filePathById.set(file.fileId, normalizePath(file.relPath));
  }

  for (const symbol of symbols) {
    addSymbolToCache(cache, symbol);
  }

  symbolMapCacheByRepo.set(repoId, cache);
  return cache;
}

export function removeFilesFromSymbolMapCache(
  cache: SymbolMapCache,
  removedFileIds: Iterable<string>,
): void {
  for (const fileId of removedFileIds) {
    removeFileFromCache(cache, fileId);
  }
}

export function applySymbolMapFileUpdates(
  cache: SymbolMapCache,
  updates: Iterable<SymbolMapFileUpdate>,
): void {
  for (const update of updates) {
    removeFileFromCache(cache, update.fileId);

    const relPath = normalizePath(update.relPath);
    const nextSymbols = update.symbols.map((symbol) => ({
      ...symbol,
      fileId: update.fileId,
      repoId: cache.repoId,
    }));

    cache.filePathById.set(update.fileId, relPath);

    const fileIndex: SymbolIndex = new Map();
    for (const symbol of nextSymbols) {
      addSymbolToCache(cache, symbol);
      addToSymbolIndex(
        fileIndex,
        relPath,
        symbol.symbolId,
        symbol.name,
        symbol.kind as SymbolKind,
      );
    }

    if (fileIndex.size > 0) {
      const entry = fileIndex.get(relPath);
      if (entry) {
        cache.symbolIndex.set(relPath, entry);
      }
    }
  }
}

export function syncSymbolIndexFromCache(
  cache: SymbolMapCache,
  symbolIndex: SymbolIndex,
): void {
  symbolIndex.clear();
  for (const [filePath, symbolsByName] of cache.symbolIndex) {
    symbolIndex.set(filePath, symbolsByName);
  }
}

export function clearSymbolMapCache(repoId?: string): void {
  if (repoId) {
    symbolMapCacheByRepo.delete(repoId);
    return;
  }
  symbolMapCacheByRepo.clear();
}

function addSymbolToCache(
  cache: SymbolMapCache,
  symbol: ladybugDb.SymbolLiteRow,
): void {
  const byFile = cache.symbolsByFileId.get(symbol.fileId) ?? [];
  byFile.push(symbol);
  cache.symbolsByFileId.set(symbol.fileId, byFile);

  const byName = cache.allSymbolsByName.get(symbol.name) ?? [];
  byName.push(symbol);
  cache.allSymbolsByName.set(symbol.name, byName);

  const symbolIds = cache.globalNameToSymbolIds.get(symbol.name) ?? [];
  insertSortedUnique(symbolIds, symbol.symbolId);
  cache.globalNameToSymbolIds.set(symbol.name, symbolIds);

  const filePath = cache.filePathById.get(symbol.fileId);
  if (filePath) {
    addToSymbolIndex(
      cache.symbolIndex,
      filePath,
      symbol.symbolId,
      symbol.name,
      symbol.kind as SymbolKind,
    );
  }

  updatePreferredSymbolForName(cache, symbol.name);
}

function removeFileFromCache(cache: SymbolMapCache, fileId: string): void {
  const previousSymbols = cache.symbolsByFileId.get(fileId);
  if (previousSymbols) {
    for (const symbol of previousSymbols) {
      const byName = cache.allSymbolsByName.get(symbol.name);
      if (byName) {
        const remainingByName = byName.filter(
          (candidate) => candidate.symbolId !== symbol.symbolId,
        );
        if (remainingByName.length === 0) {
          cache.allSymbolsByName.delete(symbol.name);
        } else {
          cache.allSymbolsByName.set(symbol.name, remainingByName);
        }
      }

      const symbolIds = cache.globalNameToSymbolIds.get(symbol.name);
      if (symbolIds) {
        const remainingIds = symbolIds.filter((id) => id !== symbol.symbolId);
        if (remainingIds.length === 0) {
          cache.globalNameToSymbolIds.delete(symbol.name);
        } else {
          cache.globalNameToSymbolIds.set(symbol.name, remainingIds);
        }
      }

      updatePreferredSymbolForName(cache, symbol.name);
    }
    cache.symbolsByFileId.delete(fileId);
  }

  const filePath = cache.filePathById.get(fileId);
  if (filePath) {
    cache.symbolIndex.delete(filePath);
    cache.filePathById.delete(fileId);
  }
}

function insertSortedUnique(ids: string[], symbolId: string): void {
  if (ids.includes(symbolId)) {
    return;
  }
  ids.push(symbolId);
  ids.sort();
}

function updatePreferredSymbolForName(
  cache: SymbolMapCache,
  name: string,
): void {
  const candidates = cache.allSymbolsByName.get(name) ?? [];
  if (candidates.length <= 1) {
    cache.globalPreferredSymbolId.delete(name);
    return;
  }

  const exportedCandidates = candidates.filter((symbol) => symbol.exported);
  if (exportedCandidates.length === 1) {
    cache.globalPreferredSymbolId.set(name, exportedCandidates[0].symbolId);
    return;
  }

  cache.globalPreferredSymbolId.delete(name);
}
