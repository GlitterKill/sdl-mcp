/**
 * Context Seeding Pipeline
 *
 * Implements a 3-stage seeding strategy for context retrieval:
 *   1. Semantic retrieval (entitySearch — FTS + vector hybrid)
 *   2. Hybrid/lexical fallback (searchSymbols — keyword matching)
 *   3. Feedback boosting (queryFeedbackBoosts — historically useful symbols)
 *
 * Each stage produces scored candidates that are deduplicated and capped
 * so no single source dominates the final candidate set.
 *
 * @module agent/context-seeding
 */

import type {
  AgentTask,
  ContextSeedCandidate,
  ContextSeedResult,
} from "./types.js";
import { entitySearch } from "../retrieval/index.js";
import {
  extractIdentifiersFromText,
  generateCompoundIdentifiers,
  IDENTIFIER_STOP_WORDS,
} from "./identifier-extraction.js";
import { searchSymbols } from "../db/ladybug-queries.js";
import { searchSymbolsHybridWithOverlay } from "../live-index/overlay-reader.js";
import { queryFeedbackBoosts } from "../retrieval/feedback-boost.js";
import { buildCatalog, rankCatalog } from "../code-mode/action-catalog.js";
import { getLadybugConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Minimum normalized entity score to keep from semantic search. */
const MIN_ENTITY_NORMALIZED_SCORE = 0.3;

/** Max seed candidates by context mode. */
const MAX_SEEDS_PRECISE = 12;
const MAX_SEEDS_BROAD = 24;

/** Per-term keyword search limit by mode. */
const PER_TERM_LIMIT_PRECISE = 5;
const PER_TERM_LIMIT_BROAD = 8;

/** Max individual keyword terms to search. */
const MAX_INDIVIDUAL_TERMS_PRECISE = 3;
const MAX_INDIVIDUAL_TERMS_BROAD = 6;

/** Compound search limit by mode. */
const COMPOUND_LIMIT_PRECISE = 8;
const COMPOUND_LIMIT_BROAD = 15;

/** Maximum feedback rows to consider. */
const FEEDBACK_LIMIT = 10;

/** Slots reserved so a secondary source can still appear when one lane dominates. */
const DIVERSITY_RESERVE_PRECISE = 3;
const DIVERSITY_RESERVE_BROAD = 4;

function recordTiming(
  timings: Map<string, number>,
  phase: string,
  startedAt: number,
): void {
  const durationMs = performance.now() - startedAt;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  timings.set(phase, (timings.get(phase) ?? 0) + durationMs);
}

function timingsToRecord(timings: Map<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [phase, durationMs] of timings.entries()) {
    result[phase] = Math.round(durationMs);
  }
  return result;
}

function mergeTimingRecord(
  timings: Map<string, number>,
  record: Record<string, number> | undefined,
): void {
  if (!record) return;
  for (const [phase, durationMs] of Object.entries(record)) {
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    timings.set(phase, (timings.get(phase) ?? 0) + durationMs);
  }
}

const HIGH_SIGNAL_COMPOUND_TERMS = new Set([
  "beam",
  "budget",
  "candidate",
  "cluster",
  "context",
  "dedup",
  "diagnostic",
  "entity",
  "evidence",
  "executor",
  "fusion",
  "graph",
  "hybrid",
  "identifier",
  "ladder",
  "planner",
  "projection",
  "ranking",
  "retrieval",
  "rrf",
  "rung",
  "score",
  "search",
  "seed",
  "semantic",
  "skeleton",
  "slice",
  "symbol",
]);

function isHighSignalCompound(term: string): boolean {
  const words =
    term
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? [];
  return words.some((word) => HIGH_SIGNAL_COMPOUND_TERMS.has(word));
}

export function buildContextFtsQuery(taskText: string): string {
  const words = taskText
    .slice(0, 2000)
    .match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g);
  const lexicalTerms = [...new Set(words ?? [])]
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !IDENTIFIER_STOP_WORDS.has(term.toLowerCase()));
  const seenCompoundKeys = new Set<string>();
  const identifierTerms = generateCompoundIdentifiers(taskText).filter((term) => {
    if (
      IDENTIFIER_STOP_WORDS.has(term.toLowerCase()) ||
      !/[A-Z_]/.test(term) ||
      !isHighSignalCompound(term)
    ) {
      return false;
    }
    const key = term.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seenCompoundKeys.has(key)) return false;
    seenCompoundKeys.add(key);
    return true;
  });
  const terms = [
    ...new Set([
      ...lexicalTerms.slice(0, 8),
      ...identifierTerms.slice(0, 8),
      ...lexicalTerms.slice(8, 12),
    ]),
  ].slice(0, 12);
  if (terms.length > 0) return terms.join(" ");
  return taskText.slice(0, 200);
}

