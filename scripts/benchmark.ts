#!/usr/bin/env tsx
/**
 * SDL-MCP Effectiveness Benchmark
 *
 * Measures token savings, performance, and context quality compared to
 * traditional approaches. Includes tuning parameters and recommendations.
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark -- --repo-id my-repo
 *   npm run benchmark -- --json                    # Output JSON results
 *   npm run benchmark -- --out results.json        # Save to file
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { getDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrations.js";
import { loadConfig } from "../src/config/loadConfig.js";
import * as db from "../src/db/queries.js";
import type { SymbolRow } from "../src/db/schema.js";
import { indexRepo } from "../src/indexer/indexer.js";
import { buildSlice } from "../src/graph/slice.js";
import { generateSymbolSkeleton } from "../src/code/skeleton.js";
import type {
  SymbolCard,
  SymbolSignature,
  SymbolDeps,
  SymbolMetrics,
} from "../src/mcp/types.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  SLICE_SCORE_THRESHOLD,
  MAX_FRONTIER,
  SYMBOL_TOKEN_BASE,
  SYMBOL_TOKEN_MAX,
} from "../src/config/constants.js";
import { estimateTokens } from "../src/util/tokenize.js";

// ============================================================================
// Types
// ============================================================================

interface TuningParameters {
  slice: {
    maxCards: number;
    maxTokens: number;
    scoreThreshold: number;
    maxFrontier: number;
    edgeWeights: {
      call: number;
      import: number;
      config: number;
    };
  };
  tokenEstimation: {
    baseTokensPerSymbol: number;
    maxTokensPerSymbol: number;
    algorithm: string;
  };
}

interface PerformanceMetrics {
  indexTimeMs: number;
  indexTimePerFile: number;
  indexTimePerSymbol: number;
  sliceBuildTimeMs: number;
  skeletonGenerationTimeMs: number;
  avgSkeletonTimeMs: number;
  dbQueryTimeMs: number;
}

interface QualityMetrics {
  symbolsPerFile: number;
  edgesPerSymbol: number;
  edgeTypeDistribution: Record<string, number>;
  exportedSymbolRatio: number;
  functionMethodRatio: number;
  avgDepsPerSymbol: number;
  graphConnectivity: number;
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
  traces: ReplayTrace[];
}

interface BenchmarkResult {
  timestamp: string;
  repoId: string;
  repoPath: string;
  tuningParameters: TuningParameters;
  performance: PerformanceMetrics;
  traditional: {
    totalFiles: number;
    totalBytes: number;
    totalLines: number;
    estimatedTokens: number;
    avgTokensPerFile: number;
  };
  sdlMcp: {
    symbolsIndexed: number;
    avgCardTokens: number;
    avgSkeletonTokens: number;
    sampleSlice: {
      seedSymbol: string;
      cards: number;
      tokens: number;
      frontierSize: number;
    };
  };
  quality: QualityMetrics;
  tokenAnalysis: TokenAnalysis[];
  traceSource?: {
    traceFile: string;
    traceCount: number;
  };
  recommendations: string[];
}

// ============================================================================
// Utilities
// ============================================================================

const DEFAULT_REPLAY_TRACE_PATH = "benchmarks/synthetic/replay-traces.json";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatMs(n: number): string {
  if (n < 1) return "<1ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

function progressBar(percent: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
}

function loadReplayTraces(
  traceFilePath: string,
  repoId: string,
): ReplayTrace[] {
  const resolved = resolve(traceFilePath);
  const raw = readFileSync(resolved, "utf-8");
  const payload = JSON.parse(raw) as ReplayTraceFile;
  const repoScoped = payload.traces.filter(
    (trace) => !trace.sourceRepoId || trace.sourceRepoId === repoId,
  );
  if (repoScoped.length > 0) {
    return repoScoped;
  }
  const traceRepoIds = [
    ...new Set(payload.traces.map((t) => t.sourceRepoId).filter(Boolean)),
  ];
  console.warn(
    `  Warning: No replay traces found for repo "${repoId}". ` +
      `Falling back to all ${payload.traces.length} traces ` +
      `(from repo(s): ${traceRepoIds.join(", ") || "unknown"}). ` +
      `Token comparisons may not reflect this repository.`,
  );
  return payload.traces;
}

function buildTokenAnalysisFromTrace(trace: ReplayTrace): TokenAnalysis {
  const traditionalTokens = Math.max(0, trace.traditional.tokens);
  const sdlTokens = Math.max(0, trace.sdlMcp.tokens);
  const reduction =
    traditionalTokens > 0 && sdlTokens > 0
      ? (1 - sdlTokens / traditionalTokens) * 100
      : 0;
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
    compressionRatio:
      sdlTokens > 0 ? traditionalTokens / sdlTokens : 0,
    winner,
    qualifier: trace.qualifier,
  };
}

function buildCardFromSymbol(
  repoId: string,
  symbol: SymbolRow,
): SymbolCard | null {
  const file = db.getFile(symbol.file_id);
  if (!file) return null;

  const latestVersion = db.getLatestVersion(repoId);
  const edgesFrom = db.getEdgesFrom(symbol.symbol_id);
  const metrics = db.getMetrics(symbol.symbol_id);

  const signature: SymbolSignature | undefined = symbol.signature_json
    ? JSON.parse(symbol.signature_json)
    : undefined;

  const invariants: string[] | undefined = symbol.invariants_json
    ? JSON.parse(symbol.invariants_json)
    : undefined;

  const sideEffects: string[] | undefined = symbol.side_effects_json
    ? JSON.parse(symbol.side_effects_json)
    : undefined;

  const deps: SymbolDeps = {
    imports: edgesFrom
      .filter((e) => e.type === "import")
      .map((e) => e.to_symbol_id),
    calls: edgesFrom.filter((e) => e.type === "call").map((e) => e.to_symbol_id),
  };

  const cardMetrics: SymbolMetrics | undefined = metrics
    ? {
        fanIn: metrics.fan_in,
        fanOut: metrics.fan_out,
        churn30d: metrics.churn_30d,
        testRefs: metrics.test_refs_json
          ? JSON.parse(metrics.test_refs_json)
          : undefined,
      }
    : undefined;

  return {
    symbolId: symbol.symbol_id,
    repoId: symbol.repo_id,
    file: file.rel_path,
    range: {
      startLine: symbol.range_start_line,
      startCol: symbol.range_start_col,
      endLine: symbol.range_end_line,
      endCol: symbol.range_end_col,
    },
    kind: symbol.kind as SymbolCard["kind"],
    name: symbol.name,
    exported: symbol.exported === 1,
    visibility: symbol.visibility as SymbolCard["visibility"],
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
}

function countFileTokens(
  filePath: string,
): { bytes: number; lines: number; tokens: number } {
  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      bytes: Buffer.byteLength(content),
      lines: content.split("\n").length,
      tokens: estimateTokens(content),
    };
  } catch {
    return { bytes: 0, lines: 0, tokens: 0 };
  }
}

function walkDir(
  dir: string,
  extensions: string[],
  ignore: string[],
): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = relative(dir, fullPath);

        if (
          ignore.some((pattern) => {
            const cleanPattern = pattern
              .replace(/\*\*/g, "")
              .replace(/\*/g, "");
            return relPath.includes(cleanPattern.replace(/\//g, ""));
          })
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = "." + entry.name.split(".").pop();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  walk(dir);
  return files;
}

