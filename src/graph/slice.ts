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

import type { Connection } from "kuzu";

import type { RepoId, SymbolId, VersionId, EdgeType } from "../db/schema.js";
import type {
  SliceBudget,
  GraphSlice,
  SymbolCard,
  SliceSymbolDeps,
  ConfidenceDistribution,
  CardDetailLevel,
  DetailLevelMetadata,
  CallResolution,
} from "../domain/types.js";
import {
  normalizeCardDetailLevel,
  CARD_DETAIL_LEVEL_RANK,
} from "../domain/types.js";
import { loadConfig } from "../config/loadConfig.js";
import { DatabaseError, ValidationError } from "../domain/errors.js";
import { pickDepLabel } from "../util/depLabels.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_PROCESSES,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
} from "../config/constants.js";
import { symbolCardCache } from "./cache.js";
import {
  getSliceCacheKey,
  getCachedSlice,
  setCachedSlice,
  configureSliceCache,
} from "./sliceCache.js";

import {
  resolveStartNodes,
  resolveStartNodesLadybug,
  type StartNodeSource,
  type ResolvedStartNode,
  type StartNodeLimits,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
  TASK_TEXT_STOP_WORDS,
} from "./slice/start-node-resolver.js";

import {
  beamSearch,
  beamSearchLadybug,
  normalizeEdgeConfidence,
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
  type FrontierItem,
} from "./slice/beam-search-engine.js";

import {
  getGraphSnapshot,
  loadAndCacheGraphSnapshot,
} from "./graphSnapshotCache.js";

import {
  buildPayloadCardsAndRefs,
  toSliceSymbolCard,
  toFullCard,
  toCardAtDetailLevel,
  selectAdaptiveDetailLevel,
  filterDepsBySliceSymbolSet,
  encodeEdgesWithSymbolIndex,
  estimateTokens,
  uniqueLimit,
  uniqueDepRefs,
} from "./slice/slice-serializer.js";

import {
  type SliceResult,
  type SliceError,
  sliceOk,
  sliceErr,
} from "./slice/result.js";
import {
  getOverlaySnapshot,
  getTargetNamesWithOverlay,
  mergeEdgeMapWithOverlay,
  mergeSymbolRowsWithOverlay,
  type OverlaySnapshot,
} from "../live-index/overlay-reader.js";
import { logger } from "../util/logger.js";

