#!/usr/bin/env tsx
/**
 * SDL-MCP Synthetic Benchmark (Replay-Trace Based)
 *
 * This benchmark summarizes token reduction from replay traces generated
 * from the real-world benchmark output.
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark -- --repo-id my-repo
 *   npm run benchmark -- --trace-file benchmarks/synthetic/replay-traces.json
 *   npm run benchmark -- --json
 *   npm run benchmark -- --out benchmarks/synthetic/results.json
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";

interface ReplayTrace {
  id: string;
  scenario: string;
  traditional: {
    description: string;
    tokens: number;
  };
  sdlMcp: {
    description: string;
    tokens: number;
  };
  qualifier?: string;
  sourceTaskId?: string;
  sourceRepoId?: string;
}

interface ReplayTraceFile {
  version: number;
  generatedAt: string;
  source?: {
    inputFile?: string;
    benchmarkGeneratedAt?: string;
  };
  traces: ReplayTrace[];
}

interface TokenAnalysis {
  scenario: string;
  traditional: {
    description: string;
    tokens: number;
  };
  sdlMcp: {
    description: string;
    tokens: number;
  };
  reduction: number;
  compressionRatio: number;
  winner: "SDL-MCP" | "Traditional" | "Tie";
  qualifier?: string;
}

interface SyntheticSummary {
  traceCount: number;
  avgReductionPct: number;
  p25ReductionPct: number;
  p50ReductionPct: number;
  minReductionPct: number;
  maxReductionPct: number;
  avgCompressionRatio: number;
  sdlWins: number;
  traditionalWins: number;
  ties: number;
}

interface BenchmarkResult {
  benchmarkVersion: string;
  generatedAt: string;
  repoId: string;
  traceSource: {
    path: string;
    generatedAt: string;
    sourceInputFile?: string;
  };
  summary: SyntheticSummary;
  tokenAnalysis: TokenAnalysis[];
  recommendations: string[];
}

const DEFAULT_REPLAY_TRACE_PATH = "benchmarks/synthetic/replay-traces.json";
const DEFAULT_REAL_WORLD_RESULTS_CURRENT =
  "benchmarks/real-world/results-current.json";
const DEFAULT_CONFIG_PATH = "config/sdlmcp.config.json";
const REPLAY_TRACE_STALE_DAYS = 7;
const REPLAY_TRACE_REFRESH_COMMAND =
  "npm run benchmark:record-trace -- --input benchmarks/real-world/results-current.json --tasks benchmarks/real-world/tasks.json --out benchmarks/synthetic/replay-traces.json";

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function normalizePathForCompare(filePath: string): string {
  return resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function warnReplayTraceStaleness(
  traceFilePath: string,
  payload: ReplayTraceFile,
): void {
  const expectedSourcePath = resolve(DEFAULT_REAL_WORLD_RESULTS_CURRENT);
  const sourceInputPath = payload.source?.inputFile
    ? resolve(payload.source.inputFile)
    : undefined;

  if (
    sourceInputPath &&
    normalizePathForCompare(sourceInputPath) !==
      normalizePathForCompare(expectedSourcePath)
  ) {
    console.warn(
      `Warning: replay traces were generated from "${sourceInputPath}" instead of ` +
        `"${expectedSourcePath}". Rebuild with: ${REPLAY_TRACE_REFRESH_COMMAND}`,
    );
  }

  const generatedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    console.warn(
      `Warning: replay trace file "${traceFilePath}" has an invalid generatedAt timestamp.`,
    );
    return;
  }

  const staleThresholdMs = REPLAY_TRACE_STALE_DAYS * 24 * 60 * 60 * 1000;
  const ageMs = Date.now() - generatedAtMs;
  if (ageMs > staleThresholdMs) {
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    console.warn(
      `Warning: replay traces are ${ageDays} day(s) old. Rebuild with: ${REPLAY_TRACE_REFRESH_COMMAND}`,
    );
  }

  if (!existsSync(expectedSourcePath)) return;
  const sourceStats = statSync(expectedSourcePath);
  if (sourceStats.mtimeMs > generatedAtMs + 1000) {
    console.warn(
      `Warning: replay traces were generated before "${expectedSourcePath}" was updated. ` +
        `Rebuild with: ${REPLAY_TRACE_REFRESH_COMMAND}`,
    );
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferRepoId(configPath: string): string {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) return "my-repo";
  const payload = JSON.parse(readFileSync(resolved, "utf-8")) as {
    repos?: Array<{ repoId?: string }>;
  };
  return payload.repos?.[0]?.repoId ?? "my-repo";
}

function loadReplayTraces(
  traceFilePath: string,
  repoId: string,
): {
  resolvedPath: string;
  payload: ReplayTraceFile;
  traces: ReplayTrace[];
} {
  const resolvedPath = resolve(traceFilePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Replay trace file not found: ${resolvedPath}. ` +
        `Generate it with: ${REPLAY_TRACE_REFRESH_COMMAND}`,
    );
  }

  const raw = readFileSync(resolvedPath, "utf-8");
  const payload = JSON.parse(raw) as ReplayTraceFile;
  warnReplayTraceStaleness(resolvedPath, payload);

  const repoScoped = payload.traces.filter(
    (trace) => !trace.sourceRepoId || trace.sourceRepoId === repoId,
  );
  if (repoScoped.length > 0) {
    return { resolvedPath, payload, traces: repoScoped };
  }

  const traceRepoIds = [
    ...new Set(payload.traces.map((trace) => trace.sourceRepoId).filter(Boolean)),
  ];
  console.warn(
    `Warning: no replay traces found for repo "${repoId}". Falling back to all traces ` +
      `(source repos: ${traceRepoIds.join(", ") || "unknown"}).`,
  );
  return { resolvedPath, payload, traces: payload.traces };
}

function buildTokenAnalysis(trace: ReplayTrace): TokenAnalysis {
  const traditionalTokens = Math.max(0, Math.round(trace.traditional.tokens));
  const sdlTokens = Math.max(0, Math.round(trace.sdlMcp.tokens));
  const reduction =
    traditionalTokens > 0
      ? ((traditionalTokens - sdlTokens) / traditionalTokens) * 100
      : 0;
  const compressionRatio =
    sdlTokens > 0 ? traditionalTokens / sdlTokens : traditionalTokens > 0 ? Infinity : 1;
  const winner: TokenAnalysis["winner"] =
    sdlTokens < traditionalTokens
      ? "SDL-MCP"
      : traditionalTokens < sdlTokens
        ? "Traditional"
        : "Tie";

  return {
    scenario: trace.scenario,
    traditional: {
      description: trace.traditional.description,
      tokens: traditionalTokens,
    },
    sdlMcp: {
      description: trace.sdlMcp.description,
      tokens: sdlTokens,
    },
    reduction,
    compressionRatio,
    winner,
    qualifier: trace.qualifier,
  };
}

function buildRecommendations(summary: SyntheticSummary): string[] {
  const recommendations: string[] = [];
  if (summary.avgReductionPct < 50) {
    recommendations.push(
      "Average synthetic reduction is below 50%; consider using --mode efficient in real-world benchmarks and regenerating replay traces.",
    );
  }
  if (summary.p25ReductionPct < 30) {
    recommendations.push(
      "Lower quartile tasks are under 30% reduction; inspect task-specific slice/card payload size and tune card detail/budgets.",
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Synthetic benchmark is healthy; keep replay traces fresh and track p25 reductions for regression detection.",
    );
  }
  return recommendations;
}

function printSummary(repoId: string, summary: SyntheticSummary): void {
  console.log("\nSDL-MCP SYNTHETIC BENCHMARK (REPLAY TRACES)");
  console.log("------------------------------------------------------------");
  console.log(`Repo:                      ${repoId}`);
  console.log(`Replay traces:             ${summary.traceCount}`);
  console.log(`Average token reduction:   ${summary.avgReductionPct.toFixed(2)}%`);
  console.log(`p25 / p50 reduction:       ${summary.p25ReductionPct.toFixed(2)}% / ${summary.p50ReductionPct.toFixed(2)}%`);
  console.log(`Min / max reduction:       ${summary.minReductionPct.toFixed(2)}% / ${summary.maxReductionPct.toFixed(2)}%`);
  console.log(`Average compression:       ${summary.avgCompressionRatio.toFixed(2)}x`);
  console.log(`Winners (SDL/Trad/Tie):    ${summary.sdlWins}/${summary.traditionalWins}/${summary.ties}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const traceFilePath = getArgValue(args, "trace-file") ?? DEFAULT_REPLAY_TRACE_PATH;
  const configPath = getArgValue(args, "config") ?? DEFAULT_CONFIG_PATH;
  const repoId = getArgValue(args, "repo-id") ?? inferRepoId(configPath);
  const outPath = getArgValue(args, "out");
  const jsonOutput = hasFlag(args, "json");

  const loaded = loadReplayTraces(traceFilePath, repoId);
  const analysis = loaded.traces.map((trace) => buildTokenAnalysis(trace));
  const reductions = analysis.map((item) => item.reduction);
  const compressions = analysis.map((item) => item.compressionRatio);

  const summary: SyntheticSummary = {
    traceCount: analysis.length,
    avgReductionPct: average(reductions),
    p25ReductionPct: percentile(reductions, 25),
    p50ReductionPct: percentile(reductions, 50),
    minReductionPct: reductions.length > 0 ? Math.min(...reductions) : 0,
    maxReductionPct: reductions.length > 0 ? Math.max(...reductions) : 0,
    avgCompressionRatio: average(compressions),
    sdlWins: analysis.filter((item) => item.winner === "SDL-MCP").length,
    traditionalWins: analysis.filter((item) => item.winner === "Traditional").length,
    ties: analysis.filter((item) => item.winner === "Tie").length,
  };

  const result: BenchmarkResult = {
    benchmarkVersion: "3.0-replay",
    generatedAt: new Date().toISOString(),
    repoId,
    traceSource: {
      path: loaded.resolvedPath,
      generatedAt: loaded.payload.generatedAt,
      sourceInputFile: loaded.payload.source?.inputFile,
    },
    summary,
    tokenAnalysis: analysis,
    recommendations: buildRecommendations(summary),
  };

  printSummary(repoId, summary);

  if (outPath) {
    const resolvedOutPath = resolve(outPath);
    writeFileSync(resolvedOutPath, JSON.stringify(result, null, 2), "utf-8");
    console.log(`\nResults written to ${resolvedOutPath}`);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  }
}

try {
  main();
} catch (error) {
  console.error(
    `Synthetic benchmark failed: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
}
