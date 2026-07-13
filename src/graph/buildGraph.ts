import type { Connection } from "kuzu";
import type { EdgeType, RepoId, SymbolId } from "../domain/types.js";
import type { EdgeRow, FileRow, MetricsRow, SymbolRow } from "../db/schema.js";
import {
  getNeighborSymbolIds,
  loadGraphNeighborhoodRows,
} from "../db/ladybug-graph-read.js";
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
  return getNeighborSymbolIds(conn, repoId, symbolId, direction, edgeType);
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

  const safeMaxSymbols = Math.max(1, Math.min(maxSymbols, 100_000));
  const rows = await loadGraphNeighborhoodRows(
    conn,
    repoId,
    entrySymbols,
    maxHops,
    direction,
    safeMaxSymbols,
  );
  const symbolIds = new Set(rows.symbolIds);
  const edges: NeighborhoodEdge[] = rows.edges.map((row) => ({
    ...row,
    edgeType: row.edgeType as EdgeType,
  }));

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