// ============================================================================
// Tuning Recommendations
// ============================================================================

function generateRecommendations(result: BenchmarkResult): string[] {
  const recommendations: string[] = [];

  // Check symbol density
  if (result.quality.symbolsPerFile < 3) {
    recommendations.push(
      "Low symbol density (<3/file). Consider expanding indexed file types or reviewing ignore patterns.",
    );
  }

  // Check edge coverage
  if (result.quality.edgesPerSymbol < 1) {
    recommendations.push(
      "Low edge coverage (<1/symbol). Call graph extraction may need tuning - check tree-sitter queries.",
    );
  }

  // Check slice effectiveness using average reduction across all replay traces
  const avgReduction =
    result.tokenAnalysis.length > 0
      ? result.tokenAnalysis.reduce((sum, t) => sum + t.reduction, 0) /
        result.tokenAnalysis.length
      : 0;
  if (avgReduction < 30) {
    recommendations.push(
      `Average token reduction is low (${formatPercent(avgReduction)}). Consider:
   - Increasing maxCards for broader coverage
   - Adjusting edge weights to prioritize call edges
   - Lowering SLICE_SCORE_THRESHOLD for more inclusive slices`,
    );
  }

  // Check indexing performance
  if (result.performance.indexTimePerFile > 100) {
    recommendations.push(
      `Slow indexing (${formatMs(result.performance.indexTimePerFile)}/file). Consider:
   - Increasing indexing concurrency
   - Adding large generated files to ignore list
   - Reducing maxFileBytes threshold`,
    );
  }

  // Check graph connectivity
  if (result.quality.graphConnectivity < 0.3) {
    recommendations.push(
      `Low graph connectivity (${formatPercent(result.quality.graphConnectivity * 100)}). Many symbols are isolated. Check:
   - Import resolution accuracy
   - Call extraction for method chaining`,
    );
  }

  // Check exported symbol ratio
  if (result.quality.exportedSymbolRatio < 0.3) {
    recommendations.push(
      `Few exported symbols (${formatPercent(result.quality.exportedSymbolRatio * 100)}). Consider whether internal symbols should be tracked.`,
    );
  }

  // Check skeleton generation
  if (result.sdlMcp.avgSkeletonTokens === 0) {
    recommendations.push(
      "Skeleton generation returned no results. Verify file paths and symbol ranges are correct.",
    );
  }

  // Token budget recommendations
  const avgTokensPerFile = result.traditional.avgTokensPerFile;
  const currentMaxTokens = result.tuningParameters.slice.maxTokens;
  if (avgTokensPerFile > 0 && currentMaxTokens < avgTokensPerFile * 3) {
    recommendations.push(
      `Slice token budget (${formatNumber(currentMaxTokens)}) may be too restrictive for files averaging ${formatNumber(Math.round(avgTokensPerFile))} tokens. Consider increasing to ${formatNumber(Math.round(avgTokensPerFile * 5))}.`,
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "Configuration looks well-tuned for this codebase. Monitor as codebase grows.",
    );
  }

  return recommendations;
}

