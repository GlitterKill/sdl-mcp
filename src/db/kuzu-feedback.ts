/**
 * kuzu-feedback.ts — Audit and Agent Feedback Operations
 * Extracted from kuzu-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, assertSafeInt } from "./kuzu-core.js";

export interface AuditRow {
  eventId: string;
  timestamp: string;
  tool: string;
  decision: string;
  repoId: string | null;
  symbolId: string | null;
  detailsJson: string;
}

export async function insertAuditEvent(
  conn: Connection,
  row: AuditRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (a:Audit {eventId: $eventId})
     SET a.timestamp = $timestamp,
         a.tool = $tool,
         a.decision = $decision,
         a.repoId = $repoId,
         a.symbolId = $symbolId,
         a.detailsJson = $detailsJson`,
    {
      eventId: row.eventId,
      timestamp: row.timestamp,
      tool: row.tool,
      decision: row.decision,
      repoId: row.repoId,
      symbolId: row.symbolId,
      detailsJson: row.detailsJson,
    },
  );
}

export async function getAuditEvents(
  conn: Connection,
  options: {
    repoId?: string;
    sinceTimestamp?: string;
    untilTimestamp?: string;
    limit?: number;
  } = {},
): Promise<AuditRow[]> {
  const safeLimit = options.limit ?? 1000;
  assertSafeInt(safeLimit, "limit");

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.repoId) {
    conditions.push("a.repoId = $repoId");
    params.repoId = options.repoId;
  }

  if (options.sinceTimestamp) {
    conditions.push("a.timestamp >= $sinceTimestamp");
    params.sinceTimestamp = options.sinceTimestamp;
  }

  if (options.untilTimestamp) {
    conditions.push("a.timestamp <= $untilTimestamp");
    params.untilTimestamp = options.untilTimestamp;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await queryAll<AuditRow>(
    conn,
    `MATCH (a:Audit)
     ${whereClause}
     RETURN a.eventId AS eventId,
            a.timestamp AS timestamp,
            a.tool AS tool,
            a.decision AS decision,
            a.repoId AS repoId,
            a.symbolId AS symbolId,
            a.detailsJson AS detailsJson
     ORDER BY a.timestamp DESC`,
    params,
  );
  return rows.slice(0, safeLimit);
}

export interface AgentFeedbackRow {
  feedbackId: string;
  repoId: string;
  versionId: string;
  sliceHandle: string;
  usefulSymbolsJson: string;
  missingSymbolsJson: string;
  taskTagsJson: string | null;
  taskType: string | null;
  taskText: string | null;
  createdAt: string;
}

export async function upsertAgentFeedback(
  conn: Connection,
  row: AgentFeedbackRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (f:AgentFeedback {feedbackId: $feedbackId})
     SET f.repoId = $repoId,
         f.versionId = $versionId,
         f.sliceHandle = $sliceHandle,
         f.usefulSymbolsJson = $usefulSymbolsJson,
         f.missingSymbolsJson = $missingSymbolsJson,
         f.taskTagsJson = $taskTagsJson,
         f.taskType = $taskType,
         f.taskText = $taskText,
         f.createdAt = $createdAt`,
    {
      feedbackId: row.feedbackId,
      repoId: row.repoId,
      versionId: row.versionId,
      sliceHandle: row.sliceHandle,
      usefulSymbolsJson: row.usefulSymbolsJson,
      missingSymbolsJson: row.missingSymbolsJson,
      taskTagsJson: row.taskTagsJson,
      taskType: row.taskType,
      taskText: row.taskText,
      createdAt: row.createdAt,
    },
  );
}

export async function getAgentFeedback(
  conn: Connection,
  feedbackId: string,
): Promise<AgentFeedbackRow | null> {
  const row = await querySingle<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {feedbackId: $feedbackId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt`,
    { feedbackId },
  );
  return row ?? null;
}

export async function getAgentFeedbackByRepo(
  conn: Connection,
  repoId: string,
  limit: number,
): Promise<AgentFeedbackRow[]> {
  assertSafeInt(limit, "limit");
  const rows = await queryAll<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {repoId: $repoId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt
     ORDER BY f.createdAt DESC`,
    { repoId },
  );
  return rows.slice(0, limit);
}

export async function getAgentFeedbackByVersion(
  conn: Connection,
  repoId: string,
  versionId: string,
  limit: number,
): Promise<AgentFeedbackRow[]> {
  assertSafeInt(limit, "limit");
  const rows = await queryAll<AgentFeedbackRow>(
    conn,
    `MATCH (f:AgentFeedback {repoId: $repoId, versionId: $versionId})
     RETURN f.feedbackId AS feedbackId,
            f.repoId AS repoId,
            f.versionId AS versionId,
            f.sliceHandle AS sliceHandle,
            f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType,
            f.taskText AS taskText,
            f.createdAt AS createdAt
     ORDER BY f.createdAt DESC`,
    { repoId, versionId },
  );
  return rows.slice(0, limit);
}

export interface AggregatedFeedback {
  totalFeedback: number;
  symbolPositiveCounts: Map<string, number>;
  symbolNegativeCounts: Map<string, number>;
  taskTypeCounts: Map<string, number>;
}

export async function getAggregatedFeedback(
  conn: Connection,
  repoId: string,
  sinceTimestamp?: string,
): Promise<AggregatedFeedback> {
  const conditions: string[] = ["f.repoId = $repoId"];
  const params: Record<string, unknown> = { repoId };

  if (sinceTimestamp) {
    conditions.push("f.createdAt >= $sinceTimestamp");
    params.sinceTimestamp = sinceTimestamp;
  }

  const rows = await queryAll<Pick<AgentFeedbackRow, "usefulSymbolsJson" | "missingSymbolsJson" | "taskTagsJson" | "taskType">>(
    conn,
    `MATCH (f:AgentFeedback)
     WHERE ${conditions.join(" AND ")}
     RETURN f.usefulSymbolsJson AS usefulSymbolsJson,
            f.missingSymbolsJson AS missingSymbolsJson,
            f.taskTagsJson AS taskTagsJson,
            f.taskType AS taskType
     ORDER BY f.createdAt DESC`,
    params,
  );

  const symbolPositiveCounts = new Map<string, number>();
  const symbolNegativeCounts = new Map<string, number>();
  const taskTypeCounts = new Map<string, number>();

  for (const row of rows) {
    let usefulSymbols: string[];
    let missingSymbols: string[];
    let taskTags: string[];
    try {
      usefulSymbols = JSON.parse(row.usefulSymbolsJson) as string[];
      missingSymbols = JSON.parse(row.missingSymbolsJson) as string[];
      taskTags = row.taskTagsJson ? (JSON.parse(row.taskTagsJson) as string[]) : [];
    } catch {
      continue;
    }

    for (const symbolId of usefulSymbols) {
      symbolPositiveCounts.set(
        symbolId,
        (symbolPositiveCounts.get(symbolId) ?? 0) + 1,
      );
    }

    for (const symbolId of missingSymbols) {
      symbolNegativeCounts.set(
        symbolId,
        (symbolNegativeCounts.get(symbolId) ?? 0) + 1,
      );
    }

    if (row.taskType) {
      taskTypeCounts.set(row.taskType, (taskTypeCounts.get(row.taskType) ?? 0) + 1);
    }

    for (const tag of taskTags) {
      taskTypeCounts.set(tag, (taskTypeCounts.get(tag) ?? 0) + 1);
    }
  }

  return {
    totalFeedback: rows.length,
    symbolPositiveCounts,
    symbolNegativeCounts,
    taskTypeCounts,
  };
}

