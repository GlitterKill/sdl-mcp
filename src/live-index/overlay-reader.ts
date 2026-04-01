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
import { hybridSearch } from "../retrieval/orchestrator.js";
import type { RetrievalEvidence } from "../retrieval/types.js";
import type { DraftOverlayEntry } from "./overlay-store.js";
import { getOverlayEmbeddingCache } from "./overlay-embedding-cache.js";
import { logger } from "../util/logger.js";

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

const MAX_SNAPSHOT_CACHE_SIZE = 50;
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
  if (snapshotCache.size >= MAX_SNAPSHOT_CACHE_SIZE) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
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
  kinds?: string[],
): Promise<Array<OverlaySearchResult>> {
  const snapshot = getOverlaySnapshot(repoId);
  const durableRows = (await ladybugDb.searchSymbolsLite(conn, repoId, query, limit * 2, kinds))
    .filter((row) => !snapshot.touchedFileIds.has(row.fileId));
  const durableSymbolIds = new Set(durableRows.map((row) => row.symbolId));
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
      file: file.relPath,
      kind: symbol.kind,
      exported: symbol.exported,
      filePath: file.relPath,
      summary: symbol.summary,
      searchText: symbol.searchText,
      matchedTermCount: matchCount,
      overlayOnly: !durableSymbolIds.has(symbol.symbolId),
    });
  }

  const durableSearchRows: OverlaySearchResult[] = durableRows.map((row) => ({
    ...row,
    filePath: durableFileMap.get(row.fileId)?.relPath ?? "",
  }));

  return mergeSearchResults(durableSearchRows, overlayRows, query, limit);
}

/**
 * Hybrid-aware overlay search. Uses hybrid retrieval (FTS + vector + RRF)
 * for durable symbols and lexical matching for overlay (draft) symbols.
 * Overlay symbols take precedence when the same symbolId exists in both.
 */
export async function searchSymbolsHybridWithOverlay(
  conn: Connection,
  repoId: string,
  query: string,
  limit: number,
  hybridOptions: {
    ftsTopK?: number;
    vectorTopK?: number;
    rrfK?: number;
    candidateLimit?: number;
    includeEvidence?: boolean;
  },
): Promise<{ rows: OverlaySearchResult[]; evidence?: RetrievalEvidence }> {
  const snapshot = getOverlaySnapshot(repoId);

  // 1. Run hybrid search for durable symbols
  const hybridResult = await hybridSearch({
    repoId,
    query,
    // Over-fetch since touched-file filtering removes some results.
    // The 2x multiplier is a heuristic; revisit if many files are in draft state.
    limit: limit * 2,
    ftsEnabled: true,
    vectorEnabled: true,
    rrfK: hybridOptions.rrfK,
    candidateLimit: hybridOptions.candidateLimit,
    includeEvidence: hybridOptions.includeEvidence,
  });

  // 2. Hydrate hybrid results — get symbol/file data, filter out touched files
  const hybridSymbolIds = hybridResult.results.map((r) => r.symbolId);
  const symbolMap = hybridSymbolIds.length > 0
    ? await ladybugDb.getSymbolsByIds(conn, hybridSymbolIds)
    : new Map<string, SymbolRow>();
  const fileIds = new Set<string>();
  for (const sym of symbolMap.values()) fileIds.add(sym.fileId);
  const fileMap = fileIds.size > 0
    ? await ladybugDb.getFilesByIds(conn, Array.from(fileIds))
    : new Map<string, FileRow>();

  const durableRows: OverlaySearchResult[] = [];
  for (const item of hybridResult.results) {
    const sym = symbolMap.get(item.symbolId);
    if (!sym) continue;
    if (snapshot.touchedFileIds.has(sym.fileId)) continue;
    const file = fileMap.get(sym.fileId);
    durableRows.push({
      symbolId: sym.symbolId,
      name: sym.name,
      kind: sym.kind,
      fileId: sym.fileId,
      file: file?.relPath ?? "",
      exported: sym.exported,
      filePath: file?.relPath ?? "",
    });
  }

  // Build a set of durable symbolIds so we can mark overlay-only hits below.
  const durableSymbolIdSet = new Set(durableRows.map((r) => r.symbolId));

  // 3. Collect overlay results (same logic as searchSymbolsWithOverlay)
  const loweredQuery = query.trim().toLowerCase();
  const terms = loweredQuery.includes(" ")
    ? loweredQuery.split(/\s+/).filter((t) => t.length > 0)
    : [loweredQuery];
  const isMultiTerm = terms.length > 1;

  const overlayRows: OverlaySearchResult[] = [];
  for (const symbol of snapshot.symbolsById.values()) {
    if (symbol.repoId !== repoId) continue;
    const haystack = [
      symbol.name,
      symbol.summary ?? "",
      symbol.searchText ?? "",
    ]
      .join(" ")
      .toLowerCase();
    const matchCount = isMultiTerm
      ? terms.filter((t) => haystack.includes(t)).length
      : (haystack.includes(loweredQuery) ? 1 : 0);
    if (matchCount === 0) continue;
    const file = snapshot.filesById.get(symbol.fileId);
    if (!file) continue;
    overlayRows.push({
      symbolId: symbol.symbolId,
      name: symbol.name,
      fileId: symbol.fileId,
      file: file.relPath,
      kind: symbol.kind,
      exported: symbol.exported,
      filePath: file.relPath,
      summary: symbol.summary,
      searchText: symbol.searchText,
      matchedTermCount: matchCount,
      // Overlay-only: no durable DB record for this symbolId
      overlayOnly: !durableSymbolIdSet.has(symbol.symbolId),
    });
    // Fire-and-forget: lazily populate the embedding cache for this overlay symbol.
    // This never blocks the search path — the result will be used on subsequent calls.
    getOverlayEmbeddingCache()
      .computeAndCacheSymbol(symbol)
      .catch((err) => { logger.debug(`[overlay-embedding-cache] Fire-and-forget embed failed for ${symbol.symbolId}: ${err instanceof Error ? err.message : String(err)}`); });
  }

  // 4. Merge: use mergeSearchResults for proper interleaving.
  //    Overlay takes precedence for matching symbolIds.
  //    Durable results retain their hybrid RRF ordering via the merge sort.
  //    Overlay-only hits are preserved regardless of score (see mergeSearchResults).
  const merged = mergeSearchResults(durableRows, overlayRows, query, limit);

  // 5. Update evidence with overlay-only candidate count.
  const overlayOnlyCount = overlayRows.filter((r) => r.overlayOnly).length;
  const evidence = hybridResult.evidence;
  if (evidence && overlayOnlyCount > 0) {
    evidence.candidateCountPerSource = {
      ...evidence.candidateCountPerSource,
      overlay: overlayOnlyCount,
    };
  }

  return { rows: merged, evidence };
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
