import type { Connection, PreparedStatement, QueryResult } from "kuzu";
import type {
  EdgeRow,
  EdgeType,
  RepoId,
  SymbolId,
  SymbolRow,
} from "../db/schema.js";
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
 * New KuzuDB-backed graph operations should prefer `NeighborhoodSubgraph` or
 * direct Cypher traversal helpers instead of materializing full-repo maps.
 */
export interface Graph {
  repoId: RepoId;
  symbols: Map<SymbolId, SymbolRow>;
  edges: EdgeRow[];
  adjacencyIn: Map<SymbolId, EdgeRow[]>;
  adjacencyOut: Map<SymbolId, EdgeRow[]>;
}

const MAX_PREPARED_STATEMENT_CACHE_SIZE = 100;
const preparedStatementCacheByConn = new WeakMap<
  Connection,
  Map<string, PreparedStatement>
>();

function assertSafeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer, got: ${String(value)}`);
  }
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function coerceQueryResult(result: QueryResult | QueryResult[]): QueryResult {
  if (!Array.isArray(result)) return result;
  for (let i = 0; i < result.length - 1; i++) {
    result[i]?.close();
  }
  return result[result.length - 1];
}

async function getPreparedStatement(
  conn: Connection,
  statement: string,
): Promise<PreparedStatement> {
  let cache = preparedStatementCacheByConn.get(conn);
  if (!cache) {
    cache = new Map<string, PreparedStatement>();
    preparedStatementCacheByConn.set(conn, cache);
  }

  const cached = cache.get(statement);
  if (cached) {
    cache.delete(statement);
    cache.set(statement, cached);
    return cached;
  }

  const prepared = await conn.prepare(statement);
  cache.set(statement, prepared);

  if (cache.size > MAX_PREPARED_STATEMENT_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  return prepared;
}

async function execute(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult> {
  const prepared = await getPreparedStatement(conn, statement);
  const result = await conn.execute(prepared, params);
  return coerceQueryResult(result);
}

async function queryAll<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result = await execute(conn, statement, params);
  try {
    return (await result.getAll()) as T[];
  } finally {
    result.close();
  }
}

async function querySingle<T>(
  conn: Connection,
  statement: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const rows = await queryAll<T>(conn, statement, params);
  return rows.length > 0 ? rows[0] : null;
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
  if (fromSymbol === toSymbol) {
    return [fromSymbol];
  }

  assertSafeInt(maxHops, "maxHops");
  const safeMaxHops = Math.max(1, Math.min(maxHops, 50));

  const row = await querySingle<{ pathNodes: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol {symbolId: $fromSymbol})
     MATCH (r)<-[:SYMBOL_IN_REPO]-(b:Symbol {symbolId: $toSymbol})
     MATCH p = (a)-[:DEPENDS_ON*1..${safeMaxHops}]->(b)
     RETURN nodes(p) AS pathNodes
     ORDER BY length(p)
     LIMIT 1`,
    { repoId, fromSymbol, toSymbol },
  );

  if (!row) return null;

  const rawNodes = row.pathNodes;
  if (!Array.isArray(rawNodes)) {
    return null;
  }

  const symbolIds: SymbolId[] = [];
  for (const node of rawNodes) {
    if (typeof node === "string") {
      symbolIds.push(node);
      continue;
    }
    if (node && typeof node === "object" && "symbolId" in node) {
      const value = (node as { symbolId?: unknown }).symbolId;
      if (typeof value === "string") {
        symbolIds.push(value);
      }
    }
  }

  return symbolIds.length > 0 ? symbolIds : null;
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

  assertSafeInt(maxHops, "maxHops");
  assertSafeInt(maxSymbols, "maxSymbols");

  const safeMaxHops = Math.max(0, Math.min(maxHops, 20));
  const safeMaxSymbols = Math.max(1, Math.min(maxSymbols, 100_000));

  const relPattern =
    direction === "out"
      ? `-[:DEPENDS_ON*0..${safeMaxHops}]->`
      : direction === "in"
        ? `<-[:DEPENDS_ON*0..${safeMaxHops}]-`
        : `-[:DEPENDS_ON*0..${safeMaxHops}]-`;

  const symbolRows = await queryAll<{ symbolId: SymbolId }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(s:Symbol)
     WHERE s.symbolId IN $entrySymbols
     MATCH (s)${relPattern}(t:Symbol)-[:SYMBOL_IN_REPO]->(r)
     RETURN DISTINCT t.symbolId AS symbolId
     LIMIT ${safeMaxSymbols}`,
    { repoId, entrySymbols },
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
