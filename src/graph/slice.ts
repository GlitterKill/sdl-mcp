/**
 * Graph Slice Orchestration Layer
 *
 * Main entry point for building graph slices. Coordinates between:
 * - start-node-resolver: Entry point symbol resolution
 * - beam-search-engine: Beam search traversal
 * - slice-serializer: Wire format and serialization
 * - truncation-handler: Truncation decisions
 *
 * @module graph/slice
 */


import type { GraphSlice } from "../domain/types.js";
import { normalizeCardDetailLevel } from "../domain/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { DatabaseError, ValidationError } from "../domain/errors.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { DEFAULT_MAX_CARDS, DEFAULT_MAX_TOKENS_SLICE } from "../config/constants.js";
import { getSliceCacheKey, getCachedSlice, setCachedSlice, configureSliceCache } from "./sliceCache.js";

import { resolveStartNodes, resolveStartNodesLadybug, type StartNodeSource, type ResolvedStartNode, type StartNodeResolutionResult, type StartNodeLimits, START_NODE_SOURCE_PRIORITY, START_NODE_SOURCE_SCORE, TASK_TEXT_STOP_WORDS } from "./slice/start-node-resolver.js";

import { beamSearch, beamSearchLadybug, applyEdgeConfidenceWeight, getAdaptiveMinConfidence, type FrontierItem, type BeamTraceCollector } from "./slice/beam-search-engine.js";
import { SLICE_SCORE_THRESHOLD as TRACE_SLICE_SCORE_THRESHOLD, MAX_FRONTIER as TRACE_MAX_FRONTIER } from "../config/constants.js";
import type { BeamExplainEntry } from "../observability/types.js";
import { getBeamExplainStore } from "../observability/index.js";
import { getObservabilityTap } from "../observability/event-tap.js";

import { getGraphSnapshot } from "./graphSnapshotCache.js";

import { buildPayloadCardsAndRefs, toSliceSymbolCard, filterDepsBySliceSymbolSet, encodeEdgesWithSymbolIndex, estimateTokens } from "./slice/slice-serializer.js";

import { type SliceResult, type SliceError, sliceOk, sliceErr } from "./slice/result.js";
import { getOverlaySnapshot } from "../live-index/overlay-reader.js";
import { logger } from "../util/logger.js";
import {
  type SliceBuildInternalResult,
  type SliceBuildRequest,
} from "./slice/types.js";
import {
  resolveEffectiveDetailLevel,
  buildDetailLevelMetadata,
} from "./slice/detail-level.js";
import { loadSymbolCards } from "./slice/card-hydrator.js";
import {
  loadEdgesBetweenSymbols,
} from "./slice/edge-projector.js";
export type { SliceBuildInternalResult } from "./slice/types.js";

export {
  type StartNodeSource,
  type ResolvedStartNode,
  type StartNodeResolutionResult,
  type StartNodeLimits,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
  TASK_TEXT_STOP_WORDS,
  resolveStartNodes,
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
  buildPayloadCardsAndRefs,
  toSliceSymbolCard,
  filterDepsBySliceSymbolSet,
  encodeEdgesWithSymbolIndex,
  estimateTokens,
  type SliceResult,
  type SliceError,
  sliceOk,
  sliceErr,
};

/**
 * Internal result from buildSlice that includes both the slice and any
 * retrieval evidence gathered during start-node resolution.
 */
