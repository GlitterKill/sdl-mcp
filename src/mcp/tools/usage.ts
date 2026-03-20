/**
 * MCP tool handler for sdl.usage.stats.
 *
 * Returns cumulative token savings — session-level (in-memory) and/or
 * historical (persisted in LadybugDB).
 */

import {
  UsageStatsRequestSchema,
  type UsageStatsResponse,
} from "../tools.js";
import { tokenAccumulator } from "../token-accumulator.js";
import { getLadybugConn } from "../../db/ladybug.js";
import {
  getUsageSnapshots,
  getAggregateUsage,
  persistUsageSnapshot,
} from "../../db/ladybug-usage.js";
import { safeJsonParse } from "../../util/safeJson.js";
import { z } from "zod";
import type { ToolUsageEntry } from "../token-accumulator.js";

const ToolBreakdownSchema = z.array(
  z.object({
    tool: z.string(),
    sdlTokens: z.number(),
    rawEquivalent: z.number(),
    savedTokens: z.number(),
    callCount: z.number(),
  }),
);

export async function handleUsageStats(
  args: unknown,
): Promise<UsageStatsResponse> {
  const request = UsageStatsRequestSchema.parse(args);
  const response: UsageStatsResponse = {};

  // Optionally persist current session snapshot first
  if (request.persist && tokenAccumulator.hasUsage) {
    await persistUsageSnapshot(
      tokenAccumulator.getSnapshot(),
      request.repoId,
    );
  }

  // Session scope — in-memory accumulator
  if (request.scope === "session" || request.scope === "both") {
    response.session = tokenAccumulator.getSnapshot();
  }

  // History scope — from LadybugDB
  if (request.scope === "history" || request.scope === "both") {
    const conn = await getLadybugConn();

    const snapshots = await getUsageSnapshots(conn, {
      repoId: request.repoId,
      since: request.since,
      limit: request.limit ?? 20,
    });

    const aggregate = await getAggregateUsage(conn, {
      repoId: request.repoId,
      since: request.since,
    });

    // Compute top tools by savings across all historical snapshots
    const toolTotals = new Map<string, { saved: number; sdl: number; raw: number }>();
    for (const snap of snapshots) {
      const breakdown = safeJsonParse(
        snap.toolBreakdownJson,
        ToolBreakdownSchema,
        [] as ToolUsageEntry[],
      );
      for (const entry of breakdown) {
        const existing = toolTotals.get(entry.tool);
        if (existing) {
          existing.saved += entry.savedTokens;
          existing.sdl += entry.sdlTokens;
          existing.raw += entry.rawEquivalent;
        } else {
          toolTotals.set(entry.tool, {
            saved: entry.savedTokens,
            sdl: entry.sdlTokens,
            raw: entry.rawEquivalent,
          });
        }
      }
    }

    const topToolsBySavings = [...toolTotals.entries()]
      .map(([tool, t]) => ({
        tool,
        savedTokens: t.saved,
        savingsPercent:
          t.raw > 0 && t.sdl < t.raw
            ? Math.round((1 - t.sdl / t.raw) * 100)
            : 0,
      }))
      .sort((a, b) => b.savedTokens - a.savedTokens)
      .slice(0, 10);

    response.history = {
      snapshots: snapshots.map((s) => ({
        snapshotId: s.snapshotId,
        sessionId: s.sessionId,
        repoId: s.repoId,
        timestamp: s.timestamp,
        totalSdlTokens: s.totalSdlTokens,
        totalRawEquivalent: s.totalRawEquivalent,
        totalSavedTokens: s.totalSavedTokens,
        savingsPercent: s.savingsPercent,
        callCount: s.callCount,
      })),
      aggregate: {
        ...aggregate,
        topToolsBySavings,
      },
    };
  }

  return response;
}
