import {
  AgentFeedbackRequestSchema,
  AgentFeedbackResponse,
  AgentFeedbackQueryRequestSchema,
  AgentFeedbackQueryResponse,
} from "../tools.js";
import * as db from "../../db/queries.js";
import { DatabaseError } from "../errors.js";

/**
 * Handles agent feedback submission requests.
 * Records feedback about useful and missing symbols for offline tuning.
 *
 * @param args - Raw arguments containing feedback data
 * @returns Response with feedback ID and stats
 * @throws {Error} If repository not found
 */
export async function handleAgentFeedback(
  args: unknown,
): Promise<AgentFeedbackResponse> {
  const request = AgentFeedbackRequestSchema.parse(args);
  const {
    repoId,
    versionId,
    sliceHandle,
    usefulSymbols,
    missingSymbols = [],
    taskTags,
    taskType,
    taskText,
  } = request;

  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const version = db.getVersion(versionId);
  if (!version) {
    throw new DatabaseError(`Version ${versionId} not found`);
  }

  const now = new Date().toISOString();
  const feedbackId = db.createAgentFeedback({
    repo_id: repoId,
    version_id: versionId,
    slice_handle: sliceHandle,
    useful_symbols_json: JSON.stringify(usefulSymbols),
    missing_symbols_json: JSON.stringify(missingSymbols),
    task_tags_json: taskTags ? JSON.stringify(taskTags) : null,
    task_type: taskType ?? null,
    task_text: taskText ?? null,
    created_at: now,
  });

  db.batchUpdateSymbolFeedbackWeights(repoId, usefulSymbols, missingSymbols);

  return {
    ok: true,
    feedbackId,
    repoId,
    versionId,
    symbolsRecorded: usefulSymbols.length + missingSymbols.length,
  };
}

/**
 * Handles agent feedback query requests.
 * Returns feedback records and aggregated statistics for offline tuning.
 *
 * @param args - Raw arguments containing query parameters
 * @returns Response with feedback records and stats
 * @throws {Error} If repository not found
 */
export async function handleAgentFeedbackQuery(
  args: unknown,
): Promise<AgentFeedbackQueryResponse> {
  const request = AgentFeedbackQueryRequestSchema.parse(args);
  const { repoId, versionId, limit = 50, since } = request;

  const repo = db.getRepo(repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const feedbackRows = versionId
    ? db.getAgentFeedbackByVersion(repoId, versionId, limit + 1)
    : db.getAgentFeedbackByRepo(repoId, limit + 1);

  const hasMore = feedbackRows.length > limit;
  const rows = hasMore ? feedbackRows.slice(0, limit) : feedbackRows;

  const feedback = rows.map((row) => ({
    feedbackId: row.feedback_id,
    versionId: row.version_id,
    sliceHandle: row.slice_handle,
    usefulSymbols: JSON.parse(row.useful_symbols_json) as string[],
    missingSymbols: JSON.parse(row.missing_symbols_json) as string[],
    taskTags: row.task_tags_json
      ? (JSON.parse(row.task_tags_json) as string[])
      : null,
    taskType: row.task_type,
    taskText: row.task_text,
    createdAt: row.created_at,
  }));

  const aggregated = db.getAggregatedFeedback(repoId, since);

  const topUsefulSymbols = Array.from(aggregated.symbolPositiveCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([symbolId, count]) => ({ symbolId, count }));

  const topMissingSymbols = Array.from(
    aggregated.symbolNegativeCounts.entries(),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([symbolId, count]) => ({ symbolId, count }));

  return {
    repoId,
    feedback,
    aggregatedStats: {
      totalFeedback: aggregated.totalFeedback,
      topUsefulSymbols,
      topMissingSymbols,
    },
    hasMore,
  };
}
