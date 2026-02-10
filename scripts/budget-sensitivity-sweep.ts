#!/usr/bin/env tsx

import { execSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

interface SweepRow {
  maxCards: number;
  maxTokens: number;
  sdlWins: number;
  traditionalWins: number;
  ties: number;
  avgTokenReductionPct: number;
  avgCompositeScore: number;
  tokenReductionCvPct: number;
  compositeScoreCvPct: number;
}

interface BenchmarkResultPayload {
  summary: {
    sdlWins: number;
    traditionalWins: number;
    ties: number;
    avgTokenReductionPct: number;
    avgCompositeScore?: number;
  };
  tasks: Array<{
    comparison: {
      tokenReductionPct: number;
      compositeScore?: number;
    };
  }>;
}

const MAX_CARDS_GRID = [8, 12, 16, 20, 24, 30];
const MAX_TOKENS_GRID = [2000, 3000, 4000, 5000, 6500, 8000];
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

function getNpmConfigValue(name: string): string | undefined {
  const envName = `npm_config_${name.replace(/-/g, "_")}`;
  const value = process.env[envName];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTruthyOrFalsyToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "false" ||
    normalized === "1" ||
    normalized === "0" ||
    normalized === "yes" ||
    normalized === "no"
  );
}

function getMeaningfulNpmConfigValue(name: string): string | undefined {
  const value = getNpmConfigValue(name);
  if (!value) return undefined;
  if (isTruthyOrFalsyToken(value)) return undefined;
  return value;
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    if (current.startsWith("--")) {
      if (!current.includes("=") && i + 1 < args.length) {
        const next = args[i + 1];
        if (!next.startsWith("--")) {
          i++;
        }
      }
      continue;
    }
    positional.push(current);
  }
  return positional;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariationPct(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  if (Math.abs(mean) < 1e-9) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return (stdDev / Math.abs(mean)) * 100;
}

function runSweepPoint(params: {
  tasksPath: string;
  outDir: string;
  pointResultsDir: string;
  repoId?: string;
  maxCards: number;
  maxTokens: number;
  skipIndex: boolean;
}): SweepRow {
  const taskFileRaw = readFileSync(params.tasksPath, "utf-8");
  const taskFile = JSON.parse(taskFileRaw) as {
    defaults?: { sdl?: Record<string, unknown> };
  };

  taskFile.defaults = taskFile.defaults ?? {};
  taskFile.defaults.sdl = taskFile.defaults.sdl ?? {};
  taskFile.defaults.sdl.maxCards = params.maxCards;
  taskFile.defaults.sdl.maxTokens = params.maxTokens;

  const tempDir = mkdtempSync(join(tmpdir(), "sdl-budget-sweep-"));
  const tempTasksPath = join(tempDir, "tasks.json");
  const tempOutPath = join(
    tempDir,
    `result-c${params.maxCards}-t${params.maxTokens}.json`,
  );
  writeFileSync(tempTasksPath, JSON.stringify(taskFile, null, 2), "utf-8");

  const repoArg = params.repoId ? ` --repo-id "${params.repoId}"` : "";
  const skipIndexArg = params.skipIndex ? " --skip-index" : "";
  const command = `"${TSX_BIN}" scripts/real-world-benchmark.ts --tasks "${tempTasksPath}" --out "${tempOutPath}"${repoArg}${skipIndexArg}`;
  execSync(command, { stdio: "inherit" });

  const resultRaw = readFileSync(tempOutPath, "utf-8");
  const result = JSON.parse(resultRaw) as BenchmarkResultPayload;
  const pointResultPath = join(
    params.pointResultsDir,
    `result-c${params.maxCards}-t${params.maxTokens}.json`,
  );
  writeFileSync(pointResultPath, resultRaw, "utf-8");
  const reductionValues = result.tasks.map((task) => task.comparison.tokenReductionPct);
  const compositeValues = result.tasks.map(
    (task) => task.comparison.compositeScore ?? 0,
  );

  rmSync(tempDir, { recursive: true, force: true });

  return {
    maxCards: params.maxCards,
    maxTokens: params.maxTokens,
    sdlWins: result.summary.sdlWins,
    traditionalWins: result.summary.traditionalWins,
    ties: result.summary.ties,
    avgTokenReductionPct: result.summary.avgTokenReductionPct,
    avgCompositeScore: result.summary.avgCompositeScore ?? average(compositeValues),
    tokenReductionCvPct: coefficientOfVariationPct(reductionValues),
    compositeScoreCvPct: coefficientOfVariationPct(compositeValues),
  };
}

function writeCsv(path: string, rows: SweepRow[]): void {
  const header = [
    "maxCards",
    "maxTokens",
    "sdlWins",
    "traditionalWins",
    "ties",
    "avgTokenReductionPct",
    "avgCompositeScore",
    "tokenReductionCvPct",
    "compositeScoreCvPct",
  ];

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.maxCards,
        row.maxTokens,
        row.sdlWins,
        row.traditionalWins,
        row.ties,
        row.avgTokenReductionPct.toFixed(4),
        row.avgCompositeScore.toFixed(4),
        row.tokenReductionCvPct.toFixed(4),
        row.compositeScoreCvPct.toFixed(4),
      ].join(","),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

