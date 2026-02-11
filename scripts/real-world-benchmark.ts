#!/usr/bin/env tsx
/**
 * Real-world Workflow Benchmark for SDL-MCP
 *
 * Compares a traditional file-search workflow against an SDL-MCP tool-ladder
 * workflow on realistic engineering tasks (review, debugging, understanding,
 * code change, and impact analysis).
 *
 * The benchmark is realism-first:
 * - No per-task budget tuning
 * - No hand-authored benchmark query terms
 * - Terms are derived from task/step prompts and artifacts
 * - SDL uses a fixed ladder: symbol search -> symbol cards -> slice -> skeletons
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
import { handleSymbolGetCard } from "../src/mcp/tools/symbol.js";
import { estimateTokens, tokenize } from "../src/util/tokenize.js";
import { hashCard } from "../src/util/hashing.js";
import { normalizePath, getRelativePath } from "../src/util/paths.js";
import type { SymbolRow } from "../src/db/schema.js";
import type { CardWithETag, GraphSlice, SymbolCard } from "../src/mcp/types.js";

// ============================================================================
// Types
// ============================================================================

interface BenchmarkDefaults {
  baseline: {
    maxFilesPerStep: number;
    maxTokensPerFile: number;
  };
  sdl: {
    maxSearchTerms: number;
    maxSearchResultsPerTerm: number;
    maxEntrySymbols: number;
    maxCardsPerStep: number;
    maxCards: number;
    maxTokens: number;
    maxSkeletonsPerStep: number;
    skeletonMaxLines: number;
    skeletonMaxTokens: number;
  };
  scoring: {
    weights: {
      tokenEfficiency: number;
      coverageQuality: number;
      efficiencyScore: number;
      precisionQuality: number;
    };
    thresholds: {
      sdlWin: number;
      traditionalWin: number;
    };
  };
}

interface WorkflowArtifacts {
  changedFiles?: string[];
  stackTrace?: string;
  failingTest?: string;
  notes?: string;
}

interface WorkflowStep {
  id: string;
  phase: "triage" | "investigate" | "change" | "validate";
  goal: string;
  prompt: string;
  entrySymbolHints?: string[];
  artifacts?: WorkflowArtifacts;
}

interface WorkflowTask {
  id: string;
  category:
    | "code-review"
    | "feature-review"
    | "bug-fix"
    | "understanding"
    | "code-change"
    | "performance"
    | "impact-analysis"
    | "test-triage";
  title: string;
  description: string;
  tags?: string[];
  difficulty?: "easy" | "medium" | "hard";
  contextTargets: {
    files?: string[];
    symbols?: string[];
  };
  workflow: WorkflowStep[];
  repoId?: string;
}

interface TaskFile {
  version: number;
  defaults?: Partial<BenchmarkDefaults>;
  tasks: Array<WorkflowTask | LegacyTask>;
}

interface LegacyTask {
  id: string;
  title: string;
  description: string;
  tags?: string[];
  repoId?: string;
  entrySymbolNames?: string[];
  relevantFiles?: string[];
  relevantSymbols?: string[];
}

interface CorpusFile {
  absPath: string;
  relPath: string;
  content: string;
  tokens: number;
}

interface StepResult {
  id: string;
  phase: WorkflowStep["phase"];
  baselineFilesOpened: number;
  baselineTokensAdded: number;
  sdlSearchHits: number;
  sdlEntrySymbols: number;
  sdlCardsFetched: number;
  sdlSliceCards: number;
  sdlSkeletons: number;
  sdlTokensAdded: number;
  sliceBuildTimeMs: number;
  baselineCoveragePctAfter: number;
  sdlCoveragePctAfter: number;
  baselineMarginalCoveragePct: number;
  sdlMarginalCoveragePct: number;
  baselineTokensPerCoveragePoint: number | null;
  sdlTokensPerCoveragePoint: number | null;
  baselineDeadWeight: boolean;
  sdlDeadWeight: boolean;
}

interface CompletionResult {
  baselineAddedTokens: number;
  baselineAddedFiles: number;
  baselineAddedSymbolFiles: number;
  sdlAddedTokens: number;
  sdlAddedCards: number;
  sdlAddedSlices: number;
  sdlAddedRawFiles: number;
  completed: boolean;
}

interface ApproachMetrics {
  tokens: number;
  tokensUncapped?: number;
  fileCoveragePct: number;
  symbolCoveragePct: number;
  contextCoveragePct: number;
  tokensPerCoveragePoint: number | null;
  precision: number;
  recall: number;
  contextUnitsFound: number;
  contextUnitsTotal: number;
  filesFound: number;
  filesTotal: number;
  symbolsFound: number;
  symbolsTotal: number;
}

interface BaselineSelection extends ApproachMetrics {
  filesViewed: string[];
  matchedFiles: number;
  matchedTerms: number;
}

interface SdlSelection extends ApproachMetrics {
  contextFiles: string[];
  entrySymbols: string[];
  cardsFetched: number;
  slicesBuilt: number;
  skeletonsGenerated: number;
  searchTokens: number;
  cardTokens: number;
  sliceTokens: number;
  skeletonTokens: number;
  sliceBuildTimeMs: number;
}

interface LossAnalysis {
  reasons: string[];
  suggestions: string[];
}

interface TaskResult {
  id: string;
  category: WorkflowTask["category"];
  tags: string[];
  difficulty: "easy" | "medium" | "hard";
  title: string;
  description: string;
  naturalCoverage: {
    baseline: ApproachMetrics;
    sdl: ApproachMetrics;
  };
  postCompletionCoverage: {
    baseline: ApproachMetrics;
    sdl: ApproachMetrics;
  };
  baseline: BaselineSelection;
  sdl: SdlSelection;
  steps: StepResult[];
  completion: CompletionResult;
  comparison: {
    tokenReductionPct: number;
    tokenReductionPctUncapped: number;
    fileCoverageGainPct: number;
    symbolCoverageGainPct: number;
    contextCoverageGainPct: number;
    precisionGainPct: number;
    recallGainPct: number;
    compositeScore: number;
    scoreBreakdown: {
      tokenEfficiency: number;
      coverageQuality: number;
      efficiencyScore: number;
      precisionQuality: number;
    };
    extraContextPctWhenCheaper: number | null;
    winner: "SDL-MCP" | "Traditional" | "Tie";
  };
  lossAnalysis?: LossAnalysis;
}

interface BenchmarkSummary {
  repoId: string;
  rootPath: string;
  timestamp: string;
  taskCount: number;
  sdlWins: number;
  traditionalWins: number;
  ties: number;
  avgTokenReductionPct: number;
  avgContextCoverageGainPct: number;
  avgFileCoverageGainPct: number;
  avgSymbolCoverageGainPct: number;
  avgPrecisionGainPct: number;
  avgRecallGainPct: number;
  avgCompositeScore: number;
  tasksWithExtraContextWhenCheaper: number;
  avgExtraContextWhenCheaperPct: number;
  difficultyBreakdown: {
    easy: number;
    medium: number;
    hard: number;
  };
}

interface BaselineState {
  openedFiles: Set<string>;
  tokens: number;
  uncappedTokens: number;
  matchedFiles: number;
  matchedTerms: number;
}

interface SdlState {
  files: Set<string>;
  symbolNames: Set<string>;
  textFragments: string[];
  entrySymbols: Set<string>;
  fetchedCardSymbols: Set<string>;
  cardEtags: Map<string, string>;
  cardsBySymbolId: Map<string, SymbolCard>;
  generatedSkeletonSymbols: Set<string>;
  tokens: number;
  searchTokens: number;
  cardTokens: number;
  sliceTokens: number;
  skeletonTokens: number;
  cardsFetched: number;
  slicesBuilt: number;
  skeletonsGenerated: number;
  sliceBuildTimeMs: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TASKS_PATH = "benchmarks/real-world/tasks.json";
const SEARCH_TERM_MIN_LENGTH = 3;
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const FALLBACK_DEFAULTS: BenchmarkDefaults = {
  baseline: {
    maxFilesPerStep: 4,
    maxTokensPerFile: 2200,
  },
  sdl: {
    maxSearchTerms: 12,
    maxSearchResultsPerTerm: 6,
    maxEntrySymbols: 4,
    maxCardsPerStep: 5,
    maxCards: 14,
    maxTokens: 3200,
    maxSkeletonsPerStep: 1,
    skeletonMaxLines: 120,
    skeletonMaxTokens: 1500,
  },
  scoring: {
    weights: {
      tokenEfficiency: 0.45,
      coverageQuality: 0.25,
      efficiencyScore: 0.2,
      precisionQuality: 0.1,
    },
    thresholds: {
      sdlWin: 5,
      traditionalWin: -5,
    },
  },
};

const PRECISION_EXCLUDED_PREFIXES = ["dist/", "node_modules/"];
const PRECISION_EXCLUDED_PATTERNS = [/\.d\.ts$/i, /\.map$/i];
const COMPLETION_SLICE_MIN_CARDS = 6;
const COMPLETION_SLICE_MIN_TOKENS = 1200;
const COMPLETION_SLICE_TOKENS_PER_GAP = 350;
const INITIAL_STEP_CARD_FRACTION = 0.6;
const INITIAL_STEP_MIN_CARDS = 3;
const SEARCH_PAYLOAD_PREVIEW_LIMIT = 8;
const INITIAL_STEP_SEARCH_PREVIEW_LIMIT = 6;
const SDL_RAW_FILE_MAX_TOKENS = 1200;

// ============================================================================
// Formatting Helpers
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

function formatTokensPerCoveragePoint(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${formatNumber(Math.round(value))} tk/pt`;
}

function progressBar(percent: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
}

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
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

function getFlagEnabled(args: string[], name: string): boolean {
  if (args.includes(`--${name}`)) return true;
  const direct = args.find((arg) => arg.startsWith(`--${name}=`));
  if (direct) {
    const value = direct.slice(name.length + 3).trim().toLowerCase();
    return value !== "false" && value !== "0" && value !== "no";
  }

  const npmConfigValue = getNpmConfigValue(name);
  if (npmConfigValue) {
    const normalized = npmConfigValue.toLowerCase();
    return normalized !== "false" && normalized !== "0" && normalized !== "no";
  }

  return false;
}

function getFallbackOutPath(args: string[]): string | undefined {
  const positionalJson = args.find((arg) => arg.endsWith(".json") && !arg.startsWith("--"));
  if (positionalJson) return positionalJson;
  return undefined;
}

function getNpmOutPath(): string | undefined {
  const raw = getNpmConfigValue("out");
  if (!raw) return undefined;
  if (isTruthyOrFalsyToken(raw)) return undefined;
  return raw;
}

function printHeader(title: string): void {
  console.log("\n" + "=".repeat(74));
  console.log(`  ${title}`);
  console.log("=".repeat(74));
}

function printTaskHeader(task: WorkflowTask): void {
  console.log("\n" + "-".repeat(74));
  console.log(`  TASK: ${task.title}`);
  console.log(`  ID: ${task.id}`);
  console.log(`  CATEGORY: ${task.category}`);
  console.log(`  DIFFICULTY: ${task.difficulty ?? "medium"}`);
  console.log("-".repeat(74));
  console.log(`  ${task.description}`);
}

// ============================================================================
// Scoring Helpers
// ============================================================================

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

function normalizeSymbolName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.toLowerCase();
}

function isUsableSearchTerm(term: string): boolean {
  if (!term) return false;
  const normalized = term.trim().toLowerCase();
  if (normalized.length < SEARCH_TERM_MIN_LENGTH) return false;
  if (SEARCH_STOP_WORDS.has(normalized)) return false;
  return /[a-z]/i.test(normalized);
}

function dedupeTerms(terms: string[], maxTerms: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (!isUsableSearchTerm(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxTerms) break;
  }

  return result;
}

function uniqueLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

function deriveStepTerms(
  task: WorkflowTask,
  step: WorkflowStep,
  maxTerms: number,
): string[] {
  const artifactText = [
    ...(step.artifacts?.changedFiles ?? []),
    step.artifacts?.stackTrace ?? "",
    step.artifacts?.failingTest ?? "",
    step.artifacts?.notes ?? "",
  ].join("\n");

  const tokens = tokenize(
    [
      task.title,
      task.description,
      step.goal,
      step.prompt,
      artifactText,
      ...(step.entrySymbolHints ?? []),
    ].join("\n"),
  );

  return dedupeTerms(tokens, maxTerms);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSymbolRegex(symbol: string): RegExp {
  const escaped = escapeRegExp(symbol);
  const hasNonWord = /[^A-Za-z0-9_]/.test(symbol);
  if (hasNonWord) return new RegExp(escaped, "i");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function countSymbolsInText(text: string, symbols: Set<string>): number {
  if (symbols.size === 0 || !text) return 0;
  let count = 0;
  for (const symbol of symbols) {
    if (!symbol) continue;
    const regex = buildSymbolRegex(symbol);
    if (regex.test(text)) count++;
  }
  return count;
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
    if (!matches || matches.length === 0) continue;
    score += matches.length;
    hits += matches.length;
  }

  return { score, hits };
}

function computeTokenReduction(baselineTokens: number, sdlTokens: number): number {
  if (baselineTokens <= 0) return 0;
  return ((baselineTokens - sdlTokens) / baselineTokens) * 100;
}

function computePercent(found: number, total: number): number {
  if (total <= 0) return 0;
  return (found / total) * 100;
}

function computePrecision(found: number, total: number): number {
  if (total <= 0) return 0;
  return found / total;
}

function computeRecall(found: number, relevant: number): number {
  if (relevant <= 0) return 0;
  return found / relevant;
}

function computeTokensPerCoveragePoint(
  tokens: number,
  contextCoveragePct: number,
): number | null {
  if (contextCoveragePct <= 0) return null;
  return tokens / contextCoveragePct;
}

function hasSourceVariant(relPath: string, corpusPaths: Set<string>): boolean {
  if (!/\.js$/i.test(relPath)) return false;
  const base = relPath.slice(0, -3);
  return corpusPaths.has(`${base}.ts`) || corpusPaths.has(`${base}.tsx`);
}

function isPrecisionExcludedPath(
  relPath: string,
  corpusPaths: Set<string>,
): boolean {
  const normalized = normalizePath(relPath);
  if (
    PRECISION_EXCLUDED_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  ) {
    return true;
  }
  if (PRECISION_EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (hasSourceVariant(normalized, corpusPaths)) {
    return true;
  }
  return false;
}

function countPrecisionEligibleFiles(
  files: Iterable<string>,
  corpusPaths: Set<string>,
): number {
  let count = 0;
  for (const relPath of files) {
    if (isPrecisionExcludedPath(relPath, corpusPaths)) continue;
    count++;
  }
  return count;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ============================================================================
// Corpus + Symbol Helpers
// ============================================================================

function collectCandidateFiles(
  repoRoot: string,
  languages: string[],
  ignore: string[],
): string[] {
  const codePatterns = languages.map((lang) => `**/*.${lang}`);
  const ancillaryPatterns = ["config/**/*.json"];
  const patterns = [...codePatterns, ...ancillaryPatterns];

  return fg.sync(patterns, {
    cwd: repoRoot,
    ignore,
    dot: true,
    onlyFiles: true,
    absolute: true,
  });
}

function buildCorpus(
  repoRoot: string,
  absPaths: string[],
): CorpusFile[] {
  const result: CorpusFile[] = [];

  for (const absPath of absPaths) {
    let content = "";
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    result.push({
      absPath,
      relPath: normalizeRelPath(repoRoot, absPath),
      content,
      tokens: estimateTokens(content),
    });
  }

  return result;
}

function buildFileSymbolNameMap(repoId: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const files = db.getFilesByRepoLite(repoId);

  for (const file of files) {
    const relPath = normalizePath(file.rel_path);
    const symbols = db.getSymbolsByFileLite(file.file_id);
    map.set(
      relPath,
      new Set(
        symbols
          .map((symbol) => normalizeSymbolName(symbol.name))
          .filter((name): name is string => !!name),
      ),
    );
  }

  return map;
}

function buildFileRepresentativeSymbolMap(repoId: string): Map<string, string> {
  const map = new Map<string, string>();
  const files = db.getFilesByRepoLite(repoId);

  for (const file of files) {
    const relPath = normalizePath(file.rel_path);
    const symbols = db.getSymbolsByFileLite(file.file_id);
    if (symbols.length === 0) continue;
    const representative =
      symbols.find((symbol) => symbol.exported === 1) ?? symbols[0];
    if (!representative?.symbol_id) continue;
    map.set(relPath, representative.symbol_id);
  }

  return map;
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
    if (matches.length === 0) continue;
    const exact = matches.find((m) => m.name === name);
    results.push(exact ?? matches[0]);
  }

  return results;
}

function scoreSymbolCandidate(
  symbol: SymbolRow,
  terms: string[],
  changedFiles: Set<string>,
): number {
  const name = symbol.name.toLowerCase();
  const file = db.getFile(symbol.file_id);
  const relPath = file ? normalizePath(file.rel_path) : "";

  let score = 0;

  for (const term of terms) {
    if (!term) continue;
    if (name === term) {
      score += 16;
    } else if (name.startsWith(term)) {
      score += 8;
    } else if (name.includes(term)) {
      score += 4;
    }

    if (relPath.includes(term)) {
      score += 2;
    }
  }

  if (symbol.kind === "function" || symbol.kind === "method") {
    score += 2;
  }
  if (symbol.exported === 1) {
    score += 1;
  }
  if (relPath && changedFiles.has(relPath)) {
    score += 5;
  }

  return score;
}

function searchSymbolsByTerms(
  repoId: string,
  terms: string[],
  maxResultsPerTerm: number,
  changedFiles: Set<string>,
): SymbolRow[] {
  const scored = new Map<string, { symbol: SymbolRow; score: number }>();

  for (const term of terms) {
    const matches = db.searchSymbols(repoId, term, maxResultsPerTerm);
    for (const match of matches) {
      const extra = scoreSymbolCandidate(match, [term], changedFiles);
      const existing = scored.get(match.symbol_id);
      if (!existing) {
        scored.set(match.symbol_id, { symbol: match, score: extra });
      } else {
        existing.score += extra;
      }
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.symbol.name.localeCompare(b.symbol.name);
    })
    .map((entry) => entry.symbol);
}

function collectDependencyNames(symbolIds: string[]): Set<string> {
  const names = new Set<string>();

  for (const symbolId of symbolIds) {
    if (!symbolId) continue;

    const unresolvedPrefix = "unresolved:call:";
    if (symbolId.startsWith(unresolvedPrefix)) {
      const unresolvedName = symbolId.slice(unresolvedPrefix.length).trim();
      if (unresolvedName) names.add(unresolvedName.toLowerCase());
      continue;
    }

    const depSymbol = db.getSymbol(symbolId);
    if (depSymbol?.name) names.add(depSymbol.name.toLowerCase());
  }

  return names;
}

function applyCardContext(state: SdlState, card: SymbolCard): void {
  state.cardsBySymbolId.set(card.symbolId, card);
  state.symbolNames.add(card.name.toLowerCase());
  if (card.file) state.files.add(normalizePath(card.file));

  if (card.deps?.imports?.length) {
    const names = collectDependencyNames(card.deps.imports);
    for (const name of names) state.symbolNames.add(name);
  }
  if (card.deps?.calls?.length) {
    const names = collectDependencyNames(card.deps.calls);
    for (const name of names) state.symbolNames.add(name);
  }
}

function inflateSliceCard(
  slice: GraphSlice,
  card: GraphSlice["cards"][number],
): SymbolCard {
  return {
    ...card,
    repoId: slice.repoId,
    version: {
      ledgerVersion: slice.versionId,
      astFingerprint: card.version.astFingerprint,
    },
    detailLevel: card.detailLevel ?? "compact",
  };
}

function normalizeTags(tags?: string[]): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawTag of tags) {
    if (typeof rawTag !== "string") continue;
    const tag = rawTag.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

function normalizeTaskFile(taskFile: TaskFile): { defaults: BenchmarkDefaults; tasks: WorkflowTask[] } {
  const mergedDefaults: BenchmarkDefaults = {
    baseline: {
      maxFilesPerStep:
        taskFile.defaults?.baseline?.maxFilesPerStep ?? FALLBACK_DEFAULTS.baseline.maxFilesPerStep,
      maxTokensPerFile:
        taskFile.defaults?.baseline?.maxTokensPerFile ?? FALLBACK_DEFAULTS.baseline.maxTokensPerFile,
    },
    sdl: {
      maxSearchTerms:
        taskFile.defaults?.sdl?.maxSearchTerms ?? FALLBACK_DEFAULTS.sdl.maxSearchTerms,
      maxSearchResultsPerTerm:
        taskFile.defaults?.sdl?.maxSearchResultsPerTerm ?? FALLBACK_DEFAULTS.sdl.maxSearchResultsPerTerm,
      maxEntrySymbols:
        taskFile.defaults?.sdl?.maxEntrySymbols ?? FALLBACK_DEFAULTS.sdl.maxEntrySymbols,
      maxCardsPerStep:
        taskFile.defaults?.sdl?.maxCardsPerStep ?? FALLBACK_DEFAULTS.sdl.maxCardsPerStep,
      maxCards: taskFile.defaults?.sdl?.maxCards ?? FALLBACK_DEFAULTS.sdl.maxCards,
      maxTokens: taskFile.defaults?.sdl?.maxTokens ?? FALLBACK_DEFAULTS.sdl.maxTokens,
      maxSkeletonsPerStep:
        taskFile.defaults?.sdl?.maxSkeletonsPerStep ?? FALLBACK_DEFAULTS.sdl.maxSkeletonsPerStep,
      skeletonMaxLines:
        taskFile.defaults?.sdl?.skeletonMaxLines ?? FALLBACK_DEFAULTS.sdl.skeletonMaxLines,
      skeletonMaxTokens:
        taskFile.defaults?.sdl?.skeletonMaxTokens ?? FALLBACK_DEFAULTS.sdl.skeletonMaxTokens,
    },
    scoring: {
      weights: {
        tokenEfficiency:
          taskFile.defaults?.scoring?.weights?.tokenEfficiency ??
          FALLBACK_DEFAULTS.scoring.weights.tokenEfficiency,
        coverageQuality:
          taskFile.defaults?.scoring?.weights?.coverageQuality ??
          FALLBACK_DEFAULTS.scoring.weights.coverageQuality,
        efficiencyScore:
          taskFile.defaults?.scoring?.weights?.efficiencyScore ??
          FALLBACK_DEFAULTS.scoring.weights.efficiencyScore,
        precisionQuality:
          taskFile.defaults?.scoring?.weights?.precisionQuality ??
          FALLBACK_DEFAULTS.scoring.weights.precisionQuality,
      },
      thresholds: {
        sdlWin:
          taskFile.defaults?.scoring?.thresholds?.sdlWin ??
          FALLBACK_DEFAULTS.scoring.thresholds.sdlWin,
        traditionalWin:
          taskFile.defaults?.scoring?.thresholds?.traditionalWin ??
          FALLBACK_DEFAULTS.scoring.thresholds.traditionalWin,
      },
    },
  };

  const normalizedTasks: WorkflowTask[] = taskFile.tasks.map((task): WorkflowTask => {
    if ("workflow" in task && Array.isArray(task.workflow)) {
      const workflowTask = task as WorkflowTask;
      return {
        ...workflowTask,
        tags: normalizeTags(workflowTask.tags),
        difficulty: workflowTask.difficulty ?? "medium",
      };
    }

    const legacy = task as LegacyTask;
    return {
      id: legacy.id,
      category: "understanding",
      title: legacy.title,
      description: legacy.description,
      tags: normalizeTags(legacy.tags),
      difficulty: "medium",
      repoId: legacy.repoId,
      contextTargets: {
        files: legacy.relevantFiles,
        symbols: legacy.relevantSymbols,
      },
      workflow: [
        {
          id: "legacy-step",
          phase: "investigate",
          goal: legacy.description,
          prompt: `${legacy.title}. ${legacy.description}`,
          entrySymbolHints: legacy.entrySymbolNames,
        },
      ],
    };
  });

  return { defaults: mergedDefaults, tasks: normalizedTasks };
}

function buildChangedFilesSet(changedFiles: string[] | undefined): Set<string> {
  if (!changedFiles || changedFiles.length === 0) return new Set<string>();
  return new Set(changedFiles.map((file) => normalizePath(file)));
}

function collectBaselineSymbolNames(
  openedFiles: Set<string>,
  fileSymbolMap: Map<string, Set<string>>,
): Set<string> {
  const baselineSymbolNames = new Set<string>();
  for (const relPath of openedFiles) {
    const symbols = fileSymbolMap.get(relPath);
    if (!symbols) continue;
    for (const symbolName of symbols) {
      baselineSymbolNames.add(symbolName);
    }
  }
  return baselineSymbolNames;
}

function collectSdlSymbolHits(
  relevantSymbols: Set<string>,
  sdlState: SdlState,
): Set<string> {
  const hits = new Set<string>();
  if (relevantSymbols.size === 0) return hits;
  const text = sdlState.textFragments.join("\n");

  for (const symbol of relevantSymbols) {
    if (!symbol) continue;
    if (sdlState.symbolNames.has(symbol)) {
      hits.add(symbol);
      continue;
    }
    const regex = buildSymbolRegex(symbol);
    if (regex.test(text)) {
      hits.add(symbol);
    }
  }

  return hits;
}

function buildApproachMetrics(params: {
  tokens: number;
  tokensUncapped?: number;
  filesFound: number;
  filesTotal: number;
  symbolsFound: number;
  symbolsTotal: number;
  precisionDenominator: number;
}): ApproachMetrics {
  const contextUnitsTotal = params.filesTotal + params.symbolsTotal;
  const contextUnitsFound = params.filesFound + params.symbolsFound;
  const fileCoveragePct = computePercent(params.filesFound, params.filesTotal);
  const symbolCoveragePct = computePercent(params.symbolsFound, params.symbolsTotal);
  const contextCoveragePct = computePercent(contextUnitsFound, contextUnitsTotal);
  return {
    tokens: params.tokens,
    tokensUncapped: params.tokensUncapped,
    filesFound: params.filesFound,
    filesTotal: params.filesTotal,
    symbolsFound: params.symbolsFound,
    symbolsTotal: params.symbolsTotal,
    fileCoveragePct,
    symbolCoveragePct,
    contextCoveragePct,
    contextUnitsFound,
    contextUnitsTotal,
    precision: computePrecision(params.filesFound, params.precisionDenominator),
    recall: computeRecall(params.filesFound, params.filesTotal),
    tokensPerCoveragePoint: computeTokensPerCoveragePoint(
      params.tokens,
      contextCoveragePct,
    ),
  };
}

function computeCompositeScore(
  baselineMetrics: ApproachMetrics,
  sdlMetrics: ApproachMetrics,
  scoring: BenchmarkDefaults["scoring"],
): {
  compositeScore: number;
  scoreBreakdown: {
    tokenEfficiency: number;
    coverageQuality: number;
    efficiencyScore: number;
    precisionQuality: number;
  };
} {
  const tokenEfficiency = clamp(
    computeTokenReduction(baselineMetrics.tokens, sdlMetrics.tokens),
    -100,
    100,
  );
  const coverageQuality = clamp(
    sdlMetrics.contextCoveragePct - baselineMetrics.contextCoveragePct,
    -100,
    100,
  );
  const precisionQuality = clamp(
    (sdlMetrics.precision - baselineMetrics.precision) * 100,
    -100,
    100,
  );

  let efficiencyScore = 0;
  if (
    baselineMetrics.tokensPerCoveragePoint !== null &&
    sdlMetrics.tokensPerCoveragePoint !== null &&
    baselineMetrics.tokensPerCoveragePoint > 0
  ) {
    efficiencyScore = clamp(
      ((baselineMetrics.tokensPerCoveragePoint -
        sdlMetrics.tokensPerCoveragePoint) /
        baselineMetrics.tokensPerCoveragePoint) *
        100,
      -100,
      100,
    );
  }

  const compositeScore =
    tokenEfficiency * scoring.weights.tokenEfficiency +
    coverageQuality * scoring.weights.coverageQuality +
    efficiencyScore * scoring.weights.efficiencyScore +
    precisionQuality * scoring.weights.precisionQuality;

  return {
    compositeScore,
    scoreBreakdown: {
      tokenEfficiency,
      coverageQuality,
      efficiencyScore,
      precisionQuality,
    },
  };
}

function captureCoverageFromStates(params: {
  relevantFiles: Set<string>;
  relevantSymbols: Set<string>;
  fileSymbolMap: Map<string, Set<string>>;
  baselineState: BaselineState;
  sdlState: SdlState;
  corpusPaths: Set<string>;
}): { baseline: ApproachMetrics; sdl: ApproachMetrics } {
  const baselineFilesFound = Array.from(params.relevantFiles).filter((file) =>
    params.baselineState.openedFiles.has(file),
  ).length;
  const baselineSymbolNames = collectBaselineSymbolNames(
    params.baselineState.openedFiles,
    params.fileSymbolMap,
  );
  const baselineSymbolsFound = Array.from(params.relevantSymbols).filter((symbol) =>
    baselineSymbolNames.has(symbol),
  ).length;

  const sdlFilesFound = Array.from(params.relevantFiles).filter((file) =>
    params.sdlState.files.has(file),
  ).length;
  const sdlSymbolsFound = collectSdlSymbolHits(
    params.relevantSymbols,
    params.sdlState,
  ).size;

  const baselinePrecisionDenominator = countPrecisionEligibleFiles(
    params.baselineState.openedFiles,
    params.corpusPaths,
  );
  const sdlPrecisionDenominator = countPrecisionEligibleFiles(
    params.sdlState.files,
    params.corpusPaths,
  );

  return {
    baseline: buildApproachMetrics({
      tokens: params.baselineState.tokens,
      tokensUncapped: params.baselineState.uncappedTokens,
      filesFound: baselineFilesFound,
      filesTotal: params.relevantFiles.size,
      symbolsFound: baselineSymbolsFound,
      symbolsTotal: params.relevantSymbols.size,
      precisionDenominator: baselinePrecisionDenominator,
    }),
    sdl: buildApproachMetrics({
      tokens: params.sdlState.tokens,
      filesFound: sdlFilesFound,
      filesTotal: params.relevantFiles.size,
      symbolsFound: sdlSymbolsFound,
      symbolsTotal: params.relevantSymbols.size,
      precisionDenominator: sdlPrecisionDenominator,
    }),
  };
}

function addBaselineFileContext(
  relPath: string,
  corpusByRelPath: Map<string, CorpusFile>,
  maxTokensPerFile: number,
  baselineState: BaselineState,
): boolean {
  if (baselineState.openedFiles.has(relPath)) return false;
  const file = corpusByRelPath.get(relPath);
  if (!file) return false;

  baselineState.openedFiles.add(relPath);
  baselineState.tokens += Math.min(file.tokens, maxTokensPerFile);
  baselineState.uncappedTokens += file.tokens;
  return true;
}

function getSdlRawFileTokenCap(maxTokensPerFile: number): number {
  return Math.min(maxTokensPerFile, SDL_RAW_FILE_MAX_TOKENS);
}

function addSdlRawFileContext(
  relPath: string,
  corpusByRelPath: Map<string, CorpusFile>,
  fileSymbolMap: Map<string, Set<string>>,
  maxTokensPerFile: number,
  sdlState: SdlState,
): boolean {
  if (sdlState.files.has(relPath)) return false;
  const file = corpusByRelPath.get(relPath);
  if (!file) return false;

  const tokens = Math.min(file.tokens, getSdlRawFileTokenCap(maxTokensPerFile));
  sdlState.files.add(relPath);
  sdlState.tokens += tokens;
  sdlState.textFragments.push(file.content);

  const symbols = fileSymbolMap.get(relPath);
  if (symbols) {
    for (const symbolName of symbols) {
      sdlState.symbolNames.add(symbolName);
    }
  }

  return true;
}

async function runCompletionPass(
  repoId: string,
  task: WorkflowTask,
  defaults: BenchmarkDefaults,
  relevantFiles: Set<string>,
  relevantSymbols: Set<string>,
  corpusByRelPath: Map<string, CorpusFile>,
  fileSymbolMap: Map<string, Set<string>>,
  fileRepresentativeSymbolMap: Map<string, string>,
  baselineState: BaselineState,
  sdlState: SdlState,
): Promise<CompletionResult> {
  let baselineAddedTokens = 0;
  let baselineAddedFiles = 0;
  let baselineAddedSymbolFiles = 0;
  let sdlAddedTokens = 0;
  let sdlAddedCards = 0;
  let sdlAddedSlices = 0;
  let sdlAddedRawFiles = 0;

  // Baseline completion: keep reading until task targets are covered.
  for (const relPath of relevantFiles) {
    if (!addBaselineFileContext(relPath, corpusByRelPath, defaults.baseline.maxTokensPerFile, baselineState)) {
      continue;
    }
    baselineAddedFiles++;
    const file = corpusByRelPath.get(relPath);
    if (file) baselineAddedTokens += Math.min(file.tokens, defaults.baseline.maxTokensPerFile);
  }

  let baselineSymbolNames = collectBaselineSymbolNames(baselineState.openedFiles, fileSymbolMap);
  const missingBaselineSymbols = Array.from(relevantSymbols).filter(
    (symbolName) => !baselineSymbolNames.has(symbolName),
  );

  for (const symbolName of missingBaselineSymbols) {
    const matches = db.searchSymbols(repoId, symbolName, 8);
    if (matches.length === 0) continue;
    const exact = matches.find((match) => normalizeSymbolName(match.name) === symbolName);
    const chosen = exact ?? matches[0];
    const file = db.getFile(chosen.file_id);
    if (!file) continue;
    const relPath = normalizePath(file.rel_path);

    if (!addBaselineFileContext(relPath, corpusByRelPath, defaults.baseline.maxTokensPerFile, baselineState)) {
      continue;
    }
    baselineAddedSymbolFiles++;
    const corpusFile = corpusByRelPath.get(relPath);
    if (corpusFile) baselineAddedTokens += Math.min(corpusFile.tokens, defaults.baseline.maxTokensPerFile);
  }

  baselineSymbolNames = collectBaselineSymbolNames(baselineState.openedFiles, fileSymbolMap);

  // SDL completion: target missing symbols/files through normal tool ladder first.
  const initialSdlSymbolHits = collectSdlSymbolHits(relevantSymbols, sdlState);
  const missingSdlSymbols = Array.from(relevantSymbols).filter(
    (symbolName) => !initialSdlSymbolHits.has(symbolName),
  );
  const completionEntries: string[] = [];

  for (const symbolName of missingSdlSymbols) {
    const matches = db.searchSymbols(repoId, symbolName, 8);
    if (matches.length === 0) continue;
    const exact = matches.find((match) => normalizeSymbolName(match.name) === symbolName);
    const chosen = exact ?? matches[0];
    completionEntries.push(chosen.symbol_id);

    const response = await handleSymbolGetCard({
      repoId,
      symbolId: chosen.symbol_id,
      ifNoneMatch: sdlState.cardEtags.get(chosen.symbol_id),
    });
    const responseTokens = estimateTokens(JSON.stringify(response));
    sdlAddedTokens += responseTokens;
    sdlState.tokens += responseTokens;
    sdlState.cardTokens += responseTokens;

    if ("notModified" in response && response.notModified) {
      sdlState.cardEtags.set(chosen.symbol_id, response.etag);
      continue;
    }
    if (!("card" in response) || !response.card) {
      continue;
    }

    const card = response.card as CardWithETag;
    if (!sdlState.fetchedCardSymbols.has(chosen.symbol_id)) {
      sdlState.fetchedCardSymbols.add(chosen.symbol_id);
      sdlState.cardsFetched += 1;
      sdlAddedCards += 1;
    }
    sdlState.cardEtags.set(chosen.symbol_id, card.etag);
    applyCardContext(sdlState, card);
  }

  const sdlSymbolHitsAfterCards = collectSdlSymbolHits(relevantSymbols, sdlState);
  const remainingSdlSymbolsAfterCards = Array.from(relevantSymbols).filter(
    (symbolName) => !sdlSymbolHitsAfterCards.has(symbolName),
  );
  const missingSdlFilesAfterCards = Array.from(relevantFiles).filter(
    (relPath) => !sdlState.files.has(relPath),
  );

  if (
    completionEntries.length > 0 &&
    (remainingSdlSymbolsAfterCards.length > 0 ||
      missingSdlFilesAfterCards.length > 0)
  ) {
    const latestVersion = db.getLatestVersion(repoId);
    const versionId = latestVersion?.version_id ?? "current";
    const knownCardEtags = Object.fromEntries(sdlState.cardEtags.entries());
    const completionGapSize =
      remainingSdlSymbolsAfterCards.length + missingSdlFilesAfterCards.length;
    const completionSliceBudget = {
      maxCards: Math.min(
        defaults.sdl.maxCards,
        Math.max(
          COMPLETION_SLICE_MIN_CARDS,
          remainingSdlSymbolsAfterCards.length * 2 +
            missingSdlFilesAfterCards.length,
        ),
      ),
      maxEstimatedTokens: Math.min(
        defaults.sdl.maxTokens,
        Math.max(
          COMPLETION_SLICE_MIN_TOKENS,
          completionGapSize * COMPLETION_SLICE_TOKENS_PER_GAP,
        ),
      ),
    };

    const sliceStart = performance.now();
    const slice = await buildSlice({
      repoId,
      versionId,
      entrySymbols: uniqueLimit(completionEntries, defaults.sdl.maxEntrySymbols),
      taskText: `${task.title}\n${task.description}\nCompletion pass: continue until required context is reached.`,
      knownCardEtags,
      cardDetail: "compact",
      budget: completionSliceBudget,
    });
    const sliceBuildTimeMs = performance.now() - sliceStart;
    sdlState.slicesBuilt += 1;
    sdlState.sliceBuildTimeMs += sliceBuildTimeMs;
    sdlAddedSlices += 1;

    const sliceTokens = estimateTokens(
      JSON.stringify({
        cards: slice.cards,
        cardRefs: slice.cardRefs ?? [],
      }),
    );
    sdlAddedTokens += sliceTokens;
    sdlState.tokens += sliceTokens;
    sdlState.sliceTokens += sliceTokens;

    const refsBySymbolId = new Map(
      (slice.cardRefs ?? []).map((ref) => [ref.symbolId, ref]),
    );
    const cardsBySymbolId = new Map(slice.cards.map((card) => [card.symbolId, card]));
    for (const card of slice.cards) {
      const inflatedCard = inflateSliceCard(slice, card);
      const ref = refsBySymbolId.get(card.symbolId);
      const etag = ref?.etag ?? hashCard(inflatedCard);
      sdlState.cardEtags.set(card.symbolId, etag);
      applyCardContext(sdlState, inflatedCard);
    }
    for (const ref of slice.cardRefs ?? []) {
      sdlState.cardEtags.set(ref.symbolId, ref.etag);
      if (cardsBySymbolId.has(ref.symbolId)) continue;
      const cachedCard = sdlState.cardsBySymbolId.get(ref.symbolId);
      if (cachedCard) applyCardContext(sdlState, cachedCard);
    }
  }

  // Try file-specific cards before raw file fallback to reduce capped token cost.
  const missingSdlFilesBeforeRaw = Array.from(relevantFiles).filter(
    (relPath) => !sdlState.files.has(relPath),
  );
  for (const relPath of missingSdlFilesBeforeRaw) {
    const representativeSymbolId = fileRepresentativeSymbolMap.get(relPath);
    if (!representativeSymbolId) continue;

    if (sdlState.fetchedCardSymbols.has(representativeSymbolId)) {
      const cachedCard = sdlState.cardsBySymbolId.get(representativeSymbolId);
      if (cachedCard) applyCardContext(sdlState, cachedCard);
      continue;
    }

    const response = await handleSymbolGetCard({
      repoId,
      symbolId: representativeSymbolId,
      ifNoneMatch: sdlState.cardEtags.get(representativeSymbolId),
    });
    const responseTokens = estimateTokens(JSON.stringify(response));
    sdlAddedTokens += responseTokens;
    sdlState.tokens += responseTokens;
    sdlState.cardTokens += responseTokens;

    if ("notModified" in response && response.notModified) {
      sdlState.cardEtags.set(representativeSymbolId, response.etag);
      const cachedCard = sdlState.cardsBySymbolId.get(representativeSymbolId);
      if (cachedCard) applyCardContext(sdlState, cachedCard);
      continue;
    }
    if (!("card" in response) || !response.card) {
      continue;
    }

    const card = response.card as CardWithETag;
    if (!sdlState.fetchedCardSymbols.has(representativeSymbolId)) {
      sdlState.fetchedCardSymbols.add(representativeSymbolId);
      sdlState.cardsFetched += 1;
      sdlAddedCards += 1;
    }
    sdlState.cardEtags.set(representativeSymbolId, card.etag);
    applyCardContext(sdlState, card);
  }

  // Final safety net: in real workflows agents may open raw files when needed.
  for (const relPath of relevantFiles) {
    if (!addSdlRawFileContext(relPath, corpusByRelPath, fileSymbolMap, defaults.baseline.maxTokensPerFile, sdlState)) {
      continue;
    }
    sdlAddedRawFiles++;
    const file = corpusByRelPath.get(relPath);
    if (file) {
      sdlAddedTokens += Math.min(
        file.tokens,
        getSdlRawFileTokenCap(defaults.baseline.maxTokensPerFile),
      );
    }
  }

  const baselineFilesFound = Array.from(relevantFiles).filter((file) =>
    baselineState.openedFiles.has(file),
  ).length;
  const baselineSymbolsFound = Array.from(relevantSymbols).filter((symbol) =>
    baselineSymbolNames.has(symbol),
  ).length;
  const sdlFilesFound = Array.from(relevantFiles).filter((file) =>
    sdlState.files.has(file),
  ).length;
  const sdlSymbolsFound = collectSdlSymbolHits(relevantSymbols, sdlState).size;

  const completed =
    baselineFilesFound === relevantFiles.size &&
    baselineSymbolsFound === relevantSymbols.size &&
    sdlFilesFound === relevantFiles.size &&
    sdlSymbolsFound === relevantSymbols.size;

  return {
    baselineAddedTokens,
    baselineAddedFiles,
    baselineAddedSymbolFiles,
    sdlAddedTokens,
    sdlAddedCards,
    sdlAddedSlices,
    sdlAddedRawFiles,
    completed,
  };
}

async function runSdlStep(
  repoId: string,
  task: WorkflowTask,
  step: WorkflowStep,
  defaults: BenchmarkDefaults,
  state: SdlState,
): Promise<{
  searchHits: number;
  entrySymbols: number;
  cardsFetched: number;
  sliceCards: number;
  skeletons: number;
  tokensAdded: number;
  sliceBuildTimeMs: number;
}> {
  const terms = deriveStepTerms(task, step, defaults.sdl.maxSearchTerms);
  const changedFiles = buildChangedFilesSet(step.artifacts?.changedFiles);
  const hasExplicitHints = (step.entrySymbolHints?.length ?? 0) > 0;
  const shouldRunSearch =
    state.fetchedCardSymbols.size === 0 || hasExplicitHints;

  const searchMatches = shouldRunSearch
    ? searchSymbolsByTerms(
        repoId,
        terms,
        defaults.sdl.maxSearchResultsPerTerm,
        changedFiles,
      )
    : [];

  const hintMatches = findSymbolsByName(
    repoId,
    step.entrySymbolHints ?? [],
    4,
  );
  const hintSymbolIds = new Set(hintMatches.map((symbol) => symbol.symbol_id));

  const deduped = new Map<string, SymbolRow>();
  for (const symbol of hintMatches) deduped.set(symbol.symbol_id, symbol);
  for (const symbol of searchMatches) {
    if (!deduped.has(symbol.symbol_id)) deduped.set(symbol.symbol_id, symbol);
  }

  const ranked = Array.from(deduped.values()).sort((a, b) => {
    const aIsHint = hintSymbolIds.has(a.symbol_id);
    const bIsHint = hintSymbolIds.has(b.symbol_id);
    if (aIsHint !== bIsHint) return aIsHint ? -1 : 1;

    const aScore = scoreSymbolCandidate(a, terms, changedFiles);
    const bScore = scoreSymbolCandidate(b, terms, changedFiles);
    if (bScore !== aScore) return bScore - aScore;
    return a.name.localeCompare(b.name);
  });

  const searchPayloadLimit =
    state.slicesBuilt === 0
      ? INITIAL_STEP_SEARCH_PREVIEW_LIMIT
      : SEARCH_PAYLOAD_PREVIEW_LIMIT;
  const searchPayload = ranked.slice(0, searchPayloadLimit).map((symbol) => {
    const file = db.getFile(symbol.file_id);
    return {
      symbolId: symbol.symbol_id,
      name: symbol.name,
      kind: symbol.kind,
      file: file ? normalizePath(file.rel_path) : "",
    };
  });

  const searchTokens = estimateTokens(JSON.stringify(searchPayload));
  state.tokens += searchTokens;
  state.searchTokens += searchTokens;

  const entrySymbols = ranked.slice(0, defaults.sdl.maxEntrySymbols);
  const entrySymbolIds = entrySymbols.map((symbol) => symbol.symbol_id);
  const hintEntrySymbolIds = hintMatches
    .slice(0, defaults.sdl.maxEntrySymbols)
    .map((symbol) => symbol.symbol_id);
  const newHintEntrySymbolIds = hintEntrySymbolIds.filter(
    (symbolId) => !state.entrySymbols.has(symbolId),
  );
  const newEntrySymbolIds = entrySymbolIds.filter(
    (symbolId) => !state.entrySymbols.has(symbolId),
  );
  for (const symbolId of entrySymbolIds) state.entrySymbols.add(symbolId);

  let cardsFetched = 0;
  let cardTokens = 0;
  const maxCardsForStep =
    state.slicesBuilt === 0
      ? Math.max(
          INITIAL_STEP_MIN_CARDS,
          Math.floor(defaults.sdl.maxCardsPerStep * INITIAL_STEP_CARD_FRACTION),
        )
      : defaults.sdl.maxCardsPerStep;
  const cardCandidateMap = new Map<string, SymbolRow>();
  for (const symbol of hintMatches) {
    cardCandidateMap.set(symbol.symbol_id, symbol);
    if (cardCandidateMap.size >= maxCardsForStep) break;
  }
  for (const symbol of entrySymbols) {
    if (!cardCandidateMap.has(symbol.symbol_id)) {
      cardCandidateMap.set(symbol.symbol_id, symbol);
      if (cardCandidateMap.size >= maxCardsForStep) break;
    }
  }
  if (cardCandidateMap.size < maxCardsForStep && state.fetchedCardSymbols.size === 0) {
    for (const symbol of ranked) {
      if (!cardCandidateMap.has(symbol.symbol_id)) {
        cardCandidateMap.set(symbol.symbol_id, symbol);
        if (cardCandidateMap.size >= maxCardsForStep) break;
      }
    }
  }

  for (const symbol of cardCandidateMap.values()) {
    if (state.fetchedCardSymbols.has(symbol.symbol_id)) continue;
    const response = await handleSymbolGetCard({
      repoId,
      symbolId: symbol.symbol_id,
      ifNoneMatch: state.cardEtags.get(symbol.symbol_id),
    });

    cardTokens += estimateTokens(JSON.stringify(response));

    if ("notModified" in response && response.notModified) {
      state.cardEtags.set(symbol.symbol_id, response.etag);
      continue;
    }
    if (!("card" in response) || !response.card) {
      continue;
    }

    const card = response.card as CardWithETag;
    state.fetchedCardSymbols.add(symbol.symbol_id);
    state.cardEtags.set(symbol.symbol_id, card.etag);
    cardsFetched++;
    applyCardContext(state, card);
  }

  state.tokens += cardTokens;
  state.cardTokens += cardTokens;
  state.cardsFetched += cardsFetched;

  let sliceCards = 0;
  let sliceTokens = 0;
  let sliceBuildTimeMs = 0;
  let slice: GraphSlice | null = null;
  const hasWorkflowFocusSignal = Boolean(
    step.artifacts?.stackTrace ||
      step.artifacts?.failingTest ||
      (step.artifacts?.changedFiles?.length ?? 0) > 0,
  );
  const hasMeaningfulNewHints = newHintEntrySymbolIds.length >= 2;
  const shouldBuildSlice =
    entrySymbolIds.length > 0 &&
    (state.slicesBuilt === 0 ||
      hasWorkflowFocusSignal ||
      hasMeaningfulNewHints);

  if (shouldBuildSlice) {
    const latestVersion = db.getLatestVersion(repoId);
    const versionId = latestVersion?.version_id ?? "current";
    const isFollowUpSlice = state.slicesBuilt > 0;
    const sliceBudget = isFollowUpSlice
      ? {
          maxCards: Math.max(8, Math.floor(defaults.sdl.maxCards * 0.5)),
          maxEstimatedTokens: Math.max(
            1500,
            Math.floor(defaults.sdl.maxTokens * 0.5),
          ),
        }
      : {
          maxCards: defaults.sdl.maxCards,
          maxEstimatedTokens: defaults.sdl.maxTokens,
        };

    const sliceStart = performance.now();
    const knownCardEtags = Object.fromEntries(state.cardEtags.entries());
    slice = await buildSlice({
      repoId,
      versionId,
      entrySymbols: entrySymbolIds,
      taskText: `${task.title}\n${task.description}\n${step.goal}\n${step.prompt}`,
      knownCardEtags,
      cardDetail: "compact",
      budget: sliceBudget,
    });
    sliceBuildTimeMs = performance.now() - sliceStart;

    sliceCards = slice.cards.length;
    sliceTokens = estimateTokens(
      JSON.stringify({
        cards: slice.cards,
        cardRefs: slice.cardRefs ?? [],
      }),
    );
    state.tokens += sliceTokens;
    state.sliceTokens += sliceTokens;
    state.slicesBuilt += 1;
    state.sliceBuildTimeMs += sliceBuildTimeMs;
    const refsBySymbolId = new Map(
      (slice.cardRefs ?? []).map((ref) => [ref.symbolId, ref]),
    );
    const cardsBySymbolId = new Map(slice.cards.map((card) => [card.symbolId, card]));
    for (const card of slice.cards) {
      const inflatedCard = inflateSliceCard(slice, card);
      const ref = refsBySymbolId.get(card.symbolId);
      const etag = ref?.etag ?? hashCard(inflatedCard);
      state.cardEtags.set(card.symbolId, etag);
      applyCardContext(state, inflatedCard);
    }
    for (const ref of slice.cardRefs ?? []) {
      state.cardEtags.set(ref.symbolId, ref.etag);
      if (cardsBySymbolId.has(ref.symbolId)) continue;
      const cachedCard = state.cardsBySymbolId.get(ref.symbolId);
      if (cachedCard) applyCardContext(state, cachedCard);
    }
  } else if (entrySymbolIds.length > 0) {
    // In normal usage, agents reuse prior slice context when focus is unchanged.
    const refreshPayload = {
      reusePreviousSlice: true,
      entrySymbols: entrySymbolIds.slice(0, 6),
    };
    sliceTokens = estimateTokens(JSON.stringify(refreshPayload));
    state.tokens += sliceTokens;
    state.sliceTokens += sliceTokens;
  }

  const shouldGenerateSkeleton =
    step.phase === "investigate" || step.phase === "change";
  const skeletonTargets: SymbolRow[] = [];
  if (shouldGenerateSkeleton) {
    for (const symbol of entrySymbols) {
      if (skeletonTargets.length >= defaults.sdl.maxSkeletonsPerStep) break;
      if (symbol.kind !== "function" && symbol.kind !== "method") continue;
      skeletonTargets.push(symbol);
    }

    if (slice && skeletonTargets.length < defaults.sdl.maxSkeletonsPerStep) {
      for (const card of slice.cards) {
        if (skeletonTargets.length >= defaults.sdl.maxSkeletonsPerStep) break;
        if (card.kind !== "function" && card.kind !== "method") continue;
        const symbol = db.getSymbol(card.symbolId);
        if (!symbol) continue;
        if (skeletonTargets.some((existing) => existing.symbol_id === symbol.symbol_id)) {
          continue;
        }
        skeletonTargets.push(symbol);
      }
    }
  }

  let skeletons = 0;
  let skeletonTokens = 0;

  for (const symbol of skeletonTargets) {
    if (state.generatedSkeletonSymbols.has(symbol.symbol_id)) continue;

    const skeleton = generateSymbolSkeleton(repoId, symbol.symbol_id, {
      maxLines: defaults.sdl.skeletonMaxLines,
      maxTokens: defaults.sdl.skeletonMaxTokens,
    });

    if (!skeleton) continue;

    state.generatedSkeletonSymbols.add(symbol.symbol_id);
    skeletons++;
    skeletonTokens += skeleton.estimatedTokens;

    if (skeleton.skeleton) state.textFragments.push(skeleton.skeleton);
    state.symbolNames.add(symbol.name.toLowerCase());

    const file = db.getFile(symbol.file_id);
    if (file) state.files.add(normalizePath(file.rel_path));
  }

  state.tokens += skeletonTokens;
  state.skeletonTokens += skeletonTokens;
  state.skeletonsGenerated += skeletons;

  const tokensAdded = searchTokens + cardTokens + sliceTokens + skeletonTokens;

  return {
    searchHits: ranked.length,
    entrySymbols: entrySymbolIds.length,
    cardsFetched,
    sliceCards,
    skeletons,
    tokensAdded,
    sliceBuildTimeMs,
  };
}

function runBaselineStep(
  task: WorkflowTask,
  step: WorkflowStep,
  defaults: BenchmarkDefaults,
  corpus: CorpusFile[],
  state: BaselineState,
): { filesOpened: number; tokensAdded: number } {
  const terms = deriveStepTerms(task, step, defaults.sdl.maxSearchTerms);
  const changedFiles = buildChangedFilesSet(step.artifacts?.changedFiles);

  const scored = corpus
    .map((file) => {
      const { score, hits } = scoreContent(file.content, terms);
      const changedFileBonus = changedFiles.has(file.relPath) ? 30 : 0;
      const pathScore = terms.reduce((sum, term) => {
        if (file.relPath.toLowerCase().includes(term)) return sum + 2;
        return sum;
      }, 0);
      return {
        file,
        score: score + changedFileBonus + pathScore,
        hits,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.file.relPath.localeCompare(b.file.relPath);
    });

  const selected = scored.slice(0, defaults.baseline.maxFilesPerStep);
  state.matchedFiles += scored.length;
  state.matchedTerms += selected.reduce((sum, file) => sum + file.hits, 0);

  let filesOpened = 0;
  let tokensAdded = 0;

  for (const entry of selected) {
    const relPath = entry.file.relPath;
    if (state.openedFiles.has(relPath)) continue;
    state.openedFiles.add(relPath);
    filesOpened++;
    const cappedTokens = Math.min(entry.file.tokens, defaults.baseline.maxTokensPerFile);
    tokensAdded += cappedTokens;
    state.tokens += cappedTokens;
    state.uncappedTokens += entry.file.tokens;
  }

  return { filesOpened, tokensAdded };
}

function analyzeLoss(taskResult: TaskResult): LossAnalysis {
  const reasons: string[] = [];
  const suggestions: string[] = [];

  if (taskResult.sdl.tokens >= taskResult.baseline.tokens) {
    reasons.push(
      "SDL tool-ladder consumed as many or more tokens than opening files for this workflow.",
    );
    suggestions.push(
      "Add incremental/delta payload responses for repeated slice and card retrieval to reduce repeated token payloads.",
    );
  }

  if (taskResult.sdl.fileCoveragePct < taskResult.baseline.fileCoveragePct) {
    reasons.push(
      "SDL reached fewer target files, indicating prompt-to-entry selection or graph expansion gaps.",
    );
    suggestions.push(
      "Improve natural-language-to-entry-symbol mapping and strengthen first-hop expansion from explicit entry symbols.",
    );
  }

  if (taskResult.sdl.symbolCoveragePct < taskResult.baseline.symbolCoveragePct) {
    reasons.push(
      "SDL surfaced fewer target symbols, indicating ranking/recall issues for symbol discovery.",
    );
    suggestions.push(
      "Improve symbol search ranking for natural-language prompts and include unresolved identifier normalization in ranking.",
    );
  }

  if (taskResult.sdl.precision < taskResult.baseline.precision) {
    reasons.push(
      "SDL context included more non-target files than baseline for this task.",
    );
    suggestions.push(
      "Further penalize high-degree aggregator symbols/files during slice scoring so domain-focused files rank higher.",
    );
  }

  if (taskResult.sdl.slicesBuilt > 0 && taskResult.sdl.sliceBuildTimeMs > 750) {
    reasons.push("Slice builds were relatively expensive for this task.");
    suggestions.push(
      "Add intent-aware fast path that skips full slice expansion when search/cards already satisfy task context.",
    );
  }

  if (reasons.length === 0) {
    reasons.push("Traditional won on tie-break scoring despite close metrics.");
    suggestions.push(
      "Review ranking tie-breakers and add stronger lightweight-context heuristics for short investigative tasks.",
    );
  }

  return {
    reasons,
    suggestions: Array.from(new Set(suggestions)),
  };
}

function printComparisonTable(result: TaskResult): void {
  const b = result.baseline;
  const s = result.sdl;
  const nB = result.naturalCoverage.baseline;
  const nS = result.naturalCoverage.sdl;

  console.log("\n  COMPARISON TABLE");
  console.log("  " + "-".repeat(68));
  console.log(
    "  | Metric                    | Traditional    | SDL-MCP        | Winner |",
  );
  console.log(
    "  |---------------------------+----------------+----------------+--------|",
  );

  const tokenWinner = s.tokens < b.tokens ? "SDL" : b.tokens < s.tokens ? "Trad" : "Tie";
  const baselineTokensPerCoverage = b.tokensPerCoveragePoint ?? Number.POSITIVE_INFINITY;
  const sdlTokensPerCoverage = s.tokensPerCoveragePoint ?? Number.POSITIVE_INFINITY;
  const tokenEfficiencyWinner =
    sdlTokensPerCoverage < baselineTokensPerCoverage
      ? "SDL"
      : baselineTokensPerCoverage < sdlTokensPerCoverage
        ? "Trad"
        : "Tie";
  const naturalContextWinner =
    nS.contextCoveragePct > nB.contextCoveragePct
      ? "SDL"
      : nB.contextCoveragePct > nS.contextCoveragePct
        ? "Trad"
        : "Tie";
  console.log(
    `  | Tokens                    | ${formatNumber(b.tokens).padStart(12)} | ${formatNumber(s.tokens).padStart(12)} | ${tokenWinner.padStart(6)} |`,
  );
  console.log(
    `  | Tokens/Coverage Point     | ${formatTokensPerCoveragePoint(b.tokensPerCoveragePoint).padStart(12)} | ${formatTokensPerCoveragePoint(s.tokensPerCoveragePoint).padStart(12)} | ${tokenEfficiencyWinner.padStart(6)} |`,
  );

  const fileWinner = s.fileCoveragePct > b.fileCoveragePct ? "SDL" : b.fileCoveragePct > s.fileCoveragePct ? "Trad" : "Tie";
  console.log(
    `  | File Coverage             | ${formatPercent(b.fileCoveragePct).padStart(12)} | ${formatPercent(s.fileCoveragePct).padStart(12)} | ${fileWinner.padStart(6)} |`,
  );

  const symbolWinner = s.symbolCoveragePct > b.symbolCoveragePct ? "SDL" : b.symbolCoveragePct > s.symbolCoveragePct ? "Trad" : "Tie";
  console.log(
    `  | Symbol Coverage           | ${formatPercent(b.symbolCoveragePct).padStart(12)} | ${formatPercent(s.symbolCoveragePct).padStart(12)} | ${symbolWinner.padStart(6)} |`,
  );

  const contextWinner = s.contextCoveragePct > b.contextCoveragePct ? "SDL" : b.contextCoveragePct > s.contextCoveragePct ? "Trad" : "Tie";
  console.log(
    `  | Context Coverage          | ${formatPercent(b.contextCoveragePct).padStart(12)} | ${formatPercent(s.contextCoveragePct).padStart(12)} | ${contextWinner.padStart(6)} |`,
  );
  console.log(
    `  | Natural Context Coverage  | ${formatPercent(nB.contextCoveragePct).padStart(12)} | ${formatPercent(nS.contextCoveragePct).padStart(12)} | ${naturalContextWinner.padStart(6)} |`,
  );

  const precisionWinner = s.precision > b.precision ? "SDL" : b.precision > s.precision ? "Trad" : "Tie";
  console.log(
    `  | Precision                 | ${formatPercent(b.precision * 100).padStart(12)} | ${formatPercent(s.precision * 100).padStart(12)} | ${precisionWinner.padStart(6)} |`,
  );

  const recallWinner = s.recall > b.recall ? "SDL" : b.recall > s.recall ? "Trad" : "Tie";
  console.log(
    `  | Recall                    | ${formatPercent(b.recall * 100).padStart(12)} | ${formatPercent(s.recall * 100).padStart(12)} | ${recallWinner.padStart(6)} |`,
  );

  console.log(
    "  |---------------------------+----------------+----------------+--------|",
  );
  console.log(`  | OVERALL WINNER: ${result.comparison.winner.padEnd(49)}|`);
  console.log(
    `  | Composite Score: ${result.comparison.compositeScore.toFixed(2).padEnd(48)}|`,
  );
  console.log(
    `  | Token Reduction: ${formatPercent(result.comparison.tokenReductionPct).padEnd(48)}|`,
  );
  console.log(
    `  | Token Reduction (uncap): ${formatPercent(result.comparison.tokenReductionPctUncapped).padEnd(39)}|`,
  );
  if (result.comparison.extraContextPctWhenCheaper !== null) {
    console.log(
      `  | Extra Context (cheaper): ${formatPercent(result.comparison.extraContextPctWhenCheaper).padEnd(39)}|`,
    );
  }
  console.log("  " + "-".repeat(68));

  console.log("  Coverage score definitions:");
  console.log("    File Coverage   = relevant files found / total relevant files for the task.");
  console.log("    Symbol Coverage = relevant symbols found / total relevant symbols for the task.");
  console.log("    Natural Coverage = coverage before completion pass retrieval.");
}

function printSummary(summary: BenchmarkSummary): void {
  console.log("\n  REAL-WORLD WORKFLOW SUMMARY");
  console.log("  " + "-".repeat(68));
  console.log(`
  Tasks run:                  ${summary.taskCount}
  SDL-MCP wins:               ${summary.sdlWins}
  Traditional wins:           ${summary.traditionalWins}
  Ties:                       ${summary.ties}

  ${progressBar(summary.avgTokenReductionPct)} ${formatPercent(summary.avgTokenReductionPct)} average token reduction
  ${progressBar(summary.avgContextCoverageGainPct + 50)} ${formatPercent(summary.avgContextCoverageGainPct)} average context coverage gain
  ${progressBar(summary.avgFileCoverageGainPct + 50)} ${formatPercent(summary.avgFileCoverageGainPct)} average file coverage gain
  ${progressBar(summary.avgSymbolCoverageGainPct + 50)} ${formatPercent(summary.avgSymbolCoverageGainPct)} average symbol coverage gain
  ${progressBar(summary.avgPrecisionGainPct + 50)} ${formatPercent(summary.avgPrecisionGainPct)} average precision gain
  ${progressBar(summary.avgRecallGainPct + 50)} ${formatPercent(summary.avgRecallGainPct)} average recall gain
  Composite score (avg):      ${summary.avgCompositeScore.toFixed(2)}

  SDL cheaper + richer context tasks: ${summary.tasksWithExtraContextWhenCheaper}
  Avg extra context when cheaper:      ${formatPercent(summary.avgExtraContextWhenCheaperPct)}
  Difficulty mix (E/M/H):              ${summary.difficultyBreakdown.easy}/${summary.difficultyBreakdown.medium}/${summary.difficultyBreakdown.hard}
  `);
}

function printLosses(results: TaskResult[]): void {
  const losses = results.filter((result) => result.comparison.winner === "Traditional");
  if (losses.length === 0) return;

  console.log("\n  SDL-MCP LOSS ANALYSIS");
  console.log("  " + "-".repeat(68));

  for (const loss of losses) {
    const analysis = loss.lossAnalysis;
    if (!analysis) continue;

    console.log(`\n  Task: ${loss.id} (${loss.title})`);
    console.log("  Reasons:");
    for (const reason of analysis.reasons) {
      console.log(`    - ${reason}`);
    }
    console.log("  Improvement suggestions:");
    for (const suggestion of analysis.suggestions) {
      console.log(`    - ${suggestion}`);
    }
  }
}

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const tasksPath = resolve(
    getArgValue(args, "tasks") ??
      getNpmConfigValue("tasks") ??
      DEFAULT_TASKS_PATH,
  );
  const repoOverride =
    getArgValue(args, "repo-id") ?? getNpmConfigValue("repo-id");
  const configPath =
    getArgValue(args, "config") ?? getNpmConfigValue("config");
  const outPath =
    getArgValue(args, "out") ??
    getFallbackOutPath(args) ??
    getNpmOutPath();
  const skipIndex = getFlagEnabled(args, "skip-index");

  const taskFileRaw = readFileSync(tasksPath, "utf-8");
  const parsed = JSON.parse(taskFileRaw) as TaskFile;
  const normalized = normalizeTaskFile(parsed);

  const config = loadConfig(configPath);
  const database = getDb(config.dbPath);
  runMigrations(database);

  const repoConfig = repoOverride
    ? config.repos.find((repo) => repo.repoId === repoOverride)
    : config.repos[0];

  if (!repoConfig) {
    throw new Error("No repository configured for benchmark.");
  }

  const persistedRepo = db.getRepo(repoConfig.repoId);
  if (!persistedRepo) {
    db.createRepo({
      repo_id: repoConfig.repoId,
      root_path: repoConfig.rootPath,
      config_json: JSON.stringify(repoConfig),
      created_at: new Date().toISOString(),
    });
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
  const corpus = buildCorpus(repoConfig.rootPath, candidateFiles);
  const corpusByRelPath = new Map(corpus.map((file) => [file.relPath, file]));
  const corpusPaths = new Set(corpus.map((file) => file.relPath));
  const fileSymbolMap = buildFileSymbolNameMap(repoConfig.repoId);
  const fileRepresentativeSymbolMap = buildFileRepresentativeSymbolMap(
    repoConfig.repoId,
  );

  const results: TaskResult[] = [];

  printHeader("SDL-MCP REAL-WORLD WORKFLOW BENCHMARK");
  console.log(`
  Benchmark Mode: realism-first (no per-task budget/query tuning)
  SDL ladder:     symbol search -> cards -> slice -> skeletons
  Completion:     continue retrieval until task target context is reached
  Scoring:        weighted composite (token, coverage, efficiency, precision)
  Baseline mode:  capped + uncapped token baselines reported
  Repository:     ${repoConfig.repoId}
  Root Path:      ${repoConfig.rootPath}
  Tasks:          ${normalized.tasks.length}
  Candidate files:${formatNumber(corpus.length)}
  `);

  for (const task of normalized.tasks) {
    if (task.repoId && task.repoId !== repoConfig.repoId) continue;

    printTaskHeader(task);

    const relevantFiles = expandRelevantFiles(
      repoConfig.rootPath,
      task.contextTargets.files,
    );
    const relevantSymbols = new Set(
      (task.contextTargets.symbols ?? [])
        .map((name) => normalizeSymbolName(name))
        .filter((name): name is string => !!name),
    );

    const baselineState: BaselineState = {
      openedFiles: new Set<string>(),
      tokens: 0,
      uncappedTokens: 0,
      matchedFiles: 0,
      matchedTerms: 0,
    };

    const sdlState: SdlState = {
      files: new Set<string>(),
      symbolNames: new Set<string>(),
      textFragments: [],
      entrySymbols: new Set<string>(),
      fetchedCardSymbols: new Set<string>(),
      cardEtags: new Map<string, string>(),
      cardsBySymbolId: new Map<string, SymbolCard>(),
      generatedSkeletonSymbols: new Set<string>(),
      tokens: 0,
      searchTokens: 0,
      cardTokens: 0,
      sliceTokens: 0,
      skeletonTokens: 0,
      cardsFetched: 0,
      slicesBuilt: 0,
      skeletonsGenerated: 0,
      sliceBuildTimeMs: 0,
    };

    const stepResults: StepResult[] = [];
    let previousCoverage = captureCoverageFromStates({
      relevantFiles,
      relevantSymbols,
      fileSymbolMap,
      baselineState,
      sdlState,
      corpusPaths,
    });

    for (const step of task.workflow) {
      console.log(`\n  [Step: ${step.phase}] ${step.goal}`);

      const baselineStep = runBaselineStep(
        task,
        step,
        normalized.defaults,
        corpus,
        baselineState,
      );

      const sdlStep = await runSdlStep(
        repoConfig.repoId,
        task,
        step,
        normalized.defaults,
        sdlState,
      );

      const currentCoverage = captureCoverageFromStates({
        relevantFiles,
        relevantSymbols,
        fileSymbolMap,
        baselineState,
        sdlState,
        corpusPaths,
      });
      const baselineMarginalCoveragePct =
        currentCoverage.baseline.contextCoveragePct -
        previousCoverage.baseline.contextCoveragePct;
      const sdlMarginalCoveragePct =
        currentCoverage.sdl.contextCoveragePct -
        previousCoverage.sdl.contextCoveragePct;
      const baselineTokensPerCoveragePoint =
        baselineMarginalCoveragePct > 0
          ? baselineStep.tokensAdded / baselineMarginalCoveragePct
          : null;
      const sdlTokensPerCoveragePoint =
        sdlMarginalCoveragePct > 0
          ? sdlStep.tokensAdded / sdlMarginalCoveragePct
          : null;
      const baselineDeadWeight =
        baselineStep.tokensAdded > 0 && baselineMarginalCoveragePct <= 0;
      const sdlDeadWeight = sdlStep.tokensAdded > 0 && sdlMarginalCoveragePct <= 0;

      stepResults.push({
        id: step.id,
        phase: step.phase,
        baselineFilesOpened: baselineStep.filesOpened,
        baselineTokensAdded: baselineStep.tokensAdded,
        sdlSearchHits: sdlStep.searchHits,
        sdlEntrySymbols: sdlStep.entrySymbols,
        sdlCardsFetched: sdlStep.cardsFetched,
        sdlSliceCards: sdlStep.sliceCards,
        sdlSkeletons: sdlStep.skeletons,
        sdlTokensAdded: sdlStep.tokensAdded,
        sliceBuildTimeMs: sdlStep.sliceBuildTimeMs,
        baselineCoveragePctAfter: currentCoverage.baseline.contextCoveragePct,
        sdlCoveragePctAfter: currentCoverage.sdl.contextCoveragePct,
        baselineMarginalCoveragePct,
        sdlMarginalCoveragePct,
        baselineTokensPerCoveragePoint,
        sdlTokensPerCoveragePoint,
        baselineDeadWeight,
        sdlDeadWeight,
      });

      console.log(
        `    Baseline opened ${baselineStep.filesOpened} new file(s), +${formatNumber(baselineStep.tokensAdded)} tokens`,
      );
      console.log(
        `    SDL hits:${sdlStep.searchHits} entry:${sdlStep.entrySymbols} cards:${sdlStep.cardsFetched} sliceCards:${sdlStep.sliceCards} skeletons:${sdlStep.skeletons} +${formatNumber(sdlStep.tokensAdded)} tokens (${formatMs(sdlStep.sliceBuildTimeMs)} slice)`,
      );
      console.log(
        `    Marginal coverage gain -> baseline +${formatPercent(baselineMarginalCoveragePct)} (${formatTokensPerCoveragePoint(baselineTokensPerCoveragePoint)})${baselineDeadWeight ? " [dead-weight]" : ""}, SDL +${formatPercent(sdlMarginalCoveragePct)} (${formatTokensPerCoveragePoint(sdlTokensPerCoveragePoint)})${sdlDeadWeight ? " [dead-weight]" : ""}`,
      );
      previousCoverage = currentCoverage;
    }

    const naturalCoverage = captureCoverageFromStates({
      relevantFiles,
      relevantSymbols,
      fileSymbolMap,
      baselineState,
      sdlState,
      corpusPaths,
    });

    const completion = await runCompletionPass(
      repoConfig.repoId,
      task,
      normalized.defaults,
      relevantFiles,
      relevantSymbols,
      corpusByRelPath,
      fileSymbolMap,
      fileRepresentativeSymbolMap,
      baselineState,
      sdlState,
    );
    console.log(
      `\n  [Completion pass] baseline +${formatNumber(completion.baselineAddedTokens)} tokens (${completion.baselineAddedFiles} target files + ${completion.baselineAddedSymbolFiles} symbol-driven files), SDL +${formatNumber(completion.sdlAddedTokens)} tokens (${completion.sdlAddedCards} cards, ${completion.sdlAddedSlices} slices, ${completion.sdlAddedRawFiles} raw files)`,
    );

    const postCompletionCoverage = captureCoverageFromStates({
      relevantFiles,
      relevantSymbols,
      fileSymbolMap,
      baselineState,
      sdlState,
      corpusPaths,
    });

    const baselineMetrics: BaselineSelection = {
      ...postCompletionCoverage.baseline,
      filesViewed: Array.from(baselineState.openedFiles).sort(),
      matchedFiles: baselineState.matchedFiles,
      matchedTerms: baselineState.matchedTerms,
    };

    const sdlMetrics: SdlSelection = {
      ...postCompletionCoverage.sdl,
      contextFiles: Array.from(sdlState.files).sort(),
      entrySymbols: Array.from(sdlState.entrySymbols).sort(),
      cardsFetched: sdlState.cardsFetched,
      slicesBuilt: sdlState.slicesBuilt,
      skeletonsGenerated: sdlState.skeletonsGenerated,
      searchTokens: sdlState.searchTokens,
      cardTokens: sdlState.cardTokens,
      sliceTokens: sdlState.sliceTokens,
      skeletonTokens: sdlState.skeletonTokens,
      sliceBuildTimeMs: sdlState.sliceBuildTimeMs,
    };

    const tokenReductionPct = computeTokenReduction(
      baselineMetrics.tokens,
      sdlMetrics.tokens,
    );
    const tokenReductionPctUncapped = computeTokenReduction(
      baselineMetrics.tokensUncapped ?? baselineMetrics.tokens,
      sdlMetrics.tokens,
    );

    const fileCoverageGainPct = sdlMetrics.fileCoveragePct - baselineMetrics.fileCoveragePct;
    const symbolCoverageGainPct = sdlMetrics.symbolCoveragePct - baselineMetrics.symbolCoveragePct;
    const contextCoverageGainPct = sdlMetrics.contextCoveragePct - baselineMetrics.contextCoveragePct;
    const precisionGainPct = (sdlMetrics.precision - baselineMetrics.precision) * 100;
    const recallGainPct = (sdlMetrics.recall - baselineMetrics.recall) * 100;
    const { compositeScore, scoreBreakdown } = computeCompositeScore(
      baselineMetrics,
      sdlMetrics,
      normalized.defaults.scoring,
    );
    const winner: "SDL-MCP" | "Traditional" | "Tie" =
      compositeScore > normalized.defaults.scoring.thresholds.sdlWin
        ? "SDL-MCP"
        : compositeScore < normalized.defaults.scoring.thresholds.traditionalWin
          ? "Traditional"
          : "Tie";

    const extraContextPctWhenCheaper =
      sdlMetrics.tokens < baselineMetrics.tokens &&
      sdlMetrics.contextUnitsFound > baselineMetrics.contextUnitsFound
        ? ((sdlMetrics.contextUnitsFound - baselineMetrics.contextUnitsFound) /
            Math.max(1, baselineMetrics.contextUnitsFound)) *
          100
        : null;

    const taskResult: TaskResult = {
      id: task.id,
      category: task.category,
      tags: task.tags ?? [],
      difficulty: task.difficulty ?? "medium",
      title: task.title,
      description: task.description,
      naturalCoverage,
      postCompletionCoverage,
      baseline: baselineMetrics,
      sdl: sdlMetrics,
      steps: stepResults,
      completion,
      comparison: {
        tokenReductionPct,
        tokenReductionPctUncapped,
        fileCoverageGainPct,
        symbolCoverageGainPct,
        contextCoverageGainPct,
        precisionGainPct,
        recallGainPct,
        compositeScore,
        scoreBreakdown,
        extraContextPctWhenCheaper,
        winner,
      },
    };

    if (winner === "Traditional") {
      taskResult.lossAnalysis = analyzeLoss(taskResult);
    }

    results.push(taskResult);
    printComparisonTable(taskResult);
  }

  printHeader("BENCHMARK SUMMARY");

  const taskCount = results.length;
  const avgTokenReductionPct =
    results.reduce((sum, result) => sum + result.comparison.tokenReductionPct, 0) /
    Math.max(1, taskCount);
  const avgContextCoverageGainPct =
    results.reduce((sum, result) => sum + result.comparison.contextCoverageGainPct, 0) /
    Math.max(1, taskCount);
  const avgFileCoverageGainPct =
    results.reduce((sum, result) => sum + result.comparison.fileCoverageGainPct, 0) /
    Math.max(1, taskCount);
  const avgSymbolCoverageGainPct =
    results.reduce((sum, result) => sum + result.comparison.symbolCoverageGainPct, 0) /
    Math.max(1, taskCount);
  const avgPrecisionGainPct =
    results.reduce((sum, result) => sum + result.comparison.precisionGainPct, 0) /
    Math.max(1, taskCount);
  const avgRecallGainPct =
    results.reduce((sum, result) => sum + result.comparison.recallGainPct, 0) /
    Math.max(1, taskCount);
  const avgCompositeScore =
    results.reduce((sum, result) => sum + result.comparison.compositeScore, 0) /
    Math.max(1, taskCount);

  const sdlWins = results.filter((result) => result.comparison.winner === "SDL-MCP").length;
  const traditionalWins = results.filter((result) => result.comparison.winner === "Traditional").length;
  const ties = results.filter((result) => result.comparison.winner === "Tie").length;

  const extraContextValues = results
    .map((result) => result.comparison.extraContextPctWhenCheaper)
    .filter((value): value is number => value !== null);

  const difficultyBreakdown = {
    easy: results.filter((result) => result.difficulty === "easy").length,
    medium: results.filter((result) => result.difficulty === "medium").length,
    hard: results.filter((result) => result.difficulty === "hard").length,
  };

  const summary: BenchmarkSummary = {
    repoId: repoConfig.repoId,
    rootPath: repoConfig.rootPath,
    timestamp: new Date().toISOString(),
    taskCount,
    sdlWins,
    traditionalWins,
    ties,
    avgTokenReductionPct,
    avgContextCoverageGainPct,
    avgFileCoverageGainPct,
    avgSymbolCoverageGainPct,
    avgPrecisionGainPct,
    avgRecallGainPct,
    avgCompositeScore,
    tasksWithExtraContextWhenCheaper: extraContextValues.length,
    avgExtraContextWhenCheaperPct:
      extraContextValues.reduce((sum, value) => sum + value, 0) /
      Math.max(1, extraContextValues.length),
    difficultyBreakdown,
  };

  printSummary(summary);
  printLosses(results);

  if (outPath) {
    const resolved = resolve(outPath);
    const payload = {
      benchmarkVersion: "3.0",
      generatedAt: new Date().toISOString(),
      repoId: repoConfig.repoId,
      rootPath: repoConfig.rootPath,
      defaults: normalized.defaults,
      summary,
      tasks: results,
    };

    writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf-8");
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
