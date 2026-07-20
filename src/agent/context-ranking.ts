/**
 * Multi-factor symbol ranking for context retrieval.
 *
 * Combines retrieval priors (seed scores), graph proximity, lexical overlap,
 * summary/searchText support, feedback priors, structural bonuses, and path
 * affinity into a single 0-100 composite score with confidence metadata.
 *
 * @module agent/context-ranking
 */

import type {
  AgentTask,
  ContextSeedCandidate,
  ContextSeedEntityType,
  ScoredSymbol,
  SymbolRankingResult,
  ConfidenceTier,
  TaskOptions,
} from "./types.js";
import { isTestLikePath } from "../retrieval/task-query-ranking.js";
import { logger } from "../util/logger.js";
import { caseFoldedPathKey } from "../util/paths.js";

/** Symbol metadata subset needed for ranking (avoids coupling to full SymbolRow). */
export interface RankableSymbol {
  name: string;
  kind: string;
  summary?: string | null;
  searchText?: string | null;
  exported?: boolean;
  signatureJson?: string | null;
  fileId?: string;
}

/** Behavioral kinds that get a structural bonus. */
const BEHAVIORAL_KINDS = new Set([
  "function",
  "method",
  "class",
  "constructor",
]);
const EXECUTABLE_KINDS = new Set(["function", "method", "constructor"]);
const GENERIC_MODULE_NAMES = new Set(["index", "main", "mod", "module"]);

// ---------------------------------------------------------------------------
// Score components (each capped to their documented range)
// ---------------------------------------------------------------------------

/**
 * Retrieval prior (0-40): seed candidates from semantic/lexical/feedback search.
 */
function scoreRetrievalPrior(
  symbolId: string,
  seedMap: Map<string, number>,
): number {
  const seedScore = seedMap.get(symbolId);
  if (seedScore == null) return 0;
  // seedScore is normalized 0-1; scale to 0-40
  return Math.min(40, Math.max(0, seedScore * 40));
}

/**
 * Graph proximity (0-20): anchor membership or file co-location.
 *
 * This is a simplified heuristic that checks anchor set membership and
 * file-level co-location. Full graph-distance scoring comes in Chunk 6.
 */
function scoreGraphProximity(
  symbolId: string,
  sym: RankableSymbol,
  anchorSet: Set<string>,
  anchorFileIds: Set<string>,
): number {
  if (anchorSet.has(symbolId)) return 20;
  // Same file as an anchor symbol implies close graph proximity
  if (sym.fileId && anchorFileIds.has(sym.fileId)) return 10;
  return 0;
}

/**
 * Lexical overlap (0-15): name/identifier matching against task text.
 */
function scoreLexicalOverlap(
  sym: RankableSymbol,
  identifiers: string[],
  taskTextLower: string,
): number {
  let score = 0;
  const nameLower = sym.name.toLowerCase();

  // File-name relevance: if the file basename contains a task identifier,
  // boost the score. File names are often the most reliable signal of what
  // a function is about (e.g. "gate.ts" for gating logic). Without this,
  // a symbol like requireRawAccess in gate.ts loses to PolicyEngine even
  // when the task is explicitly about "how the policy engine gates code".
  if (sym.fileId) {
    const colonIdx = sym.fileId.indexOf(":");
    const relPath = colonIdx >= 0 ? sym.fileId.slice(colonIdx + 1) : sym.fileId;
    const slashIdx = Math.max(
      relPath.lastIndexOf("/"),
      relPath.lastIndexOf("\\"),
    );
    const baseNameRaw = relPath.slice(slashIdx + 1).replace(/\.[^.]+$/, "");
    const baseName = baseNameRaw.toLowerCase();
    if (baseName.length >= 3) {
      // Word-boundary match: "log" should match log.ts or log-writer.ts
      // but NOT dialog.ts or changelog.ts. Split the raw basename on
      // camelCase, kebab-case, and snake_case boundaries then check
      // set membership instead of using a substring test.
      const baseWords = new Set(
        baseNameRaw
          .replace(/([a-z])([A-Z])/g, (_, a, b) => a + "-" + b)
          .toLowerCase()
          .split(/[-_]+/)
          .filter((w) => w.length > 0),
      );
      for (const id of identifiers) {
        if (id.length < 3) continue;
        const idLower = id.toLowerCase();
        if (baseName === idLower || baseWords.has(idLower)) {
          score += 3;
          break;
        }
      }
    }
  }

  // Exact name in taskText: +5 (only for names >= 8 chars to avoid
  // rewarding generic short names that coincidentally appear in the query)
  if (nameLower.length >= 8 && taskTextLower.includes(nameLower)) {
    score += 5;
  }

  // Exact identifier match: +3 (compound names 6+ chars or code-like identifiers)
  const identifierSet = new Set(identifiers.map((id) => id.toLowerCase()));
  if (
    identifierSet.has(nameLower) &&
    (nameLower.length >= 6 || /[A-Z]/.test(sym.name))
  ) {
    score += 3;
  }

  // Per-identifier overlap in name: first +2, additional +2 each (max 3 extra = +8)
  if (nameLower.length >= 3) {
    let nameMatches = 0;
    for (const id of identifiers) {
      if (id.length < 3) continue;
      const idLower = id.toLowerCase();
      if (
        nameLower.includes(idLower) ||
        (nameLower.length >= 6 && idLower.includes(nameLower))
      ) {
        nameMatches++;
      }
    }
    if (nameMatches > 0) {
      score += 2 + Math.min(nameMatches - 1, 3) * 2;
    }
  }

  return Math.min(15, score);
}

