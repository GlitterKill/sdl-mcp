import type { Connection } from "kuzu";
import type { EdgeType, RepoId, SymbolId } from "../domain/types.js";
import type { EdgeRow, FileRow, MetricsRow, SymbolRow } from "../db/schema.js";
import {
  assertSafeInt,
  queryAll,
  toNumber,
} from "../db/ladybug-core.js";
import { shortestPath } from "../db/ladybug-algorithms.js";
import { logger } from "../util/logger.js";

export const LAZY_GRAPH_LOADING_DEFAULT_HOPS = 4;
export const LAZY_GRAPH_LOADING_MAX_SYMBOLS = 15000;

export interface GraphLoadStats {
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  mode: "lazy";
  hopBudget?: number;
  entrySymbolCount?: number;
}

export interface GraphTelemetryEvent {
  repoId: string;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  mode: "lazy";
  hopBudget?: number;
  entrySymbolCount?: number;
}

export function logGraphTelemetry(event: GraphTelemetryEvent): void {
  logger.info("Graph load telemetry", {
    eventType: "graph_load",
    timestamp: new Date().toISOString(),
    ...event,
  });
}

let lastLoadStats: GraphLoadStats | null = null;

/**
 * Build a Cypher variable-length path clause like `-[:REL_TYPE*min..max]->`.
 *
 * WHY interpolation is required: Kuzu (LadybugDB) does not support
 * parameterized values inside variable-length path bounds (`*min..max`).
 * Parameters like `$minHops` are rejected by the parser in that position.
 * We therefore validate and clamp the integers here before interpolating.
 */