export async function buildSlice(
  request: SliceBuildRequest,
): Promise<SliceBuildInternalResult> {
  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;
  const overlaySnapshot = getOverlaySnapshot(request.repoId);
  const canUseCache = cacheEnabled && overlaySnapshot === null;

  if (cacheConfig) {
    configureSliceCache({
      maxEntries: cacheConfig.graphSliceMaxEntries,
    });
  }

  const cacheKey = getSliceCacheKey(request);
  const cached = canUseCache ? getCachedSlice(cacheKey) : null;
  if (cached) {
    // Cached slices intentionally omit retrievalEvidence — the evidence describes
    // the initial hybrid retrieval process, not the slice content. Re-running
    // retrieval solely for evidence would defeat caching.
    return { slice: cached };
  }

  const sliceConfig = config.slice;
  const edgeWeights = sliceConfig?.edgeWeights ?? {
    call: 1.0,
    import: 0.6,
    config: 0.8,
    implements: 0.9,
  };

  const budget = {
    maxCards:
      request.budget?.maxCards ??
      sliceConfig?.defaultMaxCards ??
      DEFAULT_MAX_CARDS,
    maxEstimatedTokens:
      request.budget?.maxEstimatedTokens ??
      sliceConfig?.defaultMaxTokens ??
      DEFAULT_MAX_TOKENS_SLICE,
  };
  const minConfidence = request.minConfidence ?? 0.5;
  const minCallConfidence = request.minCallConfidence;

  const conn = request.conn ?? (await getLadybugConn());

  // -----------------------------------------------------------------------
  // Try in-memory graph snapshot path first (zero DB calls during traversal)
  // -----------------------------------------------------------------------
  const cachedGraph = getGraphSnapshot(request.repoId);

  const startNodeResult = await resolveStartNodesLadybug(
    conn,
    request.repoId,
    request,
  );
  const startNodes = startNodeResult.startNodes;
  const { retrievalEvidence, hybridSearchItems } = startNodeResult;
  const startSymbols = startNodes.map((node) => node.symbolId);

  // Validate that at least some entry symbols resolved when explicitly provided
  if (
    request.entrySymbols &&
    request.entrySymbols.length > 0 &&
    startSymbols.length === 0
  ) {
    // Reuse existing conn (already resolved above)
    // Try to find close matches for the failed entry symbols
    const suggestions: string[] = [];
    for (const entryId of request.entrySymbols.slice(0, 3)) {
      const sym = await ladybugDb.getSymbol(conn, entryId);
      if (!sym) {
        suggestions.push(`"${entryId.slice(0, 16)}..." not found`);
      }
    }
    const hint = suggestions.length > 0 ? ` (${suggestions.join(", ")})` : "";
    logger.warn(
      "slice.build: none of the provided entrySymbols resolved to valid symbols",
      {
        repoId: request.repoId,
        entrySymbols: request.entrySymbols,
      },
    );
    // Throw an error instead of silently returning an empty slice
    throw new Error(
      `None of the provided entrySymbols were found in the index${hint}. Verify symbol IDs with sdl.symbol.search first.`,
    );
  }

  let clusterContext:
    | { entryClusterIds: string[]; relatedClusterIds: string[] }
    | undefined;
  try {
    const clustersBySymbolId = await ladybugDb.getClustersForSymbols(
      conn,
      startSymbols,
    );
    const entryClusterIds = new Set<string>();
    for (const row of clustersBySymbolId.values()) {
      entryClusterIds.add(row.clusterId);
    }

    if (entryClusterIds.size > 0) {
      const relatedClusterIds = new Set<string>();
      for (const clusterId of entryClusterIds) {
        const related = await ladybugDb.getRelatedClusters(conn, clusterId, 20);
        for (const row of related) {
          relatedClusterIds.add(row.clusterId);
        }
      }

      clusterContext = {
        entryClusterIds: Array.from(entryClusterIds).sort(),
        relatedClusterIds: Array.from(relatedClusterIds).sort(),
      };
    }
  } catch (error) {
    logger.debug("Cluster context resolution failed (graceful degradation)", {
      error: String(error),
    });
  }

  const beamRequest = clusterContext ? { ...request, clusterContext } : request;

  let sliceCards: Set<string>;
  let frontier: FrontierItem[];
  let wasTruncated: boolean;
  let droppedCandidates: number;

  // Beam-search decision trace setup. Only active when an observability store
  // is registered AND the slice request has a versionId we can publish under.
  // The collector is bounded by config.observability.beamExplainEntriesPerSlice
  // (default 512) — once full, additional entries are dropped and 	runcated
  // is set true. Errors in the collector NEVER propagate back into beam search.
  const observabilityCfg = config.observability;
  const traceCap =
    observabilityCfg?.beamExplainEntriesPerSlice && observabilityCfg.beamExplainEntriesPerSlice > 0
      ? observabilityCfg.beamExplainEntriesPerSlice
      : 512;
  let traceTruncated = false;
  const traceEntries: BeamExplainEntry[] = [];
  const beamStore = getBeamExplainStore();
  let beamAcceptedCount = 0;
  let beamEvictedCount = 0;
  let beamRejectedCount = 0;
  const beamStartedAt = performance.now();
  const traceCollector: BeamTraceCollector = {
    recordAccept(entry) {
      beamAcceptedCount++;
      if (beamStore !== null) {
        if (traceEntries.length < traceCap) traceEntries.push(entry);
        else traceTruncated = true;
      }
    },
    recordEvict(entry) {
      beamEvictedCount++;
      if (beamStore !== null) {
        if (traceEntries.length < traceCap) traceEntries.push(entry);
        else traceTruncated = true;
      }
    },
    recordReject(entry) {
      beamRejectedCount++;
      if (beamStore !== null) {
        if (traceEntries.length < traceCap) traceEntries.push(entry);
        else traceTruncated = true;
      }
    },
  };

  if (cachedGraph) {
    // Fast path: in-memory beam search — no DB calls during traversal
    logger.debug("Using in-memory graph snapshot for slice build", {
      repoId: request.repoId,
      graphSymbols: cachedGraph.symbols.size,
      graphEdges: cachedGraph.edges.length,
    });
    const result = beamSearch(
      cachedGraph,
      startNodes,
      budget,
      beamRequest,
      edgeWeights,
      minConfidence,
      request.signal,
      traceCollector,
    );
    sliceCards = result.sliceCards;
    frontier = result.frontier;
    wasTruncated = result.wasTruncated;
    droppedCandidates = result.droppedCandidates;
  } else {
    // DB-backed path with batch prefetching
    const result = await beamSearchLadybug(
      conn,
      request.repoId,
      startNodes,
      budget,
      beamRequest,
      edgeWeights,
      minConfidence,
      request.signal,
      traceCollector,
    );
    sliceCards = result.sliceCards;
    frontier = result.frontier;
    wasTruncated = result.wasTruncated;
    droppedCandidates = result.droppedCandidates;
  }

  try {
    getObservabilityTap()?.sliceBuild({
      repoId: request.repoId,
      durationMs: performance.now() - beamStartedAt,
      accepted: beamAcceptedCount,
      evicted: beamEvictedCount,
      rejected: beamRejectedCount,
    });
  } catch {
    // observability is best-effort
  }

  const cardCount = sliceCards.size;
  const requestedLevel = normalizeCardDetailLevel(request.cardDetail);
  const effectiveLevel = resolveEffectiveDetailLevel(
    request,
    budget,
    cardCount,
  );
  const budgetAdaptive =
    request.adaptiveDetail !== false && effectiveLevel !== requestedLevel;

  const { cards, sliceDepsBySymbol } = await loadSymbolCards(
    conn,
    Array.from(sliceCards),
    request.versionId,
    request.repoId,
    effectiveLevel,
    minCallConfidence,
    request.includeResolutionMetadata,
    overlaySnapshot,
  );
  const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs(
    cards,
    request.knownCardEtags,
    sliceDepsBySymbol,
    sliceCards,
  );
  const { symbolIndex, edges, confidenceDistribution } =
    await loadEdgesBetweenSymbols(
      conn,
      Array.from(sliceCards),
      request.repoId,
      minConfidence,
      minCallConfidence,
      overlaySnapshot,
    );
  const estimatedTokens = estimateTokens(cardsForPayload);
  const slice: GraphSlice = {
    repoId: request.repoId,
    versionId: request.versionId,
    budget,
    startSymbols,
    symbolIndex,
    cards: cardsForPayload,
    cardRefs,
    edges,
    confidenceDistribution,
    detailLevelMetadata: buildDetailLevelMetadata(
      cards,
      requestedLevel,
      effectiveLevel,
      budgetAdaptive,
    ),
  };

  if (wasTruncated || cards.length >= budget.maxCards) {
    slice.frontier = frontier.slice(0, 10).map((item) => ({
      symbolId: item.symbolId,
      score: item.score,
      why: item.why,
    }));
    // Determine the reason for truncation
    const hitCardLimit = cards.length >= budget.maxCards;
    const hitTokenLimit = estimatedTokens >= budget.maxEstimatedTokens;
    const reasons: string[] = [];
    if (hitCardLimit) reasons.push(`card limit (${budget.maxCards})`);
    if (hitTokenLimit)
      reasons.push(`token limit (~${budget.maxEstimatedTokens})`);
    if (reasons.length === 0) reasons.push("score threshold");

    slice.truncation = {
      truncated: true,
      droppedCards: droppedCandidates,
      droppedEdges: Math.max(0, droppedCandidates),
      reason: `Slice truncated due to ${reasons.join(" and ")}.`,
      budgetUsed: {
        cards: cards.length,
        maxCards: budget.maxCards,
        estimatedTokens,
        maxTokens: budget.maxEstimatedTokens,
      },
      suggestion:
        droppedCandidates > 0
          ? `Use slice.spillover.get with the spilloverHandle to retrieve ${Math.min(droppedCandidates, 20)} more symbols, or increase budget.maxCards/budget.maxEstimatedTokens.`
          : "Use slice.refresh to get incremental updates.",
      howToResume: {
        type: "token",
        value: estimatedTokens,
      },
    };
  }

  // Cache the full slice (before ETag dedup) so that cache hits serve
  // complete data regardless of the requesting client's known ETags.
  if (canUseCache) {
    const hasKnownEtags =
      request.knownCardEtags && Object.keys(request.knownCardEtags).length > 0;
    if (hasKnownEtags) {
      // Rebuild full cards (without ETag dedup) for caching
      const { cardsForPayload: fullCards } = buildPayloadCardsAndRefs(
        cards,
        undefined,
        sliceDepsBySymbol,
        sliceCards,
      );
      const fullSlice: GraphSlice = {
        ...slice,
        cards: fullCards,
        cardRefs: undefined,
      };
      setCachedSlice(cacheKey, fullSlice);
    } else {
      setCachedSlice(cacheKey, slice);
    }
  }

  const beamTrace = beamStore === null ? null : {
    entries: traceEntries,
    truncated: traceTruncated,
    edgeWeights: {
      call: edgeWeights.call,
      import: edgeWeights.import,
      config: edgeWeights.config,
      implements: edgeWeights.implements,
    },
    thresholds: {
      sliceScoreThreshold: TRACE_SLICE_SCORE_THRESHOLD,
      maxFrontier: TRACE_MAX_FRONTIER,
    },
  };

  return { slice, retrievalEvidence, hybridSearchItems, beamTrace: beamTrace ?? undefined };
}

export async function buildSliceWithResult(
  request: SliceBuildRequest,
): Promise<SliceResult> {
  try {
    const { slice } = await buildSlice(request);

    if (slice.cards.length === 0) {
      return sliceErr({
        type: "no_symbols",
        repoId: request.repoId,
        entrySymbols: request.entrySymbols,
      });
    }

    return sliceOk(slice);
  } catch (error) {
    if (error instanceof DatabaseError) {
      return sliceErr({
        type: "invalid_repo",
        repoId: request.repoId,
      });
    }

    if (error instanceof ValidationError) {
      return sliceErr({
        type: "no_version",
        repoId: request.repoId,
      });
    }

    // PolicyDenialError (from createPolicyDenial) has code === POLICY_ERROR
    const codeError = error as { code?: string };
    if (codeError.code === "POLICY_ERROR") {
      const message = error instanceof Error ? error.message : String(error);
      return sliceErr({
        type: "policy_denied",
        reason: message.replace("Policy denied slice request: ", ""),
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return sliceErr({
      type: "internal",
      message,
      cause:
        error instanceof Error && error.cause ? String(error.cause) : undefined,
    });
  }
}
