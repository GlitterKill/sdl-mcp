import type {
  RepoId,
  SymbolId,
  VersionId,
  EdgeType,
  SymbolRow,
} from "../db/schema.js";
import type {
  SliceBudget,
  GraphSlice,
  SymbolCard,
  SliceSymbolCard,
  CompressedEdge,
} from "../mcp/types.js";
import type { Graph } from "./buildGraph.js";
import { loadGraphForRepo } from "./buildGraph.js";
import { scoreSymbolWithMetrics, SliceContext } from "./score.js";
import { loadConfig } from "../config/loadConfig.js";
import {
  tokenize,
  estimateTokens as estimateTextTokens,
} from "../util/tokenize.js";
import { hashCard } from "../util/hashing.js";
import { pickDepLabel } from "../util/depLabels.js";
import * as db from "../db/queries.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SLICE_SCORE_THRESHOLD,
  MAX_FRONTIER,
  TASK_TEXT_START_NODE_MAX,
  TASK_TEXT_TOKEN_MAX,
  TASK_TEXT_TOKEN_QUERY_LIMIT,
  TASK_TEXT_MIN_TOKEN_LENGTH,
  ENTRY_FIRST_HOP_MAX_PER_SYMBOL,
  ENTRY_SIBLING_MAX_PER_SYMBOL,
  ENTRY_SIBLING_MIN_SHARED_PREFIX,
  SYMBOL_TOKEN_BASE,
  SYMBOL_TOKEN_ADDITIONAL_MAX,
  SYMBOL_TOKEN_MAX,
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_INVARIANTS_LIGHT,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT,
  AST_FINGERPRINT_WIRE_LENGTH,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
  TOKENS_PER_CHAR_ESTIMATE,
  DB_QUERY_LIMIT_DEFAULT,
} from "../config/constants.js";
import { MinHeap } from "./minHeap.js";
import { symbolCardCache } from "./cache.js";
import {
  getSliceCacheKey,
  getCachedSlice,
  setCachedSlice,
} from "./sliceCache.js";

interface FrontierItem {
  symbolId: SymbolId;
  score: number;
  why: string;
  priority: number;
  sequence: number;
}

type StartNodeSource =
  | "entrySymbol"
  | "entryFirstHop"
  | "entrySibling"
  | "stackTrace"
  | "failingTestPath"
  | "editedFile"
  | "taskText";

interface ResolvedStartNode {
  symbolId: SymbolId;
  source: StartNodeSource;
}

interface StartNodeLimits {
  maxTotalStartNodes: number;
  maxTaskTextStartNodes: number;
  maxFirstHopPerEntry: number;
  maxSiblingPerEntry: number;
}

const START_NODE_SOURCE_PRIORITY: Record<StartNodeSource, number> = {
  entrySymbol: 0,
  entrySibling: 1,
  entryFirstHop: 2,
  stackTrace: 3,
  failingTestPath: 4,
  editedFile: 5,
  taskText: 6,
};

const START_NODE_SOURCE_SCORE: Record<StartNodeSource, number> = {
  entrySymbol: -1.4,
  entrySibling: -1.22,
  entryFirstHop: -1.18,
  stackTrace: -1.2,
  failingTestPath: -1.1,
  editedFile: -1.0,
  taskText: -0.6,
};

const TASK_TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "id",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "please",
  "task",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const DYNAMIC_CAP_MIN_CARDS = 6;
const DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN = 0.2;
const DYNAMIC_CAP_RECENT_SCORE_WINDOW = 6;
const DYNAMIC_CAP_MIN_ENTRY_COVERAGE = 0.9;
const DYNAMIC_CAP_FRONTIER_SCORE_MARGIN = 0.08;
const DYNAMIC_CAP_FRONTIER_DROP_FACTOR = 0.67;
interface SliceBuildRequest {
  repoId: RepoId;
  versionId: VersionId;
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  knownCardEtags?: Record<SymbolId, string>;
  cardDetail?: "compact" | "full";
  budget?: SliceBudget;
}

