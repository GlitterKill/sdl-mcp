/**
 * Feedback Boost Module
 *
 * Queries prior AgentFeedback rows via FTS/vector similarity to the current
 * task text, extracts the usefulSymbols from matching feedback, and returns
 * boost scores for those symbols.
 *
 * Heavy imports (logger, queryAll, entitySearch, safeJsonParse) are loaded
 * dynamically inside queryFeedbackBoosts() so the pure mergeFeedbackBoosts()
 * function and types can be imported without triggering OTel initialization.
 *
 * @module retrieval/feedback-boost
 */

import type { Connection } from "kuzu";

/**
 * Parsed feedback result with extracted fields for boost computation.
 */
export interface FeedbackBoostResult {
  feedbackId: string;
  score: number;
  usefulSymbols: string[];
  missingSymbols: string[];
  taskType: string | null;
}

/**
 * Options for querying feedback boosts.
 */
export interface FeedbackBoostOptions {
  repoId: string;
  query: string;
  /** Max feedback rows to consider. Default: 10. */
  limit?: number;
}

/**
 * Merge feedback boost results into a symbolId -> boost score map.
 *
 * For each matching feedback row, each usefulSymbol gets a boost
 * proportional to the feedback retrieval score. When a symbol appears
 * in multiple feedback rows, boosts accumulate (capped at 1.0).
 *
 * Missing symbols are NOT negatively boosted -- they serve as
 * diagnostic information only.
 */
export function mergeFeedbackBoosts(
  feedbackHits: FeedbackBoostResult[],
): Map<string, number> {
  const boosts = new Map<string, number>();

  for (const hit of feedbackHits) {
    const weight = hit.score * 0.3;
    for (const symbolId of hit.usefulSymbols) {
      const current = boosts.get(symbolId) ?? 0;
      boosts.set(symbolId, Math.min(1.0, current + weight));
    }
  }

  return boosts;
}

/**
 * Query prior feedback by entity search (FTS/vector) and extract boost signals.
 *
 * All errors are caught gracefully -- feedback boost failure is non-fatal.
 * All heavy imports are dynamic to keep the module static surface pure.
 */
export async function queryFeedbackBoosts(
  conn: Connection,
  options: FeedbackBoostOptions,
): Promise<{
  boosts: Map<string, number>;
  feedbackHits: FeedbackBoostResult[];
}> {
  const limit = options.limit ?? 10;

  try {
    // Dynamic imports to avoid pulling OTel/DB chains at module load time
    const { entitySearch } = await import("./orchestrator.js");
    const { queryAll } = await import("../db/ladybug-core.js");
    const { safeJsonParse, StringArraySchema } = await import("../util/safeJson.js");
    const { logger } = await import("../util/logger.js");

    const searchResult = await entitySearch({
      repoId: options.repoId,
      query: options.query,
      limit,
      entityTypes: ["agentFeedback"],
      includeEvidence: false,
    });

    if (searchResult.results.length === 0) {
      return { boosts: new Map(), feedbackHits: [] };
    }

    const feedbackHits: FeedbackBoostResult[] = [];
    const feedbackIds = searchResult.results.map((r) => r.entityId);
    const scoreMap = new Map(searchResult.results.map((r) => [r.entityId, r.score]));

    const rows = await queryAll<{
      feedbackId: string;
      usefulSymbolsJson: string;
      missingSymbolsJson: string;
      taskType: string | null;
    }>(
      conn,
      `MATCH (f:AgentFeedback)
       WHERE f.feedbackId IN $feedbackIds
       RETURN f.feedbackId AS feedbackId,
              f.usefulSymbolsJson AS usefulSymbolsJson,
              f.missingSymbolsJson AS missingSymbolsJson,
              f.taskType AS taskType`,
      { feedbackIds },
    );

    for (const row of rows) {
      feedbackHits.push({
        feedbackId: row.feedbackId,
        score: scoreMap.get(row.feedbackId) ?? 0,
        usefulSymbols: safeJsonParse(row.usefulSymbolsJson, StringArraySchema, []),
        missingSymbols: safeJsonParse(row.missingSymbolsJson, StringArraySchema, []),
        taskType: row.taskType,
      });
    }

    const boosts = mergeFeedbackBoosts(feedbackHits);

    logger.debug(
      `[feedback-boost] Found ${feedbackHits.length} matching feedback rows, ` +
      `boosting ${boosts.size} symbols`,
    );

    return { boosts, feedbackHits };
  } catch (err) {
    try {
      const { logger } = await import("../util/logger.js");
      logger.debug(
        `[feedback-boost] Feedback boost query failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } catch {
      // If even logger import fails, silently continue
    }
    return { boosts: new Map(), feedbackHits: [] };
  }
}
