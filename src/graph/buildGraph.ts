import type { SymbolId, EdgeType, SymbolRow, EdgeRow } from "../db/schema.js";
import * as db from "../db/queries.js";
import { logger } from "../util/logger.js";

export const LAZY_GRAPH_LOADING_DEFAULT_HOPS = 4;
export const LAZY_GRAPH_LOADING_MAX_SYMBOLS = 15000;

export interface Graph {
  repoId: string;
  symbols: Map<SymbolId, SymbolRow>;
  edges: EdgeRow[];
  adjacencyIn: Map<SymbolId, EdgeRow[]>;
  adjacencyOut: Map<SymbolId, EdgeRow[]>;
}

export interface GraphLoadStats {
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  mode: "full" | "lazy";
  hopBudget?: number;
  entrySymbolCount?: number;
}

export interface GraphTelemetryEvent {
  repoId: string;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
  mode: "full" | "lazy";
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

export function loadNeighborhood(
  repoId: string,
  entrySymbols: SymbolId[],
  options: NeighborhoodOptions,
): Graph {
  const startTime = Date.now();
  const maxHops = options.maxHops ?? 3;
  const direction = options.direction ?? "both";
  const maxSymbols = options.maxSymbols ?? 10000;

  const symbols = new Map<SymbolId, SymbolRow>();
  const adjacencyIn = new Map<SymbolId, EdgeRow[]>();
  const adjacencyOut = new Map<SymbolId, EdgeRow[]>();
  const allEdges: EdgeRow[] = [];
  const seenEdgeKeys = new Set<string>();
  const edgeKey = (e: EdgeRow) => `${e.from_symbol_id}\0${e.to_symbol_id}\0${e.type}`;

  const visited = new Set<SymbolId>();
  const frontier: Array<{ symbolId: SymbolId; hop: number }> = entrySymbols
    .filter((id) => id && id.length > 0)
    .map((symbolId) => ({ symbolId, hop: 0 }));

  while (frontier.length > 0 && symbols.size < maxSymbols) {
    const batch: Array<{ symbolId: SymbolId; hop: number }> = [];
    const toFetch: SymbolId[] = [];

    while (frontier.length > 0 && batch.length < 500) {
      const item = frontier.shift()!;
      if (visited.has(item.symbolId)) continue;
      visited.add(item.symbolId);
      batch.push(item);
      toFetch.push(item.symbolId);
    }

    if (toFetch.length === 0) continue;

    const fetchedSymbols = db.getSymbolsByIds(toFetch);
    for (const [symbolId, symbol] of fetchedSymbols) {
      symbols.set(symbolId, symbol);
      adjacencyIn.set(symbolId, []);
      adjacencyOut.set(symbolId, []);
    }

    const edgesMap = db.getEdgesFromSymbols(toFetch);
    const reverseEdgesMap = db.getEdgesToSymbols(toFetch);

    for (const [fromId, edges] of edgesMap) {
      for (const edge of edges) {
        const key = edgeKey(edge);
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);

        allEdges.push(edge);
        const outList = adjacencyOut.get(fromId);
        if (outList) outList.push(edge);

        if (!symbols.has(edge.to_symbol_id)) {
          adjacencyIn.set(edge.to_symbol_id, []);
        }
        const inList = adjacencyIn.get(edge.to_symbol_id);
        if (inList) inList.push(edge);
      }
    }

    for (const [toId, edges] of reverseEdgesMap) {
      for (const edge of edges) {
        const key = edgeKey(edge);
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);

        allEdges.push(edge);

        if (!symbols.has(edge.from_symbol_id)) {
          adjacencyOut.set(edge.from_symbol_id, []);
        }
        const outList = adjacencyOut.get(edge.from_symbol_id);
        if (outList) outList.push(edge);

        const inList = adjacencyIn.get(toId);
        if (inList) inList.push(edge);
      }
    }