const ACTION_SEED_QUERY_LIMIT = 3;

function toPascalCaseIdentifier(identifier: string): string {
  return identifier.length === 0
    ? identifier
    : identifier[0]!.toUpperCase() + identifier.slice(1);
}

export function buildActionSeedQueries(taskText: string): string[] {
  const normalizedTaskText = taskText.toLowerCase();
  const mentionedActions = buildCatalog().filter(
    (action) =>
      normalizedTaskText.includes(action.action.toLowerCase()) ||
      normalizedTaskText.includes(action.fn.toLowerCase()),
  );
  if (mentionedActions.length === 0) return [];

  const rankedActions = rankCatalog(mentionedActions, taskText).slice(
    0,
    ACTION_SEED_QUERY_LIMIT,
  );
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const action of rankedActions) {
    const pascalFn = toPascalCaseIdentifier(action.fn);
    const query = [
      `handle${pascalFn}`,
      `${pascalFn}RequestSchema`,
      `${pascalFn}ResponseSchema`,
      action.fn,
      action.action,
    ].join(" ");

    if (!seen.has(query)) {
      seen.add(query);
      queries.push(query);
    }
  }

  return queries;
}

// ---------------------------------------------------------------------------
// Focus Path Inference
// ---------------------------------------------------------------------------

/**
 * Known concept-to-directory mappings for common codebase structures.
 * Each entry maps a set of keywords (lowercase) to directories where
 * related symbols are most likely to live.
 */
