import type {
  Connection,
} from "kuzu";

import type {
  EdgeForSlice,
  SymbolRow,
  FileRow,
} from "../db/ladybug-queries.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  getDefaultOverlayStore,
} from "./coordinator.js";
import { mergeSearchResults, type OverlaySearchResult } from "./overlay-merge.js";
import type { DraftOverlayEntry } from "./overlay-store.js";

export interface OverlaySnapshot {
  repoId: string;
  touchedFileIds: Set<string>;
  symbolsById: Map<string, SymbolRow>;
  filesById: Map<string, FileRow>;
  outgoingEdgesBySymbolId: Map<string, EdgeForSlice[]>;
}

function toEdgeForSlice(edge: {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
  resolution?: string;
  resolverId?: string;
  resolutionPhase?: string;
}): EdgeForSlice {
  return {
    fromSymbolId: edge.fromSymbolId,
    toSymbolId: edge.toSymbolId,
    edgeType: edge.edgeType,
    weight: edge.weight,
    confidence: edge.confidence,
    resolution: edge.resolution,
    resolverId: edge.resolverId,
    resolutionPhase: edge.resolutionPhase,
  };
}

function draftEntriesWithParse(repoId: string): DraftOverlayEntry[] {
  return getDefaultOverlayStore()
    .listDrafts(repoId)
    .filter((entry) => entry.parseResult !== null);
}

const snapshotCache = new Map<string, { version: number; snapshot: OverlaySnapshot }>();

export function getOverlaySnapshot(repoId: string): OverlaySnapshot {
  const store = getDefaultOverlayStore();
  const currentVersion = store.getSnapshotVersion(repoId);
  const cached = snapshotCache.get(repoId);
  if (cached && cached.version === currentVersion) {
    return cached.snapshot;
  }

  const touchedFileIds = new Set<string>();
  const symbolsById = new Map<string, SymbolRow>();
  const filesById = new Map<string, FileRow>();
  const outgoingEdgesBySymbolId = new Map<string, EdgeForSlice[]>();

  for (const entry of draftEntriesWithParse(repoId)) {
    const parseResult = entry.parseResult;
    if (!parseResult) {
      continue;
    }
    touchedFileIds.add(parseResult.file.fileId);
    filesById.set(parseResult.file.fileId, parseResult.file);

    for (const symbol of parseResult.symbols) {
      symbolsById.set(symbol.symbolId, symbol);
    }

    for (const edge of parseResult.edges) {
      const existing = outgoingEdgesBySymbolId.get(edge.fromSymbolId) ?? [];
      existing.push(toEdgeForSlice(edge));
      outgoingEdgesBySymbolId.set(edge.fromSymbolId, existing);
    }
  }

  const snapshot: OverlaySnapshot = {
    repoId,
    touchedFileIds,
    symbolsById,
    filesById,
    outgoingEdgesBySymbolId,
  };
  snapshotCache.set(repoId, { version: currentVersion, snapshot });
  return snapshot;
}

export function clearSnapshotCache(): void {
  snapshotCache.clear();
}

export function getOverlaySymbol(
  snapshot: OverlaySnapshot,
  symbolId: string,
): { symbol: SymbolRow; file: FileRow; outgoingEdges: EdgeForSlice[] } | null {
  const symbol = snapshot.symbolsById.get(symbolId);
  if (!symbol) {
    return null;
  }

  const file = snapshot.filesById.get(symbol.fileId);
  if (!file) {
    return null;
  }

  return {
    symbol,
    file,
    outgoingEdges: snapshot.outgoingEdgesBySymbolId.get(symbolId) ?? [],
  };
}

export async function getShadowedDurableSymbol(
  conn: Connection,
  repoId: string,
  symbolId: string,
  snapshot: OverlaySnapshot,
): Promise<SymbolRow | null> {
  const durableSymbol = await ladybugDb.getSymbol(conn, symbolId);
  if (!durableSymbol || durableSymbol.repoId !== repoId) {
    return null;
  }

  if (!snapshot.touchedFileIds.has(durableSymbol.fileId)) {
    return durableSymbol;
  }

  return snapshot.symbolsById.get(symbolId) ? durableSymbol : null;
}

