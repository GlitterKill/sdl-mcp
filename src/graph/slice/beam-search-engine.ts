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

import type {
  EdgeType,
  FileRow,
  MetricsRow,
  RepoId,
  SymbolId,
  SymbolRow,
} from "../../db/schema.js";
import type { SliceBudget } from "../../domain/types.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import {
  SLICE_SCORE_THRESHOLD,
  MAX_FRONTIER,
  SYMBOL_TOKEN_BASE,
  TOKENS_PER_CHAR_ESTIMATE,
  SYMBOL_TOKEN_ADDITIONAL_MAX,
} from "../../config/constants.js";
import { logger } from "../../util/logger.js";
import { findPackageRoot } from "../../util/findPackageRoot.js";

import type { Graph } from "../buildGraph.js";
import { MinHeap } from "../minHeap.js";
import {
  calculateClusterCohesion,
  scoreSymbolWithMetrics,
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
    updated_at: metrics.updatedAt,
  };
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

  tokens += symbol.name.length / TOKENS_PER_CHAR_ESTIMATE;

  if (symbol.signatureJson) {
    tokens += symbol.signatureJson.length / TOKENS_PER_CHAR_ESTIMATE;
  }

  if (symbol.summary) {
    tokens += Math.min(
      symbol.summary.length / TOKENS_PER_CHAR_ESTIMATE,
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

export function beamSearch(
  graph: Graph,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: BeamSearchRequest,
  edgeWeights: Record<EdgeType, number>,
  minConfidence: number,
): BeamSearchResult {
  const sliceCards = new Set<SymbolId>();
  const visited = new Set<SymbolId>();
  const frontier = new MinHeap<FrontierItem>();
  let droppedCandidates = 0;
  let sequence = 0;
  let effectiveCardCap = budget.maxCards;
  const entrySymbols = new Set(request.entrySymbols ?? []);
  const requiredEntryCoverage = entrySymbols.size;
  const minCardsForDynamicCap = computeMinCardsForDynamicCap(
    budget.maxCards,
    requiredEntryCoverage,
  );
  let coveredEntrySymbols = 0;
  let highConfidenceCards = 0;
  const recentAcceptedScores: number[] = [];

  // Collect forced symbolIds: editedFile nodes bypass score threshold pruning
  const forcedSymbolIds = new Set<SymbolId>(
    startNodes.filter((n) => n.source === "editedFile").map((n) => n.symbolId),
  );

  for (const { symbolId, source } of startNodes) {
    if (!visited.has(symbolId) && graph.symbols.has(symbolId)) {
      frontier.insert({
        symbolId,
        score: START_NODE_SOURCE_SCORE[source],
        why: getStartNodeWhy(source),
        priority: 0,
        sequence: sequence++,
      });
      visited.add(symbolId);
    }
  }

  const context: SliceContext = {
    query: request.taskText ?? "",
    queryTokens: request.taskText ? tokenize(request.taskText) : undefined,
    stackTrace: request.stackTrace,
    failingTestPath: request.failingTestPath,
    editedFiles: request.editedFiles,
    entrySymbols: request.entrySymbols,
  };

  const entryClusterIds = new Set<string>(
    request.clusterContext?.entryClusterIds ?? [],
  );
  const relatedClusterIds = new Set<string>(
    request.clusterContext?.relatedClusterIds ?? [],
  );
  const clusterCohesionEnabled =
    (entryClusterIds.size > 0 || relatedClusterIds.size > 0) &&
    !!graph.clusters;

  let belowThresholdCount = 0;
  let wasTruncated = false;
  let totalTokens = 0;
  let effectiveMinConfidence = minConfidence;

  while (!frontier.isEmpty() && sliceCards.size < effectiveCardCap) {
    effectiveMinConfidence = getAdaptiveMinConfidence(
      minConfidence,
      totalTokens,
      budget.maxEstimatedTokens,
    );
    const current = frontier.extractMin()!;
    const actualScore = -current.score;

    if (sliceCards.size >= effectiveCardCap) {
      wasTruncated = true;
      break;
    }

    if (
      actualScore < SLICE_SCORE_THRESHOLD &&
      !forcedSymbolIds.has(current.symbolId)
    ) {
      belowThresholdCount++;
      if (belowThresholdCount >= 5) break;
      continue;
    }

    belowThresholdCount = 0;

    sliceCards.add(current.symbolId);
    if (entrySymbols.has(current.symbolId)) {
      coveredEntrySymbols++;
    }
    if (
      actualScore >=
      SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN
    ) {
      highConfidenceCards++;
    }
    recentAcceptedScores.push(actualScore);
    if (recentAcceptedScores.length > DYNAMIC_CAP_RECENT_SCORE_WINDOW) {
      recentAcceptedScores.shift();
    }

    const cardTokens = estimateCardTokens(current.symbolId, graph);
    totalTokens += cardTokens;

    if (totalTokens > budget.maxEstimatedTokens) {
      sliceCards.delete(current.symbolId);
      totalTokens -= cardTokens;
      wasTruncated = true;
      droppedCandidates++;
      break;
    }

    const outgoing = graph.adjacencyOut.get(current.symbolId) ?? [];

    const edgeByTarget = new Map<SymbolId, (typeof outgoing)[number]>();
    for (const e of outgoing) {
      if (!visited.has(e.to_symbol_id) && !sliceCards.has(e.to_symbol_id)) {
        edgeByTarget.set(e.to_symbol_id, e);
      }
    }

    if (edgeByTarget.size === 0) continue;

    const neighborsMap = new Map<SymbolId, SymbolRow>();
    for (const id of edgeByTarget.keys()) {
      const symbol = graph.symbols.get(id);
      if (symbol) {
        neighborsMap.set(id, symbol);
      }
    }

    if (neighborsMap.size === 0) continue;

    for (const [neighborId, neighborSymbol] of neighborsMap) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const edge = edgeByTarget.get(neighborId);
      if (!edge) continue;

      const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
      if (edgeConfidence < effectiveMinConfidence) {
        droppedCandidates++;
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

      const rawScore = scoreSymbolWithMetrics(
        neighborSymbol,
        context,
        metrics,
        file,
      );
      const neighborScore = -(rawScore * edgeWeight + clusterBoost);

      if (-neighborScore < SLICE_SCORE_THRESHOLD) {
        droppedCandidates++;
        continue;
      }

      if (frontier.size() < MAX_FRONTIER) {
        frontier.insert({
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.type),
          priority: 10,
          sequence: sequence++,
        });
      } else {
        const min = frontier.peek();
        const candidate: FrontierItem = {
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.type),
          priority: 10,
          sequence: sequence++,
        };
        if (min && compareFrontierItems(min, candidate) > 0) {
          frontier.extractMin();
          frontier.insert(candidate);
        } else {
          droppedCandidates++;
        }
      }
    }

    if (
      shouldTightenDynamicCardCap({
        sliceSize: sliceCards.size,
        minCardsForDynamicCap,
        highConfidenceCards,
        requiredEntryCoverage,
        coveredEntrySymbols,
        recentAcceptedScores,
        nextFrontierScore: frontier.peek() ? -frontier.peek()!.score : null,
      })
    ) {
      effectiveCardCap = Math.min(effectiveCardCap, sliceCards.size);
    }
  }

  const frontierArray = frontier.toHeapArray().map((item) => ({
    symbolId: item.symbolId,
    score: -item.score,
    why: item.why,
    priority: item.priority,
    sequence: item.sequence,
  }));
  if (sliceCards.size >= budget.maxCards || frontierArray.length > 0) {
    wasTruncated = true;
    droppedCandidates += frontierArray.length;
  }

  return {
    sliceCards,
    frontier: frontierArray,
    wasTruncated,
    droppedCandidates,
  };
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
): Promise<BeamSearchResult> {
  const sliceCards = new Set<SymbolId>();
  const visited = new Set<SymbolId>();
  const frontier = new MinHeap<FrontierItem>();
  let droppedCandidates = 0;
  let sequence = 0;
  let effectiveCardCap = budget.maxCards;
  const entrySymbols = new Set(request.entrySymbols ?? []);
  const requiredEntryCoverage = entrySymbols.size;
  const minCardsForDynamicCap = computeMinCardsForDynamicCap(
    budget.maxCards,
    requiredEntryCoverage,
  );
  let coveredEntrySymbols = 0;
  let highConfidenceCards = 0;
  const recentAcceptedScores: number[] = [];

  // Collect forced symbolIds: editedFile nodes bypass score threshold pruning
  const forcedSymbolIds = new Set<SymbolId>(
    startNodes.filter((n) => n.source === "editedFile").map((n) => n.symbolId),
  );

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

  // ---------------------------------------------------------------------------
  // Batch prefetch: peek at the top N frontier items and warm all caches in
  // parallel. This replaces sequential per-iteration DB round-trips with a
  // single batched fetch, eliminating the await waterfall.
  // ---------------------------------------------------------------------------
  const prefetchFrontierBatch = async (): Promise<void> => {
    const peekItems = frontier.peekTopN(PREFETCH_LOOKAHEAD);
    const idsToFetch = peekItems
      .map((item) => item.symbolId)
      .filter((id) => !symbolCache.has(id));

    if (idsToFetch.length === 0) return;

    // Step 1: Batch-fetch symbols + edges for all frontier candidates in parallel
    const [symbolsMap, edgesMap] = await Promise.all([
      ladybugDb.getSymbolsByIds(conn, idsToFetch),
      ladybugDb.getEdgesFromSymbolsForSlice(conn, idsToFetch, {
        minCallConfidence: request.minCallConfidence,
      }),
    ]);

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

    // Step 2: Collect all neighbor symbol IDs from prefetched edges
    const neighborIds = new Set<SymbolId>();
    for (const edges of edgesMap.values()) {
      for (const edge of edges) {
        if (
          !symbolCache.has(edge.toSymbolId) &&
          !visited.has(edge.toSymbolId) &&
          !sliceCards.has(edge.toSymbolId)
        ) {
          neighborIds.add(edge.toSymbolId);
        }
      }
    }

    if (neighborIds.size === 0) return;

    const neighborIdList = Array.from(neighborIds);

    // Step 3: Batch-fetch neighbor symbols, metrics, clusters, and files in parallel
    const [neighborSymbols, neighborMetrics] = await Promise.all([
      ladybugDb.getSymbolsByIds(conn, neighborIdList),
      ladybugDb.getMetricsBySymbolIds(conn, neighborIdList),
    ]);

    // Populate neighbor caches
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

    // Fetch missing files + clusters in parallel
    const missingFileIds = Array.from(fileIds).filter(
      (id) => !fileCache.has(id),
    );
    const clusterIds = clusterCohesionEnabled
      ? neighborIdList.filter((id) => !clusterCache.has(id))
      : [];

    const prefetchPromises: Promise<void>[] = [];
    if (missingFileIds.length > 0) {
      prefetchPromises.push(
        ladybugDb.getFilesByIds(conn, missingFileIds).then((filesMap) => {
          for (const [fileId, file] of filesMap) {
            fileCache.set(fileId, file);
          }
        }),
      );
    }
    if (clusterIds.length > 0) {
      prefetchPromises.push(
        ladybugDb
          .getClustersForSymbols(conn, clusterIds)
          .then((clusterMap) => {
            for (const symbolId of clusterIds) {
              clusterCache.set(
                symbolId,
                clusterMap.get(symbolId)?.clusterId ?? null,
              );
            }
          }),
      );
    }
    if (prefetchPromises.length > 0) {
      await Promise.all(prefetchPromises);
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
    if (visited.has(symbolId)) continue;
    if (!symbolCache.has(symbolId)) continue;

    frontier.insert({
      symbolId,
      score: START_NODE_SOURCE_SCORE[source],
      why: getStartNodeWhy(source),
      priority: 0,
      sequence: sequence++,
    });
    visited.add(symbolId);
  }

  const context: SliceContext = {
    query: request.taskText ?? "",
    queryTokens: request.taskText ? tokenize(request.taskText) : undefined,
    stackTrace: request.stackTrace,
    failingTestPath: request.failingTestPath,
    editedFiles: request.editedFiles,
    entrySymbols: request.entrySymbols,
  };

  let belowThresholdCount = 0;
  let wasTruncated = false;
  let totalTokens = 0;
  let effectiveMinConfidence = minConfidence;

  // Initial prefetch: warm caches for all frontier items before the main loop
  await prefetchFrontierBatch();
  let iterationsSincePrefetch = 0;

  while (!frontier.isEmpty() && sliceCards.size < effectiveCardCap) {
    // Periodically re-prefetch when the previous batch is likely exhausted
    iterationsSincePrefetch++;
    if (iterationsSincePrefetch >= PREFETCH_INTERVAL) {
      await prefetchFrontierBatch();
      iterationsSincePrefetch = 0;
    }

    effectiveMinConfidence = getAdaptiveMinConfidence(
      minConfidence,
      totalTokens,
      budget.maxEstimatedTokens,
    );

    const current = frontier.extractMin()!;
    const actualScore = -current.score;

    if (sliceCards.size >= effectiveCardCap) {
      wasTruncated = true;
      break;
    }

    if (
      actualScore < SLICE_SCORE_THRESHOLD &&
      !forcedSymbolIds.has(current.symbolId)
    ) {
      belowThresholdCount++;
      if (belowThresholdCount >= 5) break;
      continue;
    }

    belowThresholdCount = 0;

    const currentSymbol = await getSymbol(current.symbolId);
    if (!currentSymbol) {
      continue;
    }

    sliceCards.add(current.symbolId);
    if (entrySymbols.has(current.symbolId)) {
      coveredEntrySymbols++;
    }
    if (
      actualScore >=
      SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN
    ) {
      highConfidenceCards++;
    }
    recentAcceptedScores.push(actualScore);
    if (recentAcceptedScores.length > DYNAMIC_CAP_RECENT_SCORE_WINDOW) {
      recentAcceptedScores.shift();
    }

    const outgoing = await getOutgoingEdges(current.symbolId);
    const cardTokens = estimateCardTokensLadybug(
      currentSymbol,
      outgoing.length,
    );
    totalTokens += cardTokens;

    if (totalTokens > budget.maxEstimatedTokens) {
      sliceCards.delete(current.symbolId);
      totalTokens -= cardTokens;
      wasTruncated = true;
      droppedCandidates++;
      break;
    }

    const edgeByTarget = new Map<
      SymbolId,
      { edgeType: EdgeType; confidence: number | undefined }
    >();
    const edgeTypePriority: Record<EdgeType, number> = {
      call: 0,
      import: 1,
      config: 2,
    };

    for (const edge of outgoing) {
      const edgeType = normalizeEdgeType(edge.edgeType);
      if (!edgeType) continue;

      const toId = edge.toSymbolId;
      if (visited.has(toId) || sliceCards.has(toId)) continue;

      const candidateScore = applyEdgeConfidenceWeight(
        edgeWeights[edgeType] ?? 0.5,
        edge.confidence,
      );

      const existing = edgeByTarget.get(toId);
      if (!existing) {
        edgeByTarget.set(toId, { edgeType, confidence: edge.confidence });
        continue;
      }

      const existingScore = applyEdgeConfidenceWeight(
        edgeWeights[existing.edgeType] ?? 0.5,
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

    if (edgeByTarget.size === 0) continue;

    const neighborIds = Array.from(edgeByTarget.keys());
    const neighborSymbolsMap = await ladybugDb.getSymbolsByIds(
      conn,
      neighborIds,
    );

    const validNeighborIds: SymbolId[] = [];
    const fileIds = new Set<string>();
    for (const neighborId of neighborIds) {
      const symbol = neighborSymbolsMap.get(neighborId);
      if (!symbol || symbol.repoId !== repoId) continue;
      symbolCache.set(neighborId, symbol);
      validNeighborIds.push(neighborId);
      fileIds.add(symbol.fileId);
    }

    if (validNeighborIds.length === 0) continue;

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
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const edge = edgeByTarget.get(neighborId);
      if (!edge) continue;

      const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
      if (edgeConfidence < effectiveMinConfidence) {
        droppedCandidates++;
        continue;
      }

      const edgeWeight = applyEdgeConfidenceWeight(
        edgeWeights[edge.edgeType] ?? 0.5,
        edgeConfidence,
      );

      const metrics = metricsCache.get(neighborId) ?? null;
      const file = fileCache.get(neighborSymbol.fileId);
      const baseScore = scoreSymbolWithMetrics(
        toLegacySymbolRow(neighborSymbol),
        context,
        metrics ? toLegacyMetricsRow(metrics) : null,
        file ? toLegacyFileRow(file) : undefined,
      );
      const cohesionBoost = clusterCohesionEnabled
        ? calculateClusterCohesion({
            symbolClusterId: clusterCache.get(neighborId),
            entryClusterIds,
            relatedClusterIds,
          })
        : 0;
      const neighborScore = -(baseScore * edgeWeight + cohesionBoost);

      if (-neighborScore < SLICE_SCORE_THRESHOLD) {
        droppedCandidates++;
        continue;
      }

      if (frontier.size() < MAX_FRONTIER) {
        frontier.insert({
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.edgeType),
          priority: 10,
          sequence: sequence++,
        });
      } else {
        const min = frontier.peek();
        const candidate: FrontierItem = {
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.edgeType),
          priority: 10,
          sequence: sequence++,
        };
        if (min && compareFrontierItems(min, candidate) > 0) {
          frontier.extractMin();
          frontier.insert(candidate);
        } else {
          droppedCandidates++;
        }
      }
    }

    if (
      shouldTightenDynamicCardCap({
        sliceSize: sliceCards.size,
        minCardsForDynamicCap,
        highConfidenceCards,
        requiredEntryCoverage,
        coveredEntrySymbols,
        recentAcceptedScores,
        nextFrontierScore: frontier.peek() ? -frontier.peek()!.score : null,
      })
    ) {
      effectiveCardCap = Math.min(effectiveCardCap, sliceCards.size);
    }
  }

  const frontierArray = frontier.toHeapArray().map((item) => ({
    symbolId: item.symbolId,
    score: -item.score,
    why: item.why,
    priority: item.priority,
    sequence: item.sequence,
  }));

  if (sliceCards.size >= budget.maxCards || frontierArray.length > 0) {
    wasTruncated = true;
    droppedCandidates += frontierArray.length;
  }

  return {
    sliceCards,
    frontier: frontierArray,
    wasTruncated,
    droppedCandidates,
  };
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
  }
}