const CONCEPT_DIRECTORY_MAP: Array<{ keywords: string[]; paths: string[] }> = [
  {
    keywords: ["buildcontext", "build context", "context seeding", "seed context", "context seed"],
    paths: [
      "src/agent/context-engine.ts",
      "src/agent/context-seeding.ts",
      "src/agent/identifier-extraction.ts",
    ],
  },
  {
    keywords: ["feedback", "feedback boost", "queryfeedbackboosts", "soft-deleted"],
    paths: ["src/retrieval/feedback-boost.ts"],
  },
  {
    keywords: [
      "retrieval",
      "retrieval pipeline",
      "entity search",
      "hybrid search",
      "rrf",
      "fusion",
      "semantic seeding",
    ],
    paths: [
      "src/retrieval/orchestrator.ts",
      "src/retrieval/types.ts",
      "src/agent/context-seeding.ts",
    ],
  },
  {
    keywords: ["executor", "rung execution", "evidence-aware", "evidence dedup"],
    paths: ["src/agent/executor.ts", "src/agent/types.ts"],
  },
  {
    keywords: ["planner", "context ladder", "rung planning", "budget planning"],
    paths: ["src/agent/planner.ts", "src/agent/types.ts"],
  },
  {
    keywords: [
      "cli positional json",
      "positional json",
      "positional json args",
      "stdin json",
      "tool json",
      "tool args",
    ],
    paths: [
      "src/cli/commands/tool-dispatch.ts",
      "src/cli/commands/tool-arg-parser.ts",
      "src/cli/commands/tool-actions.ts",
    ],
  },
  {
    keywords: [
      "evidence type",
      "evidence types",
      "symbolcard",
      "codewindow",
      "searchresult",
      "diagnostic",
    ],
    paths: ["src/agent/types.ts", "src/agent/executor.ts", "src/agent/evidence.ts"],
  },
  {
    keywords: ["identifier extraction", "stop word", "stop words", "stopwords"],
    paths: ["src/agent/identifier-extraction.ts"],
  },
  {
    keywords: ["projection", "broad response", "visible fields"],
    paths: ["src/mcp/context-response-projection.ts", "src/mcp/tools/context.ts"],
  },
  {
    keywords: ["score", "scoring", "ranking", "fan-in", "churn", "hotness"],
    paths: ["src/graph/score.ts", "src/graph/slice.ts"],
  },
  { keywords: ["graph", "slice", "beam", "beam search", "bfs"], paths: ["src/graph/"] },
  {
    keywords: ["skeleton", "getskeleton", "get skeleton", "skeleton budget"],
    paths: ["src/code/skeleton.ts", "src/agent/executor.ts"],
  },
  {
    keywords: ["hotpath", "hot path", "hot-path"],
    paths: ["src/code/hotpath.ts", "src/agent/executor.ts"],
  },
  { keywords: ["code window", "gating", "gate"], paths: ["src/code/", "src/policy/"] },
  { keywords: ["index", "indexer", "indexing", "symbol extraction", "tree-sitter", "treesitter", "adapter"], paths: ["src/indexer/"] },
  { keywords: ["import", "barrel", "re-export", "reexport", "call resolution"], paths: ["src/indexer/", "src/indexer/treesitter/"] },
  { keywords: ["delta", "blast radius", "version", "diff"], paths: ["src/delta/"] },
  { keywords: ["policy", "governance", "proof of need"], paths: ["src/policy/"] },
  { keywords: ["cli", "command", "serve", "doctor", "init"], paths: ["src/cli/"] },
  { keywords: ["mcp", "tool handler", "tool dispatch"], paths: ["src/mcp/"] },
  { keywords: ["config", "configuration", "settings"], paths: ["src/config/"] },
  { keywords: ["database", "ladybug", "cypher", "query", "schema"], paths: ["src/db/"] },
  { keywords: ["agent", "planner", "executor", "context engine", "seeding", "ranking"], paths: ["src/agent/"] },
  { keywords: ["code mode", "workflow", "sdl.context", "sdl.workflow"], paths: ["src/code-mode/"] },
  { keywords: ["memory", "memories"], paths: ["src/memory/"] },
  { keywords: ["runtime", "execute", "runtime execute"], paths: ["src/runtime/"] },
  {
    keywords: ["observability", "latency", "metrics", "dashboard", "telemetry"],
    paths: [
      "src/observability/aggregator.ts",
      "src/observability/service.ts",
      "src/mcp/telemetry.ts",
    ],
  },
  { keywords: ["summary", "summaries", "summarize"], paths: ["src/indexer/", "src/services/"] },
  { keywords: ["live index", "draft buffer", "overlay"], paths: ["src/live-index/"] },
  { keywords: ["embedding", "semantic", "vector", "nomic"], paths: ["src/indexer/", "src/retrieval/"] },
  { keywords: ["cluster", "community detection", "louvain"], paths: ["src/graph/"] },
  { keywords: ["rust", "native", "napi"], paths: ["native/src/"] },
  { keywords: ["path", "normalize", "windows path"], paths: ["src/util/"] },
  { keywords: ["telemetry", "metrics", "audit"], paths: ["src/mcp/"] },
  { keywords: ["pass2", "resolver", "edge builder"], paths: ["src/indexer/pass2/", "src/indexer/edge-builder/"] },
];

/** Maximum number of inferred focus paths to return. */
const MAX_INFERRED_PATHS = 3;

/**
 * Infer likely focus paths from task text when no explicit focusPaths
 * are provided.  Scans for known concept keywords and returns the
 * directories most likely to contain relevant symbols.
 *
 * Returns an empty array if no concepts are recognized — callers should
 * treat this as "no constraint" rather than "empty constraint".
 */
