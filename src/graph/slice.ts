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

import type { RepoId, SymbolId, VersionId, EdgeType } from "../db/schema.js";
import type {
  SliceBudget,
  GraphSlice,
  SymbolCard,
  SliceSymbolDeps,
  ConfidenceDistribution,
  CardDetailLevel,
  DetailLevelMetadata,
} from "../mcp/types.js";
import {
  normalizeCardDetailLevel,
  CARD_DETAIL_LEVEL_RANK,
} from "../mcp/types.js";
import {
  loadGraphForRepo,
  loadNeighborhood,
  logGraphTelemetry,
  getLastLoadStats,
  LAZY_GRAPH_LOADING_DEFAULT_HOPS,
  LAZY_GRAPH_LOADING_MAX_SYMBOLS,
} from "./buildGraph.js";
import { loadConfig } from "../config/loadConfig.js";
import { pickDepLabel } from "../util/depLabels.js";
import * as db from "../db/queries.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
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
} from "./sliceCache.js";

import {
  resolveStartNodes,
  type StartNodeSource,
  type ResolvedStartNode,
  type StartNodeLimits,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
  TASK_TEXT_STOP_WORDS,
} from "./slice/start-node-resolver.js";

import {
  beamSearch,
  normalizeEdgeConfidence,
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
  type FrontierItem,
} from "./slice/beam-search-engine.js";

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
}

