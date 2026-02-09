#!/usr/bin/env node

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import type { CLIOptions } from "../types.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import { loadConfig } from "../../config/loadConfig.js";
import * as db from "../../db/queries.js";
import { indexRepo } from "../../indexer/indexer.js";
import { buildSlice } from "../../graph/slice.js";
import { generateSymbolSkeleton } from "../../code/skeleton.js";
import type { SymbolRow } from "../../db/schema.js";
import {
  ThresholdEvaluator,
  loadThresholdConfig,
  loadBaselineMetrics,
  saveBaselineMetrics,
  type BenchmarkThresholds,
  type ThresholdEvaluationResult,
} from "../../benchmark/threshold.js";
import { RegressionReportGenerator } from "../../benchmark/regression.js";
import {
  runBenchmarkWithSmoothing,
  type SmoothingConfig,
} from "../../benchmark/smoothing.js";

export interface BenchmarkOptions extends CLIOptions {
  repoId?: string;
  baselinePath?: string;
  thresholdPath?: string;
  outputPath?: string;
  jsonOutput?: boolean;
  updateBaseline?: boolean;
  skipIndexing?: boolean;
}

interface BenchmarkCIOptions extends BenchmarkOptions {}

interface BenchmarkMetrics {
  indexTimePerFile: number;
  indexTimePerSymbol: number;
  symbolsPerFile: number;
  edgesPerSymbol: number;
  graphConnectivity: number;
  exportedSymbolRatio: number;
  sliceBuildTimeMs: number;
  avgSkeletonTimeMs: number;
  avgCardTokens: number;
  avgSkeletonTokens: number;
  functionMethodRatio: number;
  avgDepsPerSymbol: number;
  callEdgeCount: number;
  importEdgeCount: number;
  totalSymbols: number;
  totalFiles: number;
}

interface BenchmarkCIResult {
  timestamp: string;
  repoId: string;
  repoPath: string;
  metrics: BenchmarkMetrics;
  thresholdResult?: ThresholdEvaluationResult;
  regressionReport?: import("../../benchmark/regression.js").RegressionReport;
  config: {
    thresholdPath: string;
    baselinePath: string;
    smoothing: SmoothingConfig;
  };
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildCardFromSymbol(
  repoId: string,
  symbol: SymbolRow,
): { card: unknown; tokens: number } | null {
  const file = db.getFile(symbol.file_id);
  if (!file) return null;

  const latestVersion = db.getLatestVersion(repoId);
  const edgesFrom = db.getEdgesFrom(symbol.symbol_id);
  const metrics = db.getMetrics(symbol.symbol_id);

  const signature = symbol.signature_json
    ? JSON.parse(symbol.signature_json)
    : undefined;
  const invariants = symbol.invariants_json
    ? JSON.parse(symbol.invariants_json)
    : undefined;
  const sideEffects = symbol.side_effects_json
    ? JSON.parse(symbol.side_effects_json)
    : undefined;

  const deps = {
    imports: edgesFrom
      .filter((e) => e.type === "import")
      .map((e) => e.to_symbol_id),
    calls: edgesFrom
      .filter((e) => e.type === "call")
      .map((e) => e.to_symbol_id),
  };

  const cardMetrics = metrics
    ? {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs: metrics.test_refs_json
          ? JSON.parse(metrics.test_refs_json)
          : undefined,
      }
    : undefined;

  const card = {
    symbolId: symbol.symbol_id,
    repoId: symbol.repo_id,
    file: file.rel_path,
    range: {
      startLine: symbol.range_start_line,
      startCol: symbol.range_start_col,
      endLine: symbol.range_end_line,
      endCol: symbol.range_end_col,
    },
    kind: symbol.kind,
    name: symbol.name,
    exported: symbol.exported === 1,
    visibility: symbol.visibility,
    signature,
    summary: symbol.summary ?? undefined,
    invariants,
    sideEffects,
    deps,
    metrics: cardMetrics,
    version: {
      ledgerVersion: latestVersion?.version_id ?? "current",
      astFingerprint: symbol.ast_fingerprint,
    },
  };

  const tokens = estimateTokens(JSON.stringify(card));
  return { card, tokens };
}

async function collectBenchmarkMetrics(
  repoId: string,
  _repoPath: string,
  skipIndexing: boolean,
): Promise<BenchmarkMetrics> {
  const config = loadConfig();
  const database = getDb(config.dbPath);
  runMigrations(database);

  let indexTimeMs = 0;
  let filesIndexed = 0;

  if (!skipIndexing) {
    const indexStart = performance.now();
    const indexResult = await indexRepo(repoId, "full");
    indexTimeMs = performance.now() - indexStart;
    filesIndexed = indexResult.filesProcessed;
  }

  const allSymbols = db.getSymbolsByRepo(repoId);
  const edges = db.getEdgesByRepo(repoId);
  const filesById = new Map(
    db.getFilesByRepo(repoId).map((file) => [file.file_id, file.rel_path]),
  );

  // Ensure benchmark symbol sampling is deterministic across platforms/runs.
  const sortedSymbols = [...allSymbols].sort((a, b) => {
    const pathA = filesById.get(a.file_id) ?? "";
    const pathB = filesById.get(b.file_id) ?? "";
    return (
      pathA.localeCompare(pathB) ||
      a.range_start_line - b.range_start_line ||
      a.range_start_col - b.range_start_col ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name) ||
      a.symbol_id.localeCompare(b.symbol_id)
    );
  });