export function inferFocusPathsFromTaskText(taskText: string): string[] {
  const textLower = taskText.toLowerCase();

  // Score each mapping entry by how many of its keywords appear in the text
  const scored: Array<{ paths: string[]; score: number }> = [];
  for (const entry of CONCEPT_DIRECTORY_MAP) {
    let matchScore = 0;
    for (const kw of entry.keywords) {
      if (textLower.includes(kw)) {
        // Longer keywords are stronger signals
        matchScore += kw.length;
      }
    }
    if (matchScore > 0) {
      scored.push({ paths: entry.paths, score: matchScore });
    }
  }

  if (scored.length === 0) return [];

  // Sort by score descending, collect unique paths
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { paths } of scored) {
    for (const p of paths) {
      if (!seen.has(p) && result.length < MAX_INFERRED_PATHS) {
        seen.add(p);
        result.push(p);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the 3-stage seeding pipeline and return scored, deduplicated candidates.
 * Run the 3-stage seeding pipeline and return scored, deduplicated candidates.
 *
 * Stage 1 — Semantic retrieval (entitySearch)
 * Stage 2 — Hybrid/lexical fallback (searchSymbols) when retrieval still has
 *           room before feedback slots are reserved
 * Stage 3 — Feedback boosting (queryFeedbackBoosts)
 *
 * The dominant lane can use most of the cap, but diversity reserve slots keep
 * secondary lexical/semantic and feedback evidence available for final ranking.
 */
export async function buildSeedContext(
  task: AgentTask,
): Promise<ContextSeedResult> {
  const timings = new Map<string, number>();
  const forceSemanticEntitySearch = task.options?.semantic === true;
  const semanticDisabled = task.options?.semantic === false;
  const includeEvidence = task.options?.includeRetrievalEvidence !== false;
  /* sdl.context: auto-extract chatMentions from taskText when caller did not pass any */
  const { autoExtractMentions } = await import("../retrieval/seed-resolver.js");
  const resolvedChatMentions: string[] | undefined =
    task.options?.chatMentions !== undefined
      ? task.options.chatMentions
      : autoExtractMentions(task.taskText);
  /* sdl.context: capture hybrid evidence */
  let seedEvidence: import("../retrieval/types.js").RetrievalEvidence | undefined;

  const isBroad = task.options?.contextMode !== "precise";
  const useSemanticEntitySearch =
    forceSemanticEntitySearch || (!semanticDisabled && isBroad);
  // Stage 1 already runs the hybrid FTS/vector lane. Keep Stage 2 lexical-only
  // so forced semantic calls get diversity without paying for a second hybrid
  // retrieval pass over the same query.
  const useHybridLexical = false;
  const maxSeeds = isBroad ? MAX_SEEDS_BROAD : MAX_SEEDS_PRECISE;
  const halfMax = Math.ceil(maxSeeds / 2);
  const diversityReserve = isBroad
    ? DIVERSITY_RESERVE_BROAD
    : DIVERSITY_RESERVE_PRECISE;
  const primarySourceCap = Math.max(halfMax, maxSeeds - diversityReserve);
  const feedbackCap = Math.min(FEEDBACK_LIMIT, diversityReserve);
  const preFeedbackCap = maxSeeds - feedbackCap;

  const seen = new Set<string>();
  const allCandidates: ContextSeedCandidate[] = [];
  const sourceCounts = { semantic: 0, lexical: 0, feedback: 0 };

  // ------------------------------------------------------------------
  // Stage 1: Semantic retrieval (hybrid FTS + vector via orchestrator).
  // Forced semantic runs for any mode; the confidence-gated default runs this
  // lane for broad natural-language discovery and preserves precise fast paths.
  // ------------------------------------------------------------------
  if (useSemanticEntitySearch) {
    const semanticStartedAt = performance.now();
    try {
      const entityResult = await entitySearch({
        repoId: task.repoId,
        query: task.taskText,
        ftsQuery: buildContextFtsQuery(task.taskText),
        limit: isBroad ? 32 : 16,
        entityTypes: isBroad
          ? ["symbol", "cluster", "process", "fileSummary"]
          : ["symbol", "fileSummary"],
        // Keep FTS bounded through entitySearch limits, then fuse/rerank in
        // memory. This restores exact lexical hits without changing schema.
        ftsEnabled: true,
        includeEvidence: includeEvidence,
        chatMentions: resolvedChatMentions,
        chatMentionWeights: task.options?.chatMentionWeights,
        pprDirection: task.options?.pprDirection,
        pprWeight: task.options?.pprWeight,
      });
      recordTiming(timings, "seed.semanticEntitySearch", semanticStartedAt);

      if (entityResult.evidence) {
        mergeTimingRecord(timings, entityResult.evidence.diagnosticTimings);
        seedEvidence = entityResult.evidence;
      }
      const rawSemanticCandidates = entityResult.results.filter(
        (r) => r.score > 0,
      );

      if (rawSemanticCandidates.length > 0) {
        // RRF scores are small absolute values, so apply the quality threshold
        // after normalizing against the best candidate in this retrieval batch.
        const maxScore = Math.max(...rawSemanticCandidates.map((r) => r.score));
        const norm = maxScore > 0 ? maxScore : 1;

        for (let i = 0; i < rawSemanticCandidates.length; i++) {
          if (sourceCounts.semantic >= primarySourceCap) break;
          const r = rawSemanticCandidates[i];
          const normalizedScore = r.score / norm;
          if (normalizedScore < MIN_ENTITY_NORMALIZED_SCORE) continue;
          const ref = `${r.entityType}:${r.entityId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          allCandidates.push({
            contextRef: ref,
            source: "semantic",
            score: normalizedScore,
            rawScore: r.score,
            entityType: r.entityType as ContextSeedCandidate["entityType"],
            sourceRank: i,
          });
          sourceCounts.semantic++;
        }
      }
    } catch (err) {
      recordTiming(timings, "seed.semanticEntitySearch", semanticStartedAt);
      logger.debug("Semantic retrieval for context seeding failed (non-fatal)", {
        repoId: task.repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ------------------------------------------------------------------
  // Stage 2: Hybrid/lexical fallback.
  // Always keep a bounded lexical lane available before feedback slots so
  // exact names and domain terms are not crowded out by semantic vectors.
  // ------------------------------------------------------------------
  const lexicalTargetCap = semanticDisabled
    ? preFeedbackCap
    : Math.min(
        primarySourceCap,
        Math.max(diversityReserve, preFeedbackCap - sourceCounts.semantic),
      );

  const actionSeedQueries = buildActionSeedQueries(task.taskText);
  if (actionSeedQueries.length > 0 && sourceCounts.lexical < lexicalTargetCap) {
    const actionStartedAt = performance.now();
    try {
      const conn = await getLadybugConn();
      let actionRank = 0;

      for (const query of actionSeedQueries) {
        if (sourceCounts.lexical >= lexicalTargetCap) break;
        const results = await searchSymbols(conn, task.repoId, query, 4);
        for (const r of results) {
          if (sourceCounts.lexical >= lexicalTargetCap) break;
          const ref = `symbol:${r.symbolId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          allCandidates.push({
            contextRef: ref,
            source: "lexical",
            score: Math.max(0.8, 1 - actionRank / 12),
            sourceRank: actionRank,
          });
          sourceCounts.lexical++;
          actionRank++;
        }
      }
    } catch (err) {
      logger.debug("Action catalog seeding failed (non-fatal)", {
        repoId: task.repoId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      recordTiming(timings, "seed.actionCatalog", actionStartedAt);
    }
  }

  const semanticLaneHasCoverage =
    forceSemanticEntitySearch && sourceCounts.semantic >= diversityReserve;
  if (sourceCounts.lexical < lexicalTargetCap && !semanticLaneHasCoverage) {
    const lexicalStartedAt = performance.now();
    try {
      const conn = await getLadybugConn();
      const terms = extractIdentifiersFromText(task.taskText, task.taskText);

      const compoundLimit = isBroad
        ? COMPOUND_LIMIT_BROAD
        : COMPOUND_LIMIT_PRECISE;
      const perTermLimit = isBroad
        ? PER_TERM_LIMIT_BROAD
        : PER_TERM_LIMIT_PRECISE;
      const maxIndividualTerms = isBroad
        ? MAX_INDIVIDUAL_TERMS_BROAD
        : MAX_INDIVIDUAL_TERMS_PRECISE;

      let lexicalRank = 0;

      // Strategy 1: Compound multi-term search
      const compoundQuery = terms.slice(0, 6).join(" ");
      if (compoundQuery) {
        const compoundStartedAt = performance.now();
        const compoundResults = useHybridLexical
          ? (await searchSymbolsHybridWithOverlay(conn, task.repoId, compoundQuery, compoundLimit, { chatMentions: resolvedChatMentions, chatMentionWeights: task.options?.chatMentionWeights, pprDirection: task.options?.pprDirection, pprWeight: task.options?.pprWeight })).rows
          : await searchSymbols(conn, task.repoId, compoundQuery, compoundLimit);
        recordTiming(timings, "seed.lexicalCompound", compoundStartedAt);
        for (const r of compoundResults) {
          if (sourceCounts.lexical >= lexicalTargetCap) break;
          const ref = `symbol:${r.symbolId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          // Score lexical results on a 0-1 scale based on rank.
          // Note: cross-batch scores (compound vs individual) aren't perfectly
          // comparable because denominators differ, but the final sort + cap
          // handles this acceptably.
          const score = Math.max(
            0,
            1 - lexicalRank / Math.max(compoundResults.length, 1),
          );
          allCandidates.push({
            contextRef: ref,
            source: "lexical",
            score,
            sourceRank: lexicalRank,
          });
          sourceCounts.lexical++;
          lexicalRank++;
        }
      }

      // Strategy 2: Individual term searches
      for (const term of terms.slice(0, maxIndividualTerms)) {
        if (sourceCounts.lexical >= lexicalTargetCap) break;
        const termStartedAt = performance.now();
        const results = useHybridLexical
          ? (await searchSymbolsHybridWithOverlay(conn, task.repoId, term, perTermLimit, { chatMentions: resolvedChatMentions, chatMentionWeights: task.options?.chatMentionWeights, pprDirection: task.options?.pprDirection, pprWeight: task.options?.pprWeight })).rows
          : await searchSymbols(conn, task.repoId, term, perTermLimit);
        recordTiming(timings, "seed.lexicalTermSearch", termStartedAt);
        for (const r of results) {
          if (sourceCounts.lexical >= lexicalTargetCap) break;
          const ref = `symbol:${r.symbolId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          const score = Math.max(
            0,
            1 - lexicalRank / Math.max(results.length + lexicalRank, 1),
          );
          allCandidates.push({
            contextRef: ref,
            source: "lexical",
            score,
            sourceRank: lexicalRank,
          });
          sourceCounts.lexical++;
          lexicalRank++;
        }
      }
    } catch (err) {
      logger.debug("Lexical fallback for context seeding failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      recordTiming(timings, "seed.lexicalFallback", lexicalStartedAt);
    }
  }

  // ------------------------------------------------------------------
  // Stage 3: Feedback boosting
  // ------------------------------------------------------------------
  const feedbackStartedAt = performance.now();
  const taskMentionsFeedback = /\bfeedback\b/i.test(task.taskText);
  const shouldQueryFeedbackBoosts =
    !forceSemanticEntitySearch ||
    taskMentionsFeedback ||
    sourceCounts.semantic < diversityReserve;
  if (shouldQueryFeedbackBoosts) {
    try {
      const conn = await getLadybugConn();
      const { boosts } = await queryFeedbackBoosts(conn, {
        repoId: task.repoId,
        query: task.taskText,
        limit: FEEDBACK_LIMIT,
      });

      if (boosts.size > 0) {
        let feedbackRank = 0;
        for (const [symbolId, boostScore] of boosts) {
          if (sourceCounts.feedback >= feedbackCap) break;
          const ref = `symbol:${symbolId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          allCandidates.push({
            contextRef: ref,
            source: "feedback",
            score: boostScore,
            sourceRank: feedbackRank,
          });
          sourceCounts.feedback++;
          feedbackRank++;
        }
      }
    } catch (err) {
      logger.debug("Feedback boost for context seeding failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      recordTiming(timings, "seed.feedbackBoost", feedbackStartedAt);
    }
  } else {
    recordTiming(timings, "seed.feedbackBoost.skipped", feedbackStartedAt);
  }

  // ------------------------------------------------------------------
  // Final: sort by score descending and cap at maxSeeds
  // ------------------------------------------------------------------
  const finalizeStartedAt = performance.now();
  allCandidates.sort((a, b) => b.score - a.score);
  const finalCandidates = allCandidates.slice(0, maxSeeds);

  // Recount sources after capping
  const finalSources = { semantic: 0, lexical: 0, feedback: 0 };
  for (const c of finalCandidates) {
    finalSources[c.source]++;
  }
  recordTiming(timings, "seed.finalize", finalizeStartedAt);

  return {
    candidates: finalCandidates,
    sources: finalSources,
    ...(seedEvidence ? { evidence: seedEvidence } : {}),
    diagnosticTimings: timingsToRecord(timings),
  };
}

/**
 * Extract the contextRef values from a seed result for use as the context
 * array in the executor.
 */
export function seedResultToContext(result: ContextSeedResult): string[] {
  return result.candidates.map((c) => c.contextRef);
}
