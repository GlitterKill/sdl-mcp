import type { SymbolRow, MetricsRow, FileRow } from "../db/schema.js";
import { tokenize } from "../util/tokenize.js";
import * as db from "../db/queries.js";

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

export function calculateQueryOverlap(
  symbol: SymbolRow,
  query: string,
  queryTokens?: string[],
): number {
  const tokens = queryTokens ?? tokenize(query);
  if (tokens.length === 0) return 0;

  const symbolName = symbol.name.toLowerCase();
  const file = db.getFile(symbol.file_id);
  const filePath = file?.rel_path.toLowerCase() || "";

  let matches = 0;
  for (const token of tokens) {
    if (symbolName.includes(token) || filePath.includes(token)) {
      matches++;
    }
  }

  return matches / tokens.length;
}

export function calculateStacktraceLocality(
  symbol: SymbolRow,
  stackTrace: string,
): number {
  if (!stackTrace) return 0;

  const lines = stackTrace.split("\n");
  const file = db.getFile(symbol.file_id);
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

export function calculateHotness(metrics: MetricsRow | null): number {
  if (!metrics) return 0;

  const normalizeLog = (value: number, max: number): number => {
    if (value <= 0) return 0;
    return Math.min(Math.log(value + 1) / Math.log(max + 1), 1);
  };

  const normalizeLinear = (value: number, max: number): number => {
    return Math.min(value / max, 1);
  };

  const fanInScore = normalizeLog(metrics.fan_in, 100);
  const fanOutScore = normalizeLog(metrics.fan_out, 50);
  const churnScore = normalizeLinear(metrics.churn_30d, 20);

  return 0.5 * fanInScore + 0.3 * fanOutScore + 0.2 * churnScore;
}

export function scoreSymbol(symbol: SymbolRow, context: SliceContext): number {
  const factors = new Map<string, number>();

  factors.set(
    "query",
    calculateQueryOverlap(symbol, context.query, context.queryTokens),
  );
  factors.set(
    "stacktrace",
    calculateStacktraceLocality(symbol, context.stackTrace || ""),
  );

  const weights = new Map<string, number>([
    ["query", 0.4],
    ["stacktrace", 0.3],
    ["hotness", 0.3],
  ]);

  const metrics = db.getMetrics(symbol.symbol_id);
  factors.set("hotness", calculateHotness(metrics));

  return combineScores(factors, weights);
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

  const weights = new Map<string, number>([
    ["query", 0.4],
    ["stacktrace", 0.3],
    ["hotness", 0.3],
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

  let matches = 0;
  for (const token of tokens) {
    if (symbolName.includes(token) || filePath.includes(token)) {
      matches++;
    }
  }

  return matches / tokens.length;
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

export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  if (scores.length === 1) return [1];

  const min = Math.min(...scores);
  const max = Math.max(...scores);

  if (min === max) {
    return scores.map(() => 0.5);
  }

  return scores.map((score) => (score - min) / (max - min));
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
