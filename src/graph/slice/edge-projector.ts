// =============================================================================
// graph/slice/edge-projector.ts — Slice edge projection + dependency mapping.
//
// Public exports:
//   - SliceEdgeProjection
//   - buildSliceDepsBySymbol(...)
//   - loadEdgesBetweenSymbols(...)
// =============================================================================

import type { Connection } from "kuzu";
import type { RepoId, SymbolId, EdgeType } from "../../domain/types.js";
import type { SliceSymbolDeps, ConfidenceDistribution } from "../../domain/types.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { SYMBOL_CARD_MAX_DEPS_PER_KIND } from "../../config/constants.js";
import { normalizeEdgeConfidence, type FrontierItem } from "../slice/beam-search-engine.js";
import { encodeEdgesWithSymbolIndex, uniqueDepRefs } from "../slice/slice-serializer.js";
import { getOverlaySnapshot, mergeEdgeMapWithOverlay, type OverlaySnapshot } from "../../live-index/overlay-reader.js";
import type { SliceBuildRequest } from "./types.js";

export type SliceEdgeProjection = {
  from_symbol_id: SymbolId;
  to_symbol_id: SymbolId;
  type: EdgeType;
  weight: number;
  confidence?: number;
};

export async function buildSliceDepsBySymbol(
  conn: Connection,
  symbolIds: SymbolId[],
  prefetchedEdgesMap?: Map<SymbolId, ladybugDb.EdgeForSlice[]>,
  minCallConfidence?: number,
): Promise<Map<SymbolId, SliceSymbolDeps>> {
  const depMap = new Map<SymbolId, SliceSymbolDeps>();
  if (symbolIds.length === 0) {
    return depMap;
  }

  const edgesMap = new Map<SymbolId, ladybugDb.EdgeForSlice[]>();
  if (prefetchedEdgesMap) {
    for (const [symbolId, edges] of prefetchedEdgesMap) {
      edgesMap.set(symbolId, edges);
    }
  }

  const missingSymbolIds = symbolIds.filter(
    (symbolId) => !edgesMap.has(symbolId),
  );
  if (missingSymbolIds.length > 0) {
    const missingEdgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(
      conn,
      missingSymbolIds,
      { minCallConfidence },
    );
    for (const [symbolId, edges] of missingEdgesMap) {
      edgesMap.set(symbolId, edges);
    }
  }

  for (const symbolId of symbolIds) {
    const outgoing = edgesMap.get(symbolId) ?? [];
    const imports: SliceSymbolDeps["imports"] = [];
    const calls: SliceSymbolDeps["calls"] = [];

    for (const edge of outgoing) {
      const depRef = {
        symbolId: edge.toSymbolId,
        confidence: normalizeEdgeConfidence(edge.confidence),
      };
      if (edge.edgeType === "import") {
        imports.push(depRef);
      } else if (edge.edgeType === "call") {
        calls.push(depRef);
      }
    }

    depMap.set(symbolId, {
      imports: uniqueDepRefs(imports, SYMBOL_CARD_MAX_DEPS_PER_KIND),
      calls: uniqueDepRefs(calls, SYMBOL_CARD_MAX_DEPS_PER_KIND),
    });
  }

  return depMap;
}

export async function loadEdgesBetweenSymbols(
  conn: Connection,
  symbolIds: SymbolId[],
  repoId: RepoId,
  minConfidence: number,
  minCallConfidence?: number,
  overlaySnapshot?: OverlaySnapshot,
): Promise<{
  symbolIndex: SymbolId[];
  edges: [number, number, EdgeType, number][];
  confidenceDistribution: ConfidenceDistribution;
}> {
  if (symbolIds.length === 0) {
    return {
      symbolIndex: [],
      edges: [],
      confidenceDistribution: {
        high: 0,
        medium: 0,
        low: 0,
        unknown: 0,
      },
    };
  }

  const symbolSet = new Set(symbolIds);
  const dbEdges: SliceEdgeProjection[] = [];
  const confidenceDistribution: ConfidenceDistribution = {
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };

  const durableEdgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(
    conn,
    symbolIds,
    {
      minCallConfidence,
    },
  );
  const snapshot = overlaySnapshot ?? getOverlaySnapshot(repoId);
  const edgesMap = mergeEdgeMapWithOverlay(
    snapshot,
    symbolIds,
    durableEdgesMap,
    minCallConfidence,
  );

  for (const [_fromId, outgoing] of edgesMap) {
    for (const edge of outgoing) {
      const edgeType = edge.edgeType as EdgeType;
      if (
        edgeType !== "call" &&
        edgeType !== "import" &&
        edgeType !== "config"
      ) {
        continue;
      }

      const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
      if (
        typeof edge.confidence !== "number" ||
        Number.isNaN(edge.confidence)
      ) {
        confidenceDistribution.unknown++;
      } else if (edgeConfidence >= 0.9) {
        confidenceDistribution.high++;
      } else if (edgeConfidence >= 0.6) {
        confidenceDistribution.medium++;
      } else {
        confidenceDistribution.low++;
      }
      if (symbolSet.has(edge.toSymbolId) && edgeConfidence >= minConfidence) {
        dbEdges.push({
          from_symbol_id: edge.fromSymbolId,
          to_symbol_id: edge.toSymbolId,
          type: edgeType,
          weight: edge.weight,
          confidence: edge.confidence,
        });
      }
    }
  }
  const encoded = encodeEdgesWithSymbolIndex(symbolIds, dbEdges);
  return {
    ...encoded,
    confidenceDistribution,
  };
}

export type { SliceBuildRequest, FrontierItem };