// ============================================================================
// Output Formatting
// ============================================================================

function printHeader(title: string): void {
  console.log("\n" + "=".repeat(70));
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

function printSection(title: string): void {
  console.log("\n" + "-".repeat(70));
  console.log(`  ${title}`);
  console.log("-".repeat(70));
}

function printComparisonTable(analyses: TokenAnalysis[]): void {
  console.log("\n  CONTEXT EFFICIENCY COMPARISON");
  console.log("  " + "-".repeat(66));
  console.log(
    "  | Scenario                    | Traditional  | SDL-MCP      | Savings  |",
  );
  console.log(
    "  |-----------------------------+--------------+--------------+----------|",
  );

  for (const analysis of analyses) {
    const scenario = analysis.scenario.padEnd(27);
    const trad = formatNumber(analysis.traditional.tokens).padStart(10);
    const sdl = formatNumber(analysis.sdlMcp.tokens).padStart(10);
    const savings = formatPercent(analysis.reduction).padStart(6);
    const indicator = analysis.winner === "SDL-MCP" ? " *" : "  ";
    const qualifier = analysis.qualifier ? ` ${analysis.qualifier}` : "";

    console.log(
      `  | ${scenario} | ${trad} tk | ${sdl} tk | ${savings}${indicator}${qualifier}|`,
    );
  }

  console.log(
    "  |-----------------------------+--------------+--------------+----------|",
  );
  console.log("  * = SDL-MCP wins this scenario");
}

function printBenefitsSummary(result: BenchmarkResult): void {
  const avgReductionAll =
    result.tokenAnalysis.reduce((sum, a) => sum + a.reduction, 0) /
    result.tokenAnalysis.length;
  const avgCompression =
    result.tokenAnalysis.reduce((sum, a) => sum + a.compressionRatio, 0) /
    result.tokenAnalysis.length;
  const wins = result.tokenAnalysis.filter((a) => a.winner === "SDL-MCP").length;
  const total = result.tokenAnalysis.length;

  console.log("\n  WHY USE SDL-MCP?");
  console.log("  " + "-".repeat(66));
  console.log(`
  WITHOUT SDL-MCP (Traditional Approach):
    - Reading raw files requires loading entire file contents
    - No semantic understanding of code structure
    - Must manually identify relevant dependencies
    - Token usage scales linearly with file count
    - No caching or deduplication of repeated context

  WITH SDL-MCP:
    - Symbol cards provide semantic summaries (~${result.sdlMcp.avgCardTokens} tokens each)
    - Graph slices automatically identify related code
    - Skeletons show structure without implementation details
    - Only load full code when truly necessary (gated access)
    - Intelligent caching reduces repeated context loading

  MEASURED BENEFITS FOR THIS CODEBASE:
    ${progressBar(avgReductionAll)} ${formatPercent(avgReductionAll)} avg token reduction (all scenarios)
    ${avgCompression.toFixed(1)}x average compression ratio
    ${wins}/${total} scenarios where SDL-MCP uses fewer tokens
    ${formatNumber(result.sdlMcp.symbolsIndexed)} symbols indexed across ${formatNumber(result.traditional.totalFiles)} files
    ${formatNumber(result.quality.edgeTypeDistribution.call ?? 0)} call edges + ${formatNumber(result.quality.edgeTypeDistribution.import ?? 0)} import edges tracked
  `);
}

function printTuningParameters(params: TuningParameters): void {
  console.log("\n  CURRENT TUNING PARAMETERS");
  console.log("  " + "-".repeat(66));
  console.log(`
  Slice Configuration:
    maxCards:          ${params.slice.maxCards}
    maxTokens:         ${formatNumber(params.slice.maxTokens)}
    scoreThreshold:    ${params.slice.scoreThreshold}
    maxFrontier:       ${params.slice.maxFrontier}

  Edge Weights (higher = more important):
    call:              ${params.slice.edgeWeights.call}
    config:            ${params.slice.edgeWeights.config}
    import:            ${params.slice.edgeWeights.import}

  Token Estimation:
    baseTokensPerSymbol:  ${params.tokenEstimation.baseTokensPerSymbol}
    maxTokensPerSymbol:   ${params.tokenEstimation.maxTokensPerSymbol}
    algorithm:            ${params.tokenEstimation.algorithm}
  `);
}

function printPerformanceMetrics(perf: PerformanceMetrics): void {
  console.log("\n  PERFORMANCE METRICS");
  console.log("  " + "-".repeat(66));
  console.log(`
  Indexing:
    Total time:           ${formatMs(perf.indexTimeMs)}
    Per file:             ${formatMs(perf.indexTimePerFile)}
    Per symbol:           ${formatMs(perf.indexTimePerSymbol)}

  Runtime Operations:
    Slice build:          ${formatMs(perf.sliceBuildTimeMs)}
    Skeleton generation:  ${formatMs(perf.skeletonGenerationTimeMs)}
    Avg skeleton time:    ${formatMs(perf.avgSkeletonTimeMs)}
  `);
}

function printRecommendations(recommendations: string[]): void {
  console.log("\n  TUNING RECOMMENDATIONS");
  console.log("  " + "-".repeat(66));

  for (let i = 0; i < recommendations.length; i++) {
    console.log(`\n  ${i + 1}. ${recommendations[i]}`);
  }
}

// ============================================================================
// Main Benchmark
// ============================================================================

async function runBenchmark(
  repoId?: string,
  traceFilePath: string = DEFAULT_REPLAY_TRACE_PATH,
): Promise<BenchmarkResult[]> {
  const config = loadConfig();
  const database = getDb(config.dbPath);
  runMigrations(database);

  const results: BenchmarkResult[] = [];
  const reposToTest = repoId
    ? config.repos.filter((r) => r.repoId === repoId)
    : config.repos;

  const tuningParameters: TuningParameters = {
    slice: {
      maxCards: config.slice?.defaultMaxCards ?? DEFAULT_MAX_CARDS,
      maxTokens: config.slice?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS_SLICE,
      scoreThreshold: SLICE_SCORE_THRESHOLD,
      maxFrontier: MAX_FRONTIER,
      edgeWeights: config.slice?.edgeWeights ?? {
        call: 1.0,
        import: 0.6,
        config: 0.8,
      },
    },
    tokenEstimation: {
      baseTokensPerSymbol: SYMBOL_TOKEN_BASE,
      maxTokensPerSymbol: SYMBOL_TOKEN_MAX,
      algorithm: "structural-aware (tokenize.ts)",
    },
  };

  for (const repoConfig of reposToTest) {
    printHeader(`BENCHMARKING: ${repoConfig.repoId}`);
    console.log(`  Repository: ${repoConfig.rootPath}`);

    // Ensure repo is registered
    let repo = db.getRepo(repoConfig.repoId);
    if (!repo) {
      console.log("  Registering repository...");
      db.createRepo({
        repo_id: repoConfig.repoId,
        root_path: repoConfig.rootPath,
        config_json: JSON.stringify(repoConfig),
        created_at: new Date().toISOString(),
      });
    }

    // Index with timing
    console.log("  Indexing repository...");
    const indexStart = performance.now();
    const indexResult = await indexRepo(repoConfig.repoId, "full");
    const indexTimeMs = performance.now() - indexStart;

    printSection("TRADITIONAL APPROACH (Raw Files)");

    const extensions = repoConfig.languages.map((l: string) => `.${l}`);
    const files = walkDir(repoConfig.rootPath, extensions, repoConfig.ignore);

    let totalBytes = 0;
    let totalLines = 0;
    let totalTokens = 0;

    for (const file of files) {
      const stats = countFileTokens(file);
      totalBytes += stats.bytes;
      totalLines += stats.lines;
      totalTokens += stats.tokens;
    }

    const avgTokensPerFile = files.length > 0 ? totalTokens / files.length : 0;

    console.log(`
  Files scanned:        ${formatNumber(files.length)}
  Total size:           ${formatBytes(totalBytes)}
  Total lines:          ${formatNumber(totalLines)}
  Estimated tokens:     ${formatNumber(totalTokens)}
  Avg tokens/file:      ${formatNumber(Math.round(avgTokensPerFile))}
    `);

    printSection("SDL-MCP APPROACH (Cards + Slices)");

    const allSymbols = db.getSymbolsByRepo(repoConfig.repoId);
    const edges = db.getEdgesByRepo(repoConfig.repoId);

    // Sample cards for token estimation
    const srcSymbols = allSymbols.filter((s) => {
      const file = db.getFile(s.file_id);
      return file?.rel_path.startsWith("src/");
    });
    const sampleSize = Math.min(20, srcSymbols.length || allSymbols.length);
    const sampleSymbols = (srcSymbols.length > 0 ? srcSymbols : allSymbols).slice(
      0,
      sampleSize,
    );

    let totalCardTokens = 0;
    let totalSkeletonTokens = 0;
    let skeletonCount = 0;
    let skeletonTimeMs = 0;

    for (const symbol of sampleSymbols) {
      try {
        const card = buildCardFromSymbol(repoConfig.repoId, symbol);
        if (card) {
          totalCardTokens += estimateTokens(JSON.stringify(card));
        }

        if (symbol.kind === "function" || symbol.kind === "method") {
          const skelStart = performance.now();
          try {
            const skeleton = generateSymbolSkeleton(
              repoConfig.repoId,
              symbol.symbol_id,
            );
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

    const avgCardTokens =
      sampleSize > 0 ? Math.round(totalCardTokens / sampleSize) : 0;
    const avgSkeletonTokens =
      skeletonCount > 0 ? Math.round(totalSkeletonTokens / skeletonCount) : 0;

    // Build sample slice with timing
    let sliceTokens = 0;
    let sliceCards = 0;
    let sliceSeedSymbol = "none";
    let sliceFrontierSize = 0;
    let sliceBuildTimeMs = 0;

    if (allSymbols.length > 0) {
      const srcFunctionSymbols = allSymbols.filter((s) => {
        if (s.kind !== "function") return false;
        const file = db.getFile(s.file_id);
        return file?.rel_path.startsWith("src/");
      });
      const functionSymbols =
        srcFunctionSymbols.length > 0
          ? srcFunctionSymbols
          : allSymbols.filter((s) => s.kind === "function");

      let seedSymbol = functionSymbols[0] || allSymbols[0];
      for (const sym of functionSymbols) {
        const outEdges = db.getEdgesFrom(sym.symbol_id);
        if (outEdges.length > 3) {
          seedSymbol = sym;
          break;
        }
      }
      sliceSeedSymbol = seedSymbol.name;

      const latestVersion = db.getLatestVersion(repoConfig.repoId);
      const versionId = latestVersion?.version_id ?? "current";

      try {
        const sliceStart = performance.now();
        const slice = await buildSlice({
          repoId: repoConfig.repoId,
          versionId,
          entrySymbols: [seedSymbol.symbol_id],
          taskText: "understand implementation",
          budget: { maxCards: 20, maxEstimatedTokens: 4000 },
        });
        sliceBuildTimeMs = performance.now() - sliceStart;

        sliceCards = slice.cards.length;
        sliceTokens = estimateTokens(
          JSON.stringify({ cards: slice.cards, cardRefs: slice.cardRefs ?? [] }),
        );
        sliceFrontierSize = slice.frontier?.length ?? 0;
      } catch (e) {
        console.log(`  Slice build error: ${e}`);
      }
    }

    console.log(`
  Symbols indexed:      ${formatNumber(allSymbols.length)}
  Total edges:          ${formatNumber(edges.length)}
  Avg card tokens:      ${formatNumber(avgCardTokens)}
  Avg skeleton tokens:  ${formatNumber(avgSkeletonTokens)}

  Sample Slice (20 cards max):
    Seed symbol:        ${sliceSeedSymbol}
    Cards returned:     ${sliceCards}
    Tokens:             ${formatNumber(sliceTokens)}
    Frontier size:      ${sliceFrontierSize}
    `);

    // Calculate quality metrics
    const edgeTypes = edges.reduce(
      (acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const exportedCount = allSymbols.filter((s) => s.exported === 1).length;
    const functionMethodCount = allSymbols.filter(
      (s) => s.kind === "function" || s.kind === "method",
    ).length;

    // Only count connectivity among indexed symbols (edges can reference external/unresolved nodes).
    const indexedSymbolIds = new Set(allSymbols.map((s) => s.symbol_id));
    const symbolsWithInternalEdges = new Set(
      edges
        .flatMap((e) => [e.from_symbol_id, e.to_symbol_id])
        .filter((id) => indexedSymbolIds.has(id)),
    ).size;
    const graphConnectivity =
      allSymbols.length > 0 ? symbolsWithInternalEdges / allSymbols.length : 0;

    const totalDeps = edges.length;
    const avgDepsPerSymbol =
      allSymbols.length > 0 ? totalDeps / allSymbols.length : 0;

    const quality: QualityMetrics = {
      symbolsPerFile: files.length > 0 ? allSymbols.length / files.length : 0,
      edgesPerSymbol: allSymbols.length > 0 ? edges.length / allSymbols.length : 0,
      edgeTypeDistribution: edgeTypes,
      exportedSymbolRatio:
        allSymbols.length > 0 ? exportedCount / allSymbols.length : 0,
      functionMethodRatio:
        allSymbols.length > 0 ? functionMethodCount / allSymbols.length : 0,
      avgDepsPerSymbol,
      graphConnectivity,
    };

    const traces = loadReplayTraces(traceFilePath, repoConfig.repoId);
    const tokenAnalysis = traces.map((trace) =>
      buildTokenAnalysisFromTrace(trace),
    );
    console.log(
      `\n  Replay traces loaded: ${traces.length} from ${resolve(traceFilePath)}`,
    );

    const performance_metrics: PerformanceMetrics = {
      indexTimeMs,
      indexTimePerFile: files.length > 0 ? indexTimeMs / files.length : 0,
      indexTimePerSymbol:
        allSymbols.length > 0 ? indexTimeMs / allSymbols.length : 0,
      sliceBuildTimeMs,
      skeletonGenerationTimeMs: skeletonTimeMs,
      avgSkeletonTimeMs: skeletonCount > 0 ? skeletonTimeMs / skeletonCount : 0,
      dbQueryTimeMs: 0, // Not measured individually yet
    };

    const result: BenchmarkResult = {
      timestamp: new Date().toISOString(),
      repoId: repoConfig.repoId,
      repoPath: repoConfig.rootPath,
      tuningParameters,
      performance: performance_metrics,
      traditional: {
        totalFiles: files.length,
        totalBytes,
        totalLines,
        estimatedTokens: totalTokens,
        avgTokensPerFile,
      },
      sdlMcp: {
        symbolsIndexed: allSymbols.length,
        avgCardTokens,
        avgSkeletonTokens,
        sampleSlice: {
          seedSymbol: sliceSeedSymbol,
          cards: sliceCards,
          tokens: sliceTokens,
          frontierSize: sliceFrontierSize,
        },
      },
      quality,
      tokenAnalysis,
      traceSource: {
        traceFile: resolve(traceFilePath),
        traceCount: tokenAnalysis.length,
      },
      recommendations: [],
    };

    // Generate recommendations
    result.recommendations = generateRecommendations(result);

    // Print formatted output
    printSection("QUALITY METRICS");
    console.log(`
  Symbol Coverage:
    Symbols per file:        ${result.quality.symbolsPerFile.toFixed(1)}
    Exported ratio:          ${formatPercent(result.quality.exportedSymbolRatio * 100)}
    Function/method ratio:   ${formatPercent(result.quality.functionMethodRatio * 100)}

  Graph Quality:
    Edges per symbol:        ${result.quality.edgesPerSymbol.toFixed(2)}
    Graph connectivity:      ${formatPercent(result.quality.graphConnectivity * 100)}
    Avg deps per symbol:     ${result.quality.avgDepsPerSymbol.toFixed(2)}

  Edge Distribution:
    Call edges:              ${formatNumber(edgeTypes.call ?? 0)}
    Import edges:            ${formatNumber(edgeTypes.import ?? 0)}
    Config edges:            ${formatNumber(edgeTypes.config ?? 0)}
    `);

    printComparisonTable(tokenAnalysis);
    printBenefitsSummary(result);
    printTuningParameters(tuningParameters);
    printPerformanceMetrics(performance_metrics);
    printRecommendations(result.recommendations);

    results.push(result);
  }

  return results;
}

function printFinalSummary(results: BenchmarkResult[]): void {
  if (results.length <= 1) return;

  printHeader("OVERALL SUMMARY");

  const avgReduction =
    results.reduce(
      (sum, r) =>
        sum +
        r.tokenAnalysis.reduce((s, a) => s + a.reduction, 0) /
          r.tokenAnalysis.length,
      0,
    ) / results.length;

  const avgCompression =
    results.reduce(
      (sum, r) =>
        sum +
        r.tokenAnalysis.reduce((s, a) => s + a.compressionRatio, 0) /
          r.tokenAnalysis.length,
      0,
    ) / results.length;

  const totalSymbols = results.reduce(
    (sum, r) => sum + r.sdlMcp.symbolsIndexed,
    0,
  );
  const totalFiles = results.reduce(
    (sum, r) => sum + r.traditional.totalFiles,
    0,
  );

  console.log(`
  Repositories tested:     ${results.length}
  Total files indexed:     ${formatNumber(totalFiles)}
  Total symbols indexed:   ${formatNumber(totalSymbols)}

  Average token reduction: ${formatPercent(avgReduction)}
  Average compression:     ${avgCompression.toFixed(1)}x
  `);
}

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
let targetRepoId: string | undefined;
let outputPath: string | undefined;
let jsonOutput = false;
let traceFilePath = DEFAULT_REPLAY_TRACE_PATH;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo-id" && args[i + 1]) {
    targetRepoId = args[i + 1];
  }
  if (args[i] === "--out" && args[i + 1]) {
    outputPath = args[i + 1];
  }
  if (args[i] === "--json") {
    jsonOutput = true;
  }
  if (args[i] === "--trace-file" && args[i + 1]) {
    traceFilePath = args[i + 1];
  }
}

printHeader("SDL-MCP EFFECTIVENESS BENCHMARK");
console.log(`
  This benchmark measures how SDL-MCP reduces token usage compared to
  traditional file-based code context approaches.

  Results include:
  - Token savings across different scenarios
  - Quality metrics for symbol extraction and graph building
  - Performance measurements for indexing and runtime operations
  - Replay trace based scenario analysis (no hypothetical scenario assumptions)
  - Tuning recommendations based on your codebase characteristics
`);

runBenchmark(targetRepoId, traceFilePath)
  .then((results) => {
    printFinalSummary(results);

    if (outputPath || jsonOutput) {
      const output = {
        benchmarkVersion: "2.0",
        generatedAt: new Date().toISOString(),
        results,
      };
      const json = JSON.stringify(output, null, 2);

      if (outputPath) {
        writeFileSync(resolve(outputPath), json, "utf-8");
        console.log(`\n  Results saved to: ${outputPath}`);
      }
      if (jsonOutput && !outputPath) {
        console.log("\n" + json);
      }
    }

    printHeader("BENCHMARK COMPLETE");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nBenchmark failed:", error);
    process.exit(1);
  });
