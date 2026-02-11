#!/usr/bin/env tsx

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";

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
  };
}

interface BenchmarkRunPayload {
  summary: {
    taskCount: number;
    avgTokenReductionPct: number;
  };
  tasks: BenchmarkTask[];
}

interface FamilyStats {
  family: string;
  taskCount: number;
  avgTokenReductionPct: number;
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
    p25TokenReductionPct: number;
    p50TokenReductionPct: number;
    minTokenReductionPct: number;
    maxTokenReductionPct: number;
  };
  families: FamilyStats[];
  runs: Array<{
    id: string;
    family: string;
    repoId: string;
    tasksPath: string;
    outPath: string;
    taskCount: number;
    avgTokenReductionPct: number;
  }>;
}

const TSX_BIN =
  process.platform === "win32"
    ? resolve("node_modules", ".bin", "tsx.cmd")
    : resolve("node_modules", ".bin", "tsx");

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
}): string {
  const configArg = params.configPath ? ` --config "${params.configPath}"` : "";
  const skipArg = params.skipIndex ? " --skip-index" : "";
  return `"${TSX_BIN}" scripts/real-world-benchmark.ts --tasks "${params.tasksPath}" --repo-id "${params.repoId}" --out "${params.outPath}"${configArg}${skipArg}`;
}

function toFamilyStats(family: string, reductions: number[]): FamilyStats {
  return {
    family,
    taskCount: reductions.length,
    avgTokenReductionPct: average(reductions),
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
  const familyToReductions = new Map<string, number[]>();
  const allReductions: number[] = [];
  const runSummaries: MatrixAggregate["runs"] = [];

  console.log(`[matrix] executing ${selectedRuns.length} run(s) from ${matrixPath}`);

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
    });

    console.log(
      `[matrix] run=${run.id} family=${run.family} repo=${run.repoId} skipIndex=${skipIndex}`,
    );
    execSync(cmd, { stdio: "inherit" });
    indexedRepos.add(run.repoId);

    const payload = JSON.parse(
      readFileSync(runOutPath, "utf-8"),
    ) as BenchmarkRunPayload;

    const reductions = payload.tasks.map((task) => task.comparison.tokenReductionPct);
    allReductions.push(...reductions);

    const familyReductions = familyToReductions.get(run.family) ?? [];
    familyReductions.push(...reductions);
    familyToReductions.set(run.family, familyReductions);

    runSummaries.push({
      id: run.id,
      family: run.family,
      repoId: run.repoId,
      tasksPath: resolvedTasksPath,
      outPath: runOutPath,
      taskCount: payload.summary.taskCount,
      avgTokenReductionPct: payload.summary.avgTokenReductionPct,
    });
  }

  const families = Array.from(familyToReductions.entries())
    .map(([family, reductions]) => toFamilyStats(family, reductions))
    .sort((a, b) => a.family.localeCompare(b.family));

  const aggregate: MatrixAggregate = {
    generatedAt: new Date().toISOString(),
    matrixPath,
    configPath,
    runCount: runSummaries.length,
    taskCount: allReductions.length,
    overall: {
      avgTokenReductionPct: average(allReductions),
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
}

main();