export function estimateCardTokens(symbolId: SymbolId, graph: Graph): number {
  const symbol = graph.symbols.get(symbolId);
  if (!symbol) return SYMBOL_TOKEN_BASE;

  let tokens = SYMBOL_TOKEN_BASE;

  tokens += symbol.name.length / TOKENS_PER_CHAR_ESTIMATE;

  if (symbol.signature_json) {
    tokens += symbol.signature_json.length / TOKENS_PER_CHAR_ESTIMATE;
  }

  if (symbol.summary) {
    tokens += Math.min(
      symbol.summary.length / TOKENS_PER_CHAR_ESTIMATE,
      SYMBOL_TOKEN_ADDITIONAL_MAX,
    );
  }

  const outgoing = graph.adjacencyOut.get(symbolId) ?? [];
  tokens += outgoing.length * 5;

  return Math.ceil(tokens);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
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
          logger.warn("Parallel scorer worker error", { error: err.message });
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

  async scoreBatch(
    candidates: ScoreCandidate[],
    context: SliceContext,
    metricsMap: Map<string, import("../../db/schema.js").MetricsRow | null>,
    filesMap: Map<number, import("../../db/schema.js").FileRow | undefined>,
    scoreThreshold: number,
  ): Promise<Map<string, { score: number; passed: boolean }>> {
    const result = new Map<string, { score: number; passed: boolean }>();

    if (
      this.failed ||
      this.mode === "sequential" ||
      candidates.length < this.config.minBatchSize
    ) {
      for (const c of candidates) {
        const baseScore = scoreSymbolWithMetrics(
          c.neighborSymbol,
          context,
          metricsMap.get(c.symbolId) ?? null,
          filesMap.get(c.neighborSymbol.file_id),
        );
        const finalScore = baseScore * c.edgeWeight;
        result.set(c.symbolId, {
          score: finalScore,
          passed: finalScore >= scoreThreshold,
        });
      }
      return result;
    }

    const availableWorker = this.workers.find((w) => !w.busy);
    if (!availableWorker) {
      for (const c of candidates) {
        const baseScore = scoreSymbolWithMetrics(
          c.neighborSymbol,
          context,
          metricsMap.get(c.symbolId) ?? null,
          filesMap.get(c.neighborSymbol.file_id),
        );
        const finalScore = baseScore * c.edgeWeight;
        result.set(c.symbolId, {
          score: finalScore,
          passed: finalScore >= scoreThreshold,
        });
      }
      return result;
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
      scoreThreshold,
    };

    return new Promise((resolve) => {
      availableWorker.busy = true;

      const timeout = setTimeout(() => {
        availableWorker.busy = false;
        logger.warn("Parallel scorer timeout, falling back to sequential");
        this.failed = true;

        const fallbackResult = new Map<
          string,
          { score: number; passed: boolean }
        >();
        for (const c of candidates) {
          const baseScore = scoreSymbolWithMetrics(
            c.neighborSymbol,
            context,
            metricsMap.get(c.symbolId) ?? null,
            filesMap.get(c.neighborSymbol.file_id),
          );
          const finalScore = baseScore * c.edgeWeight;
          fallbackResult.set(c.symbolId, {
            score: finalScore,
            passed: finalScore >= scoreThreshold,
          });
        }
        resolve(fallbackResult);
      }, 5000);

      const handler = (msg: ScoreWorkerOutput) => {
        clearTimeout(timeout);
        availableWorker.busy = false;
        availableWorker.worker.off("message", handler);

        if (msg.error) {
          logger.warn("Parallel scorer error, falling back to sequential", {
            error: msg.error,
          });
          this.failed = true;

          const fallbackResult = new Map<
            string,
            { score: number; passed: boolean }
          >();
          for (const c of candidates) {
            const baseScore = scoreSymbolWithMetrics(
              c.neighborSymbol,
              context,
              metricsMap.get(c.symbolId) ?? null,
              filesMap.get(c.neighborSymbol.file_id),
            );
            const finalScore = baseScore * c.edgeWeight;
            fallbackResult.set(c.symbolId, {
              score: finalScore,
              passed: finalScore >= scoreThreshold,
            });
          }
          resolve(fallbackResult);
          return;
        }

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
): Promise<BeamSearchResult & { scorerMode: ScorerMode }> {
  const scorerConfig: ParallelScorerConfig = {
    ...DEFAULT_PARALLEL_SCORER_CONFIG,
    ...options?.parallelScorer,
  };

  const pool = getScorerPool(scorerConfig);
  const scorerMode = await pool.initialize();

  const sliceCards = new Set<SymbolId>();
  const visited = new Set<SymbolId>();
  const frontier = new MinHeap<FrontierItem>();
  let droppedCandidates = 0;
  let sequence = 0;
  let effectiveCardCap = budget.maxCards;
  const entrySymbols = new Set(request.entrySymbols ?? []);
  const requiredEntryCoverage = entrySymbols.size;
  const minCardsForDynamicCap = computeMinCardsForDynamicCap(
    budget.maxCards,
    requiredEntryCoverage,
  );
  let coveredEntrySymbols = 0;
  let highConfidenceCards = 0;
  const recentAcceptedScores: number[] = [];

  // Collect forced symbolIds: editedFile nodes bypass score threshold pruning
  const forcedSymbolIds = new Set<SymbolId>(
    startNodes.filter((n) => n.source === "editedFile").map((n) => n.symbolId),
  );

  for (const { symbolId, source } of startNodes) {
    if (!visited.has(symbolId) && graph.symbols.has(symbolId)) {
      frontier.insert({
        symbolId,
        score: START_NODE_SOURCE_SCORE[source],
        why: getStartNodeWhy(source),
        priority: 0,
        sequence: sequence++,
      });
      visited.add(symbolId);
    }
  }

  const context: SliceContext = {
    query: request.taskText ?? "",
    queryTokens: request.taskText ? tokenize(request.taskText) : undefined,
    stackTrace: request.stackTrace,
    failingTestPath: request.failingTestPath,
    editedFiles: request.editedFiles,
    entrySymbols: request.entrySymbols,
  };

  let belowThresholdCount = 0;
  let wasTruncated = false;
  let totalTokens = 0;
  let effectiveMinConfidence = minConfidence;

  while (!frontier.isEmpty() && sliceCards.size < effectiveCardCap) {
    effectiveMinConfidence = getAdaptiveMinConfidence(
      minConfidence,
      totalTokens,
      budget.maxEstimatedTokens,
    );
    const current = frontier.extractMin()!;
    const actualScore = -current.score;

    if (sliceCards.size >= effectiveCardCap) {
      wasTruncated = true;
      break;
    }

    if (
      actualScore < SLICE_SCORE_THRESHOLD &&
      !forcedSymbolIds.has(current.symbolId)
    ) {
      belowThresholdCount++;
      if (belowThresholdCount >= 5) break;
      continue;
    }

    belowThresholdCount = 0;

    sliceCards.add(current.symbolId);
    if (entrySymbols.has(current.symbolId)) {
      coveredEntrySymbols++;
    }
    if (
      actualScore >=
      SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN
    ) {
      highConfidenceCards++;
    }
    recentAcceptedScores.push(actualScore);
    if (recentAcceptedScores.length > DYNAMIC_CAP_RECENT_SCORE_WINDOW) {
      recentAcceptedScores.shift();
    }

    const cardTokens = estimateCardTokens(current.symbolId, graph);
    totalTokens += cardTokens;

    if (totalTokens > budget.maxEstimatedTokens) {
      sliceCards.delete(current.symbolId);
      totalTokens -= cardTokens;
      wasTruncated = true;
      droppedCandidates++;
      break;
    }

    const outgoing = graph.adjacencyOut.get(current.symbolId) ?? [];

    const edgeByTarget = new Map<SymbolId, (typeof outgoing)[number]>();
    for (const e of outgoing) {
      if (!visited.has(e.to_symbol_id) && !sliceCards.has(e.to_symbol_id)) {
        edgeByTarget.set(e.to_symbol_id, e);
      }
    }

    if (edgeByTarget.size === 0) continue;

    const neighborsMap = new Map<SymbolId, SymbolRow>();
    for (const id of edgeByTarget.keys()) {
      const symbol = graph.symbols.get(id);
      if (symbol) {
        neighborsMap.set(id, symbol);
      }
    }

    if (neighborsMap.size === 0) continue;

    const metricsMap = new Map<SymbolId, MetricsRow>();
    const filesMap = new Map<number, FileRow>();

    const candidates: ScoreCandidate[] = [];
    for (const [neighborId, neighborSymbol] of neighborsMap) {
      if (visited.has(neighborId)) continue;

      const edge = edgeByTarget.get(neighborId);
      if (!edge) continue;

      const edgeConfidence = normalizeEdgeConfidence(edge.confidence);
      if (edgeConfidence < effectiveMinConfidence) {
        droppedCandidates++;
        continue;
      }

      const edgeWeight = applyEdgeConfidenceWeight(
        edgeWeights[edge.type] ?? 0.5,
        edgeConfidence,
      );

      candidates.push({
        symbolId: neighborId,
        neighborSymbol,
        edgeWeight,
      });
    }

    if (candidates.length === 0) continue;

    const scoredResults = await pool.scoreBatch(
      candidates,
      context,
      metricsMap,
      filesMap,
      SLICE_SCORE_THRESHOLD,
    );

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const neighborId = candidate.symbolId;
      const scored = scoredResults.get(neighborId);

      if (!scored) continue;
      if (!scored.passed) {
        droppedCandidates++;
        continue;
      }

      visited.add(neighborId);
      const neighborScore = -scored.score;
      const edge = edgeByTarget.get(neighborId)!;

      if (frontier.size() < MAX_FRONTIER) {
        frontier.insert({
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.type),
          priority: 10,
          sequence: sequence++,
        });
      } else {
        const min = frontier.peek();
        const candidateItem: FrontierItem = {
          symbolId: neighborId,
          score: neighborScore,
          why: getEdgeWhy(edge.type),
          priority: 10,
          sequence: sequence++,
        };
        if (min && compareFrontierItems(min, candidateItem) > 0) {
          frontier.extractMin();
          frontier.insert(candidateItem);
        } else {
          droppedCandidates++;
        }
      }
    }

    if (
      shouldTightenDynamicCardCap({
        sliceSize: sliceCards.size,
        minCardsForDynamicCap,
        highConfidenceCards,
        requiredEntryCoverage,
        coveredEntrySymbols,
        recentAcceptedScores,
        nextFrontierScore: frontier.peek() ? -frontier.peek()!.score : null,
      })
    ) {
      effectiveCardCap = Math.min(effectiveCardCap, sliceCards.size);
    }
  }

  const frontierArray = frontier.toHeapArray().map((item) => ({
    symbolId: item.symbolId,
    score: -item.score,
    why: item.why,
    priority: item.priority,
    sequence: item.sequence,
  }));
  if (sliceCards.size >= budget.maxCards || frontierArray.length > 0) {
    wasTruncated = true;
    droppedCandidates += frontierArray.length;
  }

  return {
    sliceCards,
    frontier: frontierArray,
    wasTruncated,
    droppedCandidates,
    scorerMode,
  };
}
