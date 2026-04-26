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
import { extractIdentifiersFromText } from "./identifier-extraction.js";
import { searchSymbols } from "../db/ladybug-queries.js";
import { searchSymbolsHybridWithOverlay } from "../live-index/overlay-reader.js";
import { queryFeedbackBoosts } from "../retrieval/feedback-boost.js";
import { getLadybugConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Minimum entity score to keep from semantic search. */
const MIN_ENTITY_SCORE = 0.3;

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

// ---------------------------------------------------------------------------
// Focus Path Inference
// ---------------------------------------------------------------------------

/**
 * Known concept-to-directory mappings for common codebase structures.
 * Each entry maps a set of keywords (lowercase) to directories where
 * related symbols are most likely to live.
 */
const CONCEPT_DIRECTORY_MAP: Array<{ keywords: string[]; paths: string[] }> = [
  { keywords: ["graph", "slice", "beam", "beam search", "bfs"], paths: ["src/graph/"] },
  { keywords: ["skeleton", "hotpath", "hot path", "hot-path", "code window", "gating", "gate"], paths: ["src/code/"] },
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
 *
 * Stage 1 — Semantic retrieval (entitySearch)
 * Stage 2 — Hybrid/lexical fallback (searchSymbols) — only when Stage 1
 *           returned fewer than half the max seed count
 * Stage 3 — Feedback boosting (queryFeedbackBoosts)
 *
 * No single source contributes more than half the total cap. Final candidates
 * are sorted by score descending.
 */
export async function buildSeedContext(
  task: AgentTask,
): Promise<ContextSeedResult> {
  /* sdl.context: semantic hybrid defaults */
  const useHybrid = task.options?.semantic !== false;
  const includeEvidence = task.options?.includeRetrievalEvidence !== false;
  /* sdl.context: capture hybrid evidence */
  let seedEvidence: import("../retrieval/types.js").RetrievalEvidence | undefined;

  const isBroad = task.options?.contextMode !== "precise";
  const maxSeeds = isBroad ? MAX_SEEDS_BROAD : MAX_SEEDS_PRECISE;
  const halfMax = Math.ceil(maxSeeds / 2);

  const seen = new Set<string>();
  const allCandidates: ContextSeedCandidate[] = [];
  const sourceCounts = { semantic: 0, lexical: 0, feedback: 0 };

  // ------------------------------------------------------------------
  // Stage 1: Semantic retrieval (hybrid FTS + vector via orchestrator)
  //   Skipped when the caller explicitly sets options.semantic = false.
  // ------------------------------------------------------------------
  if (useHybrid) try {
    const entityResult = await entitySearch({
      repoId: task.repoId,
      query: task.taskText,
      limit: 20,
      entityTypes: ["symbol", "cluster", "process", "fileSummary"],
      includeEvidence: includeEvidence,
    });

    if (entityResult.evidence) seedEvidence = entityResult.evidence;
    const filtered = entityResult.results.filter(
      (r) => r.score >= MIN_ENTITY_SCORE,
    );

    if (filtered.length > 0) {
      // Normalize scores to 0-1 (divide by max score in batch)
      const maxScore = Math.max(...filtered.map((r) => r.score));
      const norm = maxScore > 0 ? maxScore : 1;

      for (let i = 0; i < filtered.length; i++) {
        if (sourceCounts.semantic >= halfMax) break;
        const r = filtered[i];
        const ref = `${r.entityType}:${r.entityId}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        allCandidates.push({
          contextRef: ref,
          source: "semantic",
          score: r.score / norm,
          sourceRank: i,
        });
        sourceCounts.semantic++;
      }
    }
  } catch (err) {
    logger.debug("Semantic retrieval for context seeding failed (non-fatal)", {
      repoId: task.repoId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ------------------------------------------------------------------
  // Stage 2: Hybrid/lexical fallback
  //   Only runs if Stage 1 returned fewer than half the max seed count.
  // ------------------------------------------------------------------
  if (sourceCounts.semantic < halfMax) {
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
        const compoundResults = useHybrid
          ? (await searchSymbolsHybridWithOverlay(conn, task.repoId, compoundQuery, compoundLimit, {})).rows
          : await searchSymbols(conn, task.repoId, compoundQuery, compoundLimit);
        for (const r of compoundResults) {
          if (sourceCounts.lexical >= halfMax) break;
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
        if (sourceCounts.lexical >= halfMax) break;
        const results = useHybrid
          ? (await searchSymbolsHybridWithOverlay(conn, task.repoId, term, perTermLimit, {})).rows
          : await searchSymbols(conn, task.repoId, term, perTermLimit);
        for (const r of results) {
          if (sourceCounts.lexical >= halfMax) break;
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
    }
  }

  // ------------------------------------------------------------------
  // Stage 3: Feedback boosting
  // ------------------------------------------------------------------
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
        if (sourceCounts.feedback >= halfMax) break;
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
  }

  // ------------------------------------------------------------------
  // Final: sort by score descending and cap at maxSeeds
  // ------------------------------------------------------------------
  allCandidates.sort((a, b) => b.score - a.score);
  const finalCandidates = allCandidates.slice(0, maxSeeds);

  // Recount sources after capping
  const finalSources = { semantic: 0, lexical: 0, feedback: 0 };
  for (const c of finalCandidates) {
    finalSources[c.source]++;
  }

  return {
    candidates: finalCandidates,
    sources: finalSources,
    ...(seedEvidence ? { evidence: seedEvidence } : {}),
  };
}

/**
 * Extract the contextRef values from a seed result for use as the context
 * array in the executor.
 */
export function seedResultToContext(result: ContextSeedResult): string[] {
  return result.candidates.map((c) => c.contextRef);
}
