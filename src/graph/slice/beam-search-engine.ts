/**
 * Beam Search Engine Module
 *
 * Implements beam search traversal for graph slice construction.
 * Manages frontier exploration, scoring, and dynamic card cap adjustments.
 *
 * @module graph/slice/beam-search-engine
 */

import type { SymbolId, EdgeType, SymbolRow } from "../../db/schema.js";
import type { SliceBudget } from "../../mcp/types.js";
import type { Graph } from "../buildGraph.js";
import type { ResolvedStartNode } from "./start-node-resolver.js";
import type {
  ScoreCandidate,
  ScoreWorkerInput,
  ScoreWorkerOutput,
} from "./beam-score-worker.js";
import {
  START_NODE_SOURCE_SCORE,
  getStartNodeWhy,
} from "./start-node-resolver.js";
import { scoreSymbolWithMetrics, SliceContext } from "../score.js";
import * as db from "../../db/queries.js";
import { MinHeap } from "../minHeap.js";
import { logger } from "../../util/logger.js";
import { findPackageRoot } from "../../util/findPackageRoot.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Worker } from "worker_threads";
import * as os from "os";
import {
  SLICE_SCORE_THRESHOLD,
  MAX_FRONTIER,
  SYMBOL_TOKEN_BASE,
  TOKENS_PER_CHAR_ESTIMATE,
  SYMBOL_TOKEN_ADDITIONAL_MAX,
} from "../../config/constants.js";

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

    const metricsMap = db.getMetricsBySymbolIds([...neighborsMap.keys()]);
    const fileIds = new Set([...neighborsMap.values()].map((s) => s.file_id));
    const filesMap = db.getFilesByIds([...fileIds]);

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
    globalScorerPool.shutdown().catch(() => {});
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

    const metricsMap = db.getMetricsBySymbolIds([...neighborsMap.keys()]);
    const fileIds = new Set([...neighborsMap.values()].map((s) => s.file_id));
    const filesMap = db.getFilesByIds([...fileIds]);

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
