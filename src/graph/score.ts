import type { SymbolRow, MetricsRow, FileRow } from "../db/schema.js";
import {
  CLUSTER_COHESION_RELATED_BOOST,
  CLUSTER_COHESION_SAME_BOOST,
} from "../config/constants.js";
import { tokenize } from "../util/tokenize.js";

export interface SliceContext {
  query: string;
  queryTokens?: string[];
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: string[];
  edgeWeights?: {
    call: number;
    import: number;
    config: number;
  };
}

export interface ScoreResult {
  symbolId: string;
  score: number;
  factors: Map<string, number>;
}

export function calculateHotness(metrics: MetricsRow | null): number {
  if (!metrics) return 0;

  const normalizeLog = (value: number, max: number): number => {
    if (value <= 0) return 0;
    return Math.min(Math.log(value + 1) / Math.log(max + 1), 1);
  };

  const normalizeLinear = (value: number, max: number): number => {
    if (max <= 0) return 0;
    return Math.min(value / max, 1);
  };

  const fanInScore = normalizeLog(metrics.fan_in, 100);
  const fanOutScore = normalizeLog(metrics.fan_out, 50);
  const churnScore = normalizeLinear(metrics.churn_30d, 20);

  return 0.5 * fanInScore + 0.3 * fanOutScore + 0.2 * churnScore;
}

export function scoreSymbol(
  symbol: SymbolRow,
  context: SliceContext,
  metrics: MetricsRow | null = null,
  file?: FileRow,
): number {
  return scoreSymbolWithMetrics(symbol, context, metrics, file);
}

export function scoreSymbolWithMetrics(
  symbol: SymbolRow,
  context: SliceContext,
  metrics: MetricsRow | null,
  file: FileRow | undefined,
): number {
  const factors = new Map<string, number>();

  factors.set(
    "query",
    calculateQueryOverlapWithFile(
      symbol,
      context.query,
      context.queryTokens,
      file,
    ),
  );
  factors.set(
    "stacktrace",
    calculateStacktraceLocalityWithFile(symbol, context.stackTrace || "", file),
  );
  factors.set("structure", calculateStructuralSpecificity(file));
  factors.set("kind", calculateSymbolKindSpecificity(symbol));

  const weights = new Map<string, number>([
    ["query", 0.4],
    ["stacktrace", 0.2],
    ["hotness", 0.15],
    ["structure", 0.15],
    ["kind", 0.1],
  ]);

  factors.set("hotness", calculateHotness(metrics));

  return combineScores(factors, weights);
}

function calculateQueryOverlapWithFile(
  symbol: SymbolRow,
  query: string,
  queryTokens?: string[],
  file?: FileRow,
): number {
  const tokens = queryTokens ?? tokenize(query);
  if (tokens.length === 0) return 0;

  const symbolName = symbol.name.toLowerCase();
  const filePath = file?.rel_path.toLowerCase() || "";

  let weightedMatches = 0;
  for (const token of tokens) {
    if (symbolName === token) {
      weightedMatches += 1.25;
      continue;
    }
    if (symbolName.startsWith(token)) {
      weightedMatches += 1.0;
      continue;
    }
    if (symbolName.includes(token)) {
      weightedMatches += 0.75;
      continue;
    }
    if (filePath.includes(token)) {
      weightedMatches += 0.4;
    }
  }

  return Math.min(weightedMatches / tokens.length, 1);
}

function calculateStacktraceLocalityWithFile(
  symbol: SymbolRow,
  stackTrace: string,
  file?: FileRow,
): number {
  if (!stackTrace) return 0;

  const lines = stackTrace.split("\n");
  const filePath = file?.rel_path || "";
  const symbolRange = {
    startLine: symbol.range_start_line,
    endLine: symbol.range_end_line,
  };

  for (const line of lines) {
    if (line.includes(filePath)) {
      const lineMatch = line.match(/:(\d+)(?::(\d+))?/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1], 10);
        if (
          lineNum >= symbolRange.startLine &&
          lineNum <= symbolRange.endLine
        ) {
          return 1;
        }
      }
      return 0.5;
    }
  }

  return 0;
}