/**
 * Builds a graph slice for code context delivery.
 * Uses beam search to select relevant symbols based on entry points and scoring.
 * Supports truncation and spillover for large slices.
 *
 * @param request - Slice build parameters including repoId, versionId, task context, and budget
 * @returns Graph slice with cards, edges, and truncation metadata
 */
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

  const graph = loadGraphForRepo(request.repoId);
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

  const startNodes = resolveStartNodes(graph, request);
  const startSymbols = startNodes.map((node) => node.symbolId);
  const { sliceCards, frontier, wasTruncated, droppedCandidates } = beamSearch(
    graph,
    startNodes,
    budget,
    request,
    edgeWeights,
  );

  const detailedSymbolIds = resolveDetailedSymbolIds(
    Array.from(sliceCards),
    request,
  );
  const cards = await loadSymbolCards(
    Array.from(sliceCards),
    request.versionId,
    request.repoId,
    detailedSymbolIds,
  );
  const {
    cardsForPayload,
    cardRefs,
  } = buildPayloadCardsAndRefs(cards, request.knownCardEtags);
  const { symbolIndex, edges } = loadEdgesBetweenSymbols(
    Array.from(sliceCards),
    request.repoId,
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

function resolveStartNodes(
  graph: Graph,
  request: SliceBuildRequest,
): ResolvedStartNode[] {
  const startNodes = new Map<SymbolId, StartNodeSource>();
  const explicitEntrySymbols: SymbolId[] = [];

  const addStartNode = (symbolId: SymbolId, source: StartNodeSource): void => {
    if (!graph.symbols.has(symbolId)) return;
    const existingSource = startNodes.get(symbolId);
    if (
      existingSource &&
      START_NODE_SOURCE_PRIORITY[existingSource] <=
        START_NODE_SOURCE_PRIORITY[source]
    ) {
      return;
    }
    startNodes.set(symbolId, source);
  };

  if (request.entrySymbols) {
    for (const symbolId of request.entrySymbols) {
      if (!graph.symbols.has(symbolId)) continue;
      explicitEntrySymbols.push(symbolId);
      addStartNode(symbolId, "entrySymbol");
    }
  }

  const limits = computeStartNodeLimits(request, explicitEntrySymbols.length);

  for (const symbolId of explicitEntrySymbols) {
    if (startNodes.size >= limits.maxTotalStartNodes) break;
    const firstHopSymbols = collectEntryFirstHopSymbols(
      graph,
      symbolId,
      limits.maxFirstHopPerEntry,
    );
    for (const firstHopSymbolId of firstHopSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(firstHopSymbolId, "entryFirstHop");
    }
  }

  if (explicitEntrySymbols.length > 0) {
    const symbolsByFile = buildSymbolsByFile(graph);
    for (const symbolId of explicitEntrySymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      const siblingSymbols = collectEntrySiblingSymbols(
        graph,
        symbolId,
        symbolsByFile,
        limits.maxSiblingPerEntry,
      );
      for (const siblingSymbolId of siblingSymbols) {
        if (startNodes.size >= limits.maxTotalStartNodes) break;
        addStartNode(siblingSymbolId, "entrySibling");
      }
    }
  }

  if (request.stackTrace) {
    const stackSymbols = extractSymbolsFromStackTrace(
      request.stackTrace,
      request.repoId,
    );
    for (const symbolId of stackSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(symbolId, "stackTrace");
    }
  }

  if (request.failingTestPath) {
    const fileSymbols = getSymbolsByPath(
      request.repoId,
      request.failingTestPath,
    );
    for (const symbolId of fileSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(symbolId, "failingTestPath");
    }
  }

  if (request.editedFiles) {
    for (const filePath of request.editedFiles) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      const fileSymbols = getSymbolsByPath(request.repoId, filePath);
      for (const symbolId of fileSymbols) {
        if (startNodes.size >= limits.maxTotalStartNodes) break;
        addStartNode(symbolId, "editedFile");
      }
    }
  }

  if (request.taskText) {
    const taskTokens = collectTaskTextSeedTokens(request.taskText);
    let taskTextSeedCount = 0;
    for (const token of taskTokens) {
      if (
        taskTextSeedCount >= limits.maxTaskTextStartNodes ||
        startNodes.size >= limits.maxTotalStartNodes
      ) {
        break;
      }
      const remaining = limits.maxTaskTextStartNodes - taskTextSeedCount;
      const perTokenLimit = Math.max(
        1,
        Math.min(
          DB_QUERY_LIMIT_DEFAULT,
          TASK_TEXT_TOKEN_QUERY_LIMIT,
          remaining,
        ),
      );
      const results = db.searchSymbolsLite(request.repoId, token, perTokenLimit);
      for (const result of results) {
        if (
          taskTextSeedCount >= limits.maxTaskTextStartNodes ||
          startNodes.size >= limits.maxTotalStartNodes
        ) {
          break;
        }
        const symbolId = result.symbol_id;
        if (startNodes.has(symbolId)) continue;
        addStartNode(symbolId, "taskText");
        if (startNodes.has(symbolId)) {
          taskTextSeedCount++;
        }
      }
    }
  }

  return Array.from(startNodes.entries())
    .sort(
      ([, sourceA], [, sourceB]) =>
        START_NODE_SOURCE_PRIORITY[sourceA] -
        START_NODE_SOURCE_PRIORITY[sourceB],
    )
    .map(([symbolId, source]) => ({ symbolId, source }));
}

