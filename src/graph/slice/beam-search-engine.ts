// =============================================================================
// graph/slice/beam-search-engine.ts — Beam-search algorithm for slice traversal.
//
// Public exports (LLM-cost cheat sheet):
//
//   Types:
//     - FrontierItem, BeamSearchResult, BeamSearchRequest
//     - DynamicCapState, RollbackSliceState
//
//   Pure scoring / weighting helpers (no I/O):
//     - normalizeEdgeConfidence(c)
//     - applyEdgeConfidenceWeight(baseWeight, c)
//     - getAdaptiveMinConfidence(min, used, max)
//     - shouldTightenDynamicCardCap(state)
//     - computeMinCardsForDynamicCap(...)
//     - estimateCardTokens / estimateCardTokensLadybug
//     - normalizeEdgeType, getEdgeWhy, compareFrontierItems
//
//   Frontier / state mutation:
//     - acceptNodeIntoSlice(state, symbolId, score)
//     - rollbackAcceptedNodeFromSlice(state, symbolId, actualScore)
//     - insertCandidateIntoFrontier(...)
//     - seedFrontierFromGraph(...)
//     - buildUnvisitedNeighborMaps(...)
//
//   Main loops:
//     - beamSearch(graph, startNodes, budget, request, edgeWeights, minConfidence, signal?)
//     - beamSearchLadybug(...)
//
//   Constants:
//     - DYNAMIC_CAP_MIN_CARDS, DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN,
//       DYNAMIC_CAP_RECENT_SCORE_WINDOW, DYNAMIC_CAP_MIN_ENTRY_COVERAGE,
//       DYNAMIC_CAP_FRONTIER_SCORE_MARGIN, DYNAMIC_CAP_FRONTIER_DROP_FACTOR
//
//   Parallel scoring infra:
//     - ParallelScorerPool (class)
//     - getScorerPool() / resetScorerPool()
// =============================================================================


/**
 * Beam Search Engine Module
 *
 * Implements beam search traversal for graph slice construction.
 * Manages frontier exploration, scoring, and dynamic card cap adjustments.
 *
 * @module graph/slice/beam-search-engine
 */


import * as os from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";

import type { Connection } from "kuzu";

import type { EdgeType, RepoId, SymbolId } from "../../domain/types.js";
import type {
  EdgeRow,
  FileRow,
  MetricsRow,
  SymbolRow,
} from "../../db/schema.js";
import type { SliceBudget } from "../../domain/types.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  SLICE_SCORE_THRESHOLD,
  MAX_FRONTIER,
  SYMBOL_TOKEN_BASE,
  CHARS_PER_TOKEN_ESTIMATE,
  SYMBOL_TOKEN_ADDITIONAL_MAX,
} from "../../config/constants.js";
import { logger } from "../../util/logger.js";
import { findPackageRoot } from "../../util/findPackageRoot.js";
import { tokenize } from "../../util/tokenize.js";

import type { Graph } from "../buildGraph.js";
import { MinHeap } from "../minHeap.js";
import {
  applyCentralityTiebreak,
  calculateClusterCohesion,
  computeCentralityStats,
  scoreSymbolWithCentralityContext,
  type CentralityStats,
  SliceContext,
} from "../score.js";
import type { ResolvedStartNode } from "./start-node-resolver.js";
import {
  START_NODE_SOURCE_SCORE,
  getStartNodeWhy,
} from "./start-node-resolver.js";
import type {
  ScoreCandidate,
  ScoreWorkerInput,
  ScoreWorkerOutput,
} from "./beam-score-worker.js";

function toLegacySymbolRow(symbol: ladybugDb.SymbolRow): SymbolRow {
  return {
    symbol_id: symbol.symbolId,
    repo_id: symbol.repoId,
    file_id: 0,
    kind: symbol.kind as SymbolRow["kind"],
    name: symbol.name,
    exported: symbol.exported ? 1 : 0,
    visibility: symbol.visibility as SymbolRow["visibility"],
    language: symbol.language,
    range_start_line: symbol.rangeStartLine,
    range_start_col: symbol.rangeStartCol,
    range_end_line: symbol.rangeEndLine,
    range_end_col: symbol.rangeEndCol,
    ast_fingerprint: symbol.astFingerprint,
    signature_json: symbol.signatureJson,
    summary: symbol.summary,
    invariants_json: symbol.invariantsJson,
    side_effects_json: symbol.sideEffectsJson,
    updated_at: symbol.updatedAt,
  };
}

function toLegacyFileRow(file: ladybugDb.FileRow): FileRow {
  return {
    file_id: 0,
    repo_id: file.repoId,
    rel_path: file.relPath,
    content_hash: file.contentHash,
    language: file.language,
    byte_size: file.byteSize,
    last_indexed_at: file.lastIndexedAt,
    directory: file.directory,
  };
}

function toLegacyMetricsRow(metrics: ladybugDb.MetricsRow): MetricsRow {
  return {
    symbol_id: metrics.symbolId,
    fan_in: metrics.fanIn,
    fan_out: metrics.fanOut,
    churn_30d: metrics.churn30d,
    test_refs_json: metrics.testRefsJson,
    canonical_test_json: metrics.canonicalTestJson,
    page_rank: metrics.pageRank ?? 0,
    k_core: metrics.kCore ?? 0,
    updated_at: metrics.updatedAt,
  };
}

