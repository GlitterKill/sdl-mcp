import * as ladybugDb from "../db/ladybug-queries.js";
import { getLadybugConn } from "../db/ladybug.js";
import type {
  Pass2ExportedSymbolFull,
  Pass2ImportCache,
} from "./pass2/types.js";

/**
 * Build the pass-2 import resolution cache with two batched reads:
 *
 *   1. `getFilesByRepo` — every File row keyed by `relPath`.
 *   2. `getExportedSymbolsLiteByFileIds` — exported `(symbolId, name)` tuples
 *      grouped by `fileId`.
 *
 * Both batches run on a single read connection. Replaces the per-file
 * `getFileByRepoPath` and `getSymbolsByFile` round-trips that
 * `import-resolution.ts` previously made on every imported module — for a
 * 1000-file TS repo with 20 imports/file × 1.5 candidate paths each, that
 * collapsed ~30k point reads into 2 batched queries.
 */
export interface PreloadedPass2ExportedSymbols {
  lite: ReadonlyMap<string, readonly ladybugDb.ExportedSymbolLite[]>;
  full: ReadonlyMap<string, readonly Pass2ExportedSymbolFull[]>;
}

export type Pass2TimingRecorder = (phaseName: string, durationMs: number) => void;

export function buildPreloadedPass2ExportedSymbolsFromRows(params: {
  files: Iterable<Pick<ladybugDb.FileRow, "fileId">>;
  symbols: Iterable<
    Pick<
      ladybugDb.SymbolRow,
      | "symbolId"
      | "repoId"
      | "fileId"
      | "kind"
      | "name"
      | "exported"
      | "language"
      | "rangeStartLine"
      | "rangeStartCol"
      | "rangeEndLine"
      | "rangeEndCol"
      | "symbolStatus"
    >
  >;
}): {
  lite: Map<string, ladybugDb.ExportedSymbolLite[]>;
  full: Map<string, Pass2ExportedSymbolFull[]>;
} {
  const lite = new Map<string, ladybugDb.ExportedSymbolLite[]>();
  const full = new Map<string, Pass2ExportedSymbolFull[]>();
  for (const file of params.files) {
    lite.set(file.fileId, []);
    full.set(file.fileId, []);
  }
  for (const symbol of params.symbols) {
    if ((symbol.symbolStatus ?? "real") !== "real") continue;
    if (!symbol.exported) continue;
    const liteList = lite.get(symbol.fileId);
    const fullList = full.get(symbol.fileId);
    if (!liteList || !fullList) continue;
    liteList.push({ symbolId: symbol.symbolId, name: symbol.name });
    fullList.push({
      symbolId: symbol.symbolId,
      repoId: symbol.repoId,
      fileId: symbol.fileId,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported,
      language: symbol.language,
      rangeStartLine: symbol.rangeStartLine,
      rangeStartCol: symbol.rangeStartCol,
      rangeEndLine: symbol.rangeEndLine,
      rangeEndCol: symbol.rangeEndCol,
    });
  }
  sortPreloadedPass2ExportedSymbols(lite, full);
  return { lite, full };
}

function sortPreloadedPass2ExportedSymbols(
  lite: Map<string, ladybugDb.ExportedSymbolLite[]>,
  full: Map<string, Pass2ExportedSymbolFull[]>,
): void {
  for (const list of lite.values()) {
    list.sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.symbolId.localeCompare(b.symbolId);
    });
  }
  for (const list of full.values()) {
    list.sort((a, b) => {
      if (a.rangeStartLine !== b.rangeStartLine) {
        return a.rangeStartLine - b.rangeStartLine;
      }
      if (a.rangeStartCol !== b.rangeStartCol) {
        return a.rangeStartCol - b.rangeStartCol;
      }
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.symbolId.localeCompare(b.symbolId);
    });
  }
}

function clonePreloadedPass2LiteSymbols(
  preloaded: ReadonlyMap<
    string,
    readonly ladybugDb.ExportedSymbolLite[]
  > | null,
  targetFileIds: ReadonlySet<string>,
): Map<string, ladybugDb.ExportedSymbolLite[]> {
  const cloned = new Map<string, ladybugDb.ExportedSymbolLite[]>();
  if (!preloaded) return cloned;
  for (const [fileId, symbols] of preloaded) {
    if (!targetFileIds.has(fileId)) continue;
    cloned.set(
      fileId,
      symbols.map((symbol) => ({ ...symbol })),
    );
  }
  return cloned;
}

function clonePreloadedPass2FullSymbols(
  preloaded: ReadonlyMap<string, readonly Pass2ExportedSymbolFull[]> | null,
  targetFileIds: ReadonlySet<string>,
): Map<string, Pass2ExportedSymbolFull[]> | undefined {
  if (!preloaded) return undefined;
  const cloned = new Map<string, Pass2ExportedSymbolFull[]>();
  for (const [fileId, symbols] of preloaded) {
    if (!targetFileIds.has(fileId)) continue;
    cloned.set(
      fileId,
      symbols.map((symbol) => ({ ...symbol })),
    );
  }
  return cloned;
}

export async function buildPass2ImportCache(
  repoId: string,
  preloaded?: PreloadedPass2ExportedSymbols,
): Promise<Pass2ImportCache> {
  const conn = await getLadybugConn();
  const files = await ladybugDb.getFilesByRepo(conn, repoId);
  const fileByRelPath = new Map<string, ladybugDb.FileRow>();
  const fileIds = files.map((f) => f.fileId);
  const targetFileIds = new Set(fileIds);
  for (const file of files) {
    fileByRelPath.set(file.relPath, file);
  }
  const exportedSymbolsByFileId = clonePreloadedPass2LiteSymbols(
    preloaded?.lite ?? null,
    targetFileIds,
  );
  const missingExportFileIds = fileIds.filter(
    (fileId) => !exportedSymbolsByFileId.has(fileId),
  );
  const loadedExportedSymbolsByFileId =
    await ladybugDb.getExportedSymbolsLiteByFileIds(
      conn,
      missingExportFileIds,
    );
  for (const [fileId, symbols] of loadedExportedSymbolsByFileId) {
    exportedSymbolsByFileId.set(
      fileId,
      symbols.map((symbol) => ({ ...symbol })),
    );
  }
  const exportedFullSymbolsByFileId = clonePreloadedPass2FullSymbols(
    preloaded?.full ?? null,
    targetFileIds,
  );
  return {
    fileByRelPath,
    exportedSymbolsByFileId,
    exportedFullSymbolsByFileId,
  };
}
