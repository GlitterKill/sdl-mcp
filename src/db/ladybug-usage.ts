/**
 * ladybug-usage.ts — Usage snapshot persistence for token savings tracking
 *
 * Stores cumulative session-level token usage snapshots in the graph DB
 * so that historical savings can be queried across sessions.
 */

import type { Connection } from "kuzu";
import { exec, queryAll, toNumber, assertSafeInt } from "./ladybug-core.js";
import { withWriteConn } from "./ladybug.js";
import type {
  SessionUsageSnapshot,
  ToolUsageEntry,
} from "../mcp/token-accumulator.js";
import { getCurrentTimestamp } from "../util/time.js";

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface UsageSnapshotRow {
  snapshotId: string;
  sessionId: string;
  repoId: string;
  timestamp: string;
  totalSdlTokens: number;
  totalRawEquivalent: number;
  totalSavedTokens: number;
  savingsPercent: number;
  callCount: number;
  toolBreakdownJson: string;
  packedEncodings?: number;
  packedFallbacks?: number;
  packedBytesSaved?: number;
  packedByEncoderJson?: string;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function insertUsageSnapshot(
  conn: Connection,
  row: UsageSnapshotRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (u:UsageSnapshot {snapshotId: $snapshotId})
     SET u.sessionId = $sessionId,
         u.repoId = $repoId,
         u.timestamp = $timestamp,
         u.totalSdlTokens = $totalSdlTokens,
         u.totalRawEquivalent = $totalRawEquivalent,
         u.totalSavedTokens = $totalSavedTokens,
         u.savingsPercent = $savingsPercent,
         u.callCount = $callCount,
         u.toolBreakdownJson = $toolBreakdownJson,
         u.packedEncodings = $packedEncodings,
         u.packedFallbacks = $packedFallbacks,
         u.packedBytesSaved = $packedBytesSaved,
         u.packedByEncoderJson = $packedByEncoderJson`,
    {
      snapshotId: row.snapshotId,
      sessionId: row.sessionId,
      repoId: row.repoId,
      timestamp: row.timestamp,
      totalSdlTokens: row.totalSdlTokens,
      totalRawEquivalent: row.totalRawEquivalent,
      totalSavedTokens: row.totalSavedTokens,
      savingsPercent: row.savingsPercent,
      callCount: row.callCount,
      toolBreakdownJson: row.toolBreakdownJson,
      packedEncodings: row.packedEncodings ?? 0,
      packedFallbacks: row.packedFallbacks ?? 0,
      packedBytesSaved: row.packedBytesSaved ?? 0,
      packedByEncoderJson: row.packedByEncoderJson ?? "{}",
    },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getUsageSnapshots(
  conn: Connection,
  options: {
    repoId?: string;
    since?: string;
    limit?: number;
  } = {},
): Promise<UsageSnapshotRow[]> {
  const safeLimit = options.limit ?? 50;
  assertSafeInt(safeLimit, "limit");
  const maxFetch = Math.min(Math.max(1, safeLimit), 1000);

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.repoId) {
    conditions.push("u.repoId = $repoId");
    params.repoId = options.repoId;
  }
  if (options.since) {
    conditions.push("u.timestamp >= $since");
    params.since = options.since;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return queryAll<UsageSnapshotRow>(
    conn,
    `MATCH (u:UsageSnapshot)
     ${whereClause}
     RETURN u.snapshotId AS snapshotId,
            u.sessionId AS sessionId,
            u.repoId AS repoId,
            u.timestamp AS timestamp,
            u.totalSdlTokens AS totalSdlTokens,
            u.totalRawEquivalent AS totalRawEquivalent,
            u.totalSavedTokens AS totalSavedTokens,
            u.savingsPercent AS savingsPercent,
            u.callCount AS callCount,
            u.toolBreakdownJson AS toolBreakdownJson,
            u.packedEncodings AS packedEncodings,
            u.packedFallbacks AS packedFallbacks,
            u.packedBytesSaved AS packedBytesSaved,
            u.packedByEncoderJson AS packedByEncoderJson
     ORDER BY u.timestamp DESC
     LIMIT $limit`,
    { ...params, limit: maxFetch },
  ).then((rows) =>
    rows.map((r) => ({
      snapshotId: String(r.snapshotId),
      sessionId: String(r.sessionId),
      repoId: String(r.repoId),
      timestamp: String(r.timestamp),
      totalSdlTokens: toNumber(r.totalSdlTokens),
      totalRawEquivalent: toNumber(r.totalRawEquivalent),
      totalSavedTokens: toNumber(r.totalSavedTokens),
      savingsPercent: toNumber(r.savingsPercent),
      callCount: toNumber(r.callCount),
      toolBreakdownJson: String(r.toolBreakdownJson),
      packedEncodings: r.packedEncodings != null ? toNumber(r.packedEncodings) : 0,
      packedFallbacks: r.packedFallbacks != null ? toNumber(r.packedFallbacks) : 0,
      packedBytesSaved:
        r.packedBytesSaved != null ? toNumber(r.packedBytesSaved) : 0,
      packedByEncoderJson:
        r.packedByEncoderJson != null ? String(r.packedByEncoderJson) : "{}",
    })),
  );
}

export async function getAggregateUsage(
  conn: Connection,
  options: {
    repoId?: string;
    since?: string;
  } = {},
): Promise<{
  totalSdlTokens: number;
  totalRawEquivalent: number;
  totalSavedTokens: number;
  overallSavingsPercent: number;
  totalCalls: number;
  sessionCount: number;
}> {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.repoId) {
    conditions.push("u.repoId = $repoId");
    params.repoId = options.repoId;
  }
  if (options.since) {
    conditions.push("u.timestamp >= $since");
    params.since = options.since;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `MATCH (u:UsageSnapshot)
     ${whereClause}
     RETURN sum(u.totalSdlTokens) AS totalSdlTokens,
            sum(u.totalRawEquivalent) AS totalRawEquivalent,
            sum(u.totalSavedTokens) AS totalSavedTokens,
            sum(u.callCount) AS totalCalls,
            count(u) AS sessionCount`,
    params,
  );

  if (rows.length === 0) {
    return {
      totalSdlTokens: 0,
      totalRawEquivalent: 0,
      totalSavedTokens: 0,
      overallSavingsPercent: 0,
      totalCalls: 0,
      sessionCount: 0,
    };
  }

  const r = rows[0];
  const sdl = toNumber(r.totalSdlTokens);
  const raw = toNumber(r.totalRawEquivalent);
  const saved = toNumber(r.totalSavedTokens);
  const savingsPercent =
    raw > 0 && sdl < raw ? Math.round((1 - sdl / raw) * 100) : 0;

  return {
    totalSdlTokens: sdl,
    totalRawEquivalent: raw,
    totalSavedTokens: saved,
    overallSavingsPercent: savingsPercent,
    totalCalls: toNumber(r.totalCalls),
    sessionCount: toNumber(r.sessionCount),
  };
}

// ---------------------------------------------------------------------------
// Pure aggregation (no DB access)
// ---------------------------------------------------------------------------

/**
 * Aggregate tool breakdown entries from multiple snapshot JSON strings.
 * Returns a single array of ToolUsageEntry with totals per tool.
 */
export function aggregateToolBreakdowns(
  toolBreakdownJsons: string[],
): ToolUsageEntry[] {
  const map = new Map<
    string,
    { sdl: number; raw: number; saved: number; calls: number }
  >();

  for (const json of toolBreakdownJsons) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed as ToolUsageEntry[]) {
      if (
        typeof entry.tool !== "string" ||
        typeof entry.savedTokens !== "number"
      ) {
        continue;
      }
      const existing = map.get(entry.tool);
      if (existing) {
        existing.sdl += entry.sdlTokens ?? 0;
        existing.raw += entry.rawEquivalent ?? 0;
        existing.saved += entry.savedTokens;
        existing.calls += entry.callCount ?? 0;
      } else {
        map.set(entry.tool, {
          sdl: entry.sdlTokens ?? 0,
          raw: entry.rawEquivalent ?? 0,
          saved: entry.savedTokens,
          calls: entry.callCount ?? 0,
        });
      }
    }
  }

  return Array.from(map.entries()).map(([tool, v]) => ({
    tool,
    sdlTokens: v.sdl,
    rawEquivalent: v.raw,
    savedTokens: v.saved,
    callCount: v.calls,
  }));
}

// ---------------------------------------------------------------------------
// Convenience: persist a SessionUsageSnapshot
// ---------------------------------------------------------------------------

export async function persistUsageSnapshot(
  snapshot: SessionUsageSnapshot,
  repoId?: string,
): Promise<void> {
  const snapshotId = `usage_${snapshot.sessionId}_${Date.now()}`;
  await withWriteConn(async (conn) => {
    await insertUsageSnapshot(conn, {
      snapshotId,
      sessionId: snapshot.sessionId,
      repoId: repoId ?? "global",
      timestamp: getCurrentTimestamp(),
      totalSdlTokens: snapshot.totalSdlTokens,
      totalRawEquivalent: snapshot.totalRawEquivalent,
      totalSavedTokens: snapshot.totalSavedTokens,
      savingsPercent: snapshot.overallSavingsPercent,
      callCount: snapshot.callCount,
      toolBreakdownJson: JSON.stringify(snapshot.toolBreakdown),
      packedEncodings: snapshot.packedEncodings ?? 0,
      packedFallbacks: snapshot.packedFallbacks ?? 0,
      packedBytesSaved: snapshot.packedBytesSaved ?? 0,
      packedByEncoderJson: JSON.stringify(snapshot.packedByEncoder ?? {}),
    });
  });
}