export {
  type StartNodeSource,
  type ResolvedStartNode,
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

interface SliceBuildRequest {
  repoId: RepoId;
  versionId: VersionId;
  /**
   * Optional Ladybug connection override (primarily for tests).
   * Not exposed via MCP tool schemas.
   */
  conn?: Connection;
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  knownCardEtags?: Record<SymbolId, string>;
  cardDetail?: CardDetailLevel;
  adaptiveDetail?: boolean;
  budget?: SliceBudget;
  minConfidence?: number;
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
}

export async function buildSlice(
  request: SliceBuildRequest,
): Promise<GraphSlice> {
  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;

  if (cacheConfig) {
    configureSliceCache({
      maxEntries: cacheConfig.graphSliceMaxEntries,
    });
  }

  const cacheKey = getSliceCacheKey(request);
  const cached = cacheEnabled ? getCachedSlice(cacheKey) : null;
  if (cached) {
    return cached;
  }

  const sliceConfig = config.slice;
  const edgeWeights = sliceConfig?.edgeWeights ?? {
    call: 1.0,
    import: 0.6,
    config: 0.8,
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
  const overlaySnapshot = getOverlaySnapshot(request.repoId);

  // -----------------------------------------------------------------------
  // Try in-memory graph snapshot path first (zero DB calls during traversal)
  // -----------------------------------------------------------------------
  const cachedGraph = getGraphSnapshot(request.repoId);

  const startNodes = await resolveStartNodesLadybug(
    conn,
    request.repoId,
    request,
  );
  const startSymbols = startNodes.map((node) => node.symbolId);

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
      const relatedLists = await Promise.all(
        Array.from(entryClusterIds).map((clusterId) =>
          ladybugDb.getRelatedClusters(conn, clusterId, 20),
        ),
      );
      for (const related of relatedLists) {
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
    );
    sliceCards = result.sliceCards;
    frontier = result.frontier;
    wasTruncated = result.wasTruncated;
    droppedCandidates = result.droppedCandidates;

    // Opportunistically load and cache the graph snapshot for future calls.
    // Run in background — don't block the current response.
    void loadAndCacheGraphSnapshot(conn, request.repoId).catch((err) => {
      logger.debug("Background graph snapshot load failed", {
        repoId: request.repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    const totalEdges = edges.length;
    const maxEdges = Math.max(0, totalEdges);
    slice.truncation = {
      truncated: true,
      droppedCards: droppedCandidates,
      droppedEdges: maxEdges,
      howToResume: {
        type: "token",
        value: estimatedTokens,
      },
    };
  }

  if (cacheEnabled) {
    setCachedSlice(cacheKey, slice);
  }

  return slice;
}

function resolveEffectiveDetailLevel(
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

function buildDetailLevelMetadata(
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

function buildCallResolution(
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

async function loadSymbolCards(
  conn: Connection,
  symbolIds: SymbolId[],
  versionId: VersionId,
  repoId: RepoId,
  effectiveLevel: CardDetailLevel,
  minCallConfidence?: number,
  includeResolutionMetadata?: boolean,
  overlaySnapshot?: OverlaySnapshot,
): Promise<{
  cards: SymbolCard[];
  sliceDepsBySymbol: Map<SymbolId, SliceSymbolDeps>;
}> {
  if (symbolIds.length === 0) {
    return {
      cards: [],
      sliceDepsBySymbol: new Map<SymbolId, SliceSymbolDeps>(),
    };
  }

  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;
  const canUseCache = cacheEnabled && !includeResolutionMetadata;

  const cards: SymbolCard[] = [];
  const uncachedSymbolIds: SymbolId[] = [];
  const snapshot = overlaySnapshot ?? getOverlaySnapshot(repoId);

  if (canUseCache) {
    for (const symbolId of symbolIds) {
      if (snapshot.symbolsById.has(symbolId)) {
        uncachedSymbolIds.push(symbolId);
        continue;
      }
      const cachedCard = symbolCardCache.get(repoId, symbolId, versionId);

      if (!cachedCard) {
        uncachedSymbolIds.push(symbolId);
        continue;
      }

      const cardAtLevel = toCardAtDetailLevel(cachedCard, effectiveLevel);
      cards.push(cardAtLevel);
    }
  } else {
    uncachedSymbolIds.push(...symbolIds);
  }

  if (uncachedSymbolIds.length === 0) {
    return {
      cards,
      sliceDepsBySymbol: await buildSliceDepsBySymbol(
        conn,
        symbolIds,
        undefined,
        minCallConfidence,
      ),
    };
  }

  uncachedSymbolIds.sort();

  const durableSymbolsMap = await ladybugDb.getSymbolsByIds(
    conn,
    uncachedSymbolIds,
  );
  const symbolsMap = mergeSymbolRowsWithOverlay(
    snapshot,
    uncachedSymbolIds,
    durableSymbolsMap,
  );

  const fileIds = new Set<string>();
  for (const symbol of symbolsMap.values()) {
    if (symbol.repoId !== repoId) continue;
    fileIds.add(symbol.fileId);
  }
  const filesMap = await ladybugDb.getFilesByIds(conn, [...fileIds]);
  for (const [fileId, file] of snapshot.filesById) {
    if (fileIds.has(fileId)) {
      filesMap.set(fileId, file);
    }
  }

  const metricsMap = await ladybugDb.getMetricsBySymbolIds(
    conn,
    uncachedSymbolIds,
  );

  const durableEdgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(
    conn,
    uncachedSymbolIds,
    { minCallConfidence },
  );
  const edgesMap = mergeEdgeMapWithOverlay(
    snapshot,
    uncachedSymbolIds,
    durableEdgesMap,
    minCallConfidence,
  );

  const importedSymbolIds = new Set<string>();
  const calledSymbolIds = new Set<string>();
  for (const edges of edgesMap.values()) {
    for (const edge of edges) {
      if (edge.edgeType === "import") {
        importedSymbolIds.add(edge.toSymbolId);
      } else if (edge.edgeType === "call") {
        calledSymbolIds.add(edge.toSymbolId);
      }
    }
  }
  const importedSymbolsMap = await getTargetNamesWithOverlay(conn, snapshot, [
    ...importedSymbolIds,
  ]);
  const calledSymbolsMap = await getTargetNamesWithOverlay(conn, snapshot, [
    ...calledSymbolIds,
  ]);

  const includeDeps =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.deps;
  const includeSignature =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.signature;
  const includeFullDetails = effectiveLevel === "full";

  const clustersBySymbolId = await ladybugDb.getClustersForSymbols(
    conn,
    uncachedSymbolIds,
  );
  const processesBySymbolId = includeDeps
    ? await ladybugDb.getProcessesForSymbols(conn, uncachedSymbolIds)
    : new Map<string, ladybugDb.ProcessForSymbolRow[]>();

  for (const symbolId of uncachedSymbolIds) {
    const symbolRow = symbolsMap.get(symbolId);
    if (!symbolRow || symbolRow.repoId !== repoId) continue;

    const clusterRow = clustersBySymbolId.get(symbolId);
    const processRows = includeDeps
      ? (processesBySymbolId.get(symbolId) ?? [])
      : [];

    const file = filesMap.get(symbolRow.fileId);
    const metrics = metricsMap.get(symbolId);
    const outgoingEdges = edgesMap.get(symbolId) ?? [];

    const importDeps: string[] = [];
    const callDeps: string[] = [];

    if (includeDeps) {
      for (const edge of outgoingEdges) {
        if (edge.edgeType === "import") {
          const importedSymbol = importedSymbolsMap.get(edge.toSymbolId);
          const depLabel = pickDepLabel(edge.toSymbolId, importedSymbol?.name);
          if (depLabel) {
            importDeps.push(depLabel);
          }
        } else if (edge.edgeType === "call") {
          const calledSymbol = calledSymbolsMap.get(edge.toSymbolId);
          const depLabel = pickDepLabel(edge.toSymbolId, calledSymbol?.name);
          if (depLabel) {
            callDeps.push(depLabel);
          }
        }
      }
    }

    const depLimit = includeFullDetails
      ? SYMBOL_CARD_MAX_DEPS_PER_KIND
      : SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT;
    const deps = {
      imports: includeDeps ? uniqueLimit(importDeps, depLimit) : [],
      calls: includeDeps ? uniqueLimit(callDeps, depLimit) : [],
    };

    let signature;
    if (includeSignature && symbolRow.signatureJson) {
      try {
        signature = JSON.parse(symbolRow.signatureJson);
      } catch (error) {
        logger.warn("Failed to parse signatureJson", {
          symbolId,
          error: error instanceof Error ? error.message : String(error),
        });
        signature = { name: symbolRow.name };
      }
    } else if (includeSignature) {
      signature = { name: symbolRow.name };
    }

    let invariants: string[] | undefined;
    if (includeFullDetails && symbolRow.invariantsJson) {
      try {
        const parsed = JSON.parse(symbolRow.invariantsJson);
        invariants = parsed.slice(0, SYMBOL_CARD_MAX_INVARIANTS);
      } catch (error) {
        logger.warn("Failed to parse invariantsJson", {
          symbolId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let sideEffects: string[] | undefined;
    if (includeFullDetails && symbolRow.sideEffectsJson) {
      try {
        const parsed = JSON.parse(symbolRow.sideEffectsJson);
        sideEffects = parsed.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS);
      } catch (error) {
        logger.warn("Failed to parse sideEffectsJson", {
          symbolId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let metricsData;
    if (includeFullDetails && metrics) {
      let testRefs: string[] | undefined;
      if (metrics.testRefsJson) {
        try {
          testRefs = JSON.parse(metrics.testRefsJson);
        } catch (error) {
          logger.warn("Failed to parse testRefsJson", {
            symbolId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (testRefs) {
        testRefs = uniqueLimit(testRefs, SYMBOL_CARD_MAX_TEST_REFS);
      }

      metricsData = {
        fanIn: metrics.fanIn,
        fanOut: metrics.fanOut,
        churn30d: metrics.churn30d,
        testRefs,
      };
    }

    const summaryMaxLength = includeFullDetails
      ? SYMBOL_CARD_SUMMARY_MAX_CHARS
      : SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT;

    const baseCard: SymbolCard = {
      symbolId: symbolRow.symbolId,
      repoId: symbolRow.repoId,
      file: file?.relPath ?? "",
      range: {
        startLine: symbolRow.rangeStartLine,
        startCol: symbolRow.rangeStartCol,
        endLine: symbolRow.rangeEndLine,
        endCol: symbolRow.rangeEndCol,
      },
      kind: symbolRow.kind as SymbolCard["kind"],
      name: symbolRow.name,
      exported: symbolRow.exported,
      visibility:
        (symbolRow.visibility as SymbolCard["visibility"]) ?? undefined,
      signature: includeSignature ? signature : undefined,
      summary: symbolRow.summary
        ? symbolRow.summary.slice(0, summaryMaxLength)
        : undefined,
      invariants: invariants && invariants.length > 0 ? invariants : undefined,
      sideEffects:
        sideEffects && sideEffects.length > 0 ? sideEffects : undefined,
      cluster: clusterRow
        ? {
            clusterId: clusterRow.clusterId,
            label: clusterRow.label,
            memberCount: clusterRow.symbolCount,
          }
        : undefined,
      processes:
        includeDeps && processRows.length > 0
          ? processRows.slice(0, SYMBOL_CARD_MAX_PROCESSES).map((row) => ({
              processId: row.processId,
              label: row.label,
              role:
                row.role === "entry" ||
                row.role === "exit" ||
                row.role === "intermediate"
                  ? row.role
                  : "intermediate",
              depth: row.depth,
            }))
          : undefined,
      callResolution: includeResolutionMetadata
        ? buildCallResolution(
            outgoingEdges,
            calledSymbolsMap,
            minCallConfidence,
          )
        : undefined,
      deps,
      metrics: includeFullDetails ? metricsData : undefined,
      detailLevel: effectiveLevel,
      version: {
        ledgerVersion: versionId,
        astFingerprint: symbolRow.astFingerprint,
      },
    };

    const card = toCardAtDetailLevel(baseCard, effectiveLevel);
    cards.push(card);

    if (canUseCache && !snapshot.symbolsById.has(symbolRow.symbolId)) {
      await symbolCardCache.set(
        repoId,
        symbolRow.symbolId,
        versionId,
        toFullCard(baseCard),
      );
    }
  }

  return {
    cards,
    sliceDepsBySymbol: await buildSliceDepsBySymbol(
      conn,
      symbolIds,
      edgesMap,
      minCallConfidence,
    ),
  };
}

type SliceEdgeProjection = {
  from_symbol_id: SymbolId;
  to_symbol_id: SymbolId;
  type: EdgeType;
  weight: number;
  confidence?: number;
};

async function buildSliceDepsBySymbol(
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

async function loadEdgesBetweenSymbols(
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

export async function buildSliceWithResult(
  request: SliceBuildRequest,
): Promise<SliceResult> {
  try {
    const slice = await buildSlice(request);

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