  const srcSymbols = sortedSymbols.filter(
    (symbol) => (filesById.get(symbol.file_id) ?? "").startsWith("src/"),
  );
  const samplingPool = srcSymbols.length > 0 ? srcSymbols : sortedSymbols;
  const sampleSize = Math.min(20, samplingPool.length);
  const sampleSymbols = samplingPool.slice(0, sampleSize);

  let totalCardTokens = 0;
  let totalSkeletonTokens = 0;
  let skeletonCount = 0;
  let skeletonTimeMs = 0;

  for (const symbol of sampleSymbols) {
    try {
      const cardResult = buildCardFromSymbol(repoId, symbol);
      if (cardResult) {
        totalCardTokens += cardResult.tokens;
      }

      if (symbol.kind === "function" || symbol.kind === "method") {
        const skelStart = performance.now();
        try {
          const skeleton = generateSymbolSkeleton(repoId, symbol.symbol_id);
          skeletonTimeMs += performance.now() - skelStart;
          if (skeleton?.skeleton) {
            totalSkeletonTokens += estimateTokens(skeleton.skeleton);
            skeletonCount++;
          }
        } catch {
          skeletonTimeMs += performance.now() - skelStart;
        }
      }
    } catch {
      // Skip problematic symbols
    }
  }

  const avgCardTokens = sampleSize > 0 ? totalCardTokens / sampleSize : 0;
  const avgSkeletonTokens =
    skeletonCount > 0 ? totalSkeletonTokens / skeletonCount : 0;

  let sliceBuildTimeMs = 0;