async function loadRepoCentralityStats(
  conn: Connection,
  repoId: RepoId,
): Promise<CentralityStats> {
  try {
    const metricsById = await ladybugDb.getMetricsByRepo(conn, repoId);
    return computeCentralityStats(metricsById.values());
  } catch (err) {
    logger.debug("Failed to load repo centrality stats for beam search", {
      repoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { maxPageRank: 0, maxKCore: 0 };
  }
}

function normalizeEdgeType(value: string): EdgeType | null {
  if (value === "call" || value === "import" || value === "config") {
    return value;
  }
  return null;
}

function estimateCardTokensLadybug(
  symbol: {
    name: string;
    signatureJson: string | null;
    summary: string | null;
  },
  outgoingEdgeCount: number,
): number {
  let tokens = SYMBOL_TOKEN_BASE;

  tokens += symbol.name.length / CHARS_PER_TOKEN_ESTIMATE;

  if (symbol.signatureJson) {
    tokens += symbol.signatureJson.length / CHARS_PER_TOKEN_ESTIMATE;
  }

  if (symbol.summary) {
    tokens += Math.min(
      symbol.summary.length / CHARS_PER_TOKEN_ESTIMATE,
      SYMBOL_TOKEN_ADDITIONAL_MAX,
    );
  }

  tokens += outgoingEdgeCount * 5;

  return Math.ceil(tokens);
}

export interface FrontierItem {
  symbolId: SymbolId;
  score: number;
  why: string;
  priority: number;
  sequence: number;
  /** Source symbol that produced this candidate via an edge, if any. */
  edgeFromSymbolId?: SymbolId;
  /** Edge type that produced this candidate. */
  edgeType?: EdgeType;
  /** Effective edge weight (base * normalized confidence) at time of insert. */
  edgeWeight?: number;
}

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

export interface BeamSearchResult {
  sliceCards: Set<SymbolId>;
  frontier: FrontierItem[];
  wasTruncated: boolean;
  droppedCandidates: number;
}

export interface BeamSearchRequest {
  entrySymbols?: SymbolId[];
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  minCallConfidence?: number;
  clusterContext?: {
    entryClusterIds: string[];
    relatedClusterIds: string[];
  };
}

export function normalizeEdgeConfidence(
  confidence: number | undefined,
): number {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 1;
  }
  return Math.max(0, Math.min(1, confidence));
}

export function applyEdgeConfidenceWeight(
  baseWeight: number,
  confidence: number | undefined,
): number {
  return baseWeight * normalizeEdgeConfidence(confidence);
}

export function getAdaptiveMinConfidence(
  minConfidence: number,
  usedTokens: number,
  maxEstimatedTokens: number,
): number {
  if (maxEstimatedTokens <= 0) {
    return Math.max(0, Math.min(1, minConfidence));
  }

  const ratio = usedTokens / maxEstimatedTokens;
  if (ratio > 0.9) {
    return Math.max(minConfidence, 0.95);
  }
  if (ratio > 0.7) {
    return Math.max(minConfidence, 0.8);
  }
  return Math.max(0, Math.min(1, minConfidence));
}

// =============================================================================
// Shared Beam Search Core Infrastructure
// =============================================================================

/**
 * Mutable bookkeeping state shared across all beam search iterations.
 * Passed by reference so helper functions can update it in-place.
 */

import type { BeamExplainEntry } from "../../observability/types.js";

/**
 * Optional trace collector wired by the slice-build call site to capture
 * beam-search decision rationale for the observability dashboard.
 *
 * All methods MUST be synchronous, side-effect-free against beam state,
 * and exception-safe — implementations should swallow + log their own
 * errors so the metrics path never throws into beam search.
 */
export interface BeamTraceCollector {
  recordAccept(entry: BeamExplainEntry): void;
  recordEvict(entry: BeamExplainEntry): void;
  recordReject(entry: BeamExplainEntry): void;
}

interface BeamCoreState {
  sliceCards: Set<SymbolId>;
  visited: Set<SymbolId>;
  frontier: MinHeap<FrontierItem>;
  droppedCandidates: number;
  sequence: number;
  effectiveCardCap: number;
  entrySymbols: Set<SymbolId>;
  requiredEntryCoverage: number;
  minCardsForDynamicCap: number;
  coveredEntrySymbols: number;
  highConfidenceCards: number;
  recentAcceptedScores: number[];
  /** Set of symbolIds (from editedFile start nodes) that bypass score threshold. */
  forcedSymbolIds: Set<SymbolId>;
  belowThresholdCount: number;
  wasTruncated: boolean;
  totalTokens: number;
  effectiveMinConfidence: number;
  /** Optional collector for beam-explain traces. Default null — path is unchanged when unset. */
  traceCollector: BeamTraceCollector | null;
  /** Outer beam-loop iteration counter, incremented once per loop body. */
  iterationCounter: number;
}


export interface RollbackSliceState {
  sliceCards: Set<SymbolId>;
  entrySymbols: Set<SymbolId>;
  coveredEntrySymbols: number;
  highConfidenceCards: number;
  recentAcceptedScores: number[];
}

/** Initialises all shared mutable state from budget, request and start nodes. */
function createBeamCoreState(
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  startNodes: ResolvedStartNode[],
  minConfidence: number,
): BeamCoreState {
  const entrySymbols = new Set(request.entrySymbols ?? []);
  const requiredEntryCoverage = entrySymbols.size;
  return {
    sliceCards: new Set<SymbolId>(),
    visited: new Set<SymbolId>(),
    frontier: new MinHeap<FrontierItem>(),
    droppedCandidates: 0,
    sequence: 0,
    effectiveCardCap: budget.maxCards,
    entrySymbols,
    requiredEntryCoverage,
    minCardsForDynamicCap: computeMinCardsForDynamicCap(
      budget.maxCards,
      requiredEntryCoverage,
    ),
    coveredEntrySymbols: 0,
    highConfidenceCards: 0,
    recentAcceptedScores: [],
    // editedFile nodes bypass score threshold pruning
    forcedSymbolIds: new Set<SymbolId>(
      startNodes
        .filter((n) => n.source === "editedFile")
        .map((n) => n.symbolId),
    ),
    belowThresholdCount: 0,
    wasTruncated: false,
    totalTokens: 0,
    effectiveMinConfidence: minConfidence,
    traceCollector: null,
    iterationCounter: 0,
  };

}

/** Builds the SliceContext used for symbol scoring. */
function buildSliceContext(request: BeamSearchRequest): SliceContext {
  return {
    query: request.taskText ?? "",
    queryTokens: request.taskText ? tokenize(request.taskText) : undefined,
    stackTrace: request.stackTrace,
    failingTestPath: request.failingTestPath,
    editedFiles: request.editedFiles,
    entrySymbols: request.entrySymbols,
  };
}

/** Adds a symbol to the slice and updates coverage / high-confidence counters. */
function acceptNodeIntoSlice(
  state: BeamCoreState,
  symbolId: SymbolId,
  actualScore: number,
  edgeContext?: {
    edgeFromSymbolId?: SymbolId;
    edgeType?: EdgeType;
    edgeWeight?: number;
  },
): void {
  state.sliceCards.add(symbolId);
  if (state.entrySymbols.has(symbolId)) {
    state.coveredEntrySymbols++;
  }
  if (
    actualScore >=
    SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN
  ) {
    state.highConfidenceCards++;
  }
  state.recentAcceptedScores.push(actualScore);
  if (state.recentAcceptedScores.length > DYNAMIC_CAP_RECENT_SCORE_WINDOW) {
    state.recentAcceptedScores.shift();
  }
  if (state.traceCollector !== null) {
    try {
      state.traceCollector.recordAccept({
        symbolId,
        decision: "accepted",
        totalScore: actualScore,
        components: makeEmptyScoreComponents(),
        why: edgeContext?.edgeType ? `accept via ${edgeContext.edgeType}` : "accept",
        edgeFromSymbolId: edgeContext?.edgeFromSymbolId,
        edgeType: edgeContext?.edgeType,
        edgeWeight: edgeContext?.edgeWeight,
        iteration: state.iterationCounter,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn("beam trace recordAccept failed", { error: String(err) });
    }
  }
}

/** Empty BeamScoreComponents — individual score components are not exposed at the hook point yet. */
function makeEmptyScoreComponents(): import("../../observability/types.js").BeamScoreComponents {
  return { query: 0, stacktrace: 0, hotness: 0, structure: 0, kind: 0 };
}

export function rollbackAcceptedNodeFromSlice(
  state: RollbackSliceState,
  symbolId: SymbolId,
  actualScore: number,
): void {
  state.sliceCards.delete(symbolId);
  if (state.entrySymbols.has(symbolId)) {
    state.coveredEntrySymbols = Math.max(0, state.coveredEntrySymbols - 1);
  }
  if (
    actualScore >=
    SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN
  ) {
    state.highConfidenceCards = Math.max(0, state.highConfidenceCards - 1);
  }
  if (state.recentAcceptedScores.length > 0) {
    state.recentAcceptedScores.pop();
  }
}

/**
 * Inserts a scored candidate into the frontier using the capped beam-search
 * replacement strategy.  Increments state.droppedCandidates when evicted.
 */
function insertCandidateIntoFrontier(
  state: BeamCoreState,
  symbolId: SymbolId,
  score: number,
  why: string,
  edgeContext?: {
    edgeFromSymbolId?: SymbolId;
    edgeType?: EdgeType;
    edgeWeight?: number;
  },
): void {
  const item: FrontierItem = {
    symbolId,
    score,
    why,
    priority: 10,
    sequence: state.sequence++,
    edgeFromSymbolId: edgeContext?.edgeFromSymbolId,
    edgeType: edgeContext?.edgeType,
    edgeWeight: edgeContext?.edgeWeight,
  };
  if (state.frontier.size() < MAX_FRONTIER) {
    state.frontier.insert(item);
    return;
  }
  // Frontier is full — find the worst (least-promising) item among leaf
  // nodes (O(n/2)) and replace it in-place (O(log n)) if the new
  // candidate is better. The min-heap root is the BEST item, so the
  // worst is always a leaf.
  const worstIdx = state.frontier.findWorstIndex(compareFrontierItems);
  if (worstIdx === -1) return;
  const worstItem = state.frontier.toHeapArray()[worstIdx];
  if (compareFrontierItems(item, worstItem) < 0) {
    const evicted = worstItem;
    state.frontier.replaceAt(worstIdx, item);
    if (state.traceCollector !== null) {
      try {
        state.traceCollector.recordEvict({
          symbolId: evicted.symbolId,
          decision: "evicted",
          totalScore: -evicted.score,
          components: makeEmptyScoreComponents(),
          why: `evicted by better frontier candidate (${why})`,
          edgeFromSymbolId: evicted.edgeFromSymbolId,
          edgeType: evicted.edgeType,
          edgeWeight: evicted.edgeWeight,
          iteration: state.iterationCounter,
          timestamp: Date.now(),
        });
      } catch (err) {
        logger.warn("beam trace recordEvict failed", { error: String(err) });
      }
    }
  } else {
    state.droppedCandidates++;
    if (state.traceCollector !== null) {
      try {
        state.traceCollector.recordReject({
          symbolId,
          decision: "rejected",
          totalScore: -score,
          components: makeEmptyScoreComponents(),
          why: `rejected: frontier full and worse than worst (${why})`,
          edgeFromSymbolId: edgeContext?.edgeFromSymbolId,
          edgeType: edgeContext?.edgeType,
          edgeWeight: edgeContext?.edgeWeight,
          iteration: state.iterationCounter,
          timestamp: Date.now(),
        });
      } catch (err) {
        logger.warn("beam trace recordReject failed", { error: String(err) });
      }
    }
  }
}

/** Constructs the final BeamSearchResult from accumulated state. */
function buildBeamSearchResult(
  state: BeamCoreState,
  budget: Required<SliceBudget>,
): BeamSearchResult {
  const frontierArray = state.frontier.toHeapArray().map((item) => ({
    symbolId: item.symbolId,
    score: -item.score,
    why: item.why,
    priority: item.priority,
    sequence: item.sequence,
  }));
  if (state.sliceCards.size >= budget.maxCards) {
    state.wasTruncated = true;
  }
  // Note: frontier items are NOT counted as dropped because they remain
  // available to clients via spillover (sdl.slice.spillover.get).
  return {
    sliceCards: state.sliceCards,
    frontier: frontierArray,
    wasTruncated: state.wasTruncated,
    droppedCandidates: state.droppedCandidates,
  };
}

/**
 * Seeds the beam frontier with start nodes that exist in the in-memory graph.
 * Used by both `beamSearch` (sync) and `beamSearchAsync` (async-in-memory) variants.
 */
function seedFrontierFromGraph(
  state: BeamCoreState,
  startNodes: ResolvedStartNode[],
  graph: Graph,
): void {
  for (const { symbolId, source } of startNodes) {
    if (!state.visited.has(symbolId) && graph.symbols.has(symbolId)) {
      state.frontier.insert({
        symbolId,
        score: START_NODE_SOURCE_SCORE[source],
        why: getStartNodeWhy(source),
        priority: 0,
        sequence: state.sequence++,
      });
      state.visited.add(symbolId);
    }
  }
}

/**
 * Builds the edge-by-target and neighbor-symbol maps for an in-memory graph
 * expansion step.  Returns null when there are no unvisited, non-slice
 * neighbours to explore.
 * Used by both `beamSearch` (sync) and `beamSearchAsync` (async-in-memory) variants.
 */
function buildUnvisitedNeighborMaps(
  currentSymbolId: SymbolId,
  state: BeamCoreState,
  graph: Graph,
): {
  edgeByTarget: Map<SymbolId, EdgeRow>;
  neighborsMap: Map<SymbolId, SymbolRow>;
} | null {
  const outgoing = graph.adjacencyOut.get(currentSymbolId) ?? [];
  const edgeByTarget = new Map<SymbolId, EdgeRow>();
  for (const e of outgoing) {
    if (
      !state.visited.has(e.to_symbol_id) &&
      !state.sliceCards.has(e.to_symbol_id)
    ) {
      edgeByTarget.set(e.to_symbol_id, e);
    }
  }
  if (edgeByTarget.size === 0) return null;

  const neighborsMap = new Map<SymbolId, SymbolRow>();
  for (const id of edgeByTarget.keys()) {
    const symbol = graph.symbols.get(id);
    if (symbol) {
      neighborsMap.set(id, symbol);
    }
  }
  if (neighborsMap.size === 0) return null;

  return { edgeByTarget, neighborsMap };
}

/**
 * Strategy callbacks that define the variant behaviour plugged into the shared
 * beam search loop.  All async to accommodate both DB-backed and in-memory
 * implementations.
 */
interface BeamSearchStrategy {
  /** Called once before the main loop (e.g. initial cache prefetch). */
  onBeforeLoop?(state: BeamCoreState): Promise<void>;
  /** Called at the start of each iteration (e.g. periodic cache prefetch). */
  onIterationStart?(state: BeamCoreState): Promise<void>;
  /**
   * Validates and resolves the current node.  Return false to skip it.
   * Used by DB-backed variants to confirm the symbol exists in the repo.
   */
  resolveCurrentNode?(
    symbolId: SymbolId,
    state: BeamCoreState,
  ): Promise<boolean>;
  /** Returns the estimated token cost for the current node. */
  estimateCardTokens(symbolId: SymbolId, state: BeamCoreState): Promise<number>;
  /**
   * Expands neighbours of the current node, scores them, and inserts
   * passing candidates via insertCandidateIntoFrontier().  Must also
   * increment state.droppedCandidates for every filtered-out candidate.
   */
  expandNeighbors(
    symbolId: SymbolId,
    state: BeamCoreState,
    context: SliceContext,
    edgeWeights: Record<EdgeType, number>,
  ): Promise<void>;
}

/**
 * Core async beam search loop shared by beamSearchLadybug and beamSearchAsync.
 *
 * Handles the BFS skeleton: frontier extraction, threshold gating, node
 * acceptance, token-budget enforcement, and dynamic cap tightening.
 * All variant data-access and scoring logic is delegated to `strategy`.
 */
async function beamSearchCoreAsync(
  state: BeamCoreState,
  budget: Required<SliceBudget>,
  context: SliceContext,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number,
  strategy: BeamSearchStrategy,
  signal?: AbortSignal,
): Promise<BeamSearchResult> {
  await strategy.onBeforeLoop?.(state);

  while (
    !state.frontier.isEmpty() &&
    state.sliceCards.size < state.effectiveCardCap
  ) {
    if (signal?.aborted) break;
    if (signal?.aborted) break;
    state.iterationCounter++;
    await strategy.onIterationStart?.(state);

    state.effectiveMinConfidence = getAdaptiveMinConfidence(
      minConfidence,
      state.totalTokens,
      budget.maxEstimatedTokens,
    );

    // Check card cap BEFORE extracting so the item is not lost from the frontier
    if (state.sliceCards.size >= state.effectiveCardCap) {
      state.wasTruncated = true;
      break;
    }

    const current = state.frontier.extractMin()!;
    const actualScore = -current.score;

    if (
      actualScore < SLICE_SCORE_THRESHOLD &&
      !state.forcedSymbolIds.has(current.symbolId)
    ) {
      state.belowThresholdCount++;
      if (state.belowThresholdCount >= 5) break;
      continue;
    }

    state.belowThresholdCount = 0;

    if (
      strategy.resolveCurrentNode &&
      !(await strategy.resolveCurrentNode(current.symbolId, state))
    ) {
      continue;
    }

    acceptNodeIntoSlice(state, current.symbolId, actualScore, {
      edgeFromSymbolId: current.edgeFromSymbolId,
      edgeType: current.edgeType,
      edgeWeight: current.edgeWeight,
    });

    const cardTokens = await strategy.estimateCardTokens(
      current.symbolId,
      state,
    );
    state.totalTokens += cardTokens;

    if (state.totalTokens > budget.maxEstimatedTokens) {
      rollbackAcceptedNodeFromSlice(state, current.symbolId, actualScore);
      state.totalTokens -= cardTokens;
      state.wasTruncated = true;
      state.droppedCandidates++;
      break;
    }

    await strategy.expandNeighbors(
      current.symbolId,
      state,
      context,
      edgeWeights,
    );

    if (
      shouldTightenDynamicCardCap({
        sliceSize: state.sliceCards.size,
        minCardsForDynamicCap: state.minCardsForDynamicCap,
        highConfidenceCards: state.highConfidenceCards,
        requiredEntryCoverage: state.requiredEntryCoverage,
        coveredEntrySymbols: state.coveredEntrySymbols,
        recentAcceptedScores: state.recentAcceptedScores,
        nextFrontierScore: state.frontier.peek()
          ? -state.frontier.peek()!.score
          : null,
      })
    ) {
      state.effectiveCardCap = Math.min(
        state.effectiveCardCap,
        state.sliceCards.size,
      );
    }
  }

  return buildBeamSearchResult(state, budget);
}

// =============================================================================
// Exported beam search variants
// =============================================================================

export function beamSearch(
  graph: Graph,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number,
  signal?: AbortSignal,
  traceCollector?: BeamTraceCollector | null,
): BeamSearchResult {
  const state = createBeamCoreState(budget, request, startNodes, minConfidence);
  if (traceCollector) state.traceCollector = traceCollector;

  seedFrontierFromGraph(state, startNodes, graph);

  const context = buildSliceContext(request);
  // Prefer the snapshot-cached centralityStats so repeated beam-search
  // calls on the same Graph see identical tie-break values. Fall back to
  // recomputing from metrics.values() for any legacy Graph that omits it.
  const centralityStats =
    graph.centralityStats ??
    (graph.metrics
      ? computeCentralityStats(graph.metrics.values())
      : { maxPageRank: 0, maxKCore: 0 });

  const entryClusterIds = new Set<string>(
    request.clusterContext?.entryClusterIds ?? [],
  );
  const relatedClusterIds = new Set<string>(
    request.clusterContext?.relatedClusterIds ?? [],
  );
  const clusterCohesionEnabled =
    (entryClusterIds.size > 0 || relatedClusterIds.size > 0) &&
    !!graph.clusters;

  while (
    !state.frontier.isEmpty() &&
    state.sliceCards.size < state.effectiveCardCap
  ) {
    if (signal?.aborted) break;
    if (signal?.aborted) break;
    state.iterationCounter++;
    state.effectiveMinConfidence = getAdaptiveMinConfidence(
      minConfidence,
      state.totalTokens,
      budget.maxEstimatedTokens,
    );

    // Check card cap BEFORE extracting so the item is not lost from the frontier
    if (state.sliceCards.size >= state.effectiveCardCap) {
      state.wasTruncated = true;
      break;
    }

    const current = state.frontier.extractMin()!;
    const actualScore = -current.score;

    if (
      actualScore < SLICE_SCORE_THRESHOLD &&
      !state.forcedSymbolIds.has(current.symbolId)
    ) {
      state.belowThresholdCount++;
      if (state.belowThresholdCount >= 5) break;
      continue;
    }

    state.belowThresholdCount = 0;

    acceptNodeIntoSlice(state, current.symbolId, actualScore, {
      edgeFromSymbolId: current.edgeFromSymbolId,
      edgeType: current.edgeType,
      edgeWeight: current.edgeWeight,
    });

    const cardTokens = estimateCardTokens(current.symbolId, graph);
    state.totalTokens += cardTokens;

    if (state.totalTokens > budget.maxEstimatedTokens) {
      rollbackAcceptedNodeFromSlice(state, current.symbolId, actualScore);
      state.totalTokens -= cardTokens;
      state.wasTruncated = true;
      state.droppedCandidates++;
      break;
    }

    const neighborMaps = buildUnvisitedNeighborMaps(
      current.symbolId,
      state,
      graph,
    );
    if (!neighborMaps) continue;
    const { edgeByTarget, neighborsMap } = neighborMaps;

    for (const [neighborId, neighborSymbol] of neighborsMap) {
      if (state.visited.has(neighborId)) continue;
      state.visited.add(neighborId);

      // External symbols (from SCIP) are leaf nodes: include in slice but don't traverse further
      if (neighborSymbol.external) {
        acceptNodeIntoSlice(state, neighborId, 0);
        continue;
      }

      const edge = edgeByTarget.get(neighborId);
      if (!edge) continue;

      const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
      if (edgeConfidence < state.effectiveMinConfidence) {
        state.droppedCandidates++;
        continue;
      }

      const edgeWeight = applyEdgeConfidenceWeight(
        edgeWeights[edge.type] ?? 0.5,
        edgeConfidence,
      );

      const metrics = graph.metrics?.get(neighborId) ?? null;
      const file = neighborSymbol.file_id
        ? graph.files?.get(neighborSymbol.file_id)
        : undefined;

      let clusterBoost = 0;
      if (clusterCohesionEnabled) {
        clusterBoost = calculateClusterCohesion({
          symbolClusterId: graph.clusters?.get(neighborId),
          entryClusterIds,
          relatedClusterIds,
        });
      }

      const { primaryScore, centralitySignal } =
        scoreSymbolWithCentralityContext(
          neighborSymbol,
          context,
          metrics,
          file,
          centralityStats,
        );
      const finalScore = applyCentralityTiebreak(
        primaryScore * edgeWeight + clusterBoost,
        centralitySignal,
      );
      const neighborScore = -finalScore;

      if (-neighborScore < SLICE_SCORE_THRESHOLD) {
        state.droppedCandidates++;
        continue;
      }

      insertCandidateIntoFrontier(
        state,
        neighborId,
        neighborScore,
        getEdgeWhy(edge.type),
        {
          edgeFromSymbolId: current.symbolId,
          edgeType: edge.type,
          edgeWeight,
        },
      );
    }

    if (
      shouldTightenDynamicCardCap({
        sliceSize: state.sliceCards.size,
        minCardsForDynamicCap: state.minCardsForDynamicCap,
        highConfidenceCards: state.highConfidenceCards,
        requiredEntryCoverage: state.requiredEntryCoverage,
        coveredEntrySymbols: state.coveredEntrySymbols,
        recentAcceptedScores: state.recentAcceptedScores,
        nextFrontierScore: state.frontier.peek()
          ? -state.frontier.peek()!.score
          : null,
      })
    ) {
      state.effectiveCardCap = Math.min(
        state.effectiveCardCap,
        state.sliceCards.size,
      );
    }
  }

  return buildBeamSearchResult(state, budget);
}

/**
 * Default number of frontier items to prefetch per batch.
 * Larger values amortize DB round-trip overhead but consume more memory.
 */
export const PREFETCH_LOOKAHEAD = 16;

/**
 * How many iterations between prefetch sweeps within the beam search loop.
 * A prefetch runs immediately when the batch is exhausted.
 */
export const PREFETCH_INTERVAL = 8;

export async function beamSearchLadybug(
  conn: Connection,
  repoId: RepoId,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number,
  signal?: AbortSignal,
  traceCollector?: BeamTraceCollector | null,
): Promise<BeamSearchResult> {
  const state = createBeamCoreState(budget, request, startNodes, minConfidence);
  if (traceCollector) state.traceCollector = traceCollector;

  const symbolCache = new Map<SymbolId, ladybugDb.SymbolRow>();
  const fileCache = new Map<string, ladybugDb.FileRow>();
  const metricsCache = new Map<SymbolId, ladybugDb.MetricsRow | null>();
  const outgoingEdgesCache = new Map<SymbolId, ladybugDb.EdgeForSlice[]>();

  const entryClusterIds = new Set<string>(
    request.clusterContext?.entryClusterIds ?? [],
  );
  const relatedClusterIds = new Set<string>(
    request.clusterContext?.relatedClusterIds ?? [],
  );
  const clusterCohesionEnabled =
    entryClusterIds.size > 0 || relatedClusterIds.size > 0;
  const clusterCache = new Map<SymbolId, string | null>();
  const centralityStats = await loadRepoCentralityStats(conn, repoId);

  // ---------------------------------------------------------------------------
  // Batch prefetch: peek at the top N frontier items and warm all caches in
  // parallel. This replaces sequential per-iteration DB round-trips with a
  // single batched fetch, eliminating the await waterfall.
  // ---------------------------------------------------------------------------
  const prefetchFrontierBatch = async (): Promise<void> => {
    const peekItems = state.frontier.peekTopN(PREFETCH_LOOKAHEAD);
    const idsToFetch = peekItems
      .map((item) => item.symbolId)
      .filter((id) => !symbolCache.has(id));

    if (idsToFetch.length === 0) return;

    // Step 1: Batch-fetch symbols + edges for all frontier candidates sequentially
    // (LadybugDB connections are not safe for concurrent execute() calls)
    const symbolsMap = await ladybugDb.getSymbolsByIds(conn, idsToFetch);
    const edgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(
      conn,
      idsToFetch,
      { minCallConfidence: request.minCallConfidence },
    );

    // Populate symbol + edge caches
    for (const [symbolId, symbol] of symbolsMap) {
      if (symbol.repoId === repoId) {
        symbolCache.set(symbolId, symbol);
      }
    }
    for (const [symbolId, edges] of edgesMap) {
      const sorted = [...edges].sort((a, b) => {
        const toDiff = a.toSymbolId.localeCompare(b.toSymbolId);
        if (toDiff !== 0) return toDiff;
        return a.edgeType.localeCompare(b.edgeType);
      });
      outgoingEdgesCache.set(symbolId, sorted);
    }

    // Step 2: Collect all neighbour symbol IDs from prefetched edges
    const neighborIds = new Set<SymbolId>();
    for (const edges of edgesMap.values()) {
      for (const edge of edges) {
        if (
          !symbolCache.has(edge.toSymbolId) &&
          !state.visited.has(edge.toSymbolId) &&
          !state.sliceCards.has(edge.toSymbolId)
        ) {
          neighborIds.add(edge.toSymbolId);
        }
      }
    }

    if (neighborIds.size === 0) return;

    const neighborIdList = Array.from(neighborIds);

    // Step 3: Batch-fetch neighbour symbols + metrics sequentially
    const neighborSymbols = await ladybugDb.getSymbolsByIds(
      conn,
      neighborIdList,
    );
    const neighborMetrics = await ladybugDb.getMetricsBySymbolIds(
      conn,
      neighborIdList,
    );

    // Populate neighbour caches
    const fileIds = new Set<string>();
    for (const [symbolId, symbol] of neighborSymbols) {
      if (symbol.repoId === repoId) {
        symbolCache.set(symbolId, symbol);
        fileIds.add(symbol.fileId);
      }
    }
    for (const id of neighborIdList) {
      if (!metricsCache.has(id)) {
        metricsCache.set(id, neighborMetrics.get(id) ?? null);
      }
    }

    // Fetch missing files + clusters sequentially (same conn)
    const missingFileIds = Array.from(fileIds).filter(
      (id) => !fileCache.has(id),
    );
    const clusterIds = clusterCohesionEnabled
      ? neighborIdList.filter((id) => !clusterCache.has(id))
      : [];

    if (missingFileIds.length > 0) {
      const filesMap = await ladybugDb.getFilesByIds(conn, missingFileIds);
      for (const [fileId, file] of filesMap) {
        fileCache.set(fileId, file);
      }
    }
    if (clusterIds.length > 0) {
      const clusterMap = await ladybugDb.getClustersForSymbols(
        conn,
        clusterIds,
      );
      for (const symbolId of clusterIds) {
        clusterCache.set(symbolId, clusterMap.get(symbolId)?.clusterId ?? null);
      }
    }
  };

  const getClusters = async (symbolIds: SymbolId[]): Promise<void> => {
    if (!clusterCohesionEnabled) return;

    const missing = symbolIds.filter((id) => !clusterCache.has(id));
    if (missing.length === 0) return;

    const map = await ladybugDb.getClustersForSymbols(conn, missing);
    for (const symbolId of missing) {
      clusterCache.set(symbolId, map.get(symbolId)?.clusterId ?? null);
    }
  };

  const getSymbol = async (
    symbolId: SymbolId,
  ): Promise<ladybugDb.SymbolRow | null> => {
    const cached = symbolCache.get(symbolId);
    if (cached) return cached;

    const map = await ladybugDb.getSymbolsByIds(conn, [symbolId]);
    const symbol = map.get(symbolId) ?? null;
    if (!symbol || symbol.repoId !== repoId) {
      return null;
    }

    symbolCache.set(symbolId, symbol);
    return symbol;
  };

  const getMetrics = async (symbolIds: SymbolId[]): Promise<void> => {
    const missing = symbolIds.filter((id) => !metricsCache.has(id));
    if (missing.length === 0) return;

    const map = await ladybugDb.getMetricsBySymbolIds(conn, missing);
    for (const id of missing) {
      metricsCache.set(id, map.get(id) ?? null);
    }
  };

  const getOutgoingEdges = async (
    symbolId: SymbolId,
  ): Promise<ladybugDb.EdgeForSlice[]> => {
    const cached = outgoingEdgesCache.get(symbolId);
    if (cached) return cached;

    const map = await ladybugDb.getEdgesFromSymbolsForSlice(conn, [symbolId], {
      minCallConfidence: request.minCallConfidence,
    });
    const edges = map.get(symbolId) ?? [];

    edges.sort((a, b) => {
      const toDiff = a.toSymbolId.localeCompare(b.toSymbolId);
      if (toDiff !== 0) return toDiff;
      return a.edgeType.localeCompare(b.edgeType);
    });

    outgoingEdgesCache.set(symbolId, edges);
    return edges;
  };

  // Warm start-node caches before seeding the frontier
  const startNodeIds = Array.from(new Set(startNodes.map((n) => n.symbolId)));
  if (startNodeIds.length > 0) {
    const startSymbols = await ladybugDb.getSymbolsByIds(conn, startNodeIds);
    for (const [symbolId, symbol] of startSymbols) {
      if (symbol.repoId === repoId) {
        symbolCache.set(symbolId, symbol);
      }
    }
    await getClusters(startNodeIds);
  }

  for (const { symbolId, source } of startNodes) {
    if (state.visited.has(symbolId)) continue;
    if (!symbolCache.has(symbolId)) continue;

    state.frontier.insert({
      symbolId,
      score: START_NODE_SOURCE_SCORE[source],
      why: getStartNodeWhy(source),
      priority: 0,
      sequence: state.sequence++,
    });
    state.visited.add(symbolId);
  }

  const context = buildSliceContext(request);

  let iterationsSincePrefetch = 0;

  const strategy: BeamSearchStrategy = {
    async onBeforeLoop(_st) {
      await prefetchFrontierBatch();
      iterationsSincePrefetch = 0;
    },

    async onIterationStart(_st) {
      iterationsSincePrefetch++;
      if (iterationsSincePrefetch >= PREFETCH_INTERVAL) {
        await prefetchFrontierBatch();
        iterationsSincePrefetch = 0;
      }
    },

    async resolveCurrentNode(symbolId, _st) {
      const currentSymbol = await getSymbol(symbolId);
      return currentSymbol !== null;
    },

    async estimateCardTokens(symbolId, _st) {
      const currentSymbol = symbolCache.get(symbolId)!;
      const outgoing = await getOutgoingEdges(symbolId);
      return estimateCardTokensLadybug(currentSymbol, outgoing.length);
    },

    async expandNeighbors(currentSymbolId, st, ctx, ew) {
      const outgoing = await getOutgoingEdges(currentSymbolId);

      // Build edgeByTarget keeping the best-scoring edge type per target
      const edgeByTarget = new Map<
        SymbolId,
        { edgeType: EdgeType; confidence: number | undefined }
      >();
      const edgeTypePriority: Record<EdgeType, number> = {
        call: 0,
        import: 1,
        config: 2,
        implements: 3,
      };

      for (const edge of outgoing) {
        const edgeType = normalizeEdgeType(edge.edgeType);
        if (!edgeType) continue;

        const toId = edge.toSymbolId;
        if (st.visited.has(toId) || st.sliceCards.has(toId)) continue;

        const candidateScore = applyEdgeConfidenceWeight(
          ew[edgeType] ?? 0.5,
          edge.confidence,
        );

        const existing = edgeByTarget.get(toId);
        if (!existing) {
          edgeByTarget.set(toId, { edgeType, confidence: edge.confidence });
          continue;
        }

        const existingScore = applyEdgeConfidenceWeight(
          ew[existing.edgeType] ?? 0.5,
          existing.confidence,
        );

        if (
          candidateScore > existingScore ||
          (candidateScore === existingScore &&
            edgeTypePriority[edgeType] < edgeTypePriority[existing.edgeType])
        ) {
          edgeByTarget.set(toId, { edgeType, confidence: edge.confidence });
        }
      }

      if (edgeByTarget.size === 0) return;

      const neighborIds = Array.from(edgeByTarget.keys());
      const missingNeighborIds = neighborIds.filter(
        (neighborId) => !symbolCache.has(neighborId),
      );
      if (missingNeighborIds.length > 0) {
        const neighborSymbolsMap = await ladybugDb.getSymbolsByIds(
          conn,
          missingNeighborIds,
        );
        for (const [neighborId, symbol] of neighborSymbolsMap) {
          if (symbol.repoId === repoId) {
            symbolCache.set(neighborId, symbol);
          }
        }
      }

      const validNeighborIds: SymbolId[] = [];
      const fileIds = new Set<string>();
      for (const neighborId of neighborIds) {
        const symbol = symbolCache.get(neighborId);
        if (!symbol || symbol.repoId !== repoId) continue;
        validNeighborIds.push(neighborId);
        fileIds.add(symbol.fileId);
      }

      if (validNeighborIds.length === 0) return;

      await getClusters(validNeighborIds);
      await getMetrics(validNeighborIds);

      const missingFileIds = Array.from(fileIds).filter(
        (id) => !fileCache.has(id),
      );
      if (missingFileIds.length > 0) {
        const filesMap = await ladybugDb.getFilesByIds(conn, missingFileIds);
        for (const [fileId, file] of filesMap) {
          fileCache.set(fileId, file);
        }
      }

      for (const neighborId of neighborIds) {
        const neighborSymbol = symbolCache.get(neighborId);
        if (!neighborSymbol || neighborSymbol.repoId !== repoId) continue;
        if (st.visited.has(neighborId)) continue;
        st.visited.add(neighborId);

        // External symbols (from SCIP) are leaf nodes: include in slice but don't traverse further
        if (neighborSymbol.external) {
          acceptNodeIntoSlice(st, neighborId, 0);
          continue;
        }

        const edge = edgeByTarget.get(neighborId);
        if (!edge) continue;

        const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
        if (edgeConfidence < st.effectiveMinConfidence) {
          st.droppedCandidates++;
          continue;
        }

        const edgeWeight = applyEdgeConfidenceWeight(
          ew[edge.edgeType] ?? 0.5,
          edgeConfidence,
        );

        const metrics = metricsCache.get(neighborId) ?? null;
        const file = fileCache.get(neighborSymbol.fileId);
        const { primaryScore, centralitySignal } =
          scoreSymbolWithCentralityContext(
            toLegacySymbolRow(neighborSymbol),
            ctx,
            metrics ? toLegacyMetricsRow(metrics) : null,
            file ? toLegacyFileRow(file) : undefined,
            centralityStats,
          );
        const cohesionBoost = clusterCohesionEnabled
          ? calculateClusterCohesion({
              symbolClusterId: clusterCache.get(neighborId),
              entryClusterIds,
              relatedClusterIds,
            })
          : 0;
        const finalScore = applyCentralityTiebreak(
          primaryScore * edgeWeight + cohesionBoost,
          centralitySignal,
        );
        const neighborScore = -finalScore;

        if (-neighborScore < SLICE_SCORE_THRESHOLD) {
          st.droppedCandidates++;
          continue;
        }

        insertCandidateIntoFrontier(
          st,
          neighborId,
          neighborScore,
          getEdgeWhy(edge.edgeType),
          {
            edgeFromSymbolId: currentSymbolId,
            edgeType: edge.edgeType,
            edgeWeight,
          },
        );
      }
    },
  };

  return beamSearchCoreAsync(
    state,
    budget,
    context,
    edgeWeights,
    minConfidence,
    strategy,
    signal,
  );
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

export function compareFrontierItems(a: FrontierItem, b: FrontierItem): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.sequence - b.sequence;
}

export function getEdgeWhy(edgeType: EdgeType): string {
  switch (edgeType) {
    case "call":
      return "calls";
    case "import":
      return "imports";
    case "config":
      return "configures";
    case "implements":
      return "implements";
  }
}

export function estimateCardTokens(symbolId: SymbolId, graph: Graph): number {
  const symbol = graph.symbols.get(symbolId);
  if (!symbol) return SYMBOL_TOKEN_BASE;

  let tokens = SYMBOL_TOKEN_BASE;

  tokens += symbol.name.length / CHARS_PER_TOKEN_ESTIMATE;

  if (symbol.signature_json) {
    tokens += symbol.signature_json.length / CHARS_PER_TOKEN_ESTIMATE;
  }

  if (symbol.summary) {
    tokens += Math.min(
      symbol.summary.length / CHARS_PER_TOKEN_ESTIMATE,
      SYMBOL_TOKEN_ADDITIONAL_MAX,
    );
  }

  const outgoing = graph.adjacencyOut.get(symbolId) ?? [];
  tokens += outgoing.length * 5;

  return Math.ceil(tokens);
}

export interface ParallelScorerConfig {
  enabled: boolean;
  poolSize: number;
  minBatchSize: number;
}

export const DEFAULT_PARALLEL_SCORER_CONFIG: ParallelScorerConfig = {
  enabled: false,
  poolSize: Math.max(1, Math.min(os.cpus().length - 1, 4)),
  minBatchSize: 8,
};

export type ScorerMode = "sequential" | "parallel";

interface WorkerWithState {
  worker: Worker;
  busy: boolean;
}

class ParallelScorerPool {
  private workers: WorkerWithState[] = [];
  private initialized = false;
  private failed = false;
  private mode: ScorerMode = "sequential";
  private config: ParallelScorerConfig;

  constructor(config: ParallelScorerConfig) {
    this.config = config;
  }

  async initialize(): Promise<ScorerMode> {
    if (this.initialized) {
      return this.mode;
    }

    if (!this.config.enabled) {
      this.initialized = true;
      this.mode = "sequential";
      return this.mode;
    }

    try {
      const packageRoot = findPackageRoot(
        dirname(fileURLToPath(import.meta.url)),
      );
      const workerPath = join(
        packageRoot,
        "dist",
        "graph",
        "slice",
        "beam-score-worker.js",
      );

      for (let i = 0; i < this.config.poolSize; i++) {
        const worker = new Worker(workerPath);

        worker.on("error", (err) => {
          logger.warn("Parallel scorer worker error", {
            error: err instanceof Error ? err.message : String(err),
          });
          this.failed = true;
        });

        this.workers.push({ worker, busy: false });
      }

      this.initialized = true;
      this.mode = "parallel";
      logger.info("Parallel scorer pool initialized", {
        poolSize: this.config.poolSize,
        mode: this.mode,
      });
      return this.mode;
    } catch (err) {
      logger.warn(
        "Failed to initialize parallel scorer pool, falling back to sequential",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      this.failed = true;
      this.initialized = true;
      this.mode = "sequential";
      return this.mode;
    }
  }

  getMode(): ScorerMode {
    return this.failed ? "sequential" : this.mode;
  }

  /**
   * Scores all candidates sequentially in the calling thread.
   * Used as the fallback path when the parallel worker pool is unavailable,
   * timed out, errored, or when the candidate batch is below minBatchSize.
   */
  private scoreSequential(
    candidates: ScoreCandidate[],
    context: SliceContext,
    metricsMap: Map<string, MetricsRow | null>,
    filesMap: Map<number, FileRow | undefined>,
    centralityStats: CentralityStats,
    scoreThreshold: number,
  ): Map<string, { score: number; passed: boolean }> {
    const result = new Map<string, { score: number; passed: boolean }>();
    for (const c of candidates) {
      const { primaryScore, centralitySignal } =
        scoreSymbolWithCentralityContext(
          c.neighborSymbol,
          context,
          metricsMap.get(c.symbolId) ?? null,
          filesMap.get(c.neighborSymbol.file_id),
          centralityStats,
        );
      const finalScore = applyCentralityTiebreak(
        primaryScore * c.edgeWeight,
        centralitySignal,
      );
      result.set(c.symbolId, {
        score: finalScore,
        passed: finalScore >= scoreThreshold,
      });
    }
    return result;
  }

  async scoreBatch(
    candidates: ScoreCandidate[],
    context: SliceContext,
    metricsMap: Map<string, import("../../db/schema.js").MetricsRow | null>,
    filesMap: Map<number, import("../../db/schema.js").FileRow | undefined>,
    centralityStats: CentralityStats,
    scoreThreshold: number,
  ): Promise<Map<string, { score: number; passed: boolean }>> {
    if (
      this.failed ||
      this.mode === "sequential" ||
      candidates.length < this.config.minBatchSize
    ) {
      return this.scoreSequential(
        candidates,
        context,
        metricsMap,
        filesMap,
        centralityStats,
        scoreThreshold,
      );
    }

    const availableWorker = this.workers.find((w) => !w.busy);
    if (!availableWorker) {
      return this.scoreSequential(
        candidates,
        context,
        metricsMap,
        filesMap,
        centralityStats,
        scoreThreshold,
      );
    }

    const input: ScoreWorkerInput = {
      candidates,
      context: {
        query: context.query,
        queryTokens: context.queryTokens,
        stackTrace: context.stackTrace,
        failingTestPath: context.failingTestPath,
        editedFiles: context.editedFiles,
        entrySymbols: context.entrySymbols,
      },
      metricsMap: Object.fromEntries(metricsMap),
      filesMap: Object.fromEntries(filesMap),
      centralityStats,
      scoreThreshold,
    };

    return new Promise((resolve) => {
      availableWorker.busy = true;

      const timeout = setTimeout(() => {
        availableWorker.busy = false;
        availableWorker.worker.off("message", handler);
        logger.warn("Parallel scorer timeout, falling back to sequential");
        this.failed = true;
        resolve(
          this.scoreSequential(
            candidates,
            context,
            metricsMap,
            filesMap,
            centralityStats,
            scoreThreshold,
          ),
        );
      }, 5000);
      timeout.unref();

      const handler = (msg: ScoreWorkerOutput) => {
        clearTimeout(timeout);
        availableWorker.busy = false;
        availableWorker.worker.off("message", handler);

        if (msg.error) {
          logger.warn("Parallel scorer error, falling back to sequential", {
            error: msg.error,
          });
          this.failed = true;
          resolve(
            this.scoreSequential(
              candidates,
              context,
              metricsMap,
              filesMap,
              centralityStats,
              scoreThreshold,
            ),
          );
          return;
        }

        const result = new Map<string, { score: number; passed: boolean }>();
        for (const r of msg.results) {
          result.set(r.symbolId, { score: r.score, passed: r.passed });
        }
        resolve(result);
      };

      availableWorker.worker.on("message", handler);
      availableWorker.worker.postMessage(input);
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers = [];
    this.initialized = false;
  }
}

let globalScorerPool: ParallelScorerPool | null = null;

export function getScorerPool(
  config?: Partial<ParallelScorerConfig>,
): ParallelScorerPool {
  if (!globalScorerPool) {
    globalScorerPool = new ParallelScorerPool({
      ...DEFAULT_PARALLEL_SCORER_CONFIG,
      ...config,
    });
  }
  return globalScorerPool;
}

export function resetScorerPool(): void {
  if (globalScorerPool) {
    globalScorerPool.shutdown().catch((err) => {
      logger.debug("Failed to shutdown scorer pool", { error: err });
    });
    globalScorerPool = null;
  }
}

export interface BeamSearchOptions {
  parallelScorer?: Partial<ParallelScorerConfig>;
}

export async function beamSearchAsync(
  graph: Graph,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number,
  options?: BeamSearchOptions,
  signal?: AbortSignal,
  traceCollector?: BeamTraceCollector | null,
): Promise<BeamSearchResult & { scorerMode: ScorerMode }> {
  const scorerConfig: ParallelScorerConfig = {
    ...DEFAULT_PARALLEL_SCORER_CONFIG,
    ...options?.parallelScorer,
  };

  const pool = getScorerPool(scorerConfig);
  const scorerMode = await pool.initialize();

  const state = createBeamCoreState(budget, request, startNodes, minConfidence);
  if (traceCollector) state.traceCollector = traceCollector;

  seedFrontierFromGraph(state, startNodes, graph);

  const context = buildSliceContext(request);
  const centralityStats =
    graph.centralityStats ??
    (graph.metrics
      ? computeCentralityStats(graph.metrics.values())
      : { maxPageRank: 0, maxKCore: 0 });

  const strategy: BeamSearchStrategy = {
    async estimateCardTokens(symbolId, _st) {
      return estimateCardTokens(symbolId, graph);
    },

    async expandNeighbors(currentSymbolId, st, ctx, ew) {
      const neighborMaps = buildUnvisitedNeighborMaps(
        currentSymbolId,
        st,
        graph,
      );
      if (!neighborMaps) return;
      const { edgeByTarget, neighborsMap } = neighborMaps;

      const metricsMap = new Map<SymbolId, MetricsRow>();
      const filesMap = new Map<number, FileRow>();

      const candidates: ScoreCandidate[] = [];
      for (const [neighborId, neighborSymbol] of neighborsMap) {
        if (st.visited.has(neighborId)) continue;

        const edge = edgeByTarget.get(neighborId);
        if (!edge) continue;

        const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
        if (edgeConfidence < st.effectiveMinConfidence) {
          st.droppedCandidates++;
          continue;
        }

        const edgeWeight = applyEdgeConfidenceWeight(
          ew[edge.type] ?? 0.5,
          edgeConfidence,
        );

        // Populate scoring maps from the in-memory graph so that
        // scoreBatch / scoreSequential have access to metrics and file data.
        const metrics = graph.metrics?.get(neighborId) ?? null;
        if (metrics !== null) {
          metricsMap.set(neighborId, metrics);
        }
        if (neighborSymbol.file_id && graph.files) {
          const file = graph.files.get(neighborSymbol.file_id);
          if (file) {
            filesMap.set(neighborSymbol.file_id, file);
          }
        }

        candidates.push({
          symbolId: neighborId,
          neighborSymbol,
          edgeWeight,
        });
      }

      if (candidates.length === 0) return;

      const scoredResults = await pool.scoreBatch(
        candidates,
        ctx,
        metricsMap,
        filesMap,
        centralityStats,
        SLICE_SCORE_THRESHOLD,
      );

      for (const candidate of candidates) {
        const neighborId = candidate.symbolId;
        const scored = scoredResults.get(neighborId);

        if (!scored) continue;
        if (!scored.passed) {
          st.droppedCandidates++;
          continue;
        }

        st.visited.add(neighborId);
        const neighborScore = -scored.score;
        const edge = edgeByTarget.get(neighborId);
        if (!edge) continue;

        insertCandidateIntoFrontier(
          st,
          neighborId,
          neighborScore,
          getEdgeWhy(edge.type),
          {
            edgeFromSymbolId: currentSymbolId,
            edgeType: edge.type,
            edgeWeight: candidate.edgeWeight,
          },
        );
      }
    },
  };

  const result = await beamSearchCoreAsync(
    state,
    budget,
    context,
    edgeWeights,
    minConfidence,
    strategy,
    signal,
  );
  return { ...result, scorerMode };
}
