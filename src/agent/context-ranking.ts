/**
 * Multi-factor symbol ranking for context retrieval.
 *
 * Combines retrieval priors (seed scores), graph proximity, lexical overlap,
 * summary/searchText support, feedback priors, and structural bonuses into
 * a single 0-100 composite score with confidence metadata.
 *
 * @module agent/context-ranking
 */

import type {
  AgentTask,
  ContextSeedCandidate,
  ScoredSymbol,
  SymbolRankingResult,
  ConfidenceTier,
} from "./types.js";
import { logger } from "../util/logger.js";

/** Symbol metadata subset needed for ranking (avoids coupling to full SymbolRow). */
export interface RankableSymbol {
  name: string;
  kind: string;
  summary?: string | null;
  searchText?: string | null;
  exported?: boolean;
  signature?: string | null;
  fileId?: string;
}

/** Behavioral kinds that get a structural bonus. */
const BEHAVIORAL_KINDS = new Set([
  "function",
  "method",
  "class",
  "constructor",
]);

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
const LANGUAGE_AFFINITY_MAP: Array<{ keywords: string[]; extensions: string[] }> = [
  {
    keywords: [
      "typescript", "ts file", ".ts", "type alias",
      "zod", "tsx", "esm import", ".js extension",
    ],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  {
    keywords: ["python", "py file", ".py", "def ", "__init__"],
    extensions: [".py", ".pyw"],
  },
  {
    keywords: ["rust", "rs file", ".rs", "cargo", "crate", "impl ", "fn ", "pub fn"],
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
    keywords: ["php", ".php", "namespace "],
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


/**
 * Structural/centrality bonus (0-8): exported, behavioral kind, focus path
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

  // Check if symbol name appears in any focus path
  if (focusPaths.length > 0) {
    const nameLower = sym.name.toLowerCase();
    for (const fp of focusPaths) {
      if (fp.toLowerCase().includes(nameLower) && nameLower.length >= 3) {
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
    // Review tasks benefit from functions that have side effects or do I/O.
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
    else if (sym.signature && BEHAVIORAL_KINDS.has(sym.kind)) score += 1;
  }

  return Math.min(8, score);
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

/**
 * Rank symbols by multi-factor composite score (0-100).
 *
 * Combines retrieval priors, graph proximity, lexical overlap,
 * summary support, feedback priors, and structural bonuses.
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
  const affinityExtensions = detectLanguageAffinity(taskTextLower);

  // Build seed score lookup: contextRef "symbol:<id>" -> normalized score
  const seedMap = new Map<string, number>();
  if (options?.seedCandidates) {
    for (const c of options.seedCandidates) {
      if (c.contextRef.startsWith("symbol:")) {
        const id = c.contextRef.slice("symbol:".length);
        const existing = seedMap.get(id) ?? 0;
        // Take the max score across sources for the same symbol
        seedMap.set(id, Math.max(existing, c.score));
      }
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
        languageAffinity: 0,
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
    const languageAffinity = scoreLanguageAffinity(sym, affinityExtensions);

    const totalScore = Math.min(
      100,
      retrievalPrior +
        graphProximity +
        lexicalOverlap +
        summarySupport +
        feedbackPrior +
        structuralBonus +
        languageAffinity,
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
      languageAffinity,
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

/**
 * Apply adaptive cutoff to a ranking result, returning the selected symbol IDs.
 *
 * - Precise mode: aggressive threshold (50% of top), cap at 5 symbols.
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

  const { topScore } = ranking;

  const threshold = isPrecise
    ? Math.max(10, topScore * 0.5)
    : Math.max(5, topScore * 0.25);

  const effectiveMax = isPrecise
    ? Math.min(5, maxCount)
    : hasScope
      ? maxCount
      : Math.min(20, maxCount);

  const relevant = ranking.ranked.filter((s) => s.totalScore >= threshold);
  const count = Math.max(1, Math.min(relevant.length, effectiveMax));

  logger.debug("Adaptive cutoff applied", {
    total: ranking.ranked.length,
    topScore,
    threshold,
    selected: count,
    effectiveMax,
    isPrecise,
    hasScope,
  });

  return ranking.ranked.slice(0, count).map((s) => s.symbolId);
}
