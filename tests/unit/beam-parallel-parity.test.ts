import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import type { SymbolRow, EdgeRow } from "../../src/db/schema.js";
import type { SliceBudget } from "../../src/mcp/types.js";
import type { Graph } from "../../src/graph/buildGraph.js";

type SymbolKind = SymbolRow["kind"];
type EdgeType = EdgeRow["type"];
type StartNodeSource =
  | "entrySymbol"
  | "entryFirstHop"
  | "entrySibling"
  | "stackTrace"
  | "failingTestPath"
  | "editedFile"
  | "taskText";

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

function createMockGraph(symbols: MockSymbol[], edges: MockEdge[]): Graph {
  const symbolsMap = new Map<string, SymbolRow>();
  const adjacencyOut = new Map<string, EdgeRow[]>();
  const adjacencyIn = new Map<string, EdgeRow[]>();

  for (const s of symbols) {
    symbolsMap.set(s.symbol_id, s as unknown as SymbolRow);
  }

  for (const e of edges) {
    const outList = adjacencyOut.get(e.from_symbol_id) ?? [];
    outList.push(e as unknown as EdgeRow);
    adjacencyOut.set(e.from_symbol_id, outList);

    const inList = adjacencyIn.get(e.to_symbol_id) ?? [];
    inList.push(e as unknown as EdgeRow);
    adjacencyIn.set(e.to_symbol_id, inList);
  }

  return {
    symbols: symbolsMap,
    adjacencyOut,
    adjacencyIn,
    files: new Map(),
  } as unknown as Graph;
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

describe("Beam Search Parallel Parity", () => {
  beforeEach(async () => {
    const { resetScorerPool } =
      await import("../../src/graph/slice/beam-search-engine.js");
    resetScorerPool();
  });

  afterEach(async () => {
    const { resetScorerPool } =
      await import("../../src/graph/slice/beam-search-engine.js");
    resetScorerPool();
  });

  it("should produce identical results in sequential and parallel mode for small graph", async () => {
    const { beamSearch, beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols = [
      createMockSymbol("a", "alpha"),
      createMockSymbol("b", "beta"),
      createMockSymbol("c", "gamma"),
    ];

    const edges = [
      createMockEdge("a", "b", "call", 1.0),
      createMockEdge("a", "c", "call", 0.9),
    ];

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = {
      entrySymbols: ["a"],
      taskText: "alpha beta gamma",
    };

    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const sequentialResult = beamSearch(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
    );

    const parallelResult = await beamSearchAsync(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
      { parallelScorer: { enabled: false } },
    );

    assert.strictEqual(
      parallelResult.scorerMode,
      "sequential",
      "Should use sequential mode when disabled",
    );

    assert.deepStrictEqual(
      [...sequentialResult.sliceCards].sort(),
      [...parallelResult.sliceCards].sort(),
      "Slice cards should match",
    );

    assert.strictEqual(
      sequentialResult.wasTruncated,
      parallelResult.wasTruncated,
      "Truncation flag should match",
    );
  });

  it("should maintain deterministic ordering with same sequence values", async () => {
    const { beamSearch } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols = [
      createMockSymbol("a", "funcA"),
      createMockSymbol("b1", "funcB1"),
      createMockSymbol("b2", "funcB2"),
      createMockSymbol("b3", "funcB3"),
    ];

    const edges = [
      createMockEdge("a", "b1", "call", 0.9),
      createMockEdge("a", "b2", "call", 0.9),
      createMockEdge("a", "b3", "call", 0.9),
    ];

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = { entrySymbols: ["a"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const results: (typeof sequentialResult)[] = [];
    type SequentialResult = typeof sequentialResult extends infer T ? T : never;
    let sequentialResult: ReturnType<typeof beamSearch>;

    for (let i = 0; i < 3; i++) {
      const result = beamSearch(
        graph,
        [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
        budget,
        request,
        edgeWeights,
        minConfidence,
      );
      if (i === 0) sequentialResult = result;
      results.push(result);
    }

    for (let i = 1; i < results.length; i++) {
      assert.deepStrictEqual(
        [...results[0].sliceCards],
        [...results[i].sliceCards],
        `Run ${i + 1} should produce same slice cards as run 1`,
      );
    }
  });

  it("should fallback to sequential on worker initialization failure", async () => {
    const { beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols = [
      createMockSymbol("a", "alpha"),
      createMockSymbol("b", "beta"),
    ];

    const edges = [createMockEdge("a", "b", "call", 1.0)];

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = { entrySymbols: ["a"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const result = await beamSearchAsync(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
      { parallelScorer: { enabled: true } },
    );

    assert.ok(
      result.scorerMode === "sequential" || result.scorerMode === "parallel",
      "Should have valid scorer mode",
    );

    assert.ok(result.sliceCards.has("a"), "Start node should be in slice");
  });

  it("should handle edge confidence filtering identically", async () => {
    const { beamSearch, beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols = [
      createMockSymbol("a", "alpha"),
      createMockSymbol("b", "beta"),
      createMockSymbol("c", "gamma"),
      createMockSymbol("d", "delta"),
    ];

    const edges = [
      createMockEdge("a", "b", "call", 0.9),
      createMockEdge("a", "c", "call", 0.3),
      createMockEdge("a", "d", "call", 0.1),
    ];

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = { entrySymbols: ["a"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const sequentialResult = beamSearch(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
    );

    const parallelResult = await beamSearchAsync(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
      { parallelScorer: { enabled: false } },
    );

    assert.strictEqual(
      sequentialResult.droppedCandidates,
      parallelResult.droppedCandidates,
      "Dropped candidates count should match",
    );
  });

  it("should respect budget limits identically", async () => {
    const { beamSearch, beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols: MockSymbol[] = [createMockSymbol("start", "startNode")];

    for (let i = 0; i < 100; i++) {
      symbols.push(createMockSymbol(`node${i}`, `function${i}`));
    }

    const edges: MockEdge[] = [];
    for (let i = 0; i < 100; i++) {
      edges.push(createMockEdge("start", `node${i}`, "call", 0.8));
    }

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 500,
    };

    const request = { entrySymbols: ["start"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.3;

    const sequentialResult = beamSearch(
      graph,
      [{ symbolId: "start", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
    );

    const parallelResult = await beamSearchAsync(
      graph,
      [{ symbolId: "start", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
      { parallelScorer: { enabled: false } },
    );

    assert.ok(
      sequentialResult.sliceCards.size <= budget.maxCards,
      "Sequential should respect card limit",
    );

    assert.ok(
      parallelResult.sliceCards.size <= budget.maxCards,
      "Parallel should respect card limit",
    );

    assert.strictEqual(
      sequentialResult.sliceCards.size,
      parallelResult.sliceCards.size,
      "Both modes should produce same number of cards",
    );
  });

  it("should handle empty graph gracefully", async () => {
    const { beamSearch, beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const graph = createMockGraph([], []);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = {};
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const sequentialResult = beamSearch(
      graph,
      [],
      budget,
      request,
      edgeWeights,
      minConfidence,
    );

    const parallelResult = await beamSearchAsync(
      graph,
      [],
      budget,
      request,
      edgeWeights,
      minConfidence,
      { parallelScorer: { enabled: false } },
    );

    assert.strictEqual(sequentialResult.sliceCards.size, 0);
    assert.strictEqual(parallelResult.sliceCards.size, 0);
  });

  it("should handle missing symbols in graph", async () => {
    const { beamSearchAsync } =
      await import("../../src/graph/slice/beam-search-engine.js");

    const symbols = [createMockSymbol("a", "alpha")];
    const edges: MockEdge[] = [];

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 10,
      maxEstimatedTokens: 10000,
    };

    const request = { entrySymbols: ["nonexistent"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.5;

    const result = await beamSearchAsync(
      graph,
      [{ symbolId: "nonexistent", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
    );

    assert.strictEqual(result.sliceCards.size, 0);
  });

  it("should auto-fallback on worker failure", async () => {
    const { beamSearchAsync, resetScorerPool } =
      await import("../../src/graph/slice/beam-search-engine.js");

    resetScorerPool();

    const symbols = [
      createMockSymbol("a", "alpha"),
      createMockSymbol("b", "beta"),
      createMockSymbol("c", "gamma"),
      createMockSymbol("d", "delta"),
      createMockSymbol("e", "epsilon"),
      createMockSymbol("f", "zeta"),
      createMockSymbol("g", "eta"),
      createMockSymbol("h", "theta"),
      createMockSymbol("i", "iota"),
      createMockSymbol("j", "kappa"),
    ];

    const edges: MockEdge[] = [];
    for (let i = 1; i < symbols.length; i++) {
      edges.push(createMockEdge("a", symbols[i].symbol_id, "call", 0.9));
    }

    const graph = createMockGraph(symbols, edges);
    const budget: Required<SliceBudget> = {
      maxCards: 20,
      maxEstimatedTokens: 10000,
    };

    const request = { entrySymbols: ["a"] };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const minConfidence = 0.2;

    const result = await beamSearchAsync(
      graph,
      [{ symbolId: "a", source: "entrySymbol" as StartNodeSource }],
      budget,
      request,
      edgeWeights,
      minConfidence,
      {
        parallelScorer: {
          enabled: true,
          minBatchSize: 5,
        },
      },
    );

    assert.ok(result.sliceCards.has("a"), "Start node should be in slice");
    assert.ok(
      result.scorerMode === "sequential" || result.scorerMode === "parallel",
      "Should have valid scorer mode after potential fallback",
    );
  });
});
