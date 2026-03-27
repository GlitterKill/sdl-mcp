#!/usr/bin/env tsx

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { buildMatrixRunEnv } from "../dist/benchmark/matrix-runner.js";

interface MatrixRun {
  id: string;
  family: string;
  repoId: string;
  tasks: string;
  skipIndex?: boolean;
}

interface MatrixFile {
  version: number;
  runs: MatrixRun[];
}

interface BenchmarkTask {
  id: string;
  category: string;
  tags?: string[];
  comparison: {
    tokenReductionPct: number;
    contextCoverageGainPct: number;
    fileCoverageGainPct: number;
    symbolCoverageGainPct: number;
    precisionGainPct: number;
    recallGainPct: number;
  };
}

interface BenchmarkRunPayload {
  summary: {
    mode?: string;
    taskCount: number;
    avgTokenReductionPct: number;
    avgContextCoverageGainPct: number;
    avgFileCoverageGainPct: number;
    avgSymbolCoverageGainPct: number;
    avgPrecisionGainPct: number;
    avgRecallGainPct: number;
  };
  tasks: BenchmarkTask[];
}

interface FamilyStats {
  family: string;
  taskCount: number;
  avgTokenReductionPct: number;
  avgContextCoverageGainPct: number;
  avgFileCoverageGainPct: number;
  avgSymbolCoverageGainPct: number;
  avgPrecisionGainPct: number;
  avgRecallGainPct: number;
  p25TokenReductionPct: number;
  p50TokenReductionPct: number;
  minTokenReductionPct: number;
  maxTokenReductionPct: number;
}

interface MatrixAggregate {
  generatedAt: string;
  matrixPath: string;
  configPath?: string;
  runCount: number;
  taskCount: number;
  overall: {
    avgTokenReductionPct: number;
    avgContextCoverageGainPct: number;
    avgFileCoverageGainPct: number;
    avgSymbolCoverageGainPct: number;
    avgPrecisionGainPct: number;
    avgRecallGainPct: number;
    p25TokenReductionPct: number;
    p50TokenReductionPct: number;
    minTokenReductionPct: number;
    maxTokenReductionPct: number;
  };
  mode: "realism" | "efficient";
  families: FamilyStats[];
  runs: Array<{
    id: string;
    family: string;
    repoId: string;
    tasksPath: string;
    outPath: string;
    taskCount: number;
    avgTokenReductionPct: number;
    avgContextCoverageGainPct: number;
    avgFileCoverageGainPct: number;
    avgSymbolCoverageGainPct: number;
    avgPrecisionGainPct: number;
    avgRecallGainPct: number;
  }>;
}

const NODE_BIN = process.execPath;
type BenchmarkMode = "realism" | "efficient";

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function getFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function resolveBenchmarkMode(raw: string | undefined): BenchmarkMode {
  if (!raw) return "realism";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "realism" || normalized === "default") return "realism";
  if (
    normalized === "efficient" ||
    normalized === "benchmark-efficient" ||
    normalized === "efficiency"
  ) {
    return "efficient";
  }
  throw new Error(
    `Invalid --mode "${raw}". Supported values: realism, efficient.`,
  );
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

function buildRunCommand(params: {
  configPath?: string;
  tasksPath: string;
  repoId: string;
  outPath: string;
  skipIndex: boolean;
  mode: BenchmarkMode;
}): string {
  const configArg = params.configPath ? ` --config "${params.configPath}"` : "";
  const skipArg = params.skipIndex ? " --skip-index" : "";
  return `"${NODE_BIN}" scripts/real-world-benchmark.ts --tasks "${params.tasksPath}" --repo-id "${params.repoId}" --out "${params.outPath}" --mode "${params.mode}"${configArg}${skipArg}`;
}

interface FamilyAggregates {
  reductions: number[];
  contextCoverageGains: number[];
  fileCoverageGains: number[];
  symbolCoverageGains: number[];
  precisionGains: number[];
  recallGains: number[];
}