function calculateStructuralSpecificity(file?: FileRow): number {
  if (!file?.rel_path) return 0.8;

  const relPath = file.rel_path.toLowerCase();
  let specificity = 1;

  if (
    relPath.includes("/tests/") ||
    relPath.startsWith("tests/") ||
    relPath.includes("dist-tests/") ||
    relPath.includes(".test.") ||
    relPath.includes(".spec.")
  ) {
    specificity *= 0.55;
  }

  if (
    relPath.startsWith("dist/") ||
    relPath.includes("/dist/") ||
    relPath.startsWith("dist-tests/")
  ) {
    specificity *= 0.6;
  }

  if (relPath.startsWith("scripts/")) {
    specificity *= 0.75;
  }

  if (
    relPath.includes("/target/") ||
    relPath.startsWith("target/") ||
    relPath.includes("/vendor/") ||
    relPath.startsWith("vendor/")
  ) {
    specificity *= 0.3;
  }

  if (relPath.endsWith(".min.js") || relPath.endsWith(".min.css")) {
    specificity *= 0.2;
  }

  if (/(^|\/)(index|tools|types|main|mod|util|utils)\.[^.]+$/.test(relPath)) {
    specificity *= 0.72;
  }

  if (/(^|\/)mcp\/tools\.[^.]+$/.test(relPath)) {
    specificity *= 0.65;
  }

  return Math.max(0.15, Math.min(1, specificity));
}

function calculateSymbolKindSpecificity(symbol: SymbolRow): number {
  switch (symbol.kind) {
    case "class":
      return 1;
    case "function":
      return 0.98;
    case "method":
      return 0.95;
    case "interface":
      return 0.9;
    case "type":
      return 0.88;
    case "constructor":
      return 0.8;
    case "module":
      return 0.7;
    case "variable":
    default:
      return 0.55;
  }
}

