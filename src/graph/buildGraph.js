import * as db from "../db/queries.js";
export function loadGraphForRepo(repoId) {
    const symbols = db.getSymbolsByRepo(repoId);
    const edges = db.getEdgesByRepo(repoId);
    const symbolMap = new Map();
    const adjacencyIn = new Map();
    const adjacencyOut = new Map();
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
export function getNeighbors(graph, symbolId, direction, edgeType) {
    const neighbors = new Set();
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
export function getPath(graph, fromSymbol, toSymbol) {
    if (fromSymbol === toSymbol) {
        return [fromSymbol];
    }
    const visited = new Set();
    const queue = [fromSymbol];
    const parent = new Map();
    visited.add(fromSymbol);
    while (queue.length > 0) {
        const current = queue.shift();
        const neighbors = getNeighbors(graph, current, "out");
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                parent.set(neighbor, current);
                if (neighbor === toSymbol) {
                    const path = [];
                    let node = toSymbol;
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
//# sourceMappingURL=buildGraph.js.map