function toFamilyStats(
  family: string,
  aggregates: FamilyAggregates,
): FamilyStats {
  const reductions = aggregates.reductions;
  return {
    family,
    taskCount: reductions.length,
    avgTokenReductionPct: average(reductions),
    avgContextCoverageGainPct: average(aggregates.contextCoverageGains),
    avgFileCoverageGainPct: average(aggregates.fileCoverageGains),
    avgSymbolCoverageGainPct: average(aggregates.symbolCoverageGains),
    avgPrecisionGainPct: average(aggregates.precisionGains),
    avgRecallGainPct: average(aggregates.recallGains),
    p25TokenReductionPct: percentile(reductions, 25),
    p50TokenReductionPct: percentile(reductions, 50),
    minTokenReductionPct: Math.min(...reductions),
    maxTokenReductionPct: Math.max(...reductions),
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const matrixPath = resolve(
    getArgValue(args, "matrix") ?? "benchmarks/real-world/matrix.json",
  );
  const outDir = resolve(
    getArgValue(args, "out-dir") ?? "benchmarks/real-world/runs/coverage-matrix",
  );
  const configPath = getArgValue(args, "config")
    ? resolve(getArgValue(args, "config") as string)
    : undefined;
  const limitRunsRaw = getArgValue(args, "limit-runs");
  const limitRuns = limitRunsRaw ? Number(limitRunsRaw) : Number.POSITIVE_INFINITY;
  const forceSkipIndex = getFlag(args, "skip-index");
  const mode = resolveBenchmarkMode(getArgValue(args, "mode"));

  if (!existsSync(matrixPath)) {
    throw new Error(`Matrix file not found: ${matrixPath}`);
  }

  const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as MatrixFile;
  if (!Array.isArray(matrix.runs) || matrix.runs.length === 0) {
    throw new Error(`Matrix file has no runs: ${matrixPath}`);
  }

  const selectedRuns = matrix.runs.slice(
    0,
    Number.isFinite(limitRuns) && limitRuns > 0 ? limitRuns : matrix.runs.length,
  );

  mkdirSync(outDir, { recursive: true });
  const runOutDir = resolve(outDir, "runs");
  mkdirSync(runOutDir, { recursive: true });

  const indexedRepos = new Set<string>();
  const familyAggregates = new Map<string, FamilyAggregates>();
  const allReductions: number[] = [];
  const allContextCoverageGains: number[] = [];
  const allFileCoverageGains: number[] = [];
  const allSymbolCoverageGains: number[] = [];
  const allPrecisionGains: number[] = [];
  const allRecallGains: number[] = [];
  const runSummaries: MatrixAggregate["runs"] = [];
  const failedRuns: string[] = [];

  console.log(
    `[matrix] executing ${selectedRuns.length} run(s) from ${matrixPath} (mode=${mode})`,
  );

  for (const run of selectedRuns) {
    const resolvedTasksPath = resolve(dirname(matrixPath), run.tasks);
    if (!existsSync(resolvedTasksPath)) {
      throw new Error(`Tasks file not found for run ${run.id}: ${resolvedTasksPath}`);
    }

    const runOutPath = resolve(runOutDir, `${run.id}.json`);
    const skipIndex = forceSkipIndex || run.skipIndex === true || indexedRepos.has(run.repoId);
    const cmd = buildRunCommand({
      configPath,
      tasksPath: resolvedTasksPath,
      repoId: run.repoId,
      outPath: runOutPath,
      skipIndex,
      mode,
    });

    console.log(
      `[matrix] run=${run.id} family=${run.family} repo=${run.repoId} skipIndex=${skipIndex}`,
    );

    try {
      execSync(cmd, {
        stdio: "inherit",
        env: buildMatrixRunEnv(process.env, outDir, run.repoId),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[matrix] run=${run.id} FAILED: ${msg}`);
      failedRuns.push(run.id);
      continue;
    }
    indexedRepos.add(run.repoId);

    const payload = JSON.parse(
      readFileSync(runOutPath, "utf-8"),
    ) as BenchmarkRunPayload;

    const reductions = payload.tasks.map((task) => task.comparison.tokenReductionPct);
    const contextCoverageGains = payload.tasks.map(
      (task) => task.comparison.contextCoverageGainPct,
    );
    const fileCoverageGains = payload.tasks.map(
      (task) => task.comparison.fileCoverageGainPct,
    );
    const symbolCoverageGains = payload.tasks.map(
      (task) => task.comparison.symbolCoverageGainPct,
    );
    const precisionGains = payload.tasks.map(
      (task) => task.comparison.precisionGainPct,
    );
    const recallGains = payload.tasks.map((task) => task.comparison.recallGainPct);

    allReductions.push(...reductions);
    allContextCoverageGains.push(...contextCoverageGains);
    allFileCoverageGains.push(...fileCoverageGains);
    allSymbolCoverageGains.push(...symbolCoverageGains);
    allPrecisionGains.push(...precisionGains);
    allRecallGains.push(...recallGains);

    const familyState = familyAggregates.get(run.family) ?? {
      reductions: [],
      contextCoverageGains: [],
      fileCoverageGains: [],
      symbolCoverageGains: [],
      precisionGains: [],
      recallGains: [],
    };
    familyState.reductions.push(...reductions);
    familyState.contextCoverageGains.push(...contextCoverageGains);
    familyState.fileCoverageGains.push(...fileCoverageGains);
    familyState.symbolCoverageGains.push(...symbolCoverageGains);
    familyState.precisionGains.push(...precisionGains);
    familyState.recallGains.push(...recallGains);
    familyAggregates.set(run.family, familyState);

    runSummaries.push({
      id: run.id,
      family: run.family,
      repoId: run.repoId,
      tasksPath: resolvedTasksPath,
      outPath: runOutPath,
      taskCount: payload.summary.taskCount,
      avgTokenReductionPct: payload.summary.avgTokenReductionPct,
      avgContextCoverageGainPct: payload.summary.avgContextCoverageGainPct,
      avgFileCoverageGainPct: payload.summary.avgFileCoverageGainPct,
      avgSymbolCoverageGainPct: payload.summary.avgSymbolCoverageGainPct,
      avgPrecisionGainPct: payload.summary.avgPrecisionGainPct,
      avgRecallGainPct: payload.summary.avgRecallGainPct,
    });
  }

  const families = Array.from(familyAggregates.entries())
    .map(([family, aggregates]) => toFamilyStats(family, aggregates))
    .sort((a, b) => a.family.localeCompare(b.family));

  const aggregate: MatrixAggregate = {
    generatedAt: new Date().toISOString(),
    matrixPath,
    configPath,
    mode,
    runCount: runSummaries.length,
    taskCount: allReductions.length,
    overall: {
      avgTokenReductionPct: average(allReductions),
      avgContextCoverageGainPct: average(allContextCoverageGains),
      avgFileCoverageGainPct: average(allFileCoverageGains),
      avgSymbolCoverageGainPct: average(allSymbolCoverageGains),
      avgPrecisionGainPct: average(allPrecisionGains),
      avgRecallGainPct: average(allRecallGains),
      p25TokenReductionPct: percentile(allReductions, 25),
      p50TokenReductionPct: percentile(allReductions, 50),
      minTokenReductionPct: allReductions.length > 0 ? Math.min(...allReductions) : 0,
      maxTokenReductionPct: allReductions.length > 0 ? Math.max(...allReductions) : 0,
    },
    families,
    runs: runSummaries,
  };

  const aggregatePath = resolve(outDir, "aggregate.json");
  writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2), "utf-8");

  console.log(`\n[matrix] aggregate written: ${aggregatePath}`);
  console.log(
    `[matrix] overall avg=${aggregate.overall.avgTokenReductionPct.toFixed(1)}% p50=${aggregate.overall.p50TokenReductionPct.toFixed(1)}% tasks=${aggregate.taskCount}`,
  );
  console.log(
    `[matrix] context/file/symbol gains=${aggregate.overall.avgContextCoverageGainPct.toFixed(1)}%/${aggregate.overall.avgFileCoverageGainPct.toFixed(1)}%/${aggregate.overall.avgSymbolCoverageGainPct.toFixed(1)}%`,
  );

  if (failedRuns.length > 0) {
    console.error(
      `\n[matrix] ${failedRuns.length} run(s) failed: ${failedRuns.join(", ")}`,
    );
    process.exit(1);
  }
}

main();
