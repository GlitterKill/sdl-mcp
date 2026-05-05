import crypto from "crypto";

import {
  AgentFeedbackRequestSchema,
  AgentFeedbackResponse,
  AgentFeedbackQueryRequestSchema,
  AgentFeedbackQueryResponse,
} from "../tools.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { DatabaseError } from "../errors.js";
import { safeJsonParse, StringArraySchema } from "../../util/safeJson.js";
import { logger } from "../../util/logger.js";

function generateFeedbackId(): string {
  return `fb_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

interface FeedbackRateLimitEntry {
  tokens: number;
  lastRefill: number;
  lastSeen: number;
}

type FeedbackRateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const FEEDBACK_RATE_LIMIT_BUCKET_SIZE = 30;
const FEEDBACK_RATE_LIMIT_REFILL_PER_SEC = 0.5;
const FEEDBACK_RATE_LIMIT_IDLE_MS = 5 * 60 * 1000;
const feedbackRateLimitBuckets = new Map<string, FeedbackRateLimitEntry>();

export function resetAgentFeedbackRateLimitForTests(): void {
  feedbackRateLimitBuckets.clear();
}

function evictIdleFeedbackRateLimitEntries(nowMs: number): void {
  const cutoff = nowMs - FEEDBACK_RATE_LIMIT_IDLE_MS;
  for (const [repoId, entry] of feedbackRateLimitBuckets) {
    if (entry.lastSeen < cutoff) {
      feedbackRateLimitBuckets.delete(repoId);
    }
  }
}

function consumeFeedbackRateLimit(repoId: string): FeedbackRateLimitDecision {
  const now = Date.now();
  evictIdleFeedbackRateLimitEntries(now);

  const entry =
    feedbackRateLimitBuckets.get(repoId) ??
    ({
      tokens: FEEDBACK_RATE_LIMIT_BUCKET_SIZE,
      lastRefill: now,
      lastSeen: now,
    } satisfies FeedbackRateLimitEntry);

  const elapsedSeconds = Math.max(0, (now - entry.lastRefill) / 1000);
  entry.tokens = Math.min(
    FEEDBACK_RATE_LIMIT_BUCKET_SIZE,
    entry.tokens + elapsedSeconds * FEEDBACK_RATE_LIMIT_REFILL_PER_SEC,
  );
  entry.lastRefill = now;
  entry.lastSeen = now;
  feedbackRateLimitBuckets.set(repoId, entry);

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    return { allowed: true };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((1 - entry.tokens) / FEEDBACK_RATE_LIMIT_REFILL_PER_SEC),
    ),
  };
}

function createFeedbackRateLimitError(retryAfterSeconds: number): DatabaseError {
  const error = new DatabaseError(
    "Agent feedback rate limit exceeded. Please retry later.",
  );
  (error as { classification?: string }).classification = "rate_limited";
  (error as { retryable?: boolean }).retryable = true;
  (error as { suggestedRetryDelayMs?: number }).suggestedRetryDelayMs =
    retryAfterSeconds * 1000;
  return error;
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

  // Auto-resolve versionId/sliceHandle when omitted
  const resolvedVersionId = versionId ?? (await ladybugDb.getLatestVersion(conn, repoId))?.versionId;
  if (!resolvedVersionId) {
    throw new DatabaseError(`No indexed version found for repository ${repoId}. Run sdl.index.refresh first.`);
  }
  const resolvedSliceHandle = sliceHandle ?? "none";

  const version = await ladybugDb.getVersion(conn, resolvedVersionId);
  if (!version) {
    throw new DatabaseError(`Version ${resolvedVersionId} not found`);
  }

  const rateLimit = consumeFeedbackRateLimit(repoId);
  if (!rateLimit.allowed) {
    logger.warn("Agent feedback rate limit exceeded", {
      repoId,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    throw createFeedbackRateLimitError(rateLimit.retryAfterSeconds);
  }

  const now = new Date().toISOString();
  const feedbackId = generateFeedbackId();

  await withWriteConn(async (wConn) => {
    await ladybugDb.upsertAgentFeedback(wConn, {
      feedbackId,
      repoId,
      versionId: resolvedVersionId,
      sliceHandle: resolvedSliceHandle,
      usefulSymbolsJson: JSON.stringify(usefulSymbols),
      missingSymbolsJson: JSON.stringify(missingSymbols),
      taskTagsJson: taskTags ? JSON.stringify(taskTags) : null,
      taskType: taskType ?? null,
      taskText: taskText ?? null,
      createdAt: now,
    });
  });

  return {
    ok: true,
    feedbackId,
    repoId,
    versionId: resolvedVersionId,
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
    ? await ladybugDb.getAgentFeedbackByVersion(
        conn,
        repoId,
        versionId,
        limit + 1,
        since,
      )
    : await ladybugDb.getAgentFeedbackByRepo(conn, repoId, limit + 1, since);

  const hasMore = feedbackRows.length > limit;
  const rows = hasMore ? feedbackRows.slice(0, limit) : feedbackRows;

  const feedback = rows.map((row) => ({
    feedbackId: row.feedbackId,
    versionId: row.versionId,
    sliceHandle: row.sliceHandle,
    usefulSymbols: safeJsonParse(row.usefulSymbolsJson, StringArraySchema, []),
    missingSymbols: safeJsonParse(row.missingSymbolsJson, StringArraySchema, []),
    taskTags: row.taskTagsJson
      ? safeJsonParse(row.taskTagsJson, StringArraySchema, [])
      : null,
    taskType: row.taskType,
    taskText: row.taskText,
    createdAt: row.createdAt,
  }));

  const aggregated = await ladybugDb.getAggregatedFeedback(conn, repoId, since);

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
