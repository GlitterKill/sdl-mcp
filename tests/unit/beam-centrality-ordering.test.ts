import { describe, it } from "node:test";
import assert from "node:assert";
import type { SymbolRow, EdgeRow, MetricsRow, FileRow } from "../../dist/db/schema.js";
import type { SliceBudget } from "../../dist/mcp/types.js";
import type { Graph } from "../../dist/graph/buildGraph.js";

function createSymbol(
  id: string,
  name: string,
): SymbolRow {
  return {
    symbol_id: id,
    repo_id: "repo",
    file_id: 1,
    kind: "function",
    name,
    exported: 1,
    visibility: "public",
    language: "ts",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 5,
    range_end_col: 0,
    ast_fingerprint: `${id}-fp`,
    signature_json: null,
    summary: null,
    invariants_json: null,
    side_effects_json: null,
    updated_at: new Date().toISOString(),
  };
}

function createEdge(from: string, to: string): EdgeRow {
  return {
    repo_id: "repo",
    from_symbol_id: from,
    to_symbol_id: to,
    type: "call",
    weight: 1,
    provenance: null,
    created_at: new Date().toISOString(),
    confidence: 1,
  };
}

function createMetrics(
  pageRank: number,
  kCore: number,
): MetricsRow {
  return {
    symbol_id: "",
    fan_in: 1,
    fan_out: 1,
    churn_30d: 0,
    test_refs_json: null,
    canonical_test_json: null,
    page_rank: pageRank,
    k_core: kCore,
    updated_at: new Date().toISOString(),
  };
}

function createGraph(): Graph {
  const symbols = new Map<string, SymbolRow>([
    ["entry", createSymbol("entry", "entry")],
    ["high", createSymbol("high", "candidateAlpha")],
    ["low", createSymbol("low", "candidateBeta")],
  ]);
  const adjacencyOut = new Map<string, EdgeRow[]>([
    ["entry", [createEdge("entry", "high"), createEdge("entry", "low")]],
  ]);
  const adjacencyIn = new Map<string, EdgeRow[]>([
    ["high", [createEdge("entry", "high")]],
    ["low", [createEdge("entry", "low")]],
  ]);
  const files = new Map<number, FileRow>([
    [
      1,
      {
        file_id: 1,
        repo_id: "repo",
        rel_path: "src/candidate.ts",
        content_hash: "hash",
        language: "ts",
        byte_size: 100,
        last_indexed_at: null,
        directory: "src",
      },
    ],
  ]);
  const metrics = new Map<string, MetricsRow>([
    ["high", { ...createMetrics(1, 10), symbol_id: "high" }],
    ["low", { ...createMetrics(0.1, 1), symbol_id: "low" }],
  ]);

  return {
    symbols,
    adjacencyOut,
    adjacencyIn,
    files,
    metrics,
  } as unknown as Graph;
}

describe("beam search centrality ordering", () => {
  it("prefers the higher-centrality neighbor when primary scores tie", async () => {
    const { beamSearch, beamSearchAsync, getScorerPool, resetScorerPool } =
      await import("../../dist/graph/slice/beam-search-engine.js");

    const graph = createGraph();
    const budget: Required<SliceBudget> = {
      maxCards: 2,
      maxEstimatedTokens: 10_000,
    };
    const request = {
      entrySymbols: ["entry"],
      taskText: "candidate",
    };
    const edgeWeights = { call: 1.0, import: 0.6, config: 0.8 };
    const startNodes = [{ symbolId: "entry", source: "entrySymbol" as const }];

    const sequential = beamSearch(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
    );
    assert.ok(sequential.sliceCards.has("high"));
    assert.ok(!sequential.sliceCards.has("low"));

    resetScorerPool();
    const parallel = await beamSearchAsync(
      graph,
      startNodes,
      budget,
      request,
      edgeWeights,
      0.5,
      { parallelScorer: { enabled: true, poolSize: 1, minBatchSize: 1 } },
    );
    assert.ok(parallel.sliceCards.has("high"));
    assert.ok(!parallel.sliceCards.has("low"));

    const pool = getScorerPool();
    await pool.shutdown();
    resetScorerPool();
  });
});
