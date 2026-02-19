/**
 * Truncation Handler Module
 *
 * Manages dynamic card cap tightening and truncation decisions for graph slices.
 * Controls when slices should be truncated based on score distribution and coverage.
 *
 * @module graph/slice/truncation-handler
 */

import { SLICE_SCORE_THRESHOLD } from "../../config/constants.js";

export const DYNAMIC_CAP_MIN_CARDS = 6;
export const DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN = 0.2;
export const DYNAMIC_CAP_RECENT_SCORE_WINDOW = 6;
export const DYNAMIC_CAP_MIN_ENTRY_COVERAGE = 0.9;
export const DYNAMIC_CAP_FRONTIER_SCORE_MARGIN = 0.08;
export const DYNAMIC_CAP_FRONTIER_DROP_FACTOR = 0.67;

export interface DynamicCapState {
  sliceSize: number;
  minCardsForDynamicCap: number;
  highConfidenceCards: number;
  requiredEntryCoverage: number;
  coveredEntrySymbols: number;
  recentAcceptedScores: number[];
  nextFrontierScore: number | null;
}

export function computeMinCardsForDynamicCap(
  budgetMaxCards: number,
  entrySymbolCount: number,
): number {
  const entryFloor =
    entrySymbolCount > 0 ? entrySymbolCount + 2 : DYNAMIC_CAP_MIN_CARDS;
  return Math.max(
    Math.min(budgetMaxCards, DYNAMIC_CAP_MIN_CARDS),
    Math.min(budgetMaxCards, entryFloor),
  );
}

export function shouldTightenDynamicCardCap(state: DynamicCapState): boolean {
  if (state.sliceSize < state.minCardsForDynamicCap) return false;
  if (state.nextFrontierScore === null) return false;
  if (state.recentAcceptedScores.length === 0) return false;

  const highConfidenceRatio =
    state.highConfidenceCards / Math.max(1, state.sliceSize);
  if (highConfidenceRatio < 0.6) return false;

  if (state.requiredEntryCoverage > 0) {
    const entryCoverageRatio =
      state.coveredEntrySymbols / Math.max(1, state.requiredEntryCoverage);
    if (entryCoverageRatio < DYNAMIC_CAP_MIN_ENTRY_COVERAGE) return false;
  }

  const recentAvg =
    state.recentAcceptedScores.reduce((sum, score) => sum + score, 0) /
    state.recentAcceptedScores.length;
  const dropThreshold = Math.max(
    SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_FRONTIER_SCORE_MARGIN,
    recentAvg * DYNAMIC_CAP_FRONTIER_DROP_FACTOR,
  );

  return state.nextFrontierScore < dropThreshold;
}

export interface TruncationInfo {
  truncated: boolean;
  droppedCards: number;
  droppedEdges: number;
  howToResume: {
    type: "token";
    value: number;
  };
}

export function buildTruncationInfo(
  wasTruncated: boolean,
  droppedCandidates: number,
  totalEdges: number,
  estimatedTokens: number,
): TruncationInfo | undefined {
  if (!wasTruncated) {
    return undefined;
  }

  return {
    truncated: true,
    droppedCards: droppedCandidates,
    droppedEdges: Math.max(0, totalEdges),
    howToResume: {
      type: "token",
      value: estimatedTokens,
    },
  };
}