function collectTaskTextSeedTokens(taskText: string): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const token of tokenize(taskText)) {
    if (token.length < TASK_TEXT_MIN_TOKEN_LENGTH) continue;
    if (TASK_TEXT_STOP_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (!/[a-z]/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    filtered.push(token);
  }

  filtered.sort((a, b) => {
    const rankDiff = getTaskTextTokenRank(b) - getTaskTextTokenRank(a);
    if (rankDiff !== 0) return rankDiff;
    return b.length - a.length;
  });

  return filtered.slice(0, TASK_TEXT_TOKEN_MAX);
}

function resolveDetailedSymbolIds(
  symbolIds: SymbolId[],
  request: SliceBuildRequest,
): Set<SymbolId> {
  if (request.cardDetail === "full") {
    return new Set(symbolIds);
  }

  return new Set(request.entrySymbols ?? []);
}

export function buildPayloadCardsAndRefs(
  cards: SymbolCard[],
  knownCardEtags?: Record<SymbolId, string>,
): {
  cardsForPayload: SliceSymbolCard[];
  cardRefs?: Array<{ symbolId: SymbolId; etag: string; detailLevel: "compact" | "full" }>;
} {
  const hasKnownCardEtags = Boolean(
    knownCardEtags && Object.keys(knownCardEtags).length > 0,
  );

  if (!hasKnownCardEtags) {
    return {
      cardsForPayload: cards.map((card) => {
        const detailLevel = card.detailLevel ?? "compact";
        const normalized: SymbolCard = {
          ...card,
          detailLevel,
        };
        delete normalized.etag;
        return toSliceSymbolCard(normalized);
      }),
    };
  }

  const cardsForPayload: SliceSymbolCard[] = [];
  const cardRefs: Array<{
    symbolId: SymbolId;
    etag: string;
    detailLevel: "compact" | "full";
  }> = [];

  const knownEtags = knownCardEtags ?? {};

  for (const card of cards) {
    const detailLevel = card.detailLevel ?? "compact";
    const cardWithoutEtag: SymbolCard = { ...card };
    cardWithoutEtag.detailLevel = detailLevel;
    delete cardWithoutEtag.etag;
    const etag = hashCard(cardWithoutEtag);

    if (knownEtags[card.symbolId] === etag) {
      continue;
    }

    cardRefs.push({
      symbolId: card.symbolId,
      etag,
      detailLevel,
    });
    cardsForPayload.push(toSliceSymbolCard(cardWithoutEtag));
  }

  return {
    cardsForPayload,
    cardRefs,
  };
}

function getTaskTextTokenRank(token: string): number {
  let rank = 0;
  if (token.includes("/") || token.includes("\\")) rank += 4;
  if (token.includes(".") || token.includes("_") || token.includes("-"))
    rank += 3;
  if (/[0-9]/.test(token)) rank += 2;
  if (token.length >= 8) rank += 1;
  return rank;
}

function buildSymbolsByFile(graph: Graph): Map<number, SymbolId[]> {
  const symbolsByFile = new Map<number, SymbolId[]>();
  for (const [symbolId, symbol] of graph.symbols) {
    const current = symbolsByFile.get(symbol.file_id);
    if (current) {
      current.push(symbolId);
      continue;
    }
    symbolsByFile.set(symbol.file_id, [symbolId]);
  }
  return symbolsByFile;
}

function collectEntryFirstHopSymbols(
  graph: Graph,
  entrySymbolId: SymbolId,
  maxPerSymbol: number,
): SymbolId[] {
  const outgoing = graph.adjacencyOut.get(entrySymbolId) ?? [];
  if (outgoing.length === 0) return [];

  const ranked = new Map<SymbolId, number>();
  for (const edge of outgoing) {
    if (edge.type !== "call" && edge.type !== "import") continue;
    const target = graph.symbols.get(edge.to_symbol_id);
    if (!target) continue;

    let rank = edge.type === "call" ? 4 : 2;
    if (target.exported === 1) rank += 1;
    if (target.kind === "function" || target.kind === "method") rank += 1;

    const previous = ranked.get(edge.to_symbol_id);
    if (previous === undefined || rank > previous) {
      ranked.set(edge.to_symbol_id, rank);
    }
  }

  return Array.from(ranked.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const nameA = graph.symbols.get(a[0])?.name ?? "";
      const nameB = graph.symbols.get(b[0])?.name ?? "";
      return nameA.localeCompare(nameB);
    })
    .slice(0, maxPerSymbol)
    .map(([symbolId]) => symbolId);
}