/**
 * Summary + searchText support (0-10): identifier presence in descriptive text.
 */
function scoreSummarySupport(
  sym: RankableSymbol,
  identifiers: string[],
): number {
  let score = 0;

  // Summary matches: +1.5 each, max 4 matches = 6
  if (sym.summary) {
    const summaryLower = sym.summary.toLowerCase();
    let summaryMatches = 0;
    for (const id of identifiers) {
      if (id.length < 3) continue;
      if (summaryLower.includes(id.toLowerCase())) {
        summaryMatches++;
      }
    }
    score += Math.min(summaryMatches, 4) * 1.5;
  }

  // searchText matches: +1 each, max 3 matches = 3 (but total capped at 10)
  if (sym.searchText) {
    const searchLower = sym.searchText.toLowerCase();
    let searchMatches = 0;
    for (const id of identifiers) {
      if (id.length < 3) continue;
      if (searchLower.includes(id.toLowerCase())) {
        searchMatches++;
      }
    }
    score += Math.min(searchMatches, 3);
  }

  return Math.min(10, score);
}

/**
 * Feedback prior (0-10): prior feedback boosts for this symbol.
 */
function scoreFeedbackPrior(
  symbolId: string,
  feedbackBoosts: Map<string, number>,
): number {
  const boost = feedbackBoosts.get(symbolId);
  if (boost == null) return 0;
  // boost is 0-1; scale to 0-10
  return Math.min(10, Math.max(0, boost * 10));
}

/** Symbol kinds that represent type definitions / schemas. */
const DECLARATIVE_KINDS = new Set(["type", "interface", "enum", "typeAlias"]);

// ---------------------------------------------------------------------------
// Language Affinity
// ---------------------------------------------------------------------------

/**
 * Map of language-indicator keywords (lowercase) to file extensions.
 * When the task text mentions language-specific terms, symbols from
 * files with matching extensions get a bonus.
 */
