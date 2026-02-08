import type { SymbolId, EdgeType, SymbolRow, EdgeRow } from "../db/schema.js";
import * as db from "../db/queries.js";

export interface Graph {
  repoId: string;
  symbols: Map<SymbolId, SymbolRow>;
  edges: EdgeRow[];
  adjacencyIn: Map<SymbolId, EdgeRow[]>;
  adjacencyOut: Map<SymbolId, EdgeRow[]>;
}

export function loadGraphForRepo(repoId: string): Graph {
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