export async function buildSlice(
  request: SliceBuildRequest,
): Promise<GraphSlice> {
  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;

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

  const hasEntrySymbols =
    request.entrySymbols && request.entrySymbols.length > 0;
  const repoSymbolCount = hasEntrySymbols
    ? db.countSymbolsByRepo(request.repoId)
    : 0;
  const useLazyLoading =
    hasEntrySymbols && repoSymbolCount > LAZY_GRAPH_LOADING_MAX_SYMBOLS;
  let graph;

  if (useLazyLoading && request.entrySymbols) {
    graph = loadNeighborhood(request.repoId, request.entrySymbols, {
      maxHops: LAZY_GRAPH_LOADING_DEFAULT_HOPS,
      direction: "both",
      maxSymbols: LAZY_GRAPH_LOADING_MAX_SYMBOLS,
    });
  } else {
    graph = loadGraphForRepo(request.repoId);
  }

  const loadStats = getLastLoadStats();
  if (loadStats) {
    logGraphTelemetry({
      repoId: request.repoId,
      ...loadStats,
    });
  }

  const startNodes = resolveStartNodes(graph, request);
  const startSymbols = startNodes.map((node) => node.symbolId);
  const { sliceCards, frontier, wasTruncated, droppedCandidates } = beamSearch(
    graph,
    startNodes,
    budget,
    request,
    edgeWeights,
    minConfidence,
  );

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
    Array.from(sliceCards),
    request.versionId,
    request.repoId,
    effectiveLevel,
  );
  const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs(
    cards,
    request.knownCardEtags,
    sliceDepsBySymbol,
    sliceCards,
  );
  const { symbolIndex, edges, confidenceDistribution } =
    loadEdgesBetweenSymbols(
      Array.from(sliceCards),
      request.repoId,
      minConfidence,
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

async function loadSymbolCards(
  symbolIds: SymbolId[],
  versionId: VersionId,
  repoId: RepoId,
  effectiveLevel: CardDetailLevel,
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

  const cards: SymbolCard[] = [];
  const uncachedSymbolIds: SymbolId[] = [];

  if (cacheEnabled) {
    for (const symbolId of symbolIds) {
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
      sliceDepsBySymbol: buildSliceDepsBySymbol(symbolIds),
    };
  }

  uncachedSymbolIds.sort();

  const symbolsMap = db.getSymbolsByIds(uncachedSymbolIds);

  const fileIds = new Set<number>();
  for (const symbol of symbolsMap.values()) {
    fileIds.add(symbol.file_id);
  }
  const filesMap = db.getFilesByIds([...fileIds]);

  const metricsMap = db.getMetricsBySymbolIds(uncachedSymbolIds);

  const edgesMap = db.getEdgesFromSymbolsForSlice(uncachedSymbolIds);

  const importedSymbolIds = new Set<string>();
  const calledSymbolIds = new Set<string>();
  for (const edges of edgesMap.values()) {
    for (const edge of edges) {
      if (edge.type === "import") {
        importedSymbolIds.add(edge.to_symbol_id);
      } else if (edge.type === "call") {
        calledSymbolIds.add(edge.to_symbol_id);
      }
    }
  }
  const importedSymbolsMap = db.getSymbolsByIdsLite([...importedSymbolIds]);
  const calledSymbolsMap = db.getSymbolsByIdsLite([...calledSymbolIds]);

  const includeDeps =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.deps;
  const includeSignature =
    CARD_DETAIL_LEVEL_RANK[effectiveLevel] >= CARD_DETAIL_LEVEL_RANK.signature;
  const includeFullDetails = effectiveLevel === "full";

  for (const symbolId of uncachedSymbolIds) {
    const symbolRow = symbolsMap.get(symbolId);
    if (!symbolRow) continue;

    const file = filesMap.get(symbolRow.file_id);
    const metrics = metricsMap.get(symbolId);
    const outgoingEdges = edgesMap.get(symbolId) ?? [];

    const importDeps: string[] = [];
    const callDeps: string[] = [];

    if (includeDeps) {
      for (const edge of outgoingEdges) {
        if (edge.type === "import") {
          const importedSymbol = importedSymbolsMap.get(edge.to_symbol_id);
          const depLabel = pickDepLabel(
            edge.to_symbol_id,
            importedSymbol?.name,
          );
          if (depLabel) {
            importDeps.push(depLabel);
          }
        } else if (edge.type === "call") {
          const calledSymbol = calledSymbolsMap.get(edge.to_symbol_id);
          const depLabel = pickDepLabel(edge.to_symbol_id, calledSymbol?.name);
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
    if (includeSignature && symbolRow.signature_json) {
      try {
        signature = JSON.parse(symbolRow.signature_json);
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to parse signature_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        signature = { name: symbolRow.name };
      }
    } else if (includeSignature) {
      signature = { name: symbolRow.name };
    }

    let invariants: string[] | undefined;
    if (includeFullDetails && symbolRow.invariants_json) {
      try {
        const parsed = JSON.parse(symbolRow.invariants_json);
        invariants = parsed.slice(0, SYMBOL_CARD_MAX_INVARIANTS);
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to parse invariants_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    let sideEffects: string[] | undefined;
    if (includeFullDetails && symbolRow.side_effects_json) {
      try {
        const parsed = JSON.parse(symbolRow.side_effects_json);
        sideEffects = parsed.slice(0, SYMBOL_CARD_MAX_SIDE_EFFECTS);
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to parse side_effects_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    let metricsData;
    if (includeFullDetails && metrics) {
      let testRefs: string[] | undefined;
      if (metrics.test_refs_json) {
        try {
          testRefs = JSON.parse(metrics.test_refs_json);
        } catch (error) {
          process.stderr.write(
            `[sdl-mcp] Failed to parse test_refs_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }

      if (testRefs) {
        testRefs = uniqueLimit(testRefs, SYMBOL_CARD_MAX_TEST_REFS);
      }

      metricsData = {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs,
      };
    }

    const summaryMaxLength = includeFullDetails
      ? SYMBOL_CARD_SUMMARY_MAX_CHARS
      : SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT;

    const baseCard: SymbolCard = {
      symbolId: symbolRow.symbol_id,
      repoId: symbolRow.repo_id,
      file: file?.rel_path ?? "",
      range: {
        startLine: symbolRow.range_start_line,
        startCol: symbolRow.range_start_col,
        endLine: symbolRow.range_end_line,
        endCol: symbolRow.range_end_col,
      },
      kind: symbolRow.kind,
      name: symbolRow.name,
      exported: symbolRow.exported === 1,
      visibility: symbolRow.visibility ?? undefined,
      signature: includeSignature ? signature : undefined,
      summary: symbolRow.summary
        ? symbolRow.summary.slice(0, summaryMaxLength)
        : undefined,
      invariants: invariants && invariants.length > 0 ? invariants : undefined,
      sideEffects:
        sideEffects && sideEffects.length > 0 ? sideEffects : undefined,
      deps,
      metrics: includeFullDetails ? metricsData : undefined,
      detailLevel: effectiveLevel,
      version: {
        ledgerVersion: versionId,
        astFingerprint: symbolRow.ast_fingerprint,
      },
    };

    const card = toCardAtDetailLevel(baseCard, effectiveLevel);
    cards.push(card);

    if (cacheEnabled) {
      await symbolCardCache.set(
        repoId,
        symbolRow.symbol_id,
        versionId,
        toFullCard(baseCard),
      );
    }
  }

  return {
    cards,
    sliceDepsBySymbol: buildSliceDepsBySymbol(symbolIds, edgesMap),
  };
}

type SliceEdgeProjection = {
  from_symbol_id: SymbolId;
  to_symbol_id: SymbolId;
  type: EdgeType;
  weight: number;
  confidence?: number;
};

function buildSliceDepsBySymbol(
  symbolIds: SymbolId[],
  prefetchedEdgesMap?: Map<SymbolId, SliceEdgeProjection[]>,
): Map<SymbolId, SliceSymbolDeps> {
  const depMap = new Map<SymbolId, SliceSymbolDeps>();
  if (symbolIds.length === 0) {
    return depMap;
  }

  const edgesMap = new Map<SymbolId, SliceEdgeProjection[]>();
  if (prefetchedEdgesMap) {
    for (const [symbolId, edges] of prefetchedEdgesMap) {
      edgesMap.set(symbolId, edges);
    }
  }

  const missingSymbolIds = symbolIds.filter(
    (symbolId) => !edgesMap.has(symbolId),
  );
  if (missingSymbolIds.length > 0) {
    const missingEdgesMap = db.getEdgesFromSymbolsForSlice(missingSymbolIds);
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
        symbolId: edge.to_symbol_id,
        confidence: normalizeEdgeConfidence(edge.confidence),
      };
      if (edge.type === "import") {
        imports.push(depRef);
      } else if (edge.type === "call") {
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


function loadEdgesBetweenSymbols(
  symbolIds: SymbolId[],
  _repoId: RepoId,
  minConfidence: number,
): {
  symbolIndex: SymbolId[];
  edges: [number, number, EdgeType, number][];
  confidenceDistribution: ConfidenceDistribution;
} {
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

  const edgesMap = db.getEdgesFromSymbolsForSlice(symbolIds);

  for (const [_fromId, outgoing] of edgesMap) {
    for (const edge of outgoing) {
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
      if (symbolSet.has(edge.to_symbol_id) && edgeConfidence >= minConfidence) {
        dbEdges.push(edge);
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
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("Repository not found") ||
      message.includes("not indexed")
    ) {
      return sliceErr({
        type: "invalid_repo",
        repoId: request.repoId,
      });
    }

    if (message.includes("No version found")) {
      return sliceErr({
        type: "no_version",
        repoId: request.repoId,
      });
    }

    if (message.includes("Policy denied")) {
      return sliceErr({
        type: "policy_denied",
        reason: message.replace("Policy denied slice request: ", ""),
      });
    }

    return sliceErr({
      type: "internal",
      message,
      cause:
        error instanceof Error && error.cause ? String(error.cause) : undefined,
    });
  }
}