export async function searchSymbolsWithOverlay(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
): Promise<Array<OverlaySearchResult>> {
  const snapshot = getOverlaySnapshot(repoId);
  const durableRows = (await ladybugDb.searchSymbolsLite(conn, repoId, query, limit * 2))
    .filter((row) => !snapshot.touchedFileIds.has(row.fileId));
  const durableFileMap = await ladybugDb.getFilesByIds(
    conn,
    Array.from(new Set(durableRows.map((row) => row.fileId))),
  );

  const loweredQuery = query.trim().toLowerCase();
  const terms = loweredQuery.includes(" ")
    ? loweredQuery.split(/\s+/).filter((t) => t.length > 0)
    : [loweredQuery];
  const isMultiTerm = terms.length > 1;

  const overlayRows: OverlaySearchResult[] = [];
  for (const symbol of snapshot.symbolsById.values()) {
    if (symbol.repoId !== repoId) {
      continue;
    }
    const haystack = [
      symbol.name,
      symbol.summary ?? "",
      symbol.searchText ?? "",
    ]
      .join(" ")
      .toLowerCase();

    // For multi-term: match if ANY term matches (OR semantics)
    // For single-term: existing behavior
    const matchCount = isMultiTerm
      ? terms.filter((t) => haystack.includes(t)).length
      : (haystack.includes(loweredQuery) ? 1 : 0);
    if (matchCount === 0) {
      continue;
    }
    const file = snapshot.filesById.get(symbol.fileId);
    if (!file) {
      continue;
    }
    overlayRows.push({
      symbolId: symbol.symbolId,
      name: symbol.name,
      fileId: symbol.fileId,
      kind: symbol.kind,
      filePath: file.relPath,
      summary: symbol.summary,
      searchText: symbol.searchText,
      matchedTermCount: matchCount,
    });
  }

  const durableSearchRows: OverlaySearchResult[] = durableRows.map((row) => ({
    ...row,
    filePath: durableFileMap.get(row.fileId)?.relPath ?? "",
  }));

  return mergeSearchResults(durableSearchRows, overlayRows, query, limit);
}

export async function getTargetNamesWithOverlay(
  conn: Connection,
  snapshot: OverlaySnapshot,
  targetIds: string[],
): Promise<Map<string, { name: string }>> {
  const result = new Map<string, { name: string }>();
  const missing: string[] = [];

  for (const targetId of targetIds) {
    const overlay = snapshot.symbolsById.get(targetId);
    if (overlay) {
      result.set(targetId, { name: overlay.name });
      continue;
    }
    missing.push(targetId);
  }

  const durable = await ladybugDb.getSymbolsByIdsLite(conn, missing);
  for (const [symbolId, symbol] of durable) {
    result.set(symbolId, { name: symbol.name });
  }

  return result;
}

export function mergeEdgeMapWithOverlay(
  snapshot: OverlaySnapshot,
  symbolIds: string[],
  durableEdgesMap: Map<string, EdgeForSlice[]>,
  minCallConfidence?: number,
): Map<string, EdgeForSlice[]> {
  const merged = new Map<string, EdgeForSlice[]>();

  for (const symbolId of symbolIds) {
    const overlayEdges = snapshot.outgoingEdgesBySymbolId.get(symbolId);
    if (overlayEdges) {
      merged.set(
        symbolId,
        overlayEdges.filter(
          (edge) =>
            edge.edgeType !== "call" ||
            minCallConfidence === undefined ||
            edge.confidence >= minCallConfidence,
        ),
      );
      continue;
    }

    merged.set(symbolId, durableEdgesMap.get(symbolId) ?? []);
  }

  return merged;
}

export function mergeSymbolRowsWithOverlay(
  snapshot: OverlaySnapshot,
  symbolIds: string[],
  durableSymbolsMap: Map<string, SymbolRow>,
): Map<string, SymbolRow> {
  const merged = new Map<string, SymbolRow>();
  for (const symbolId of symbolIds) {
    const overlay = snapshot.symbolsById.get(symbolId);
    if (overlay) {
      merged.set(symbolId, overlay);
      continue;
    }

    const durable = durableSymbolsMap.get(symbolId);
    if (durable) {
      merged.set(symbolId, durable);
    }
  }

  return merged;
}
