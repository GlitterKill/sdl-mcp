/**
 * ladybug-metrics.ts - Metrics Operations
 * Extracted from ladybug-queries.ts as part of the god-object split.
 */
import type { Connection } from "kuzu";
import {
  exec,
  queryAll,
  querySingle,
  toNumber,
  assertSafeInt,
  withTransaction,
} from "./ladybug-core.js";
import type {
  MetricsRow,
  TopSymbolByFanInRow,
  FanInOut,
} from "./ladybug-repos.js";

export async function upsertMetrics(
  conn: Connection,
  metrics: MetricsRow,
): Promise<void> {
  await exec(
    conn,
    `MERGE (m:Metrics {symbolId: $symbolId})
     SET m.fanIn = $fanIn,
         m.fanOut = $fanOut,
         m.churn30d = $churn30d,
         m.testRefsJson = $testRefsJson,
         m.canonicalTestJson = $canonicalTestJson,
         m.updatedAt = $updatedAt`,
    {
      symbolId: metrics.symbolId,
      fanIn: metrics.fanIn,
      fanOut: metrics.fanOut,
      churn30d: metrics.churn30d,
      testRefsJson: metrics.testRefsJson,
      canonicalTestJson: metrics.canonicalTestJson,
      updatedAt: metrics.updatedAt,
    },
  );
}

/**
 * Batch-upsert metrics rows within a single transaction to reduce per-row
 * round-trip overhead during full metric refreshes.
 */
export async function upsertMetricsBatch(
  conn: Connection,
  rows: MetricsRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await withTransaction(conn, async (txConn) => {
    for (const metrics of rows) {
      await exec(
        txConn,
        `MERGE (m:Metrics {symbolId: $symbolId})
         SET m.fanIn = $fanIn,
             m.fanOut = $fanOut,
             m.churn30d = $churn30d,
             m.testRefsJson = $testRefsJson,
             m.canonicalTestJson = $canonicalTestJson,
             m.updatedAt = $updatedAt`,
        {
          symbolId: metrics.symbolId,
          fanIn: metrics.fanIn,
          fanOut: metrics.fanOut,
          churn30d: metrics.churn30d,
          testRefsJson: metrics.testRefsJson,
          canonicalTestJson: metrics.canonicalTestJson,
          updatedAt: metrics.updatedAt,
        },
      );
    }
  });
}

export async function getMetrics(
  conn: Connection,
  symbolId: string,
): Promise<MetricsRow | null> {
  const row = await querySingle<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (m:Metrics {symbolId: $symbolId})
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.updatedAt AS updatedAt`,
    { symbolId },
  );

  if (!row) return null;

  return {
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
    testRefsJson: row.testRefsJson,
    canonicalTestJson: row.canonicalTestJson,
    updatedAt: row.updatedAt,
  };
}

export async function getMetricsBySymbolIds(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, MetricsRow>> {
  if (symbolIds.length === 0) return new Map();

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (m:Metrics)
     WHERE m.symbolId IN $symbolIds
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.updatedAt AS updatedAt`,
    { symbolIds },
  );

  const result = new Map<string, MetricsRow>();
  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      fanIn: toNumber(row.fanIn),
      fanOut: toNumber(row.fanOut),
      churn30d: toNumber(row.churn30d),
      testRefsJson: row.testRefsJson,
      canonicalTestJson: row.canonicalTestJson,
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export async function getTopSymbolsByFanIn(
  conn: Connection,
  repoId: string,
  limit = 10,
): Promise<TopSymbolByFanInRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 1000));

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN s.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d
     ORDER BY m.fanIn DESC`,
    { repoId },
  );

  return rows.slice(0, limit).map((row) => ({
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
  }));
}

export async function getMetricsByRepo(
  conn: Connection,
  repoId: string,
): Promise<Map<string, MetricsRow>> {
  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
    testRefsJson: string | null;
    canonicalTestJson: string | null;
    updatedAt: string;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN m.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d,
            m.testRefsJson AS testRefsJson,
            m.canonicalTestJson AS canonicalTestJson,
            m.updatedAt AS updatedAt`,
    { repoId },
  );

  const result = new Map<string, MetricsRow>();
  for (const row of rows) {
    result.set(row.symbolId, {
      symbolId: row.symbolId,
      fanIn: toNumber(row.fanIn),
      fanOut: toNumber(row.fanOut),
      churn30d: toNumber(row.churn30d),
      testRefsJson: row.testRefsJson,
      canonicalTestJson: row.canonicalTestJson,
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

export async function getTopSymbolsByChurn(
  conn: Connection,
  repoId: string,
  limit = 10,
): Promise<TopSymbolByFanInRow[]> {
  assertSafeInt(limit, "limit");
  limit = Math.max(0, Math.min(limit, 1000));

  const rows = await queryAll<{
    symbolId: string;
    fanIn: unknown;
    fanOut: unknown;
    churn30d: unknown;
  }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     MATCH (m:Metrics {symbolId: s.symbolId})
     RETURN s.symbolId AS symbolId,
            m.fanIn AS fanIn,
            m.fanOut AS fanOut,
            m.churn30d AS churn30d
     ORDER BY m.churn30d DESC`,
    { repoId },
  );

  return rows.slice(0, limit).map((row) => ({
    symbolId: row.symbolId,
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
    churn30d: toNumber(row.churn30d),
  }));
}

export async function computeFanInOut(
  conn: Connection,
  symbolId: string,
): Promise<FanInOut> {
  const row = await querySingle<{
    fanIn: unknown;
    fanOut: unknown;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     OPTIONAL MATCH (s)<-[i:DEPENDS_ON]-(:Symbol)
     WITH s, count(i) AS fanIn
     OPTIONAL MATCH (s)-[o:DEPENDS_ON]->(:Symbol)
     RETURN fanIn AS fanIn, count(o) AS fanOut`,
    { symbolId },
  );

  if (!row) return { fanIn: 0, fanOut: 0 };

  return {
    fanIn: toNumber(row.fanIn),
    fanOut: toNumber(row.fanOut),
  };
}

export async function batchComputeFanInOut(
  conn: Connection,
  symbolIds: string[],
): Promise<Map<string, FanInOut>> {
  if (symbolIds.length === 0) return new Map();

  const result = new Map<string, FanInOut>();
  for (const symbolId of symbolIds) {
    result.set(symbolId, { fanIn: 0, fanOut: 0 });
  }

  // NOTE: Ladybug can produce incorrect counts for large UNWIND lists, especially
  // when the input list contains many missing symbols. Prefer WHERE ... IN and
  // fill missing IDs in JS.
  const fanInRows = await queryAll<{ symbolId: string; fanIn: unknown }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)<-[i:DEPENDS_ON]-(:Symbol)
     RETURN s.symbolId AS symbolId, count(i) AS fanIn`,
    { symbolIds },
  );

  for (const row of fanInRows) {
    const entry = result.get(row.symbolId);
    if (entry) entry.fanIn = toNumber(row.fanIn);
  }

  const fanOutRows = await queryAll<{ symbolId: string; fanOut: unknown }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
     OPTIONAL MATCH (s)-[o:DEPENDS_ON]->(:Symbol)
     RETURN s.symbolId AS symbolId, count(o) AS fanOut`,
    { symbolIds },
  );

  for (const row of fanOutRows) {
    const entry = result.get(row.symbolId);
    if (entry) entry.fanOut = toNumber(row.fanOut);
  }

  return result;
}

// ============================================================================
// Auxiliary queries (audit, feedback, embeddings, caches, artifacts)
// ============================================================================
