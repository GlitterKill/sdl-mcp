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
  aggregateToolBreakdowns,
} from "../../db/ladybug-usage.js";
import {
  renderSessionSummary,
  renderLifetimeSummary,
  type AggregateUsage,
} from "../savings-meter.js";
import { ValidationError, DatabaseError } from "../errors.js";
import { ZodError } from "zod";


const EMPTY_AGGREGATE: AggregateUsage = {
  totalSdlTokens: 0,
  totalRawEquivalent: 0,
  totalSavedTokens: 0,
  overallSavingsPercent: 0,
  totalCalls: 0,
  sessionCount: 0,
};

function toAggregateUsage(aggregate: Record<string, number>): AggregateUsage {
  return {
    totalSdlTokens: aggregate.totalSdlTokens,
    totalRawEquivalent: aggregate.totalRawEquivalent,
    totalSavedTokens: aggregate.totalSavedTokens,
    overallSavingsPercent: aggregate.overallSavingsPercent,
    totalCalls: aggregate.totalCalls,
    sessionCount: aggregate.sessionCount,
  };
}

async function fetchLifetimeAggregate(
  repoId: string | undefined,
): Promise<{ ltAggregate: AggregateUsage; allToolEntries: import("../token-accumulator.js").ToolUsageEntry[] }> {
  try {
    const conn = await getLadybugConn();
    const aggregate = await getAggregateUsage(conn, { repoId });
    const snapshots = await getUsageSnapshots(conn, { repoId, limit: 100 });
    const allToolEntries = aggregateToolBreakdowns(
      snapshots.map((s) => s.toolBreakdownJson),
    );
    return { ltAggregate: toAggregateUsage(aggregate), allToolEntries };
  } catch {
    process.stderr.write(
      "[sdl-mcp] Usage stats: could not fetch lifetime data from LadybugDB\n",
    );
    return { ltAggregate: EMPTY_AGGREGATE, allToolEntries: [] };
  }
}

export async function handleUsageStats(
  args: unknown,
): Promise<UsageStatsResponse> {
  let request;
  try {
    request = UsageStatsRequestSchema.parse(args);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(
        `Invalid usage stats request: ${error.issues.map((e) => e.message).join(", ")}`,
      );
    }
    throw error;
  }

  try {
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
    const allToolEntries = aggregateToolBreakdowns(
      snapshots.map((s) => s.toolBreakdownJson),
    );

    const topToolsBySavings = allToolEntries
      .map((e) => ({
        tool: e.tool,
        savedTokens: e.savedTokens,
        savingsPercent:
          e.rawEquivalent > 0
            ? Math.round(((e.rawEquivalent - e.sdlTokens) / e.rawEquivalent) * 100)
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

    // Build formatted summary for history-aware scopes
    const ltAggregate: AggregateUsage = toAggregateUsage(aggregate);

    if (request.scope === "both" && response.session) {
      response.formattedSummary = renderSessionSummary(
        response.session,
        ltAggregate,
        allToolEntries,
      );
    } else if (request.scope === "history") {
      response.formattedSummary = renderLifetimeSummary(
        ltAggregate,
        allToolEntries,
      );
    }
  }

  // Session-only: still fetch lifetime for the combined summary
  if (request.scope === "session" && response.session) {
    const { ltAggregate, allToolEntries } = await fetchLifetimeAggregate(request.repoId);
    response.formattedSummary = renderSessionSummary(
      response.session,
      ltAggregate,
      allToolEntries,
    );
  }

  return response;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof DatabaseError) {
      throw error;
    }
    throw new DatabaseError(
      `Usage stats retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
