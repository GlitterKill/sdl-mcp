#!/usr/bin/env tsx
/**
 * Real-world Use Case Benchmark for SDL-MCP
 *
 * Compares traditional "grep + open files" workflow against SDL-MCP slices
 * on realistic maintenance tasks. Measures precision, recall, and efficiency.
 *
 * Usage:
 *   npm run benchmark:real
 *   npm run benchmark:real -- --tasks benchmarks/real-world/tasks.json
 *   npm run benchmark:real -- --repo-id my-repo --skip-index
 *   npm run benchmark:real -- --out benchmarks/real-world/results.json
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import fg from "fast-glob";
import { getDb } from "../src/db/db.js";
import { runMigrations } from "../src/db/migrations.js";
import { loadConfig } from "../src/config/loadConfig.js";
import * as db from "../src/db/queries.js";
import { indexRepo } from "../src/indexer/indexer.js";
import { buildSlice } from "../src/graph/slice.js";
import { generateSymbolSkeleton } from "../src/code/skeleton.js";
import { estimateTokens } from "../src/util/tokenize.js";
import { normalizePath, getRelativePath } from "../src/util/paths.js";
import type { SymbolRow } from "../src/db/schema.js";
import type { GraphSlice } from "../src/mcp/types.js";

// ============================================================================
// Types
// ============================================================================

interface TaskDefaults {
  baseline: {
    maxFiles: number;
  };
  sdl: {
    maxCards: number;
    maxTokens: number;
    maxEntrySymbols: number;
    maxSkeletons: number;
    skeletonMaxLines: number;
    skeletonMaxTokens: number;
  };
}

interface UseCaseTask {
  id: string;
  title: string;
  description: string;
  repoId?: string;
  queryTerms: string[];
  entrySymbolNames?: string[];
  relevantFiles?: string[];
  relevantSymbols?: string[];
  baseline?: Partial<TaskDefaults["baseline"]>;
  sdl?: Partial<TaskDefaults["sdl"]>;
}

interface TaskFile {
  version: number;
  defaults: TaskDefaults;
  tasks: UseCaseTask[];
}

interface BaselineSelection {
  files: string[];
  tokens: number;
  matchedFiles: number;
  matchedTerms: number;
  symbolsFound: number;
  relevantFilesFound: number;
  relevantFilesTotal: number;
  relevantSymbolsFound: number;
  relevantSymbolsTotal: number;
  tokensPerRelevantFile: number;
  precision: number;
  recall: number;
}

interface SdlSelection {
  entrySymbols: string[];
  slice: GraphSlice | null;
  cards: number;
  skeletons: number;
  tokens: number;
  symbolsFound: number;
  relevantFilesFound: number;
  relevantFilesTotal: number;
  relevantSymbolsFound: number;
  relevantSymbolsTotal: number;
  tokensPerRelevantFile: number;
  precision: number;
  recall: number;
  sliceBuildTimeMs: number;
  skeletonTimeMs: number;
}

interface TaskResult {
  id: string;
  title: string;
  description: string;
  baseline: BaselineSelection;
  sdl: SdlSelection;
  comparison: {
    tokenReductionPct: number;
    coverageGain: number;
    symbolCoverageGain: number;
    precisionGain: number;
    recallGain: number;
    efficiencyRatio: number;
    winner: "SDL-MCP" | "Traditional" | "Tie";
  };
}

interface BenchmarkSummary {
  repoId: string;
  rootPath: string;
  timestamp: string;
  taskCount: number;
  avgTokenReduction: number;
  avgCoverageGain: number;
  avgSymbolGain: number;
  avgPrecisionGain: number;
  avgRecallGain: number;
  avgEfficiencyRatio: number;
  sdlWins: number;
  traditionalWins: number;
  ties: number;
  tuningInsights: string[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TASKS_PATH = "benchmarks/real-world/tasks.json";

const FALLBACK_DEFAULTS: TaskDefaults = {
  baseline: {
    maxFiles: 6,
  },
  sdl: {
    maxCards: 20,
    maxTokens: 4000,
    maxEntrySymbols: 2,
    maxSkeletons: 2,
    skeletonMaxLines: 120,
    skeletonMaxTokens: 1500,
  },
};

// ============================================================================
// Utilities
// ============================================================================

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

function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(2);
}

function progressBar(percent: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
}

function getArgValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) {
    return direct.slice(name.length + 3);
  }
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) {
    return args[idx + 1];
  }
  return undefined;
}

function normalizeRelPath(repoRoot: string, absPath: string): string {
  return normalizePath(getRelativePath(repoRoot, absPath));
}

function expandRelevantFiles(
  repoRoot: string,
  patterns: string[] | undefined,
): Set<string> {
  if (!patterns || patterns.length === 0) {
    return new Set();
  }
  const matches = fg.sync(patterns, {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
  });
  return new Set(matches.map((p) => normalizePath(p)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoreContent(
  content: string,
  terms: string[],
): { score: number; hits: number } {
  let score = 0;
  let hits = 0;
  for (const term of terms) {
    if (!term) continue;
    const regex = new RegExp(escapeRegExp(term), "gi");
    const matches = content.match(regex);
    if (matches && matches.length > 0) {
      score += matches.length;
      hits += matches.length;
    }
  }
  return { score, hits };
}

function buildSymbolRegex(symbol: string): RegExp {
  const escaped = escapeRegExp(symbol);
  const hasNonWord = /[^A-Za-z0-9_]/.test(symbol);
  if (hasNonWord) {
    return new RegExp(escaped, "i");
  }
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function countSymbolsInText(text: string, symbols: Set<string>): number {
  if (symbols.size === 0 || !text) return 0;
  let count = 0;
  for (const symbol of symbols) {
    if (!symbol) continue;
    const regex = buildSymbolRegex(symbol);
    if (regex.test(text)) {
      count++;
    }
  }
  return count;
}

function normalizeSymbolName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.toLowerCase();
}

function collectDependencyNames(symbolIds: string[]): Set<string> {
  const names = new Set<string>();
  for (const symbolId of symbolIds) {
    if (!symbolId) continue;
    const unresolvedPrefix = "unresolved:call:";
    if (symbolId.startsWith(unresolvedPrefix)) {
      const unresolvedName = symbolId.slice(unresolvedPrefix.length).trim();
      if (unresolvedName) {
        names.add(unresolvedName.toLowerCase());
      }
      continue;
    }
    const depSymbol = db.getSymbol(symbolId);
    if (depSymbol?.name) {
      names.add(depSymbol.name.toLowerCase());
    }
  }
  return names;
}

function collectCandidateFiles(
  repoRoot: string,
  languages: string[],
  ignore: string[],
): string[] {
  const patterns = languages.map((lang) => `**/*.${lang}`);
  return fg.sync(patterns, {
    cwd: repoRoot,
    ignore,
    dot: true,
    onlyFiles: true,
    absolute: true,
  });
}

function findSymbolsByName(
  repoId: string,
  names: string[],
  limit: number,
): SymbolRow[] {
  const results: SymbolRow[] = [];
  for (const name of names) {
    if (!name) continue;
    const matches = db.searchSymbols(repoId, name, limit);
    if (matches.length === 0) {
      continue;
    }
    const exact = matches.find((m) => m.name === name);
    results.push(exact ?? matches[0]);
  }
  return results;
}

function mergeDefaults(
  defaults: TaskDefaults,
  overrides?: UseCaseTask,
): TaskDefaults {
  return {
    baseline: {
      maxFiles: overrides?.baseline?.maxFiles ?? defaults.baseline.maxFiles,
    },
    sdl: {
      maxCards: overrides?.sdl?.maxCards ?? defaults.sdl.maxCards,
      maxTokens: overrides?.sdl?.maxTokens ?? defaults.sdl.maxTokens,
      maxEntrySymbols:
        overrides?.sdl?.maxEntrySymbols ?? defaults.sdl.maxEntrySymbols,
      maxSkeletons:
        overrides?.sdl?.maxSkeletons ?? defaults.sdl.maxSkeletons,
      skeletonMaxLines:
        overrides?.sdl?.skeletonMaxLines ?? defaults.sdl.skeletonMaxLines,
      skeletonMaxTokens:
        overrides?.sdl?.skeletonMaxTokens ?? defaults.sdl.skeletonMaxTokens,
    },
  };
}

function computeTokenReduction(
  baselineTokens: number,
  sdlTokens: number,
): number {
  if (baselineTokens <= 0 || sdlTokens <= 0) {
    return 0;
  }
  return (1 - sdlTokens / baselineTokens) * 100;
}

function computeCoverageGain(
  baselineFound: number,
  sdlFound: number,
  total: number,
): number {
  if (total <= 0) return 0;
  return (sdlFound - baselineFound) / total;
}

function computePrecision(found: number, total: number): number {
  if (total <= 0) return 0;
  return found / total;
}

function computeRecall(found: number, relevant: number): number {
  if (relevant <= 0) return 0;
  return found / relevant;
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

function printTaskHeader(task: UseCaseTask): void {
  console.log("\n" + "-".repeat(70));
  console.log(`  TASK: ${task.title}`);
  console.log(`  ID: ${task.id}`);
  console.log("-".repeat(70));
  console.log(`  ${task.description}`);
}

function printComparisonTable(result: TaskResult): void {
  const b = result.baseline;
  const s = result.sdl;
  const c = result.comparison;

  console.log("\n  COMPARISON TABLE");
  console.log("  " + "-".repeat(64));
  console.log(
    "  | Metric                    | Traditional    | SDL-MCP        | Winner |",
  );
  console.log(
    "  |---------------------------+----------------+----------------+--------|",
  );

  // Tokens (lower is better)
  const tokWinner = s.tokens < b.tokens ? "SDL" : b.tokens < s.tokens ? "Trad" : "Tie";
  console.log(
    `  | Tokens                    | ${formatNumber(b.tokens).padStart(12)} | ${formatNumber(s.tokens).padStart(12)} | ${tokWinner.padStart(6)} |`,
  );

  // Files/Cards
  console.log(
    `  | Files/Cards               | ${String(b.files.length).padStart(12)} | ${String(s.cards).padStart(12)} |        |`,
  );

  // Coverage (higher is better)
  const bCov = b.relevantFilesTotal > 0 ? (b.relevantFilesFound / b.relevantFilesTotal) * 100 : 0;
  const sCov = s.relevantFilesTotal > 0 ? (s.relevantFilesFound / s.relevantFilesTotal) * 100 : 0;
  const covWinner = sCov > bCov ? "SDL" : bCov > sCov ? "Trad" : "Tie";
  console.log(
    `  | File Coverage             | ${formatPercent(bCov).padStart(12)} | ${formatPercent(sCov).padStart(12)} | ${covWinner.padStart(6)} |`,
  );

  // Symbol Coverage
  const bSymCov = b.relevantSymbolsTotal > 0 ? (b.relevantSymbolsFound / b.relevantSymbolsTotal) * 100 : 0;
  const sSymCov = s.relevantSymbolsTotal > 0 ? (s.relevantSymbolsFound / s.relevantSymbolsTotal) * 100 : 0;
  const symWinner = sSymCov > bSymCov ? "SDL" : bSymCov > sSymCov ? "Trad" : "Tie";
  console.log(
    `  | Symbol Coverage           | ${formatPercent(bSymCov).padStart(12)} | ${formatPercent(sSymCov).padStart(12)} | ${symWinner.padStart(6)} |`,
  );

  // Precision
  const precWinner = s.precision > b.precision ? "SDL" : b.precision > s.precision ? "Trad" : "Tie";
  console.log(
    `  | Precision                 | ${formatPercent(b.precision * 100).padStart(12)} | ${formatPercent(s.precision * 100).padStart(12)} | ${precWinner.padStart(6)} |`,
  );

  // Recall
  const recWinner = s.recall > b.recall ? "SDL" : b.recall > s.recall ? "Trad" : "Tie";
  console.log(
    `  | Recall                    | ${formatPercent(b.recall * 100).padStart(12)} | ${formatPercent(s.recall * 100).padStart(12)} | ${recWinner.padStart(6)} |`,
  );

  // Tokens per relevant file (lower is better - efficiency)
  const effWinner = s.tokensPerRelevantFile < b.tokensPerRelevantFile ? "SDL" :
                   b.tokensPerRelevantFile < s.tokensPerRelevantFile ? "Trad" : "Tie";
  console.log(
    `  | Tokens/Relevant File      | ${formatRatio(b.tokensPerRelevantFile).padStart(12)} | ${formatRatio(s.tokensPerRelevantFile).padStart(12)} | ${effWinner.padStart(6)} |`,
  );

  console.log(
    "  |---------------------------+----------------+----------------+--------|",
  );

  // Summary row
  const overallWinner = c.winner === "SDL-MCP" ? "SDL-MCP" : c.winner === "Traditional" ? "Traditional" : "Tie";
  console.log(`  | OVERALL WINNER: ${overallWinner.padEnd(52)}|`);
  console.log(`  | Token Reduction: ${formatPercent(c.tokenReductionPct).padEnd(51)}|`);
  console.log(
    "  " + "-".repeat(64),
  );
}

function printBenefitsSummary(summary: BenchmarkSummary): void {
  console.log("\n  SDL-MCP BENEFITS FOR REAL-WORLD TASKS");
  console.log("  " + "-".repeat(64));
  console.log(`
  TASK-BASED COMPARISON:
    Tasks tested:              ${summary.taskCount}
    SDL-MCP wins:              ${summary.sdlWins}
    Traditional wins:          ${summary.traditionalWins}
    Ties:                      ${summary.ties}

  EFFICIENCY METRICS:
    ${progressBar(summary.avgTokenReduction)} ${formatPercent(summary.avgTokenReduction)} avg token reduction
    ${progressBar(summary.avgCoverageGain * 100 + 50)} ${formatPercent(summary.avgCoverageGain * 100)} avg coverage gain
    ${progressBar(summary.avgSymbolGain * 100 + 50)} ${formatPercent(summary.avgSymbolGain * 100)} avg symbol coverage gain
    ${formatRatio(summary.avgEfficiencyRatio)}x avg efficiency ratio (tokens saved per coverage point)

  PRECISION & RECALL:
    ${progressBar(summary.avgPrecisionGain * 100 + 50)} ${formatPercent(summary.avgPrecisionGain * 100)} avg precision improvement
    ${progressBar(summary.avgRecallGain * 100 + 50)} ${formatPercent(summary.avgRecallGain * 100)} avg recall improvement

  WHY THIS MATTERS:
    - Lower tokens = faster response times and lower API costs
    - Higher precision = less noise in context (relevant files only)
    - Higher recall = fewer missed dependencies
    - Better efficiency = more value per token spent
  `);
}

function printTuningInsights(insights: string[]): void {
  if (insights.length === 0) return;

  console.log("\n  TUNING INSIGHTS FROM BENCHMARK RESULTS");
  console.log("  " + "-".repeat(64));

  for (let i = 0; i < insights.length; i++) {
    console.log(`\n  ${i + 1}. ${insights[i]}`);
  }
}

function generateTuningInsights(results: TaskResult[]): string[] {
  const insights: string[] = [];

  // Check if any tasks had low SDL coverage
  const lowCoverageTasks = results.filter(
    (r) => r.sdl.relevantFilesTotal > 0 &&
           r.sdl.relevantFilesFound / r.sdl.relevantFilesTotal < 0.5
  );
  if (lowCoverageTasks.length > 0) {
    insights.push(
      `${lowCoverageTasks.length} task(s) had <50% file coverage. Consider:
   - Increasing maxCards to expand slice breadth
   - Adding more entry symbol names to task definitions
   - Reviewing edge weights (call edges may need higher weight)`
    );
  }

  // Check if baseline outperformed SDL in any task
  const baselineWins = results.filter((r) => r.comparison.winner === "Traditional");
  if (baselineWins.length > 0) {
    insights.push(
      `Traditional approach won ${baselineWins.length} task(s). This may indicate:
   - Entry symbols not well-connected in the graph
   - Query terms better suited to text search
   - Consider adding skeleton generation for these cases`
    );
  }

  // Check for high token usage despite good coverage
  const highTokenTasks = results.filter(
    (r) => r.sdl.tokens > r.baseline.tokens * 0.8 &&
           r.sdl.relevantFilesFound >= r.baseline.relevantFilesFound
  );
  if (highTokenTasks.length > 0) {
    insights.push(
      `${highTokenTasks.length} task(s) used many tokens despite good coverage. Consider:
   - Reducing maxCards for tighter slices
   - Using skeletons instead of full cards where possible
   - Lowering maxTokens budget to force prioritization`
    );
  }

  // Check for low precision
  const lowPrecisionTasks = results.filter((r) => r.sdl.precision < 0.3);
  if (lowPrecisionTasks.length > 0) {
    insights.push(
      `${lowPrecisionTasks.length} task(s) had low precision (<30%). Consider:
   - Increasing SLICE_SCORE_THRESHOLD to be more selective
   - Reviewing entry symbol choices for better relevance
   - Using task text for slice building to improve targeting`
    );
  }

  // Check for slow operations
  const slowTasks = results.filter(
    (r) => r.sdl.sliceBuildTimeMs > 500 || r.sdl.skeletonTimeMs > 500
  );
  if (slowTasks.length > 0) {
    insights.push(
      `${slowTasks.length} task(s) had slow operations (>500ms). Consider:
   - Reducing maxCards/maxFrontier for faster slice builds
   - Enabling caching for repeated operations
   - Profiling specific symbol lookups`
    );
  }

  if (insights.length === 0) {
    insights.push(
      "Benchmark results look healthy. Current configuration appears well-suited for these tasks."
    );
  }

  return insights;
}

// ============================================================================
// Main Benchmark
// ============================================================================

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const tasksPath = resolve(getArgValue(args, "tasks") ?? DEFAULT_TASKS_PATH);
  const repoOverride = getArgValue(args, "repo-id");
  const configPath = getArgValue(args, "config");
  const outPath = getArgValue(args, "out");
  const skipIndex = args.includes("--skip-index");

  const taskFileRaw = readFileSync(tasksPath, "utf-8");
  const taskFile = JSON.parse(taskFileRaw) as TaskFile;

  const defaults = taskFile.defaults ?? FALLBACK_DEFAULTS;
  const config = loadConfig(configPath);
  const database = getDb(config.dbPath);
  runMigrations(database);

  const repoConfig = repoOverride
    ? config.repos.find((r) => r.repoId === repoOverride)
    : config.repos[0];

  if (!repoConfig) {
    throw new Error("No repository configured for benchmark.");
  }

  if (!skipIndex) {
    console.log(`Indexing repo ${repoConfig.repoId}...`);
    await indexRepo(repoConfig.repoId, "full");
  }

  const candidateFiles = collectCandidateFiles(
    repoConfig.rootPath,
    repoConfig.languages ?? ["ts", "tsx", "js", "jsx"],
    repoConfig.ignore ?? [],
  );

  const results: TaskResult[] = [];

  printHeader("SDL-MCP REAL-WORLD USE CASE BENCHMARK");
  console.log(`
  This benchmark compares SDL-MCP against traditional file-based approaches
  on realistic software maintenance tasks.

  Repository: ${repoConfig.repoId}
  Root Path:  ${repoConfig.rootPath}
  Tasks:      ${taskFile.tasks.length}
  `);

  for (const task of taskFile.tasks) {
    if (task.repoId && task.repoId !== repoConfig.repoId) {
      continue;
    }

    printTaskHeader(task);

    const merged = mergeDefaults(defaults, task);
    const relevantFiles = expandRelevantFiles(
      repoConfig.rootPath,
      task.relevantFiles,
    );
    const relevantSymbols = new Set(
      (task.relevantSymbols ?? [])
        .map((s) => normalizeSymbolName(s))
        .filter((s): s is string => !!s),
    );

    const searchTerms = Array.from(
      new Set([...(task.queryTerms ?? []), ...(task.entrySymbolNames ?? [])]),
    ).filter((term) => term && term.trim().length > 0);

    // ====== BASELINE APPROACH ======
    console.log("\n  [Baseline] Searching files with grep-style matching...");

    const fileEntries: Array<{
      absPath: string;
      relPath: string;
      tokens: number;
      score: number;
      content: string;
    }> = [];

    let matchedFiles = 0;
    let matchedTerms = 0;

    for (const file of candidateFiles) {
      let content = "";
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      const { score, hits } = scoreContent(content, searchTerms);
      if (score <= 0) {
        continue;
      }
      matchedFiles++;
      matchedTerms += hits;
      fileEntries.push({
        absPath: file,
        relPath: normalizeRelPath(repoConfig.rootPath, file),
        tokens: estimateTokens(content),
        score,
        content,
      });
    }

    fileEntries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.relPath.localeCompare(b.relPath);
    });

    const selectedFiles = fileEntries.slice(0, merged.baseline.maxFiles);
    const baselineTokens = selectedFiles.reduce(
      (sum, entry) => sum + entry.tokens,
      0,
    );

    const baselineRelevantFilesFound = selectedFiles.filter((entry) =>
      relevantFiles.has(entry.relPath),
    ).length;

    const baselineText = selectedFiles.map((entry) => entry.content).join("\n");
    const baselineRelevantSymbolsFound = countSymbolsInText(
      baselineText,
      relevantSymbols,
    );

    const baselineTokensPerRelevant =
      baselineRelevantFilesFound > 0
        ? baselineTokens / baselineRelevantFilesFound
        : baselineTokens;

    const baselinePrecision = computePrecision(
      baselineRelevantFilesFound,
      selectedFiles.length,
    );
    const baselineRecall = computeRecall(
      baselineRelevantFilesFound,
      relevantFiles.size,
    );

    const baseline: BaselineSelection = {
      files: selectedFiles.map((entry) => entry.relPath),
      tokens: baselineTokens,
      matchedFiles,
      matchedTerms,
      symbolsFound: baselineRelevantSymbolsFound,
      relevantFilesFound: baselineRelevantFilesFound,
      relevantFilesTotal: relevantFiles.size,
      relevantSymbolsFound: baselineRelevantSymbolsFound,
      relevantSymbolsTotal: relevantSymbols.size,
      tokensPerRelevantFile: baselineTokensPerRelevant,
      precision: baselinePrecision,
      recall: baselineRecall,
    };

    console.log(`    Files matched: ${matchedFiles}, Selected: ${selectedFiles.length}`);
    console.log(`    Tokens: ${formatNumber(baselineTokens)}`);

    // ====== SDL-MCP APPROACH ======
    console.log("\n  [SDL-MCP] Building slice from entry symbols...");

    const entrySymbolNames = task.entrySymbolNames ?? [];
    const entrySymbols = findSymbolsByName(
      repoConfig.repoId,
      entrySymbolNames,
      3,
    );

    const querySymbols = findSymbolsByName(repoConfig.repoId, searchTerms, 2);

    const entrySymbolIds = Array.from(
      new Set(
        [...entrySymbols, ...querySymbols].map((symbol) => symbol.symbol_id),
      ),
    ).slice(0, merged.sdl.maxEntrySymbols);

    let slice: GraphSlice | null = null;
    let sliceTokens = 0;
    let sliceCardCount = 0;
    let sliceBuildTimeMs = 0;
    const sliceFiles = new Set<string>();
    const sliceSymbolNames = new Set<string>();
    const depSymbolNames = new Set<string>();

    if (entrySymbolIds.length > 0) {
      const latestVersion = db.getLatestVersion(repoConfig.repoId);
      const versionId = latestVersion?.version_id ?? "current";

      const sliceStart = performance.now();
      slice = await buildSlice({
        repoId: repoConfig.repoId,
        versionId,
        entrySymbols: entrySymbolIds,
        taskText: task.title,
        budget: {
          maxCards: merged.sdl.maxCards,
          maxEstimatedTokens: merged.sdl.maxTokens,
        },
      });
      sliceBuildTimeMs = performance.now() - sliceStart;

      sliceCardCount = slice.cards.length;
      // Count tokens the same way the MCP client would receive them (JSON payload).
      sliceTokens = estimateTokens(JSON.stringify(slice.cards));

      for (const card of slice.cards) {
        const cardFile = normalizePath(card.file);
        sliceFiles.add(cardFile);
        sliceSymbolNames.add(card.name.toLowerCase());
        if (card.deps?.calls?.length) {
          const callNames = collectDependencyNames(card.deps.calls);
          for (const name of callNames) {
            depSymbolNames.add(name);
          }
        }
        if (card.deps?.imports?.length) {
          const importNames = collectDependencyNames(card.deps.imports);
          for (const name of importNames) {
            depSymbolNames.add(name);
          }
        }
      }
    }

    console.log(`    Entry symbols found: ${entrySymbolIds.length}`);
    console.log(`    Slice cards: ${sliceCardCount}`);

    // Generate skeletons
    const skeletonTargets: SymbolRow[] = [];
    for (const symbolId of entrySymbolIds) {
      const symbol = db.getSymbol(symbolId);
      if (!symbol) continue;
      if (symbol.kind !== "function" && symbol.kind !== "method") continue;
      skeletonTargets.push(symbol);
    }

    if (slice && skeletonTargets.length < merged.sdl.maxSkeletons) {
      for (const card of slice.cards) {
        if (skeletonTargets.length >= merged.sdl.maxSkeletons) break;
        if (card.kind !== "function" && card.kind !== "method") continue;
        const symbol = db.getSymbol(card.symbolId);
        if (!symbol) continue;
        if (skeletonTargets.some((s) => s.symbol_id === symbol.symbol_id)) {
          continue;
        }
        skeletonTargets.push(symbol);
      }
    }

    let skeletonTokens = 0;
    let skeletonTimeMs = 0;
    const skeletonFiles = new Set<string>();
    const skeletonTextParts: string[] = [];

    for (const symbol of skeletonTargets.slice(0, merged.sdl.maxSkeletons)) {
      const skelStart = performance.now();
      const result = generateSymbolSkeleton(
        repoConfig.repoId,
        symbol.symbol_id,
        {
          maxLines: merged.sdl.skeletonMaxLines,
          maxTokens: merged.sdl.skeletonMaxTokens,
        },
      );
      skeletonTimeMs += performance.now() - skelStart;

      if (!result) continue;
      const normalizedName = normalizeSymbolName(symbol.name);
      if (normalizedName) {
        sliceSymbolNames.add(normalizedName);
      }
      skeletonTokens += result.estimatedTokens;
      if (result.skeleton) {
        skeletonTextParts.push(result.skeleton);
      }
      const file = db.getFile(symbol.file_id);
      if (file) {
        skeletonFiles.add(normalizePath(file.rel_path));
      }
    }

    console.log(`    Skeletons generated: ${skeletonTargets.length}`);

    for (const symbol of entrySymbols) {
      const normalizedName = normalizeSymbolName(symbol.name);
      if (normalizedName) {
        sliceSymbolNames.add(normalizedName);
      }
    }
    for (const symbol of querySymbols) {
      const normalizedName = normalizeSymbolName(symbol.name);
      if (normalizedName) {
        sliceSymbolNames.add(normalizedName);
      }
    }

    const sdlText = [
      ...sliceSymbolNames,
      ...depSymbolNames,
      ...skeletonTargets.map((symbol) => symbol.name),
      ...skeletonTextParts,
    ]
      .filter((value) => value && value.length > 0)
      .join("\n");

    const sdlFiles = new Set<string>([...sliceFiles, ...skeletonFiles]);

    const sdlRelevantFilesFound = Array.from(relevantFiles).filter((file) =>
      sdlFiles.has(file),
    ).length;

    const sdlRelevantSymbolsFound = countSymbolsInText(sdlText, relevantSymbols);

    const sdlTokens = sliceTokens + skeletonTokens;
    const sdlTokensPerRelevant =
      sdlRelevantFilesFound > 0 ? sdlTokens / sdlRelevantFilesFound : sdlTokens;

    const sdlPrecision = computePrecision(sdlRelevantFilesFound, sdlFiles.size);
    const sdlRecall = computeRecall(sdlRelevantFilesFound, relevantFiles.size);

    const sdl: SdlSelection = {
      entrySymbols: entrySymbolIds,
      slice,
      cards: sliceCardCount,
      skeletons: skeletonTargets.length,
      tokens: sdlTokens,
      symbolsFound: sdlRelevantSymbolsFound,
      relevantFilesFound: sdlRelevantFilesFound,
      relevantFilesTotal: relevantFiles.size,
      relevantSymbolsFound: sdlRelevantSymbolsFound,
      relevantSymbolsTotal: relevantSymbols.size,
      tokensPerRelevantFile: sdlTokensPerRelevant,
      precision: sdlPrecision,
      recall: sdlRecall,
      sliceBuildTimeMs,
      skeletonTimeMs,
    };

    console.log(`    Total tokens: ${formatNumber(sdlTokens)}`);

    // Compute comparison metrics
    const tokenReductionPct = computeTokenReduction(baseline.tokens, sdl.tokens);
    const coverageGain = computeCoverageGain(
      baseline.relevantFilesFound,
      sdl.relevantFilesFound,
      relevantFiles.size,
    );
    const symbolCoverageGain = computeCoverageGain(
      baseline.relevantSymbolsFound,
      sdl.relevantSymbolsFound,
      relevantSymbols.size,
    );
    const precisionGain = sdl.precision - baseline.precision;
    const recallGain = sdl.recall - baseline.recall;

    // Efficiency ratio: tokens saved per coverage point gained
    const tokensSaved = baseline.tokens - sdl.tokens;
    const coveragePointsGained = coverageGain * 100;
    const efficiencyRatio =
      coveragePointsGained !== 0 ? tokensSaved / Math.abs(coveragePointsGained) : 0;

    // Determine winner based on multiple factors
    let sdlScore = 0;
    let tradScore = 0;

    if (sdl.tokens < baseline.tokens) sdlScore++;
    else if (baseline.tokens < sdl.tokens) tradScore++;

    if (sdl.precision > baseline.precision) sdlScore++;
    else if (baseline.precision > sdl.precision) tradScore++;

    if (sdl.recall > baseline.recall) sdlScore++;
    else if (baseline.recall > sdl.recall) tradScore++;

    if (sdlRelevantFilesFound > baselineRelevantFilesFound) sdlScore++;
    else if (baselineRelevantFilesFound > sdlRelevantFilesFound) tradScore++;

    const winner: "SDL-MCP" | "Traditional" | "Tie" =
      sdlScore > tradScore ? "SDL-MCP" : tradScore > sdlScore ? "Traditional" : "Tie";

    const taskResult: TaskResult = {
      id: task.id,
      title: task.title,
      description: task.description,
      baseline,
      sdl,
      comparison: {
        tokenReductionPct,
        coverageGain,
        symbolCoverageGain,
        precisionGain,
        recallGain,
        efficiencyRatio,
        winner,
      },
    };

    results.push(taskResult);

    printComparisonTable(taskResult);
  }

  // Generate summary
  printHeader("BENCHMARK SUMMARY");

  const avgTokenReduction =
    results.reduce((sum, r) => sum + r.comparison.tokenReductionPct, 0) /
    results.length;
  const avgCoverageGain =
    results.reduce((sum, r) => sum + r.comparison.coverageGain, 0) /
    results.length;
  const avgSymbolGain =
    results.reduce((sum, r) => sum + r.comparison.symbolCoverageGain, 0) /
    results.length;
  const avgPrecisionGain =
    results.reduce((sum, r) => sum + r.comparison.precisionGain, 0) /
    results.length;
  const avgRecallGain =
    results.reduce((sum, r) => sum + r.comparison.recallGain, 0) /
    results.length;
  const avgEfficiencyRatio =
    results.reduce((sum, r) => sum + r.comparison.efficiencyRatio, 0) /
    results.length;

  const sdlWins = results.filter((r) => r.comparison.winner === "SDL-MCP").length;
  const traditionalWins = results.filter(
    (r) => r.comparison.winner === "Traditional",
  ).length;
  const ties = results.filter((r) => r.comparison.winner === "Tie").length;

  const tuningInsights = generateTuningInsights(results);

  const summary: BenchmarkSummary = {
    repoId: repoConfig.repoId,
    rootPath: repoConfig.rootPath,
    timestamp: new Date().toISOString(),
    taskCount: results.length,
    avgTokenReduction,
    avgCoverageGain,
    avgSymbolGain,
    avgPrecisionGain,
    avgRecallGain,
    avgEfficiencyRatio,
    sdlWins,
    traditionalWins,
    ties,
    tuningInsights,
  };

  printBenefitsSummary(summary);
  printTuningInsights(tuningInsights);

  // Output results
  if (outPath) {
    const resolved = resolve(outPath);
    const payload = {
      benchmarkVersion: "2.0",
      generatedAt: new Date().toISOString(),
      repoId: repoConfig.repoId,
      rootPath: repoConfig.rootPath,
      summary,
      tasks: results,
    };
    const serialized = JSON.stringify(payload, null, 2);
    writeFileSync(resolved, serialized, "utf-8");
    console.log(`\n  Results written to ${resolved}`);
  }

  printHeader("BENCHMARK COMPLETE");
}

runBenchmark().catch((error) => {
  console.error(
    `Benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
