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
import { extractIdentifiersFromText } from "./executor.js";
import { searchSymbols } from "../db/ladybug-queries.js";
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
  const isBroad = task.options?.contextMode !== "precise";
  const maxSeeds = isBroad ? MAX_SEEDS_BROAD : MAX_SEEDS_PRECISE;
  const halfMax = Math.ceil(maxSeeds / 2);

  const seen = new Set<string>();
  const allCandidates: ContextSeedCandidate[] = [];
  const sourceCounts = { semantic: 0, lexical: 0, feedback: 0 };

  // ------------------------------------------------------------------
  // Stage 1: Semantic retrieval
  // ------------------------------------------------------------------
  try {
    const entityResult = await entitySearch({
      repoId: task.repoId,
      query: task.taskText,
      limit: 20,
      entityTypes: ["symbol", "cluster", "process", "fileSummary"],
      includeEvidence: false,
    });

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
        const compoundResults = await searchSymbols(
          conn,
          task.repoId,
          compoundQuery,
          compoundLimit,
        );
        for (const r of compoundResults) {
          if (sourceCounts.lexical >= halfMax) break;
          const ref = `symbol:${r.symbolId}`;
          if (seen.has(ref)) continue;
          seen.add(ref);
          // Score lexical results on a 0-1 scale based on rank
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
        const results = await searchSymbols(
          conn,
          task.repoId,
          term,
          perTermLimit,
        );
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

  return { candidates: finalCandidates, sources: finalSources };
}

/**
 * Extract the contextRef values from a seed result for use as the context
 * array in the executor.
 */
export function seedResultToContext(result: ContextSeedResult): string[] {
  return result.candidates.map((c) => c.contextRef);
}