  if (sortedSymbols.length > 0) {
    const outDegreeBySymbol = edges.reduce((counts, edge) => {
      counts.set(edge.from_symbol_id, (counts.get(edge.from_symbol_id) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());

    const srcFunctionSymbols = srcSymbols.filter(
      (s) => s.kind === "function" || s.kind === "method",
    );
    const allFunctionSymbols = sortedSymbols.filter(
      (s) => s.kind === "function" || s.kind === "method",
    );
    const seedCandidates =
      srcFunctionSymbols.length > 0 ? srcFunctionSymbols : allFunctionSymbols;

    const seedSymbol =
      seedCandidates.find((sym) => {
        const outDegree = outDegreeBySymbol.get(sym.symbol_id) ?? 0;
        return outDegree >= 3 && outDegree <= 40;
      }) ??
      seedCandidates[0] ??
      sortedSymbols[0];

    const latestVersion = db.getLatestVersion(repoId);
    const versionId = latestVersion?.version_id ?? "current";

    try {
      const sliceStart = performance.now();
      await buildSlice({
        repoId,
        versionId,
        entrySymbols: [seedSymbol.symbol_id],
        taskText: "understand implementation",
        budget: { maxCards: 20, maxEstimatedTokens: 4000 },
      });
      sliceBuildTimeMs = performance.now() - sliceStart;
    } catch {
      // Slice build errors are non-critical for metrics
    }
  }

  const exportedCount = allSymbols.filter((s) => s.exported === 1).length;
  const functionMethodCount = allSymbols.filter(
    (s) => s.kind === "function" || s.kind === "method",
  ).length;

  const indexedSymbolIds = new Set(allSymbols.map((s) => s.symbol_id));
  const symbolsWithInternalEdges = new Set(
    edges
      .flatMap((e) => [e.from_symbol_id, e.to_symbol_id])
      .filter((id) => indexedSymbolIds.has(id)),
  ).size;
  const graphConnectivity =
    allSymbols.length > 0 ? symbolsWithInternalEdges / allSymbols.length : 0;

  const edgeTypes = edges.reduce(
    (acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  if (filesIndexed === 0) {
    filesIndexed = filesById.size;
  }

  const totalSymbols = allSymbols.length;
  const totalFiles = filesIndexed > 0 ? filesIndexed : 1;

  return {
    indexTimePerFile: totalFiles > 0 ? indexTimeMs / totalFiles : 0,
    indexTimePerSymbol: totalSymbols > 0 ? indexTimeMs / totalSymbols : 0,
    symbolsPerFile: totalFiles > 0 ? totalSymbols / totalFiles : 0,
    edgesPerSymbol: totalSymbols > 0 ? edges.length / totalSymbols : 0,
    graphConnectivity,
    exportedSymbolRatio: totalSymbols > 0 ? exportedCount / totalSymbols : 0,
    sliceBuildTimeMs,
    avgSkeletonTimeMs: skeletonCount > 0 ? skeletonTimeMs / skeletonCount : 0,
    avgCardTokens,
    avgSkeletonTokens,
    functionMethodRatio:
      totalSymbols > 0 ? functionMethodCount / totalSymbols : 0,
    avgDepsPerSymbol: totalSymbols > 0 ? edges.length / totalSymbols : 0,
    callEdgeCount: edgeTypes.call ?? 0,
    importEdgeCount: edgeTypes.import ?? 0,
    totalSymbols,
    totalFiles,
  };
}

export async function benchmarkCICommand(
  options: BenchmarkCIOptions,
): Promise<number> {
  console.log("Benchmark CI: Running benchmark guardrails...\n");

  const config = loadConfig();
  const repoConfig = options.repoId
    ? config.repos.find((r) => r.repoId === options.repoId)
    : config.repos[0];

  if (!repoConfig) {
    console.error(`Repository not found: ${options.repoId || "default"}`);
    return 1;
  }

  const repoId = repoConfig.repoId;
  const configuredRepoPath = resolve(repoConfig.rootPath);
  const repoPath = existsSync(configuredRepoPath)
    ? configuredRepoPath
    : process.cwd();

  if (!existsSync(configuredRepoPath)) {
    console.warn(
      `[WARN] Configured repository path does not exist: ${configuredRepoPath}`,
    );
    console.warn(`[WARN] Falling back to current working directory: ${repoPath}`);
  }

  const database = getDb(config.dbPath);
  runMigrations(database);

  const repoRuntimeConfigJson = JSON.stringify({
    ignore: repoConfig.ignore,
    languages: repoConfig.languages,
    maxFileBytes: repoConfig.maxFileBytes,
    packageJsonPath: repoConfig.packageJsonPath,
    tsconfigPath: repoConfig.tsconfigPath,
    workspaceGlobs: repoConfig.workspaceGlobs,
  });

  const persistedRepo = db.getRepo(repoId);
  if (!persistedRepo) {
    db.createRepo({
      repo_id: repoId,
      root_path: repoPath,
      config_json: repoRuntimeConfigJson,
      created_at: new Date().toISOString(),
    });
  } else {
    const repoUpdates: { root_path?: string; config_json?: string } = {};

    if (persistedRepo.root_path !== repoPath) {
      repoUpdates.root_path = repoPath;
    }
    if (persistedRepo.config_json !== repoRuntimeConfigJson) {
      repoUpdates.config_json = repoRuntimeConfigJson;
    }

    if (Object.keys(repoUpdates).length > 0) {
      db.updateRepo(repoId, repoUpdates);
    }
  }

  const thresholdPath =
    options.thresholdPath ??
    resolve(process.cwd(), "config/benchmark.config.json");
  const outputPath =
    options.outputPath ?? resolve(process.cwd(), ".benchmark/latest.json");

  let thresholds: BenchmarkThresholds | undefined;
  try {
    thresholds = loadThresholdConfig(thresholdPath);
    console.log(`✓ Loaded threshold config from: ${thresholdPath}`);
  } catch (error) {
    console.warn(`⚠ Could not load threshold config: ${error}`);
    console.warn("  Continuing without threshold evaluation...");
  }

  const baselinePath =
    options.baselinePath ??
    resolve(
      process.cwd(),
      thresholds?.baseline.filePath ?? ".benchmark/baseline.json",
    );

  console.log(`\nBenchmarking repository: ${repoId}`);
  console.log(`Repository path: ${repoPath}`);

  if (thresholds) {
    console.log(
      `\nSmoothing config: ${thresholds.smoothing.sampleRuns} sample runs, ${thresholds.smoothing.warmupRuns} warmup runs`,
    );
  }

  let benchmarkMetrics: BenchmarkMetrics;

  if (thresholds) {
    console.log(`\nRunning benchmark with smoothing...`);
    const { smoothed } = await runBenchmarkWithSmoothing(
      thresholds.smoothing,
      () =>
        collectBenchmarkMetrics(
          repoId,
          repoPath,
          options.skipIndexing ?? false,
        ).then((m) => m as unknown as Record<string, number>),
    );
    benchmarkMetrics = smoothed as unknown as BenchmarkMetrics;
    console.log(`✓ Benchmark complete with smoothing`);
  } else {
    console.log(`\nRunning benchmark (single run)...`);
    benchmarkMetrics = await collectBenchmarkMetrics(
      repoId,
      repoPath,
      options.skipIndexing ?? false,
    );
    console.log(`✓ Benchmark complete`);
  }

  console.log("\n=== Benchmark Metrics ===");
  console.log(`Indexing:`);
  console.log(
    `  Time per file:      ${formatNumber(benchmarkMetrics.indexTimePerFile)}ms`,
  );
  console.log(
    `  Time per symbol:    ${formatNumber(benchmarkMetrics.indexTimePerSymbol)}ms`,
  );
  console.log(`Quality:`);
  console.log(
    `  Symbols per file:   ${formatNumber(benchmarkMetrics.symbolsPerFile)}`,
  );
  console.log(
    `  Edges per symbol:   ${formatNumber(benchmarkMetrics.edgesPerSymbol)}`,
  );
  console.log(
    `  Graph connectivity: ${formatPercent(benchmarkMetrics.graphConnectivity * 100)}`,
  );
  console.log(
    `  Exported ratio:     ${formatPercent(benchmarkMetrics.exportedSymbolRatio * 100)}`,
  );
  console.log(`Performance:`);
  console.log(
    `  Slice build:        ${formatNumber(benchmarkMetrics.sliceBuildTimeMs)}ms`,
  );
  console.log(
    `  Skeleton time:      ${formatNumber(benchmarkMetrics.avgSkeletonTimeMs)}ms`,
  );
  console.log(`Token Efficiency:`);
  console.log(
    `  Avg card tokens:    ${formatNumber(benchmarkMetrics.avgCardTokens)}`,
  );
  console.log(
    `  Avg skeleton tokens:${formatNumber(benchmarkMetrics.avgSkeletonTokens)}`,
  );
  console.log(`Coverage:`);
  console.log(
    `  Call edges:         ${formatNumber(benchmarkMetrics.callEdgeCount)}`,
  );
  console.log(
    `  Import edges:       ${formatNumber(benchmarkMetrics.importEdgeCount)}`,
  );

  let baselineMetrics: Record<string, number> | undefined;
  try {
    baselineMetrics = loadBaselineMetrics(baselinePath);
    if (baselineMetrics) {
      console.log(`\n✓ Loaded baseline from: ${baselinePath}`);
    } else {
      console.log(`\n⚠ No baseline found at: ${baselinePath}`);
      console.log(`  Use --update-baseline to create one`);
    }
  } catch (error) {
    console.warn(`\n⚠ Could not load baseline: ${error}`);
  }

  let thresholdResult: ThresholdEvaluationResult | undefined;
  let regressionReport:
    | import("../../benchmark/regression.js").RegressionReport
    | undefined;

  if (thresholds) {
    const evaluator = new ThresholdEvaluator(thresholds);
    const currentMetrics: Record<string, number> = {
      indexTimePerFile: benchmarkMetrics.indexTimePerFile,
      indexTimePerSymbol: benchmarkMetrics.indexTimePerSymbol,
      symbolsPerFile: benchmarkMetrics.symbolsPerFile,
      edgesPerSymbol: benchmarkMetrics.edgesPerSymbol,
      graphConnectivity: benchmarkMetrics.graphConnectivity,
      exportedSymbolRatio: benchmarkMetrics.exportedSymbolRatio,
      sliceBuildTimeMs: benchmarkMetrics.sliceBuildTimeMs,
      avgSkeletonTimeMs: benchmarkMetrics.avgSkeletonTimeMs,
      avgCardTokens: benchmarkMetrics.avgCardTokens,
      avgSkeletonTokens: benchmarkMetrics.avgSkeletonTokens,
    };

    thresholdResult = evaluator.evaluate(currentMetrics, baselineMetrics);

    console.log(`\n=== Threshold Evaluation ===`);
    console.log(
      `Status: ${thresholdResult.passed ? "✅ PASSED" : "❌ FAILED"}`,
    );
    console.log(`Total: ${thresholdResult.summary.total}`);
    console.log(`Passed: ${thresholdResult.summary.passed}`);
    console.log(`Failed: ${thresholdResult.summary.failed}`);

    const failed = thresholdResult.evaluations.filter((e) => !e.passed);
    if (failed.length > 0) {
      console.log(`\nFailed thresholds:`);
      for (const evaluation of failed) {
        console.log(
          `  - ${evaluation.category}.${evaluation.metricName}: ${evaluation.message}`,
        );
      }
    }

    if (baselineMetrics) {
      const reportGenerator = new RegressionReportGenerator();
      regressionReport = reportGenerator.generate({
        timestamp: new Date().toISOString(),
        repoId,
        currentMetrics,
        baselineMetrics,
        thresholds: thresholds.thresholds,
        evaluations: thresholdResult.evaluations,
      });

      console.log(`\n=== Regression Summary ===`);
      console.log(
        `Status: ${regressionReport.summary.passed ? "✅ PASSED" : "❌ FAILED"}`,
      );
      console.log(`Improved: ${regressionReport.summary.improved}`);
      console.log(`Degraded: ${regressionReport.summary.degraded}`);
      console.log(`Neutral: ${regressionReport.summary.neutral}`);

      if (regressionReport.recommendations.length > 0) {
        console.log(`\nRecommendations:`);
        for (const rec of regressionReport.recommendations) {
          console.log(`  ${rec}`);
        }
      }
    }
  }

  const result: BenchmarkCIResult = {
    timestamp: new Date().toISOString(),
    repoId,
    repoPath,
    metrics: benchmarkMetrics,
    thresholdResult,
    regressionReport,
    config: {
      thresholdPath,
      baselinePath,
      smoothing: thresholds?.smoothing ?? {
        warmupRuns: 0,
        sampleRuns: 1,
        outlierMethod: "none",
        iqrMultiplier: 1.5,
      },
    },
  };

  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n✓ Results saved to: ${outputPath}`);

  if (options.jsonOutput) {
    console.log(`\n${JSON.stringify(result, null, 2)}`);
  }

  if (options.updateBaseline) {
    saveBaselineMetrics(baselinePath, result);
    console.log(`\n✓ Baseline updated: ${baselinePath}`);
  }

  const exitCode = thresholdResult?.passed !== false ? 0 : 1;
  return exitCode;
}