export function combineScores(
  scores: Map<string, number>,
  weights: Map<string, number>,
): number {
  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, score] of scores.entries()) {
    const weight = weights.get(key) ?? 0;
    totalScore += score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

export function calculateClusterCohesion(params: {
  symbolClusterId: string | null | undefined;
  entryClusterIds: ReadonlySet<string>;
  relatedClusterIds: ReadonlySet<string>;
}): number {
  const { symbolClusterId, entryClusterIds, relatedClusterIds } = params;
  if (!symbolClusterId) return 0;
  if (entryClusterIds.has(symbolClusterId)) return CLUSTER_COHESION_SAME_BOOST;
  if (relatedClusterIds.has(symbolClusterId)) {
    return CLUSTER_COHESION_RELATED_BOOST;
  }
  return 0;
}

/**
 * Centrality tie-break epsilon. When two candidates have scores within
 * this margin, the centrality signal is used as a bounded tie-breaker.
 * Kept intentionally small so centrality cannot dominate the primary
 * relevance score.
 */
export const CENTRALITY_TIEBREAK_EPSILON = 0.001;

/**
 * Per-repo normalization stats for centrality metrics.
 * Computed once per beam-search / memory-surfacing run and reused.
 */
export interface CentralityStats {
  maxPageRank: number;
  maxKCore: number;
}

/**
 * Derive per-repo normalization stats from a map of metrics rows.
 * Accepts any object shape that exposes pageRank / kCore (camelCase)
 * OR page_rank / k_core (snake_case legacy MetricsRow).
 */
export function computeCentralityStats(
  entries: Iterable<{
    pageRank?: number | null;
    kCore?: number | null;
    page_rank?: number | null;
    k_core?: number | null;
  }>,
): CentralityStats {
  let maxPageRank = 0;
  let maxKCore = 0;
  for (const entry of entries) {
    const pr = entry.pageRank ?? entry.page_rank ?? 0;
    const kc = entry.kCore ?? entry.k_core ?? 0;
    if (pr > maxPageRank) maxPageRank = pr;
    if (kc > maxKCore) maxKCore = kc;
  }
  return { maxPageRank, maxKCore };
}

/**
 * Normalize a centrality component to [0, 1] given a per-repo max.
 * Returns 0 when max is <= 0 or value is missing.
 */
export function normalizeCentrality(
  value: number | null | undefined,
  max: number,
): number {
  if (max <= 0) return 0;
  const v = value ?? 0;
  if (v <= 0) return 0;
  return Math.min(v / max, 1);
}

/**
 * Combine PageRank and K-core into a single centrality signal in [0, 1].
 * centralitySignal = 0.6 * normalizedPageRank + 0.4 * normalizedKCore
 */
export function computeCentralitySignal(
  pageRank: number | null | undefined,
  kCore: number | null | undefined,
  stats: CentralityStats,
): number {
  const prNorm = normalizeCentrality(pageRank, stats.maxPageRank);
  const kcNorm = normalizeCentrality(kCore, stats.maxKCore);
  return 0.6 * prNorm + 0.4 * kcNorm;
}

/**
 * Compute shadow hotnessV2 = 0.75 * currentHotness + 0.25 * centralitySignal.
 * Kept shadow-only in v1: the beam search does not promote this to the
 * primary hotness factor yet. Exposed here for telemetry / future promotion.
 */
export function computeHotnessV2(
  currentHotness: number,
  centralitySignal: number,
): number {
  const h = Number.isFinite(currentHotness) ? currentHotness : 0;
  const c = Number.isFinite(centralitySignal) ? centralitySignal : 0;
  return 0.75 * h + 0.25 * c;
}

/**
 * Apply a bounded centrality tie-break to a primary score. The tie-break
 * can never exceed CENTRALITY_TIEBREAK_EPSILON, so ordering is preserved
 * when primary score deltas are larger than that margin.
 *
 * When centralitySignal is 0 or not a finite number, the primary score is
 * returned unchanged — this guarantees that existing orderings are stable
 * for repos that have no centrality data.
 */
export function applyCentralityTiebreak(
  score: number,
  centralitySignal: number | null | undefined,
): number {
  const c = centralitySignal ?? 0;
  if (!Number.isFinite(c) || c <= 0) return score;
  return score + CENTRALITY_TIEBREAK_EPSILON * Math.min(c, 1);
}

export interface CentralityAwareScoreResult {
  /**
   * Primary relevance score before the bounded centrality tie-break is applied.
   * Callers should apply the tie-break only after edge-weight / cohesion math
   * so centrality remains strictly secondary to the established ranking terms.
   */
  primaryScore: number;
  centralitySignal: number;
  hotnessV2: number;
}

export function scoreSymbolWithCentralityContext(
  symbol: SymbolRow,
  context: SliceContext,
  metrics: MetricsRow | null,
  file: FileRow | undefined,
  stats: CentralityStats,
): CentralityAwareScoreResult {
  const primaryScore = scoreSymbolWithMetrics(symbol, context, metrics, file);
  const centralitySignal = metrics
    ? computeCentralitySignal(metrics.page_rank, metrics.k_core, stats)
    : 0;

  return {
    primaryScore,
    centralitySignal,
    // Shadow-only today, but computed here so the production scorers and the
    // pure helper tests exercise the same centrality path.
    hotnessV2: computeHotnessV2(calculateHotness(metrics), centralitySignal),
  };
}

/**
 * Deterministic comparator for two candidates with optional centrality
 * signals. Primary key: score (desc). Secondary key: centrality signal
 * when score deltas are within CENTRALITY_TIEBREAK_EPSILON.
 * Returns negative when `a` should come first, positive otherwise.
 */
export function compareScoresWithCentrality(
  a: { score: number; centralitySignal?: number },
  b: { score: number; centralitySignal?: number },
): number {
  const delta = b.score - a.score;
  if (Math.abs(delta) > CENTRALITY_TIEBREAK_EPSILON) return delta;
  const aC = a.centralitySignal ?? 0;
  const bC = b.centralitySignal ?? 0;
  return bC - aC;
}
