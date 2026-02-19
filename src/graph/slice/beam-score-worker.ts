import { parentPort } from "worker_threads";
import type { SymbolRow, MetricsRow, FileRow } from "../../db/schema.js";
import type { SliceContext } from "../score.js";

export interface ScoreCandidate {
  symbolId: string;
  neighborSymbol: SymbolRow;
  edgeWeight: number;
}

export interface ScoreWorkerInput {
  candidates: ScoreCandidate[];
  context: SliceContext;
  metricsMap: Record<string, MetricsRow | null>;
  filesMap: Record<number, FileRow | undefined>;
  scoreThreshold: number;
}

export interface ScoreWorkerOutput {
  results: Array<{
    symbolId: string;
    score: number;
    passed: boolean;
  }>;
  error?: string;
}

function calculateQueryOverlapWithFile(
  symbol: SymbolRow,
  query: string,
  queryTokens: string[] | undefined,
  file: FileRow | undefined,
): number {
  const tokens =
    queryTokens ??
    (query
      ? query
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(/\s+/)
          .filter((t) => t.length > 0)
      : []);
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
  file: FileRow | undefined,
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

function calculateStructuralSpecificity(file: FileRow | undefined): number {
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

function calculateHotness(metrics: MetricsRow | null): number {
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

function scoreSymbolWithMetrics(
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

  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, score] of factors.entries()) {
    const weight = weights.get(key) ?? 0;
    totalScore += score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

parentPort?.on("message", (msg: ScoreWorkerInput) => {
  try {
    const results: ScoreWorkerOutput["results"] = [];

    for (const candidate of msg.candidates) {
      const baseScore = scoreSymbolWithMetrics(
        candidate.neighborSymbol,
        msg.context,
        msg.metricsMap[candidate.symbolId] ?? null,
        msg.filesMap[candidate.neighborSymbol.file_id],
      );

      const finalScore = baseScore * candidate.edgeWeight;
      const passed = finalScore >= msg.scoreThreshold;

      results.push({
        symbolId: candidate.symbolId,
        score: finalScore,
        passed,
      });
    }

    const output: ScoreWorkerOutput = { results };
    parentPort?.postMessage(output);
  } catch (error) {
    const output: ScoreWorkerOutput = {
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort?.postMessage(output);
  }
});
