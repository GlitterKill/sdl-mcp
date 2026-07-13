import type { Connection } from "kuzu";

import { assertSafeInt, queryAll, toNumber } from "./ladybug-core.js";

export interface GraphNeighborhoodEdgeRow {
  fromSymbolId: string;
  toSymbolId: string;
  edgeType: string;
  weight: number;
  confidence: number;
}

export interface GraphLayoutInputRows {
  nodes: Array<{ id: string; size: number }>;
  edges: Array<{ from: string; to: string; weight: number }>;
}

export async function getNeighborSymbolIds(
  conn: Connection,
  repoId: string,
  symbolId: string,
  direction: "in" | "out" | "both",
  edgeType?: string,
): Promise<string[]> {
  const neighbors = new Set<string>();
  const edgeTypeClause = edgeType ? "AND d.edgeType = $edgeType" : "";
  const params: Record<string, unknown> = { repoId, symbolId };
  if (edgeType) params.edgeType = edgeType;

  if (direction === "out" || direction === "both") {
    const rows = await queryAll<{ neighborId: string }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol {symbolId: $symbolId})
       MATCH (s)-[d:DEPENDS_ON]->(t:Symbol)-[:SYMBOL_IN_REPO]->(r)
       WHERE true ${edgeTypeClause}
       RETURN DISTINCT t.symbolId AS neighborId`,
      params,
    );
    for (const row of rows) neighbors.add(row.neighborId);
  }
  if (direction === "in" || direction === "both") {
    const rows = await queryAll<{ neighborId: string }>(
      conn,
      `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol {symbolId: $symbolId})
       MATCH (t:Symbol)-[d:DEPENDS_ON]->(s)
       MATCH (t)-[:SYMBOL_IN_REPO]->(r)
       WHERE true ${edgeTypeClause}
       RETURN DISTINCT t.symbolId AS neighborId`,
      params,
    );
    for (const row of rows) neighbors.add(row.neighborId);
  }
  return [...neighbors];
}

export async function loadGraphNeighborhoodRows(
  conn: Connection,
  repoId: string,
  entrySymbols: readonly string[],
  maxHops: number,
  direction: "in" | "out" | "both",
  maxSymbols: number,
): Promise<{ symbolIds: string[]; edges: GraphNeighborhoodEdgeRow[] }> {
  const relPattern = variableLengthPathClause(
    0,
    Math.min(maxHops, 20),
    "DEPENDS_ON",
    direction,
  );
  const symbolRows = await queryAll<{ symbolId: string }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE s.symbolId IN $entrySymbols
     MATCH (s)${relPattern}(t:Symbol)-[:SYMBOL_IN_REPO]->(r)
     RETURN DISTINCT t.symbolId AS symbolId
     LIMIT $limit`,
    { repoId, entrySymbols: [...entrySymbols], limit: maxSymbols },
  );
  const symbolIds = symbolRows.map((row) => row.symbolId);
  if (symbolIds.length === 0) return { symbolIds, edges: [] };

  const edgeRows = await queryAll<{
    fromSymbolId: string; toSymbolId: string; edgeType: string;
    weight: unknown; confidence: unknown;
  }>(
    conn,
    `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     WHERE a.symbolId IN $symbolIds AND b.symbolId IN $symbolIds
     RETURN a.symbolId AS fromSymbolId, b.symbolId AS toSymbolId,
            d.edgeType AS edgeType, d.weight AS weight, d.confidence AS confidence`,
    { symbolIds },
  );
  return {
    symbolIds,
    edges: edgeRows.map((row) => ({
      ...row,
      weight: toNumber(row.weight),
      confidence: toNumber(row.confidence),
    })),
  };
}

export async function getClusterLayoutInputRows(
  conn: Connection,
  repoId: string,
): Promise<GraphLayoutInputRows> {
  const nodes = await queryAll<{ id: string; size: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:CLUSTER_IN_REPO]-(c:Cluster)
     RETURN c.clusterId AS id, c.symbolCount AS size ORDER BY id ASC`,
    { repoId },
  );
  const edges = await queryAll<{ from: string; to: string; weight: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
     MATCH (a)-[:BELONGS_TO_CLUSTER]->(ca:Cluster)
     MATCH (b)-[:BELONGS_TO_CLUSTER]->(cb:Cluster)
     WHERE ca.clusterId <> cb.clusterId
     RETURN ca.clusterId AS from, cb.clusterId AS to, COUNT(*) AS weight
     ORDER BY from ASC, to ASC`,
    { repoId },
  );
  return {
    nodes: nodes.map((row) => ({ id: row.id, size: toNumber(row.size ?? 1) })),
    edges: edges.map((row) => ({ ...row, weight: toNumber(row.weight ?? 1) })),
  };
}

export async function getSymbolLayoutInputRows(
  conn: Connection,
  repoId: string,
  clusterId: string,
): Promise<GraphLayoutInputRows> {
  const nodes = await queryAll<{ id: string; size: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)-[:BELONGS_TO_CLUSTER]->(:Cluster {clusterId: $clusterId})
     OPTIONAL MATCH (:Symbol)-[incoming:DEPENDS_ON]->(s)
     RETURN s.symbolId AS id, COUNT(incoming) AS size ORDER BY id ASC`,
    { repoId, clusterId },
  );
  const edges = await queryAll<{ from: string; to: string; weight: unknown }>(
    conn,
    `MATCH (:Cluster {clusterId: $clusterId})<-[:BELONGS_TO_CLUSTER]-(a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)-[:BELONGS_TO_CLUSTER]->(:Cluster {clusterId: $clusterId})
     RETURN a.symbolId AS from, b.symbolId AS to, COUNT(*) AS weight
     ORDER BY from ASC, to ASC`,
    { clusterId },
  );
  return {
    nodes: nodes.map((row) => ({ id: row.id, size: Math.max(1, toNumber(row.size ?? 1)) })),
    edges: edges.map((row) => ({ ...row, weight: toNumber(row.weight ?? 1) })),
  };
}

function variableLengthPathClause(
  minHops: number,
  maxHops: number,
  relType: string,
  direction: "in" | "out" | "both",
): string {
  assertSafeInt(minHops, "minHops");
  assertSafeInt(maxHops, "maxHops");
  const safeMin = Math.max(0, Math.min(minHops, 50));
  const safeMax = Math.max(safeMin, Math.min(maxHops, 50));
  const pattern = `[:${relType}*${safeMin}..${safeMax}]`;
  if (direction === "out") return `-${pattern}->`;
  if (direction === "in") return `<-${pattern}-`;
  return `-${pattern}-`;
}
