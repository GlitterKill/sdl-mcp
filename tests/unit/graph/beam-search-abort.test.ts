import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { beamSearch } from "../../../dist/graph/slice/beam-search-engine.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

type SymbolKind = "function" | "class" | "interface" | "type" | "module" | "method" | "constructor" | "variable";
type EdgeType = "import" | "call" | "config";

interface MockSymbol {
  symbol_id: string;
  repo_id: string;
  name: string;
  kind: SymbolKind;
  file_id: number;
  exported: 0 | 1;
  visibility: string | null;
  language: string;
  range_start_line: number;
  range_start_col: number;
  range_end_line: number;
  range_end_col: number;
  ast_fingerprint: string;
  signature_json: string | null;
  summary: string | null;
  invariants_json: string | null;
  side_effects_json: string | null;
  updated_at: string;
}

interface MockEdge {
  edge_id?: number;
  repo_id: string;
  from_symbol_id: string;
  to_symbol_id: string;
  type: EdgeType;
  weight: number;
  provenance: string | null;
  created_at: string;
  confidence?: number;
  resolution_strategy?: string;
}

function createMockSymbol(
  id: string,
  name: string,
  kind: SymbolKind = "function",
  fileId: number = 1,
): MockSymbol {
  return {
    symbol_id: id,
    repo_id: "test-repo",
    name,
    kind,
    file_id: fileId,
    exported: 1,
    visibility: "public",
    language: "ts",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 10,
    range_end_col: 0,
    ast_fingerprint: "",
    signature_json: null,
    summary: null,
    invariants_json: null,
    side_effects_json: null,
    updated_at: new Date().toISOString(),
  };
}

function createMockEdge(
  from: string,
  to: string,
  type: EdgeType = "call",
  confidence: number = 1.0,
): MockEdge {
  return {
    repo_id: "test-repo",
    from_symbol_id: from,
    to_symbol_id: to,
    type,
    weight: 1.0,
    provenance: null,
    created_at: new Date().toISOString(),
    confidence,
  };
}

