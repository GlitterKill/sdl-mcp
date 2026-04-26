// =============================================================================
// retrieval/fusion.ts — Pure RRF fusion + evidence builders.
//
// Public exports:
//   Symbol-level:
//     - SourceRanking, DEFAULT_RRF_K
//     - rrfFuse(rankings, k?, candidateLimit?) — reciprocal-rank fusion
//     - buildEvidence(rankings, fused, fusionLatencyMs, fallbackReason?) — evidence shape
//   Entity-level:
//     - EntitySourceRanking
//     - rrfFuseEntities(...)
//     - buildEntityEvidence(...)
//
// Extracted from retrieval/orchestrator.ts. All helpers are pure (no I/O).
// =============================================================================

import type {
  RetrievalSource,
  RetrievalEvidence,
  HybridSearchResultItem,
  EntitySearchResultItem,
  EntityType,
} from "./types.js";

export interface SourceRanking {
  source: RetrievalSource;
  /** symbolId -> 1-based rank */
  ranks: Map<string, number>;
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_RRF_K = 60;

export function rrfFuse(
  rankings: SourceRanking[],
  k: number,
  limit: number,
): HybridSearchResultItem[] {
  /** symbolId -> accumulated RRF score */
  const scores = new Map<string, number>();
  /** symbolId -> best (highest individual contribution) source */
  const bestSource = new Map<string, RetrievalSource>();
  /** symbolId -> highest single-source RRF contribution */
  const bestContribution = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [symbolId, rank] of ranking.ranks) {
      const contribution = 1 / (k + rank);
      const prev = scores.get(symbolId) ?? 0;
      scores.set(symbolId, prev + contribution);

      // Track which source contributed most for the source field.
      const prevBestContrib = bestContribution.get(symbolId) ?? 0;
      if (contribution > prevBestContrib) {
        bestContribution.set(symbolId, contribution);
        bestSource.set(symbolId, ranking.source);
      }
    }
  }

  // Sort descending by fused score, take top limit.
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([symbolId, score]) => ({
      symbolId,
      score,
      source: bestSource.get(symbolId) ?? "fts",
    }));
}

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

export function buildEvidence(
  rankings: SourceRanking[],
  fusedResults: HybridSearchResultItem[],
  fusionLatencyMs: number,
  fallbackReason?: string,
): RetrievalEvidence {
  const sources: RetrievalSource[] = rankings.map((r) => r.source);
  const candidateCountPerSource: Record<string, number> = {};
  for (const r of rankings) {
    candidateCountPerSource[r.source] = r.candidateCount;
  }

  // For each source, find the 1-based positions in the fused list where
  // that source's candidates appear.
  const topRanksPerSource: Record<string, number[]> = {};
  for (const ranking of rankings) {
    const positions: number[] = [];
    for (let i = 0; i < fusedResults.length; i++) {
      if (ranking.ranks.has(fusedResults[i].symbolId)) {
        positions.push(i + 1); // 1-based
      }
    }
    topRanksPerSource[ranking.source] = positions;
  }

  return {
    sources,
    topRanksPerSource,
    candidateCountPerSource,
    fusionLatencyMs,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface EntitySourceRanking {
  source: RetrievalSource;
  entityType: EntityType;
  /** entityId -> 1-based rank */
  ranks: Map<string, number>;
  candidateCount: number;
}

/**
 * RRF fusion for multi-entity results.
 *
 * Identical algorithm to rrfFuse() but operates on EntitySourceRanking and
 * returns EntitySearchResultItem[].  The entity-type tag from the ranking
 * that contributed the best score is carried forward into the result.
 */

export function rrfFuseEntities(
  rankings: EntitySourceRanking[],
  k: number,
  limit: number,
): EntitySearchResultItem[] {
  const scores = new Map<string, number>();
  const bestSource = new Map<string, RetrievalSource>();
  const bestEntityType = new Map<string, EntityType>();
  const bestContrib = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [entityId, rank] of ranking.ranks) {
      const contribution = 1 / (k + rank);
      const prev = scores.get(entityId) ?? 0;
      scores.set(entityId, prev + contribution);

      const prevBest = bestContrib.get(entityId) ?? 0;
      if (contribution > prevBest) {
        bestContrib.set(entityId, contribution);
        bestSource.set(entityId, ranking.source);
        bestEntityType.set(entityId, ranking.entityType);
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entityId, score]) => ({
      entityType: bestEntityType.get(entityId) ?? "symbol",
      entityId,
      score,
      source: bestSource.get(entityId) ?? "fts",
    }));
}

/**
 * Build evidence for entity search — parallel to buildEvidence() but uses
 * entityId as the key to look up ranks in each source ranking.
 */

export function buildEntityEvidence(
  rankings: EntitySourceRanking[],
  fusedResults: EntitySearchResultItem[],
  fusionLatencyMs: number,
  fallbackReason?: string,
): RetrievalEvidence {
  const sources: RetrievalSource[] = rankings.map((r) => r.source);
  const candidateCountPerSource: Record<string, number> = {};
  for (const r of rankings) {
    // When multiple rankings share the same source (e.g. fts for symbol AND
    // fts for memory), accumulate counts rather than overwriting.
    candidateCountPerSource[r.source] =
      (candidateCountPerSource[r.source] ?? 0) + r.candidateCount;
  }

  const topRanksPerSource: Record<string, number[]> = {};
  for (const ranking of rankings) {
    const positions: number[] = [];
    for (let i = 0; i < fusedResults.length; i++) {
      if (ranking.ranks.has(fusedResults[i].entityId)) {
        positions.push(i + 1); // 1-based
      }
    }
    topRanksPerSource[ranking.source] = positions;
  }

  return {
    sources,
    topRanksPerSource,
    candidateCountPerSource,
    fusionLatencyMs,
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

/**
 * Multi-entity hybrid search.
 *
 * Runs FTS and (where available) vector search across the requested entity
 * types (Symbol, Memory, Cluster, Process, FileSummary), then fuses results
 * via Reciprocal Rank Fusion.  Degrades gracefully when individual backends
 * are unavailable — a failing FTS/vector query for one entity type is caught
 * and skipped without aborting the rest of the search.
 *
 * Backward-compatible note: `entitySearch({ entityTypes: ["symbol"] })`
 * produces equivalent results to `hybridSearch()` for the symbol dimension.
 */
