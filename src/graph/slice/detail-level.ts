// =============================================================================
// graph/slice/detail-level.ts — Detail-level resolution + metadata builders.
//
// Public exports:
//   - resolveEffectiveDetailLevel(...)
//   - buildDetailLevelMetadata(...)
//   - buildCallResolution(...)
// =============================================================================

import type { SliceBudget, SymbolCard, CardDetailLevel, DetailLevelMetadata, CallResolution } from "../../domain/types.js";
import { normalizeCardDetailLevel } from "../../domain/types.js";
import { pickDepLabel } from "../../util/depLabels.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { normalizeEdgeConfidence } from "../slice/beam-search-engine.js";
import { selectAdaptiveDetailLevel } from "../slice/slice-serializer.js";
import type { SliceBuildRequest } from "./types.js";

export function resolveEffectiveDetailLevel(
  request: SliceBuildRequest,
  budget: Required<SliceBudget>,
  cardCount: number,
): CardDetailLevel {
  const requestedLevel = normalizeCardDetailLevel(request.cardDetail);

  if (request.adaptiveDetail === false) {
    return requestedLevel;
  }

  return selectAdaptiveDetailLevel(
    budget.maxEstimatedTokens,
    cardCount,
    requestedLevel,
  );
}

export function buildDetailLevelMetadata(
  cards: SymbolCard[],
  requested: CardDetailLevel,
  effective: CardDetailLevel,
  budgetAdaptive: boolean,
): DetailLevelMetadata {
  const cardsByLevel: Record<CardDetailLevel, number> = {
    minimal: 0,
    signature: 0,
    deps: 0,
    compact: 0,
    full: 0,
  };

  for (const card of cards) {
    const level = card.detailLevel ?? "compact";
    cardsByLevel[level] = (cardsByLevel[level] ?? 0) + 1;
  }

  return {
    requested,
    effective,
    budgetAdaptive,
    cardsByLevel,
  };
}

export function buildCallResolution(
  outgoingEdges: ladybugDb.EdgeForSlice[],
  calledSymbolsMap: Map<string, { name: string }>,
  minCallConfidence: number | undefined,
): CallResolution | undefined {
  const calls = outgoingEdges
    .filter((edge) => edge.edgeType === "call")
    .map((edge) => {
      const label = pickDepLabel(
        edge.toSymbolId,
        calledSymbolsMap.get(edge.toSymbolId)?.name,
      );
      if (!label) {
        return null;
      }

      return {
        symbolId: edge.toSymbolId,
        label,
        confidence: normalizeEdgeConfidence(edge.confidence),
        resolutionReason: edge.resolution,
        resolverId: edge.resolverId,
        resolutionPhase: edge.resolutionPhase,
      };
    })
    .filter((call): call is NonNullable<typeof call> => call !== null);

  if (calls.length === 0) {
    return undefined;
  }

  return {
    minCallConfidence,
    calls,
  };
}

// PERF: These queries are sequential due to data dependencies between symbol
// rows, edges, metrics, files, etc. Consider parallelizing independent queries
// (e.g., metrics + files) if profiling shows this as a bottleneck.