function createMockGraph(symbols: MockSymbol[], edges: MockEdge[]) {
  const symbolsMap = new Map<string, unknown>();
  for (const s of symbols) {
    symbolsMap.set(s.symbol_id, s);
  }

  const adjacencyOut = new Map<string, unknown[]>();
  const adjacencyIn = new Map<string, unknown[]>();

  for (const e of edges) {
    if (!adjacencyOut.has(e.from_symbol_id)) adjacencyOut.set(e.from_symbol_id, []);
    adjacencyOut.get(e.from_symbol_id)!.push(e);

    if (!adjacencyIn.has(e.to_symbol_id)) adjacencyIn.set(e.to_symbol_id, []);
    adjacencyIn.get(e.to_symbol_id)!.push(e);
  }

  return {
    repoId: "test-repo",
    symbols: symbolsMap,
    edges,
    adjacencyOut,
    adjacencyIn,
    files: new Map(),
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Beam Search Abort", () => {
  const edgeWeights: Record<EdgeType, number> = {
    call: 1.0,
    import: 0.6,
    config: 0.8,
  };

  it("should return immediately when signal is pre-aborted", () => {
    const controller = new AbortController();
    controller.abort();

    const symbols = [
      createMockSymbol("a", "alpha"),
      createMockSymbol("b", "beta"),
      createMockSymbol("c", "gamma"),
    ];
    const edges = [
      createMockEdge("a", "b", "call"),
      createMockEdge("a", "c", "call"),
    ];
    const graph = createMockGraph(symbols, edges);

    const budget = { maxCards: 10, maxEstimatedTokens: 10000 };
    const request = { entrySymbols: ["a"], taskText: "alpha beta gamma" };
    const startNodes = [{ symbolId: "a", source: "entrySymbol" as const }];

    const result = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
      controller.signal,
    );

    assert.ok(result, "result should be truthy");
    assert.ok(result.sliceCards instanceof Set, "sliceCards should be a Set");
    // With a pre-aborted signal the while-loop breaks before exploring
    // neighbors, so only the seeded start node (at most) should appear.
    assert.ok(result.sliceCards.size <= 1, `expected 0 or 1 cards, got ${result.sliceCards.size}`);
  });

  it("should not throw when signal is pre-aborted", () => {
    const controller = new AbortController();
    controller.abort();

    const symbols = [createMockSymbol("a", "alpha")];
    const graph = createMockGraph(symbols, []);

    const budget = { maxCards: 10, maxEstimatedTokens: 10000 };
    const request = { entrySymbols: ["a"] };
    const startNodes = [{ symbolId: "a", source: "entrySymbol" as const }];

    assert.doesNotThrow(() => {
      beamSearch(
        graph,
        startNodes,
        budget,
        request,
        edgeWeights,
        0.5,
        controller.signal,
      );
    });
  });

  it("should return a well-shaped result even when aborted", () => {
    const controller = new AbortController();
    controller.abort();

    const symbols = [
      createMockSymbol("x", "xray"),
      createMockSymbol("y", "yankee"),
    ];
    const edges = [createMockEdge("x", "y", "call")];
    const graph = createMockGraph(symbols, edges);

    const budget = { maxCards: 50, maxEstimatedTokens: 50000 };
    const request = { entrySymbols: ["x"], taskText: "xray yankee" };
    const startNodes = [{ symbolId: "x", source: "entrySymbol" as const }];

    const result = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
      controller.signal,
    );

    // Verify structural properties of the result
    assert.ok(result.sliceCards instanceof Set, "sliceCards must be a Set");
    assert.ok(Array.isArray(result.frontier), "frontier must be an array");
    assert.equal(typeof result.wasTruncated, "boolean", "wasTruncated must be boolean");
    assert.equal(typeof result.droppedCandidates, "number", "droppedCandidates must be number");
  });

  it("should explore more nodes without abort than with abort", () => {
    // Build a deeper graph to make the difference observable.
    const symbols = [
      createMockSymbol("n1", "node1"),
      createMockSymbol("n2", "node2"),
      createMockSymbol("n3", "node3"),
      createMockSymbol("n4", "node4"),
      createMockSymbol("n5", "node5"),
    ];
    const edges = [
      createMockEdge("n1", "n2", "call"),
      createMockEdge("n2", "n3", "call"),
      createMockEdge("n3", "n4", "call"),
      createMockEdge("n4", "n5", "call"),
    ];
    const graph = createMockGraph(symbols, edges);

    const budget = { maxCards: 50, maxEstimatedTokens: 50000 };
    const request = { entrySymbols: ["n1"], taskText: "node chain" };
    const startNodes = [{ symbolId: "n1", source: "entrySymbol" as const }];

    // Run without abort
    const normalResult = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
    );

    // Run with pre-aborted signal
    const abortController = new AbortController();
    abortController.abort();

    const abortedResult = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
      abortController.signal,
    );

    assert.ok(
      abortedResult.sliceCards.size <= normalResult.sliceCards.size,
      `aborted result (${abortedResult.sliceCards.size} cards) should have <= cards than normal result (${normalResult.sliceCards.size} cards)`,
    );
  });

  it("should handle undefined signal gracefully (no abort)", () => {
    const symbols = [
      createMockSymbol("s1", "start"),
      createMockSymbol("s2", "end"),
    ];
    const edges = [createMockEdge("s1", "s2", "call")];
    const graph = createMockGraph(symbols, edges);

    const budget = { maxCards: 10, maxEstimatedTokens: 10000 };
    const request = { entrySymbols: ["s1"] };
    const startNodes = [{ symbolId: "s1", source: "entrySymbol" as const }];

    // Passing undefined signal should work identically to omitting it
    const result = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
      undefined,
    );

    assert.ok(result, "result should be truthy");
    assert.ok(result.sliceCards instanceof Set, "sliceCards should be a Set");
    // Without abort, the search should find at least the start node
    assert.ok(result.sliceCards.size >= 1, "should find at least the start node");
  });
});