function collectEntrySiblingSymbols(
  graph: Graph,
  entrySymbolId: SymbolId,
  symbolsByFile: Map<number, SymbolId[]>,
  maxPerSymbol: number,
): SymbolId[] {
  const entrySymbol = graph.symbols.get(entrySymbolId);
  if (!entrySymbol) return [];

  const symbolIdsInFile = symbolsByFile.get(entrySymbol.file_id) ?? [];
  if (symbolIdsInFile.length <= 1) return [];

  const entryName = entrySymbol.name.toLowerCase();
  const ranked: Array<{ symbolId: SymbolId; rank: number; name: string }> = [];

  for (const candidateId of symbolIdsInFile) {
    if (candidateId === entrySymbolId) continue;
    const candidate = graph.symbols.get(candidateId);
    if (!candidate) continue;
    if (candidate.kind !== entrySymbol.kind) continue;

    const sharedPrefix = commonPrefixLength(
      entryName,
      candidate.name.toLowerCase(),
    );
    if (sharedPrefix < ENTRY_SIBLING_MIN_SHARED_PREFIX) continue;

    let rank = sharedPrefix;
    if (candidate.exported === 1) rank += 2;
    ranked.push({ symbolId: candidateId, rank, name: candidate.name });
  }

  return ranked
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxPerSymbol)
    .map((item) => item.symbolId);
}

function computeStartNodeLimits(
  request: SliceBuildRequest,
  explicitEntryCount: number,
): StartNodeLimits {
  const budgetMaxCards = Math.max(
    1,
    request.budget?.maxCards ?? DEFAULT_MAX_CARDS,
  );
  const maxTotalStartNodes = Math.max(
    12,
    Math.min(96, budgetMaxCards * 2),
  );

  if (explicitEntryCount === 0) {
    return {
      maxTotalStartNodes,
      maxTaskTextStartNodes: TASK_TEXT_START_NODE_MAX,
      maxFirstHopPerEntry: ENTRY_FIRST_HOP_MAX_PER_SYMBOL,
      maxSiblingPerEntry: ENTRY_SIBLING_MAX_PER_SYMBOL,
    };
  }

  const hasStrongSignals = Boolean(
    request.stackTrace ||
      request.failingTestPath ||
      (request.editedFiles && request.editedFiles.length > 0),
  );
  const adaptiveTaskBudget = Math.max(2, Math.floor(budgetMaxCards / 5));
  const maxTaskTextStartNodes = hasStrongSignals
    ? Math.min(TASK_TEXT_START_NODE_MAX, Math.min(4, adaptiveTaskBudget))
    : Math.min(TASK_TEXT_START_NODE_MAX, Math.min(8, adaptiveTaskBudget));

  return {
    maxTotalStartNodes,
    maxTaskTextStartNodes,
    maxFirstHopPerEntry: Math.min(ENTRY_FIRST_HOP_MAX_PER_SYMBOL, 2),
    maxSiblingPerEntry: Math.min(ENTRY_SIBLING_MAX_PER_SYMBOL, 1),
  };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i++;
  }
  return i;
}

