import crypto from "crypto";

import {
  AgentFeedbackRequestSchema,
  AgentFeedbackResponse,
  AgentFeedbackQueryRequestSchema,
  AgentFeedbackQueryResponse,
} from "../tools.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { DatabaseError } from "../errors.js";

function generateFeedbackId(): string {
  return `fb_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

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

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const version = await ladybugDb.getVersion(conn, versionId);
  if (!version) {
    throw new DatabaseError(`Version ${versionId} not found`);
  }

  const now = new Date().toISOString();
  const feedbackId = generateFeedbackId();

  await ladybugDb.upsertAgentFeedback(conn, {
    feedbackId,
    repoId,
    versionId,
    sliceHandle,
    usefulSymbolsJson: JSON.stringify(usefulSymbols),
    missingSymbolsJson: JSON.stringify(missingSymbols),
    taskTagsJson: taskTags ? JSON.stringify(taskTags) : null,
    taskType: taskType ?? null,
    taskText: taskText ?? null,
    createdAt: now,
  });

  return {
    ok: true,
    feedbackId,
    repoId,
    versionId,
    symbolsRecorded: usefulSymbols.length + missingSymbols.length,
  };
}

export async function handleAgentFeedbackQuery(
  args: unknown,
): Promise<AgentFeedbackQueryResponse> {
  const request = AgentFeedbackQueryRequestSchema.parse(args);
  const { repoId, versionId, limit = 50, since } = request;

  const conn = await getLadybugConn();

  const repo = await ladybugDb.getRepo(conn, repoId);
  if (!repo) {
    throw new DatabaseError(`Repository ${repoId} not found`);
  }

  const feedbackRows = versionId
    ? await ladybugDb.getAgentFeedbackByVersion(conn, repoId, versionId, limit + 1)
    : await ladybugDb.getAgentFeedbackByRepo(conn, repoId, limit + 1);

  const hasMore = feedbackRows.length > limit;
  const rows = hasMore ? feedbackRows.slice(0, limit) : feedbackRows;

  const feedback = rows.map((row) => ({
    feedbackId: row.feedbackId,
    versionId: row.versionId,
    sliceHandle: row.sliceHandle,
    usefulSymbols: JSON.parse(row.usefulSymbolsJson) as string[],
    missingSymbols: JSON.parse(row.missingSymbolsJson) as string[],
    taskTags: row.taskTagsJson ? (JSON.parse(row.taskTagsJson) as string[]) : null,
    taskType: row.taskType,
    taskText: row.taskText,
    createdAt: row.createdAt,
  }));

  const aggregated = await ladybugDb.getAggregatedFeedback(conn, repoId, since);

  const topUsefulSymbols = Array.from(aggregated.symbolPositiveCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([symbolId, count]) => ({ symbolId, count }));

  const topMissingSymbols = Array.from(aggregated.symbolNegativeCounts.entries())
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