    for (const item of batch) {
      if (item.hop >= maxHops) continue;

      if (direction === "out" || direction === "both") {
        const outgoing = adjacencyOut.get(item.symbolId) ?? [];
        for (const edge of outgoing) {
          if (!visited.has(edge.to_symbol_id)) {
            frontier.push({ symbolId: edge.to_symbol_id, hop: item.hop + 1 });
          }
        }
      }

      if (direction === "in" || direction === "both") {
        const incoming = adjacencyIn.get(item.symbolId) ?? [];
        for (const edge of incoming) {
          if (!visited.has(edge.from_symbol_id)) {
            frontier.push({ symbolId: edge.from_symbol_id, hop: item.hop + 1 });
          }
        }
      }
    }
  }

  for (const [symbolId] of symbols) {
    const incoming = adjacencyIn.get(symbolId);
    if (incoming) {
      const filtered = incoming.filter(
        (e) => symbols.has(e.from_symbol_id) && symbols.has(e.to_symbol_id),
      );
      adjacencyIn.set(symbolId, filtered);
    }

    const outgoing = adjacencyOut.get(symbolId);
    if (outgoing) {
      const filtered = outgoing.filter(
        (e) => symbols.has(e.from_symbol_id) && symbols.has(e.to_symbol_id),
      );
      adjacencyOut.set(symbolId, filtered);
    }
  }

  const filteredEdges = allEdges.filter(
    (e) => symbols.has(e.from_symbol_id) && symbols.has(e.to_symbol_id),
  );

  const durationMs = Date.now() - startTime;
  lastLoadStats = {
    nodeCount: symbols.size,
    edgeCount: filteredEdges.length,
    durationMs,
    mode: "lazy",
    hopBudget: maxHops,
    entrySymbolCount: entrySymbols.length,
  };

  logger.debug("Lazy graph neighborhood loaded", {
    repoId,
    nodeCount: symbols.size,
    edgeCount: filteredEdges.length,
    durationMs,
    maxHops,
    entrySymbolCount: entrySymbols.length,
  });

  return {
    repoId,
    symbols,
    edges: filteredEdges,
    adjacencyIn,
    adjacencyOut,
  };
}

export function loadGraphForRepo(repoId: string): Graph {
  const startTime = Date.now();
  const symbols = db.getSymbolsByRepo(repoId);
  const edges = db.getEdgesByRepo(repoId);

  const symbolMap = new Map<SymbolId, SymbolRow>();
  const adjacencyIn = new Map<SymbolId, EdgeRow[]>();
  const adjacencyOut = new Map<SymbolId, EdgeRow[]>();

  for (const symbol of symbols) {
    symbolMap.set(symbol.symbol_id, symbol);
    adjacencyIn.set(symbol.symbol_id, []);
    adjacencyOut.set(symbol.symbol_id, []);
  }

  for (const edge of edges) {
    const outgoing = adjacencyOut.get(edge.from_symbol_id);
    const incoming = adjacencyIn.get(edge.to_symbol_id);

    if (outgoing) {
      outgoing.push(edge);
    }
    if (incoming) {
      incoming.push(edge);
    }
  }

  const durationMs = Date.now() - startTime;
  lastLoadStats = {
    nodeCount: symbolMap.size,
    edgeCount: edges.length,
    durationMs,
    mode: "full",
  };

  logger.debug("Full graph loaded", {
    repoId,
    nodeCount: symbolMap.size,
    edgeCount: edges.length,
    durationMs,
  });

  return {
    repoId,
    symbols: symbolMap,
    edges,
    adjacencyIn,
    adjacencyOut,
  };
}

export function getNeighbors(
  graph: Graph,
  symbolId: SymbolId,
  direction: "in" | "out" | "both",
  edgeType?: EdgeType,
): SymbolId[] {
  const neighbors = new Set<SymbolId>();

  if (direction === "in" || direction === "both") {
    const incoming = graph.adjacencyIn.get(symbolId) ?? [];
    for (const edge of incoming) {
      if (!edgeType || edge.type === edgeType) {
        neighbors.add(edge.from_symbol_id);
      }
    }
  }

  if (direction === "out" || direction === "both") {
    const outgoing = graph.adjacencyOut.get(symbolId) ?? [];
    for (const edge of outgoing) {
      if (!edgeType || edge.type === edgeType) {
        neighbors.add(edge.to_symbol_id);
      }
    }
  }

  return Array.from(neighbors);
}

export function getPath(
  graph: Graph,
  fromSymbol: SymbolId,
  toSymbol: SymbolId,
): SymbolId[] | null {
  if (fromSymbol === toSymbol) {
    return [fromSymbol];
  }

  const visited = new Set<SymbolId>();
  const queue: SymbolId[] = [fromSymbol];
  const parent = new Map<SymbolId, SymbolId>();

  visited.add(fromSymbol);

  while (queue.length > 0) {
    const current = queue.shift()!;

    const neighbors = getNeighbors(graph, current, "out");

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);

        if (neighbor === toSymbol) {
          const path: SymbolId[] = [];
          let node: SymbolId | undefined = toSymbol;

          while (node) {
            path.unshift(node);
            node = parent.get(node);
          }

          return path;
        }

        queue.push(neighbor);
      }
    }
  }

  return null;
}
