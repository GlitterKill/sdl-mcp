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
import {
  tokenAccumulator,
  type SessionUsageSnapshot,
} from "../token-accumulator.js";
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

function limitSessionToolBreakdown(
  snapshot: SessionUsageSnapshot,
  limit?: number,
): SessionUsageSnapshot {
  if (limit === undefined) return snapshot;
  return {
    ...snapshot,
    toolBreakdown: snapshot.toolBreakdown.slice(0, limit),
  };
}

function limitEntries<T>(entries: T[], limit?: number): T[] {
  return limit === undefined ? entries : entries.slice(0, limit);
}


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
  const scope = request.scope;
  const wantsSession = scope === "session" || scope === "both" || scope === "all";
  const wantsLifetime = scope === "history" || scope === "lifetime" || scope === "both" || scope === "all";
  const wantsAll = scope === "both" || scope === "all";

  // Optionally persist current session snapshot first
  if (request.persist && tokenAccumulator.hasUsage) {
    await persistUsageSnapshot(
      tokenAccumulator.getSnapshot(),
      request.repoId,
    );
  }

  // Session scope — in-memory accumulator
  if (wantsSession) {
    response.session = limitSessionToolBreakdown(
      tokenAccumulator.getSnapshot(),
      request.limit,
    );
  }

  // wire.packed summary — prefer session figures, fall back to history aggregate.
  const sessionSnap = response.session ?? tokenAccumulator.getSnapshot();
  if (
    (sessionSnap.packedEncodings ?? 0) > 0 ||
    (sessionSnap.packedFallbacks ?? 0) > 0
  ) {
    response.wire = {
      packed: {
        encodings: sessionSnap.packedEncodings ?? 0,
        fallbacks: sessionSnap.packedFallbacks ?? 0,
        bytesSaved: sessionSnap.packedBytesSaved ?? 0,
        byEncoder: sessionSnap.packedByEncoder ?? {},
      },
    };
  }

  // History scope — from LadybugDB
  if (wantsLifetime) {
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
      .slice(0, request.limit ?? 10);

    const displayToolEntries = limitEntries(allToolEntries, request.limit);

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

    if (wantsAll && response.session) {
      response.formattedSummary = renderSessionSummary(
        response.session,
        ltAggregate,
        displayToolEntries,
        true,
      );
    } else if (scope === "history" || scope === "lifetime") {
      response.formattedSummary = renderLifetimeSummary(
        ltAggregate,
        displayToolEntries,
      );
    }
  }

  // Session-only: render the existing Session chart without querying lifetime data.
  if (scope === "session" && response.session) {
    response.formattedSummary = renderSessionSummary(response.session, EMPTY_AGGREGATE, []);
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