const LANGUAGE_AFFINITY_MAP: Array<{
  keywords: string[];
  extensions: string[];
}> = [
  {
    keywords: [
      "typescript",
      "ts file",
      ".ts",
      "type alias",
      "zod",
      "tsx",
      "esm import",
      ".js extension",
    ],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  {
    keywords: ["python", "py file", ".py", "def ", "__init__"],
    extensions: [".py", ".pyw"],
  },
  {
    keywords: [
      "rust",
      "rs file",
      ".rs",
      "cargo",
      "crate",
      "impl ",
      "fn ",
      "pub fn",
    ],
    extensions: [".rs"],
  },
  {
    keywords: ["golang", "go file", ".go", "goroutine", "func "],
    extensions: [".go"],
  },
  {
    keywords: ["java", "jvm", ".java", "public static"],
    extensions: [".java"],
  },
  {
    keywords: ["kotlin", ".kt", "fun ", "data class", "companion object"],
    extensions: [".kt", ".kts"],
  },
  {
    keywords: ["csharp", "c#", ".cs", "dotnet"],
    extensions: [".cs"],
  },
  {
    keywords: ["cpp", "c++", ".cpp", ".hpp", "#include", "std::"],
    extensions: [".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".h"],
  },
  {
    keywords: ["php", ".php", "<?php", "phpunit"],
    extensions: [".php", ".phtml"],
  },
  {
    keywords: ["shell", "bash", ".sh", "script"],
    extensions: [".sh", ".bash", ".zsh"],
  },
];

/**
 * Detect which file extensions are relevant based on task text keywords.
 * Returns a Set of extensions to boost (empty if no language signal detected).
 */
function detectLanguageAffinity(taskTextLower: string): Set<string> {
  const extensions = new Set<string>();
  let bestScore = 0;
  let bestExts: string[] = [];

  for (const entry of LANGUAGE_AFFINITY_MAP) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (taskTextLower.includes(kw)) {
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestExts = entry.extensions;
    }
  }

  // Only apply if we have a strong signal (keyword match >= 4 chars)
  if (bestScore >= 4) {
    for (const ext of bestExts) extensions.add(ext);
  }

  return extensions;
}

/**
 * Score language affinity (0-4): bonus when the symbol's file extension
 * matches the language implied by the task text.
 */
function scoreLanguageAffinity(
  sym: RankableSymbol,
  affinityExtensions: Set<string>,
): number {
  if (affinityExtensions.size === 0 || !sym.fileId) return 0;
  const fileId = sym.fileId;
  const dotIdx = fileId.lastIndexOf(".");
  if (dotIdx < 0) return 0;
  const ext = fileId.slice(dotIdx);
  return affinityExtensions.has(ext) ? 4 : 0;
}

/** Penalize generic module containers only when neither task nor path agrees. */
function scoreGenericModulePenalty(
  sym: RankableSymbol,
  lexicalOverlap: number,
  pathAffinity: number,
): number {
  if (sym.kind !== "module" || lexicalOverlap > 0 || pathAffinity > 0) {
    return 0;
  }
  const normalizedName = sym.name
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  return GENERIC_MODULE_NAMES.has(normalizedName) ? -8 : 0;
}

const SCRIPT_INTENT = /\bscripts?\b/;
const DIST_INTENT = /\bdist\b|\bbuild output\b|\bcompiled\b/;
const TEST_INTENT = /\btests?\b|\bspecs?\b|\btesting\b/;
const GENERATED_OUTPUT_PATH_INTENT = /\boutputs[\\/]/;

function isTopLevelGeneratedOutputPath(relPath: string): boolean {
  return caseFoldedPathKey(relPath).startsWith("outputs/");
}

export function explicitFocusPaths(
  options: TaskOptions | undefined,
): string[] {
  return options?.inferredFocusPaths?.length
    ? []
    : (options?.focusPaths ?? []).filter((path) => path.trim().length > 0);
}

export function pathMatchesFocus(
  relPath: string,
  focusPaths: string[],
): boolean {
  const normalizedRelPath = caseFoldedPathKey(relPath);
  return focusPaths.some((focusPath) => {
    if (!focusPath.trim()) return false;
    const focus = caseFoldedPathKey(focusPath);
    if (!focus) return false;
    if (focus === ".") return true;
    return (
      normalizedRelPath === focus ||
      normalizedRelPath.startsWith(focus.endsWith("/") ? focus : `${focus}/`)
    );
  });
}

export function scorePathAffinity(
  sym: RankableSymbol,
  scope: { explicit: string[]; inferred: string[] },
  taskTextLower: string,
  includeTests: boolean | undefined,
): number {
  if (!sym.fileId) return 0;

  const relPath = sym.fileId.slice(sym.fileId.indexOf(":") + 1);
  // Explicit focus wins before category penalties so generated artifacts remain retrievable.
  if (scope.explicit.length > 0) {
    return pathMatchesFocus(relPath, scope.explicit) ? 10 : -8;
  }

  const inferredScore = pathMatchesFocus(relPath, scope.inferred) ? 6 : 0;
  let categoryScore = 0;
  if (pathMatchesFocus(relPath, ["scripts"])) {
    categoryScore = SCRIPT_INTENT.test(taskTextLower) ? 0 : -6;
  } else if (isTopLevelGeneratedOutputPath(relPath)) {
    categoryScore = GENERATED_OUTPUT_PATH_INTENT.test(taskTextLower) ? 0 : -6;
  } else if (pathMatchesFocus(relPath, ["dist"])) {
    categoryScore = DIST_INTENT.test(taskTextLower) ? 0 : -6;
  } else if (isTestLikePath(relPath)) {
    categoryScore = includeTests || TEST_INTENT.test(taskTextLower) ? 6 : -4;
  }
  return Math.max(-10, Math.min(10, inferredScore + categoryScore));
}

/**
 * Structural/centrality bonus (0-14): exported, behavioral kind, focus path
 * match, and task-type affinity.
 */
function scoreStructuralBonus(
  sym: RankableSymbol,
  focusPaths: string[],
  taskType?: string,
): number {
  let score = 0;
  if (sym.exported) score += 2;
  if (BEHAVIORAL_KINDS.has(sym.kind)) score += 1;

  // Keep the name-in-path signal here; direct file membership is scored
  // separately by scorePathAffinity.
  if (focusPaths.length > 0) {
    const nameLower = sym.name.toLowerCase();
    for (const fp of focusPaths) {
      const focus = caseFoldedPathKey(fp);
      if (focus.includes(nameLower) && nameLower.length >= 3) {
        score += 2;
        break;
      }
    }
  }

  // Task-type affinity: boost kinds that are most useful per task type.
  if (taskType === "explain") {
    // Explain tasks benefit from types, interfaces, enums — definitions
    if (DECLARATIVE_KINDS.has(sym.kind)) score += 3;
  } else if (taskType === "review") {
    // Reviews primarily need executable behavior; exported data shapes remain
    // useful through the base export bonus, but should not outrank an equally
    // relevant function or method solely because they are exported.
    if (EXECUTABLE_KINDS.has(sym.kind)) score += 3;

    // Side-effecting functions deserve an additional boost.
    // Heuristic: summary mentions write/send/delete/execute/spawn/emit.
    if (sym.summary) {
      const sLower = sym.summary.toLowerCase();
      if (
        /\b(writ|send|delet|execut|spawn|emit|mutate|insert|updat|remov)\w*\b/.test(
          sLower,
        )
      ) {
        score += 3;
      }
    }
  } else if (taskType === "implement") {
    // Implement tasks benefit from type definitions (contracts to implement
    // against) and symbols with signatures (concrete patterns to follow).
    // This is complementary to the base exported+behavioral bonus — it
    // lifts typed interfaces and signed functions that define the API shape.
    if (DECLARATIVE_KINDS.has(sym.kind)) score += 2;
    else if (sym.signatureJson && BEHAVIORAL_KINDS.has(sym.kind)) score += 1;
  }

  return Math.min(14, score);
}

// ---------------------------------------------------------------------------
// Confidence tier computation
// ---------------------------------------------------------------------------

function computeConfidenceTier(
  topScore: number,
  secondScore: number,
): ConfidenceTier {
  const gap = topScore - secondScore;
  if (topScore >= 40 && gap >= 15) return "high";
  if (topScore >= 20) return "medium";
  return "low";
}

/**
 * Count how many scoring categories are non-zero for the top-scored symbol.
 */
function computeSourceAgreement(scored: ScoredSymbol): number {
  let count = 0;
  if (scored.retrievalPrior > 0) count++;
  if (scored.graphProximity > 0) count++;
  if (scored.lexicalOverlap > 0) count++;
  if (scored.summarySupport > 0) count++;
  if (scored.feedbackPrior > 0) count++;
  if (scored.structuralBonus > 0) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Main ranking function
// ---------------------------------------------------------------------------

function contextSeedCategory(candidate: {
  entityType?: ContextSeedEntityType;
  expandedFrom?: string;
  expansionReason?: string;
}): ContextSeedEntityType {
  const origin = candidate.expandedFrom ?? "";
  if (candidate.expansionReason === "fileSummary" || origin.startsWith("fileSummary:")) {
    return "fileSummary";
  }
  if (candidate.expansionReason === "cluster" || origin.startsWith("cluster:")) {
    return "cluster";
  }
  if (candidate.expansionReason === "process" || origin.startsWith("process:")) {
    return "process";
  }
  return candidate.entityType ?? "symbol";
}

/**
 * Rank symbols by multi-factor composite score (0-100).
 *
 * Combines retrieval priors, graph proximity, lexical overlap,
 * summary support, feedback priors, structural bonuses, and path affinity.
 */
export function rankSymbols(
  symbolIds: string[],
  symbolMap: Map<string, RankableSymbol>,
  identifiers: string[],
  task: AgentTask,
  options?: {
    seedCandidates?: ContextSeedCandidate[];
    feedbackBoosts?: Map<string, number>;
    anchorSymbolIds?: string[];
  },
): SymbolRankingResult {
  const taskTextLower = task.taskText.toLowerCase();
  const focusPaths = task.options?.focusPaths ?? [];
  const explicitPaths = explicitFocusPaths(task.options);
  const inferredPaths = task.options?.inferredFocusPaths ?? [];
  const affinityExtensions = detectLanguageAffinity(taskTextLower);

  // Build per-symbol retrieval scores and retain every expansion category.
  const seedMap = new Map<string, number>();
  const seedCategoryMap = new Map<string, Set<ContextSeedEntityType>>();
  if (options?.seedCandidates) {
    for (const candidate of options.seedCandidates) {
      if (!candidate.contextRef.startsWith("symbol:")) continue;
      const symbolId = candidate.contextRef.slice("symbol:".length);
      const existing = seedMap.get(symbolId) ?? 0;
      seedMap.set(symbolId, Math.max(existing, candidate.score));

      const categories =
        seedCategoryMap.get(symbolId) ?? new Set<ContextSeedEntityType>();
      categories.add(contextSeedCategory(candidate));
      for (const contribution of candidate.provenance ?? []) {
        categories.add(contextSeedCategory(contribution));
      }
      seedCategoryMap.set(symbolId, categories);
    }
  }

  // Build anchor sets for graph proximity
  const anchorSet = new Set(options?.anchorSymbolIds ?? []);
  const anchorFileIds = new Set<string>();
  for (const anchorId of anchorSet) {
    const anchorSym = symbolMap.get(anchorId);
    if (anchorSym?.fileId) {
      anchorFileIds.add(anchorSym.fileId);
    }
  }

  const feedbackBoosts = options?.feedbackBoosts ?? new Map<string, number>();

  const scored: ScoredSymbol[] = [];
  for (const symbolId of symbolIds) {
    const sym = symbolMap.get(symbolId);
    if (!sym) {
      scored.push({
        symbolId,
        totalScore: 0,
        retrievalPrior: 0,
        graphProximity: 0,
        lexicalOverlap: 0,
        summarySupport: 0,
        feedbackPrior: 0,
        structuralBonus: 0,
        pathAffinity: 0,
        languageAffinity: 0,
        genericModulePenalty: 0,
        candidateCategories: Array.from(seedCategoryMap.get(symbolId) ?? []).sort(),
      });
      continue;
    }

    const retrievalPrior = scoreRetrievalPrior(symbolId, seedMap);
    const graphProximity = scoreGraphProximity(
      symbolId,
      sym,
      anchorSet,
      anchorFileIds,
    );
    const lexicalOverlap = scoreLexicalOverlap(sym, identifiers, taskTextLower);
    const summarySupport = scoreSummarySupport(sym, identifiers);
    const feedbackPrior = scoreFeedbackPrior(symbolId, feedbackBoosts);
    const structuralBonus = scoreStructuralBonus(
      sym,
      focusPaths,
      task.taskType,
    );
    const pathAffinity = scorePathAffinity(
      sym,
      { explicit: explicitPaths, inferred: inferredPaths },
      taskTextLower,
      task.options?.includeTests,
    );
    const languageAffinity = scoreLanguageAffinity(sym, affinityExtensions);
    const genericModulePenalty = scoreGenericModulePenalty(
      sym,
      lexicalOverlap,
      pathAffinity,
    );

    const totalScore = Math.max(
      0,
      Math.min(
        100,
        retrievalPrior +
          graphProximity +
          lexicalOverlap +
          summarySupport +
          feedbackPrior +
          structuralBonus +
          pathAffinity +
          languageAffinity +
          genericModulePenalty,
      ),
    );

    scored.push({
      symbolId,
      totalScore,
      retrievalPrior,
      graphProximity,
      lexicalOverlap,
      summarySupport,
      feedbackPrior,
      structuralBonus,
      pathAffinity,
      languageAffinity,
      genericModulePenalty,
      candidateCategories: Array.from(seedCategoryMap.get(symbolId) ?? []).sort(),
    });
  }

  // Sort by total score descending, then by symbolId for determinism
  scored.sort(
    (a, b) =>
      b.totalScore - a.totalScore || a.symbolId.localeCompare(b.symbolId),
  );

  const topScore = scored[0]?.totalScore ?? 0;
  const secondScore = scored.length >= 2 ? scored[1]!.totalScore : 0;
  const confidenceTier = computeConfidenceTier(topScore, secondScore);
  const sourceAgreement =
    scored.length > 0 ? computeSourceAgreement(scored[0]!) : 0;

  logger.debug("Symbol ranking complete", {
    total: scored.length,
    topScore,
    secondScore,
    confidenceTier,
    sourceAgreement,
  });

  return {
    ranked: scored,
    topScore,
    secondScore,
    confidenceTier,
    sourceAgreement,
  };
}

// ---------------------------------------------------------------------------
// Adaptive cutoff
// ---------------------------------------------------------------------------

function getAdaptiveCandidatePool(
  ranking: SymbolRankingResult,
  maxCount: number,
  isPrecise: boolean,
  hasScope: boolean,
): {
  candidateIds: string[];
  selectedCount: number;
  threshold: number;
  effectiveMax: number;
} {
  const threshold =
    isPrecise && !hasScope
      ? Math.max(10, ranking.topScore * 0.5)
      : Math.max(5, ranking.topScore * 0.25);
  const effectiveMax =
    isPrecise && !hasScope
      ? Math.min(5, maxCount)
      : isPrecise && hasScope
        ? Math.min(10, maxCount)
        : hasScope
          ? maxCount
          : Math.min(20, maxCount);
  const relevantIds = ranking.ranked
    .filter((scored) => scored.totalScore >= threshold)
    .map((scored) => scored.symbolId);
  const selectedCount = Math.max(1, Math.min(relevantIds.length, effectiveMax));
  const candidateIds =
    relevantIds.length > 0
      ? relevantIds
      : ranking.ranked.slice(0, 1).map((scored) => scored.symbolId);
  return {
    candidateIds,
    selectedCount,
    threshold,
    effectiveMax,
  };
}

/**
 * Apply adaptive cutoff to a ranking result, returning the selected symbol IDs.
 *
 * - Precise unscoped: aggressive threshold (50% of top), cap at 5 symbols.
 * - Precise scoped: relaxed threshold (25% of top), cap at 10 symbols.
 * - Broad unscoped: generous threshold (25% of top), cap at 20 symbols.
 * - Broad scoped: generous threshold (25% of top), use maxCount.
 * - Always returns at least 1 symbol if any are available.
 */
export function applyAdaptiveCutoff(
  ranking: SymbolRankingResult,
  maxCount: number,
  isPrecise: boolean,
  hasScope: boolean,
): string[] {
  if (ranking.ranked.length === 0) return [];

  const cutoff = getAdaptiveCandidatePool(
    ranking,
    maxCount,
    isPrecise,
    hasScope,
  );
  logger.debug("Adaptive cutoff applied", {
    total: ranking.ranked.length,
    topScore: ranking.topScore,
    threshold: cutoff.threshold,
    selected: cutoff.selectedCount,
    effectiveMax: cutoff.effectiveMax,
    isPrecise,
    hasScope,
  });
  return cutoff.candidateIds.slice(0, cutoff.selectedCount);
}

const FINAL_SELECTION_PER_FILE_LIMIT = 2;

function repositoryRelativeSymbolPath(symbol: RankableSymbol | undefined): string {
  const fileId = symbol?.fileId ?? "";
  return fileId.includes(":") ? fileId.slice(fileId.indexOf(":") + 1) : fileId;
}

function declarationPenalty(symbol: RankableSymbol | undefined): number {
  switch (symbol?.kind) {
    case "module":
      return 8;
    case "variable":
    case "parameter":
      return 12;
    default:
      return 0;
  }
}

function extractTaskCoverageTerms(taskText: string): string[] {
  const terms = taskText.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return [...new Set(terms)].filter(
    (term) => term !== "the" && term !== "for" && term !== "and",
  );
}

function taskCoverageTerms(
  symbol: RankableSymbol | undefined,
  identifiers: string[],
): Set<string> {
  if (!symbol || identifiers.length === 0) return new Set();
  const searchable = [
    symbol.name,
    repositoryRelativeSymbolPath(symbol),
    symbol.summary ?? "",
    symbol.searchText ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return new Set(
    identifiers.filter(
      (identifier) =>
        identifier.length >= 3 && searchable.includes(identifier.toLowerCase()),
    ),
  );
}

/**
 * Prefer candidates that add task coverage and avoid letting one broad file
 * consume all cards. Retrieval ranks remain the base relevance signal.
 */
function selectDiverseFinalCandidates(
  candidateIds: string[],
  symbolMap: Map<string, RankableSymbol>,
  ranking: SymbolRankingResult | undefined,
  identifiers: string[],
): string[] {
  const scoreById = new Map(
    ranking?.ranked.map(({ symbolId, totalScore }) => [symbolId, totalScore]) ?? [],
  );
  const categoriesById = new Map(
    ranking?.ranked.map(({ symbolId, candidateCategories }) => [
      symbolId,
      candidateCategories?.length ? candidateCategories : ["symbol" as const],
    ]) ?? [],
  );
  const remaining = [...new Set(candidateIds)];
  const selected: string[] = [];
  const coveredTerms = new Set<string>();
  const coveredCategories = new Set<ContextSeedEntityType>();
  const countByFile = new Map<string, number>();

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;
    let bestSymbolId = "";

    for (let index = 0; index < remaining.length; index++) {
      const symbolId = remaining[index];
      const symbol = symbolMap.get(symbolId);
      const path = repositoryRelativeSymbolPath(symbol);
      if (path && (countByFile.get(path) ?? 0) >= FINAL_SELECTION_PER_FILE_LIMIT) {
        continue;
      }

      const terms = taskCoverageTerms(symbol, identifiers);
      let novelTermCount = 0;
      for (const term of terms) {
        if (!coveredTerms.has(term)) novelTermCount++;
      }
      const categories = categoriesById.get(symbolId) ?? ["symbol" as const];
      const novelCategoryCount = categories.filter(
        (category) => !coveredCategories.has(category),
      ).length;
      const adjustedScore =
        (scoreById.get(symbolId) ?? 0) -
        declarationPenalty(symbol) +
        Math.min(12, novelTermCount * 3) +
        Math.min(6, novelCategoryCount * 2);

      if (
        adjustedScore > bestAdjustedScore ||
        (adjustedScore === bestAdjustedScore &&
          (bestIndex < 0 || symbolId.localeCompare(bestSymbolId) < 0))
      ) {
        bestIndex = index;
        bestAdjustedScore = adjustedScore;
        bestSymbolId = symbolId;
      }
    }

    if (bestIndex < 0) break;
    remaining.splice(bestIndex, 1);
    selected.push(bestSymbolId);

    const symbol = symbolMap.get(bestSymbolId);
    const path = repositoryRelativeSymbolPath(symbol);
    if (path) countByFile.set(path, (countByFile.get(path) ?? 0) + 1);
    for (const term of taskCoverageTerms(symbol, identifiers)) {
      coveredTerms.add(term);
    }
    for (const category of categoriesById.get(bestSymbolId) ?? ["symbol" as const]) {
      coveredCategories.add(category);
    }
  }

  return selected;
}

/** Applies the final card-selection policy after ranking and before hydration. */
export function selectFinalSymbols(
  ranking: SymbolRankingResult | undefined,
  symbolMap: Map<string, RankableSymbol>,
  task: AgentTask,
  maxCount: number,
  fallbackCandidates: string[] = ranking?.ranked.map(({ symbolId }) => symbolId) ?? [],
): string[] {
  const rankedIds = ranking?.ranked.map(({ symbolId }) => symbolId) ?? fallbackCandidates;
  const isPrecise = task.options?.contextMode === "precise";
  const hasScope = !!(
    task.options?.focusPaths?.length || task.options?.focusSymbols?.length
  );
  const adaptive = ranking
    ? getAdaptiveCandidatePool(ranking, maxCount, isPrecise, hasScope)
    : undefined;
  const explicitPaths = explicitFocusPaths(task.options);
  const inferredPaths = task.options?.inferredFocusPaths ?? [];

  // Let the final diversity pass inspect every materialized candidate. The
  // adaptive threshold still determines standalone cutoffs, but must not act
  // as a hidden pre-selector here.
  const defaultEligibleIds = rankedIds.filter((symbolId) => {
    const symbol = symbolMap.get(symbolId);
    if (!symbol) return true;
    return (
      scorePathAffinity(
        symbol,
        { explicit: [], inferred: inferredPaths },
        task.taskText.toLowerCase(),
        task.options?.includeTests,
      ) >= 0
    );
  });
  const rankedCandidates =
    explicitPaths.length === 0 && defaultEligibleIds.length > 0
      ? defaultEligibleIds
      : rankedIds;
  const selectionCount = Math.min(
    adaptive?.effectiveMax ?? maxCount,
    rankedCandidates.length,
  );
  const matchesPath = (symbolId: string, focusPath: string): boolean =>
    pathMatchesFocus(repositoryRelativeSymbolPath(symbolMap.get(symbolId)), [focusPath]);
  const candidates =
    explicitPaths.length === 0
      ? selectDiverseFinalCandidates(
          rankedCandidates,
          symbolMap,
          ranking,
          extractTaskCoverageTerms(task.taskText),
        ).slice(0, selectionCount)
      : rankedCandidates.slice(0, selectionCount);

  if (explicitPaths.length > 0) {
    const matchesExplicit = (symbolId: string): boolean =>
      explicitPaths.some((focusPath) => matchesPath(symbolId, focusPath));
    const inFocus = rankedIds.filter(matchesExplicit);

    if (isPrecise) return inFocus.slice(0, maxCount);
    if (inFocus.length > 0) {
      return [
        ...inFocus,
        ...candidates.filter((symbolId) => !matchesExplicit(symbolId)),
      ].slice(0, maxCount);
    }
    return candidates;
  }

  if (inferredPaths.length === 0 || candidates.length === 0) return candidates;

  const selected = new Set(candidates);
  const additions: string[] = [];
  const selectedFocusCount = candidates.filter((symbolId) =>
    inferredPaths.some((focusPath) => matchesPath(symbolId, focusPath)),
  ).length;
  const maxTotalFocusSymbols =
    task.options?.semantic === true ? Math.ceil(maxCount / 2) : Number.POSITIVE_INFINITY;
  const perPathLimit = inferredPaths.some((path) => path.split("/").pop()?.includes("."))
    ? 4
    : 2;

  // Walk inferred paths round-robin so the first matching path cannot consume
  // the entire soft-coverage budget before other inferred areas contribute.
  const rankingById = new Map(
    ranking?.ranked.map((entry) => [entry.symbolId, entry] as const) ?? [],
  );
  const inferredCoverageScore = (symbolId: string): number => {
    const entry = rankingById.get(symbolId);
    if (!entry) return 0;
    return (
      entry.lexicalOverlap +
      entry.summarySupport +
      entry.feedbackPrior +
      entry.structuralBonus +
      entry.pathAffinity +
      entry.languageAffinity +
      entry.genericModulePenalty
    );
  };

  // The inferred path already supplies the scope signal. Order within that
  // scope by task relevance, without letting global retrieval or graph priors
  // crowd out a lower-prior behavioral declaration.
  const pathQueues = inferredPaths.map((focusPath) =>
    rankedCandidates
      .filter((symbolId) => matchesPath(symbolId, focusPath))
      .sort(
        (a, b) =>
          inferredCoverageScore(b) - inferredCoverageScore(a) ||
          a.localeCompare(b),
      ),
  );
  for (let round = 0; round < perPathLimit; round++) {
    for (const queue of pathQueues) {
      if (selectedFocusCount + additions.length >= maxTotalFocusSymbols) break;
      let symbolId = queue.shift();
      while (symbolId !== undefined && selected.has(symbolId)) {
        symbolId = queue.shift();
      }
      if (symbolId === undefined) continue;
      selected.add(symbolId);
      additions.push(symbolId);
    }
    if (selectedFocusCount + additions.length >= maxTotalFocusSymbols) break;
  }

  if (additions.length === 0) return candidates;

  const focusSet = new Set(
    rankedCandidates.filter((symbolId) =>
      inferredPaths.some((focusPath) => matchesPath(symbolId, focusPath)),
    ),
  );
  const merged = [...candidates];
  if (task.options?.semantic === true) {
    // Preserve the strongest retrieval prefix, then surface bounded inferred
    // coverage while it is still actionable instead of hiding it at the tail.
    const insertionPoint = Math.max(1, Math.ceil(merged.length / 4));
    return [
      ...merged.slice(0, insertionPoint),
      ...additions,
      ...merged.slice(insertionPoint),
    ].slice(0, maxCount);
  }

  for (const symbolId of additions) {
    if (merged.length < maxCount) {
      merged.push(symbolId);
      continue;
    }
    const replaceIndex = merged.findLastIndex((symbolId) => !focusSet.has(symbolId));
    if (replaceIndex < 0) break;
    merged[replaceIndex] = symbolId;
  }

  return merged;
}

/**
 * Coalesce every retrieval and graph contribution for a symbol before ranking.
 *
 * The representative keeps the strongest score and earliest source rank, while
 * provenance retains every distinct contribution for diagnostics and tests.
 */
export function mergeContextSeedCandidates(
  candidates: ContextSeedCandidate[],
): ContextSeedCandidate[] {
  type Provenance = NonNullable<ContextSeedCandidate["provenance"]>[number];
  type SourceAggregate = {
    score: number;
    rawScore?: number;
    sourceRank: number;
    labels: Map<
      string,
      Pick<Provenance, "expandedFrom" | "expansionReason">
    >;
  };

  const candidateContribution = (
    candidate: ContextSeedCandidate,
  ): Provenance => ({
    source: candidate.source,
    score: candidate.score,
    sourceRank: candidate.sourceRank,
    ...(candidate.rawScore === undefined ? {} : { rawScore: candidate.rawScore }),
    ...(candidate.expandedFrom === undefined
      ? {}
      : { expandedFrom: candidate.expandedFrom }),
    ...(candidate.expansionReason === undefined
      ? {}
      : { expansionReason: candidate.expansionReason }),
  });

  const compareRepresentative = (
    left: ContextSeedCandidate,
    right: ContextSeedCandidate,
  ): number =>
    right.score - left.score ||
    left.sourceRank - right.sourceRank ||
    left.source.localeCompare(right.source);

  const merged = new Map<string, ContextSeedCandidate>();
  const provenanceByRef = new Map<
    string,
    Map<Provenance["source"], SourceAggregate>
  >();

  for (const candidate of candidates) {
    const key = candidate.contextRef;
    const bySource = provenanceByRef.get(key) ??
      new Map<Provenance["source"], SourceAggregate>();
    const contributions = [candidateContribution(candidate), ...(candidate.provenance ?? [])];

    for (const contribution of contributions) {
      const aggregate: SourceAggregate = bySource.get(contribution.source) ?? {
        score: 0,
        sourceRank: Number.POSITIVE_INFINITY,
        labels: new Map(),
      };
      aggregate.score = Math.max(aggregate.score, contribution.score);
      aggregate.sourceRank = Math.min(aggregate.sourceRank, contribution.sourceRank);
      if (contribution.rawScore !== undefined) {
        aggregate.rawScore = Math.max(
          aggregate.rawScore ?? Number.NEGATIVE_INFINITY,
          contribution.rawScore,
        );
      }
      const labelKey = [
        contribution.expandedFrom ?? "",
        contribution.expansionReason ?? "",
      ].join("\u0000");
      aggregate.labels.set(labelKey, {
        ...(contribution.expandedFrom === undefined
          ? {}
          : { expandedFrom: contribution.expandedFrom }),
        ...(contribution.expansionReason === undefined
          ? {}
          : { expansionReason: contribution.expansionReason }),
      });
      bySource.set(contribution.source, aggregate);
    }
    provenanceByRef.set(key, bySource);

    const previous = merged.get(key);
    if (!previous || compareRepresentative(candidate, previous) < 0) {
      merged.set(key, candidate);
    }
  }

  return Array.from(merged.entries())
    .sort(([leftRef], [rightRef]) => leftRef.localeCompare(rightRef))
    .map(([contextRef, candidate]) => {
      const bySource = provenanceByRef.get(contextRef) ??
        new Map<Provenance["source"], SourceAggregate>();
      const representativeSource = bySource.get(candidate.source);
      const provenance = Array.from(bySource.entries())
        .sort(([leftSource], [rightSource]) =>
          leftSource.localeCompare(rightSource),
        )
        .flatMap(([source, aggregate]) =>
          Array.from(aggregate.labels.entries())
            .sort(([leftLabel], [rightLabel]) =>
              leftLabel.localeCompare(rightLabel),
            )
            .map(([, label]) => ({
              source,
              score: aggregate.score,
              sourceRank: aggregate.sourceRank,
              ...(aggregate.rawScore === undefined
                ? {}
                : { rawScore: aggregate.rawScore }),
              ...label,
            })),
        );

      return {
        ...candidate,
        score: Math.max(...Array.from(bySource.values(), ({ score }) => score)),
        sourceRank: representativeSource?.sourceRank ?? candidate.sourceRank,
        ...(representativeSource?.rawScore === undefined
          ? {}
          : { rawScore: representativeSource.rawScore }),
        provenance,
      };
    });
}