function writeHeatmapCsv(path: string, rows: SweepRow[]): void {
  const header = ["maxCards\\maxTokens", ...MAX_TOKENS_GRID.map(String)].join(",");
  const lines = [header];

  for (const maxCards of MAX_CARDS_GRID) {
    const cells = [String(maxCards)];
    for (const maxTokens of MAX_TOKENS_GRID) {
      const row = rows.find(
        (entry) =>
          entry.maxCards === maxCards && entry.maxTokens === maxTokens,
      );
      cells.push(row ? row.avgTokenReductionPct.toFixed(4) : "");
    }
    lines.push(cells.join(","));
  }

  writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
}

function main(): void {
  const args = process.argv.slice(2);
  const positionalArgs = getPositionalArgs(args);
  const positionalRepoId = positionalArgs[0];
  const positionalLimitRuns = positionalArgs[1];
  const positionalOutDir = positionalArgs[2];
  const positionalTasksPath = positionalArgs[3];
  const tasksPath = resolve(
    getArgValue(args, "tasks") ??
      getMeaningfulNpmConfigValue("tasks") ??
      positionalTasksPath ??
      "benchmarks/real-world/tasks.json",
  );
  const outDir = resolve(
    getArgValue(args, "out-dir") ??
      getMeaningfulNpmConfigValue("out-dir") ??
      positionalOutDir ??
      "benchmarks/real-world/budget-sensitivity",
  );
  const repoId =
    getArgValue(args, "repo-id") ??
    getArgValue(args, "repoId") ??
    getMeaningfulNpmConfigValue("repo-id") ??
    getMeaningfulNpmConfigValue("repoId") ??
    positionalRepoId;
  const limitRunsRaw =
    getArgValue(args, "limit-runs") ??
    getMeaningfulNpmConfigValue("limit-runs") ??
    positionalLimitRuns;
  const parsedLimitRuns = limitRunsRaw ? Number(limitRunsRaw) : Number.POSITIVE_INFINITY;
  const limitRuns =
    Number.isFinite(parsedLimitRuns) && parsedLimitRuns > 0
      ? parsedLimitRuns
      : Number.POSITIVE_INFINITY;

  mkdirSync(outDir, { recursive: true });
  const pointResultsDir = join(outDir, "points");
  mkdirSync(pointResultsDir, { recursive: true });

  const rows: SweepRow[] = [];
  let firstRun = true;
  let runs = 0;
  const totalGridRuns = MAX_CARDS_GRID.length * MAX_TOKENS_GRID.length;
  const plannedRuns =
    Number.isFinite(limitRuns) ? Math.min(limitRuns, totalGridRuns) : totalGridRuns;

  if (repoId) {
    console.log(`[budget-sweep] using repoId=${repoId}`);
  } else {
    console.log(
      "[budget-sweep] no repoId provided; real-world benchmark defaults will be used",
    );
  }
  console.log(
    `[budget-sweep] planned runs: ${plannedRuns} (grid size: ${MAX_CARDS_GRID.length}x${MAX_TOKENS_GRID.length})`,
  );

  for (const maxCards of MAX_CARDS_GRID) {
    for (const maxTokens of MAX_TOKENS_GRID) {
      if (runs >= limitRuns) break;
      const runNumber = runs + 1;
      console.log(
        `\n[budget-sweep] run ${runNumber}/${plannedRuns}: maxCards=${maxCards}, maxTokens=${maxTokens}`,
      );
      const row = runSweepPoint({
        tasksPath,
        outDir,
        pointResultsDir,
        repoId,
        maxCards,
        maxTokens,
        skipIndex: !firstRun,
      });
      rows.push(row);
      firstRun = false;
      runs++;
    }
    if (runs >= limitRuns) break;
  }

  console.log(`\n[budget-sweep] completed ${runs} run(s)`);

  const csvPath = join(outDir, "budget-sensitivity-results.csv");
  const heatmapCsvPath = join(outDir, "budget-sensitivity-heatmap.csv");
  const surfaceJsonPath = join(outDir, "budget-sensitivity-surface.json");

  writeCsv(csvPath, rows);
  writeHeatmapCsv(heatmapCsvPath, rows);

  writeFileSync(
    surfaceJsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        axes: {
          maxCards: MAX_CARDS_GRID,
          maxTokens: MAX_TOKENS_GRID,
        },
        metric: "avgTokenReductionPct",
        rows,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`\nWrote sweep CSV: ${csvPath}`);
  console.log(`Wrote heatmap CSV: ${heatmapCsvPath}`);
  console.log(`Wrote surface JSON: ${surfaceJsonPath}`);
  console.log(`Wrote per-point results: ${pointResultsDir}`);
}

main();