function extractSymbolsFromStackTrace(
  stackTrace: string,
  repoId: RepoId,
): SymbolId[] {
  const symbols = new Set<SymbolId>();
  const lines = stackTrace.split("\n");

  const filesByRepo = db.getFilesByRepoLite(repoId);
  const filePaths = new Map<string, number>();

  for (const file of filesByRepo) {
    filePaths.set(file.rel_path, file.file_id);
  }

  for (const [path, fileId] of filePaths.entries()) {
    for (const line of lines) {
      if (line.includes(path)) {
        const symbolIds = db.getSymbolIdsByFile(fileId);
        for (const symbolId of symbolIds) {
          symbols.add(symbolId);
        }
        break;
      }
    }
  }

  return Array.from(symbols);
}

function getSymbolsByPath(repoId: RepoId, filePath: string): SymbolId[] {
  const filesByRepo = db.getFilesByRepoLite(repoId);
  const file = filesByRepo.find((f) => f.rel_path === filePath);

  if (!file) return [];

  const symbolIds = db.getSymbolIdsByFile(file.file_id);
  return symbolIds;
}

function beamSearch(
  graph: Graph,
  startNodes: ResolvedStartNode[],
  budget: Required<SliceBudget>,
  request: SliceBuildRequest,
  edgeWeights: Record<EdgeType, number>,
): {
  sliceCards: Set<SymbolId>;
  frontier: FrontierItem[];
  wasTruncated: boolean;
  droppedCandidates: number;
} {
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

  for (const { symbolId, source } of startNodes) {
    if (!visited.has(symbolId) && graph.symbols.has(symbolId)) {
      frontier.insert({
        symbolId,
        score: START_NODE_SOURCE_SCORE[source],
        why: getStartNodeWhy(source),
        priority: START_NODE_SOURCE_PRIORITY[source],
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

  while (!frontier.isEmpty() && sliceCards.size < effectiveCardCap) {
    const current = frontier.extractMin()!;
    const actualScore = -current.score;

    if (sliceCards.size >= effectiveCardCap) {
      wasTruncated = true;
      break;
    }

    if (actualScore < SLICE_SCORE_THRESHOLD) {
      belowThresholdCount++;
      if (belowThresholdCount >= 5) break;
      continue;
    }

    belowThresholdCount = 0;

    sliceCards.add(current.symbolId);
    if (entrySymbols.has(current.symbolId)) {
      coveredEntrySymbols++;
    }
    if (actualScore >= SLICE_SCORE_THRESHOLD + DYNAMIC_CAP_HIGH_CONFIDENCE_MARGIN) {
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
    const neighborIds = outgoing
      .map((e) => e.to_symbol_id)
      .filter((id) => !visited.has(id) && !sliceCards.has(id));

    if (neighborIds.length === 0) continue;

    const neighborsMap = new Map<SymbolId, SymbolRow>();
    for (const id of neighborIds) {
      const symbol = graph.symbols.get(id);
      if (symbol) {
        neighborsMap.set(id, symbol);
      }
    }

    if (neighborsMap.size === 0) continue;

    const metricsMap = db.getMetricsBySymbolIds([...neighborsMap.keys()]);
    const fileIds = new Set([...neighborsMap.values()].map((s) => s.file_id));
    const filesMap = db.getFilesByIds([...fileIds]);

    for (const [neighborId, neighborSymbol] of neighborsMap) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const edge = outgoing.find((e) => e.to_symbol_id === neighborId);
      if (!edge) continue;

      const edgeWeight = edgeWeights[edge.type] ?? 0.5;
      const neighborScore = -(
        scoreSymbolWithMetrics(
          neighborSymbol,
          context,
          metricsMap.get(neighborId) ?? null,
          filesMap.get(neighborSymbol.file_id),
        ) * edgeWeight
      );

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

interface DynamicCapState {
  sliceSize: number;
  minCardsForDynamicCap: number;
  highConfidenceCards: number;
  requiredEntryCoverage: number;
  coveredEntrySymbols: number;
  recentAcceptedScores: number[];
  nextFrontierScore: number | null;
}

function computeMinCardsForDynamicCap(
  budgetMaxCards: number,
  entrySymbolCount: number,
): number {
  const entryFloor = entrySymbolCount > 0 ? entrySymbolCount + 2 : DYNAMIC_CAP_MIN_CARDS;
  return Math.max(
    Math.min(budgetMaxCards, DYNAMIC_CAP_MIN_CARDS),
    Math.min(budgetMaxCards, entryFloor),
  );
}

function shouldTightenDynamicCardCap(state: DynamicCapState): boolean {
  if (state.sliceSize < state.minCardsForDynamicCap) return false;
  if (state.nextFrontierScore === null) return false;
  if (state.recentAcceptedScores.length === 0) return false;

  const highConfidenceRatio = state.highConfidenceCards / Math.max(1, state.sliceSize);
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

function compareFrontierItems(a: FrontierItem, b: FrontierItem): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.sequence - b.sequence;
}

function getStartNodeWhy(source: StartNodeSource): string {
  switch (source) {
    case "entrySymbol":
      return "entry symbol";
    case "entrySibling":
      return "entry sibling";
    case "entryFirstHop":
      return "entry dependency";
    case "stackTrace":
      return "stack trace";
    case "failingTestPath":
      return "failing test";
    case "editedFile":
      return "edited file";
    case "taskText":
      return "task text";
  }
}

function getEdgeWhy(edgeType: EdgeType): string {
  switch (edgeType) {
    case "call":
      return "calls";
    case "import":
      return "imports";
    case "config":
      return "configures";
  }
}

function estimateCardTokens(symbolId: SymbolId, graph: Graph): number {
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

function uniqueLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function toFullCard(card: SymbolCard): SymbolCard {
  const normalized: SymbolCard = {
    ...card,
    detailLevel: "full",
  };
  delete normalized.etag;
  return normalized;
}

function toCompactCard(card: SymbolCard): SymbolCard {
  const compact: SymbolCard = {
    symbolId: card.symbolId,
    repoId: card.repoId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: {
      imports: uniqueLimit(
        card.deps?.imports ?? [],
        SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
      ),
      calls: uniqueLimit(
        card.deps?.calls ?? [],
        SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
      ),
    },
    detailLevel: "compact",
    version: card.version,
  };

  if (card.visibility) {
    compact.visibility = card.visibility;
  }

  if (card.summary) {
    compact.summary = card.summary.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT);
  }

  return compact;
}

export function toSliceSymbolCard(card: SymbolCard): SliceSymbolCard {
  const detailLevel = card.detailLevel ?? "compact";
  const astFingerprint = card.version.astFingerprint.slice(
    0,
    AST_FINGERPRINT_WIRE_LENGTH,
  );
  const sliceCard: SliceSymbolCard = {
    symbolId: card.symbolId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: card.deps,
    detailLevel,
    version: {
      astFingerprint,
    },
  };

  if (card.visibility) {
    sliceCard.visibility = card.visibility;
  }

  if (card.signature) {
    sliceCard.signature = card.signature;
  }

  if (card.summary) {
    sliceCard.summary = card.summary;
  }

  if (card.invariants && card.invariants.length > 0) {
    sliceCard.invariants = card.invariants;
  }

  if (card.sideEffects && card.sideEffects.length > 0) {
    sliceCard.sideEffects = card.sideEffects;
  }

  if (card.metrics) {
    sliceCard.metrics = card.metrics;
  }

  return sliceCard;
}

async function loadSymbolCards(
  symbolIds: SymbolId[],
  versionId: VersionId,
  repoId: RepoId,
  detailedSymbolIds?: Set<SymbolId>,
): Promise<SymbolCard[]> {
  if (symbolIds.length === 0) return [];

  const config = loadConfig();
  const cacheConfig = config.cache;
  const cacheEnabled = cacheConfig?.enabled ?? true;

  const cards: SymbolCard[] = [];
  const uncachedSymbolIds: SymbolId[] = [];
  const detailBySymbolId = new Map<SymbolId, boolean>();

  for (const symbolId of symbolIds) {
    const isDetailed = detailedSymbolIds?.has(symbolId) ?? false;
    detailBySymbolId.set(symbolId, isDetailed);
  }

  if (cacheEnabled) {
    for (const symbolId of symbolIds) {
      const isDetailed = detailBySymbolId.get(symbolId) ?? false;
      const cachedCard = symbolCardCache.get(repoId, symbolId, versionId);

      if (!cachedCard) {
        uncachedSymbolIds.push(symbolId);
        continue;
      }

      if (isDetailed) {
        if (cachedCard.detailLevel === "compact") {
          uncachedSymbolIds.push(symbolId);
          continue;
        }
        cards.push(toFullCard(cachedCard));
        continue;
      }

      cards.push(toCompactCard(cachedCard));
    }
  } else {
    uncachedSymbolIds.push(...symbolIds);
  }

  if (uncachedSymbolIds.length === 0) {
    return cards;
  }

  uncachedSymbolIds.sort();

  // Batch fetch all symbols (1 query instead of N)
  const symbolsMap = db.getSymbolsByIds(uncachedSymbolIds);

  // Collect unique file IDs and batch fetch files (1 query instead of N)
  const fileIds = new Set<number>();
  for (const symbol of symbolsMap.values()) {
    fileIds.add(symbol.file_id);
  }
  const filesMap = db.getFilesByIds([...fileIds]);

  // Batch fetch all metrics (1 query instead of N)
  const metricsMap = db.getMetricsBySymbolIds(uncachedSymbolIds);

  // Batch fetch all outgoing edges (1 query instead of N)
  const edgesMap = db.getEdgesFromSymbols(uncachedSymbolIds);

  // Collect all imported symbol IDs to batch fetch their names
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
  // Batch fetch imported symbols for name lookup (lite version - only name needed)
  const importedSymbolsMap = db.getSymbolsByIdsLite([...importedSymbolIds]);
  const calledSymbolsMap = db.getSymbolsByIdsLite([...calledSymbolIds]);

  // Build cards using pre-fetched data
  for (const symbolId of uncachedSymbolIds) {
    const symbolRow = symbolsMap.get(symbolId);
    if (!symbolRow) continue;
    const isDetailed = detailBySymbolId.get(symbolId) ?? false;

    const file = filesMap.get(symbolRow.file_id);
    const metrics = metricsMap.get(symbolId);
    const outgoingEdges = edgesMap.get(symbolId) ?? [];

    const importDeps: string[] = [];
    const callDeps: string[] = [];

    for (const edge of outgoingEdges) {
      if (edge.type === "import") {
        const importedSymbol = importedSymbolsMap.get(edge.to_symbol_id);
        const depLabel = pickDepLabel(edge.to_symbol_id, importedSymbol?.name);
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

    const depLimit = isDetailed
      ? SYMBOL_CARD_MAX_DEPS_PER_KIND
      : SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT;
    const deps = {
      imports: uniqueLimit(importDeps, depLimit),
      calls: uniqueLimit(callDeps, depLimit),
    };

    let signature;
    if (isDetailed && symbolRow.signature_json) {
      try {
        signature = JSON.parse(symbolRow.signature_json);
      } catch (error) {
        // Log parse failure but continue with fallback
        process.stderr.write(
          `[sdl-mcp] Failed to parse signature_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        signature = { name: symbolRow.name };
      }
    } else if (isDetailed) {
      signature = { name: symbolRow.name };
    }

    let invariants: string[] | undefined;
    if (symbolRow.invariants_json) {
      try {
        const parsed = JSON.parse(symbolRow.invariants_json);
        invariants = parsed.slice(
          0,
          isDetailed
            ? SYMBOL_CARD_MAX_INVARIANTS
            : SYMBOL_CARD_MAX_INVARIANTS_LIGHT,
        );
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to parse invariants_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    let sideEffects: string[] | undefined;
    if (symbolRow.side_effects_json) {
      try {
        const parsed = JSON.parse(symbolRow.side_effects_json);
        sideEffects = parsed.slice(
          0,
          isDetailed
            ? SYMBOL_CARD_MAX_SIDE_EFFECTS
            : SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT,
        );
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Failed to parse side_effects_json for symbol ${symbolId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }

    let metricsData;
    if (isDetailed && metrics) {
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
      signature: isDetailed ? signature : undefined,
      summary: symbolRow.summary
        ? symbolRow.summary.slice(
            0,
            isDetailed
              ? SYMBOL_CARD_SUMMARY_MAX_CHARS
              : SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
          )
        : undefined,
      invariants: invariants && invariants.length > 0 ? invariants : undefined,
      sideEffects: sideEffects && sideEffects.length > 0 ? sideEffects : undefined,
      deps,
      metrics: isDetailed ? metricsData : undefined,
      detailLevel: isDetailed ? "full" : "compact",
      version: {
        ledgerVersion: versionId,
        astFingerprint: symbolRow.ast_fingerprint,
      },
    };

    const card = isDetailed ? toFullCard(baseCard) : toCompactCard(baseCard);
    cards.push(card);

    // Only full cards go into the shared symbol cache; compact cards can
    // otherwise leak into symbol.getCard responses.
    if (cacheEnabled && isDetailed) {
      await symbolCardCache.set(
        repoId,
        symbolRow.symbol_id,
        versionId,
        toFullCard(card),
      );
    }
  }

  return cards;
}

function loadEdgesBetweenSymbols(
  symbolIds: SymbolId[],
  _repoId: RepoId,
): { symbolIndex: SymbolId[]; edges: CompressedEdge[] } {
  if (symbolIds.length === 0) {
    return {
      symbolIndex: [],
      edges: [],
    };
  }

  const symbolSet = new Set(symbolIds);
  const dbEdges: Array<{
    from_symbol_id: SymbolId;
    to_symbol_id: SymbolId;
    type: EdgeType;
    weight: number;
  }> = [];

  // Batch fetch all outgoing edges (1 query instead of N)
  const edgesMap = db.getEdgesFromSymbols(symbolIds);

  for (const [_fromId, outgoing] of edgesMap) {
    for (const edge of outgoing) {
      if (symbolSet.has(edge.to_symbol_id)) {
        dbEdges.push(edge);
      }
    }
  }

  return encodeEdgesWithSymbolIndex(symbolIds, dbEdges);
}

export function encodeEdgesWithSymbolIndex(
  symbolIds: SymbolId[],
  dbEdges: ReadonlyArray<{
    from_symbol_id: SymbolId;
    to_symbol_id: SymbolId;
    type: EdgeType;
    weight: number;
  }>,
): { symbolIndex: SymbolId[]; edges: CompressedEdge[] } {
  const symbolIndex = Array.from(new Set(symbolIds)).sort();
  const symbolPosition = new Map<SymbolId, number>();

  for (const [index, symbolId] of symbolIndex.entries()) {
    symbolPosition.set(symbolId, index);
  }

  const edges: CompressedEdge[] = [];
  for (const edge of dbEdges) {
    const fromIndex = symbolPosition.get(edge.from_symbol_id);
    const toIndex = symbolPosition.get(edge.to_symbol_id);
    if (fromIndex === undefined || toIndex === undefined) continue;
    edges.push([fromIndex, toIndex, edge.type, edge.weight]);
  }

  return {
    symbolIndex,
    edges,
  };
}

export function estimateTokens(cards: Array<SymbolCard | SliceSymbolCard>): number {
  let total = 0;

  for (const card of cards) {
    let cardTokens = SYMBOL_TOKEN_BASE;

    cardTokens += estimateTextTokens(card.name);
    cardTokens += estimateTextTokens(card.file);

    if (card.signature) {
      const sigText = JSON.stringify(card.signature);
      cardTokens += estimateTextTokens(sigText);
    }

    if (card.summary) {
      cardTokens += Math.min(
        estimateTextTokens(card.summary),
        SYMBOL_TOKEN_ADDITIONAL_MAX,
      );
    }

    cardTokens += card.deps.imports.length * 5;
    cardTokens += card.deps.calls.length * 5;

    if (card.invariants) {
      for (const invariant of card.invariants) {
        cardTokens += estimateTextTokens(invariant);
      }
    }

    if (card.sideEffects) {
      for (const effect of card.sideEffects) {
        cardTokens += estimateTextTokens(effect);
      }
    }

    cardTokens = Math.min(cardTokens, SYMBOL_TOKEN_MAX);
    total += cardTokens;
  }

  return total;
}

export type { SliceBuildRequest, FrontierItem };