function buildVariableLengthPathClause(
  minHops: number,
  maxHops: number,
  relType: string,
  direction: "in" | "out" | "both" = "both",
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


export function getLastLoadStats(): GraphLoadStats | null {
  return lastLoadStats;
}

export function resetLoadStats(): void {
  lastLoadStats = null;
}

export interface NeighborhoodOptions {
  maxHops: number;
  direction?: "in" | "out" | "both";
  maxSymbols?: number;
}

export interface NeighborhoodEdge {
  fromSymbolId: SymbolId;
  toSymbolId: SymbolId;
  edgeType: EdgeType;
  weight: number;
  confidence: number;
}

export interface NeighborhoodSubgraph {
  repoId: RepoId;
  symbolIds: Set<SymbolId>;
  edges: NeighborhoodEdge[];
}

/**
 * Legacy in-memory graph shape used by older slice/metrics code and unit tests.
 *
 * New LadybugDB-backed graph operations should prefer `NeighborhoodSubgraph` or
 * direct Cypher traversal helpers instead of materializing full-repo maps.
 */
export interface Graph {
  repoId: RepoId;
  symbols: Map<SymbolId, SymbolRow>;
  edges: EdgeRow[];
  adjacencyIn: Map<SymbolId, EdgeRow[]>;
  adjacencyOut: Map<SymbolId, EdgeRow[]>;
  metrics?: Map<SymbolId, MetricsRow>;
  /**
   * Cached centrality stats derived from `metrics`. Pre-computed once when
   * the Graph snapshot is built so repeated beam-search calls on the same
   * snapshot see identical maxPageRank/maxKCore values (no drift from
   * recomputing on partial metric iterations). The async DB-backed path
   * (`beamSearchLadybug`) does not use this field and calls
   * `loadRepoCentralityStats` instead.
   */
  centralityStats?: import("./score.js").CentralityStats;
  files?: Map<number, FileRow>;
  clusters?: Map<SymbolId, string>;
}

export async function getNeighbors(
  conn: Connection,
  repoId: RepoId,
  symbolId: SymbolId,
  direction: "in" | "out" | "both",
  edgeType?: EdgeType,
): Promise<SymbolId[]> {
  const neighbors = new Set<SymbolId>();

  const edgeTypeClause = edgeType ? "AND d.edgeType = $edgeType" : "";
  const params: Record<string, unknown> = { repoId, symbolId };
  if (edgeType) params.edgeType = edgeType;

  if (direction === "out" || direction === "both") {
    const rows = await queryAll<{ neighborId: SymbolId }>(
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
    const rows = await queryAll<{ neighborId: SymbolId }>(
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

  return Array.from(neighbors);
}

export async function getPath(
  conn: Connection,
  repoId: RepoId,
  fromSymbol: SymbolId,
  toSymbol: SymbolId,
  maxHops: number = 12,
): Promise<SymbolId[] | null> {
  // Route through the centralized algorithm adapter so that all graph
  // algorithm access (including shortest-path) goes through one module.
  // The adapter uses native Cypher variable-length path syntax, so this
  // still works without the algo extension.
  const ids = await shortestPath(
    conn,
    repoId,
    fromSymbol,
    toSymbol,
    maxHops,
  );
  if (ids === null) return null;
  return ids;
}

export async function loadNeighborhood(
  conn: Connection,
  repoId: RepoId,
  entrySymbols: SymbolId[],
  options: NeighborhoodOptions,
): Promise<NeighborhoodSubgraph> {
  const startTime = Date.now();
  const maxHops = options.maxHops ?? 3;
  const direction = options.direction ?? "both";
  const maxSymbols = options.maxSymbols ?? 10000;

  if (entrySymbols.length === 0) {
    lastLoadStats = {
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
      mode: "lazy",
      hopBudget: maxHops,
      entrySymbolCount: 0,
    };
    return { repoId, symbolIds: new Set(), edges: [] };
  }

  assertSafeInt(maxSymbols, "maxSymbols");
  const safeMaxSymbols = Math.max(1, Math.min(maxSymbols, 100_000));

  const relPattern = buildVariableLengthPathClause(0, Math.min(maxHops, 20), "DEPENDS_ON", direction);

  const symbolRows = await queryAll<{ symbolId: SymbolId }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE s.symbolId IN $entrySymbols
     MATCH (s)${relPattern}(t:Symbol)-[:SYMBOL_IN_REPO]->(r)
     RETURN DISTINCT t.symbolId AS symbolId
     LIMIT $limit`,
    { repoId, entrySymbols, limit: safeMaxSymbols },
  );

  const symbolIds = new Set(symbolRows.map((r) => r.symbolId));

  const edges: NeighborhoodEdge[] = [];
  const symbolIdList = Array.from(symbolIds);

  if (symbolIdList.length > 0) {
    const edgeRows = await queryAll<{
      fromSymbolId: SymbolId;
      toSymbolId: SymbolId;
      edgeType: EdgeType;
      weight: unknown;
      confidence: unknown;
    }>(
      conn,
      `MATCH (a:Symbol)-[d:DEPENDS_ON]->(b:Symbol)
       WHERE a.symbolId IN $symbolIds AND b.symbolId IN $symbolIds
       RETURN a.symbolId AS fromSymbolId,
              b.symbolId AS toSymbolId,
              d.edgeType AS edgeType,
              d.weight AS weight,
              d.confidence AS confidence`,
      { symbolIds: symbolIdList },
    );

    for (const row of edgeRows) {
      edges.push({
        fromSymbolId: row.fromSymbolId,
        toSymbolId: row.toSymbolId,
        edgeType: row.edgeType,
        weight: toNumber(row.weight),
        confidence: toNumber(row.confidence),
      });
    }
  }

  const durationMs = Date.now() - startTime;
  lastLoadStats = {
    nodeCount: symbolIds.size,
    edgeCount: edges.length,
    durationMs,
    mode: "lazy",
    hopBudget: maxHops,
    entrySymbolCount: entrySymbols.length,
  };

  logger.debug("Cypher neighborhood loaded", {
    repoId,
    nodeCount: symbolIds.size,
    edgeCount: edges.length,
    durationMs,
    maxHops,
    entrySymbolCount: entrySymbols.length,
  });

  return {
    repoId,
    symbolIds,
    edges,
  };
}
