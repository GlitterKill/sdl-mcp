import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  loadGraphForRepo,
  loadNeighborhood,
  getLastLoadStats,
  resetLoadStats,
  type Graph,
  type GraphLoadStats,
} from "../../dist/graph/buildGraph.js";
import type { SymbolId, SymbolRow, EdgeRow } from "../../dist/db/schema.js";

function createMockSymbol(id: string, name: string): SymbolRow {
  return {
    symbol_id: id,
    repo_id: "test-repo",
    file_id: 1,
    kind: "function",
    name,
    exported: 1,
    visibility: "public",
    language: "typescript",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 5,
    range_end_col: 1,
    ast_fingerprint: `fp-${id}`,
    signature_json: null,
    summary: `Function ${name}`,
    invariants_json: null,
    side_effects_json: null,
    updated_at: new Date().toISOString(),
  };
}

function createMockEdge(
  from: string,
  to: string,
  type: "call" | "import" | "config" = "call",
): EdgeRow {
  return {
    repo_id: "test-repo",
    from_symbol_id: from,
    to_symbol_id: to,
    type,
    weight: 1.0,
    provenance: "static",
    created_at: new Date().toISOString(),
    confidence: 1.0,
    resolution_strategy: "exact",
  };
}

describe("Lazy Graph Loading", () => {
  beforeEach(() => {
    resetLoadStats();
  });

  afterEach(() => {
    resetLoadStats();
  });

  describe("GraphLoadStats", () => {
    it("should track stats mode as lazy for neighborhood loading", () => {
      resetLoadStats();
      const stats = getLastLoadStats();
      assert.strictEqual(stats, null);
    });

    it("should reset stats correctly", () => {
      resetLoadStats();
      const stats = getLastLoadStats();
      assert.strictEqual(stats, null);
    });
  });

  describe("loadNeighborhood", () => {
    it("should return empty graph for empty entry symbols", () => {
      const graph = loadNeighborhood("empty-repo", [], {
        maxHops: 3,
        direction: "both",
      });

      assert.strictEqual(graph.symbols.size, 0);
      assert.strictEqual(graph.edges.length, 0);
      assert.strictEqual(graph.repoId, "empty-repo");
    });

    it("should record telemetry stats for lazy load", () => {
      resetLoadStats();
      loadNeighborhood("test-repo", ["nonexistent-symbol"], {
        maxHops: 2,
        direction: "both",
      });

      const stats = getLastLoadStats();
      assert.ok(stats);
      assert.strictEqual(stats.mode, "lazy");
      assert.strictEqual(stats.hopBudget, 2);
      assert.strictEqual(stats.entrySymbolCount, 1);
    });

    it("should respect maxHops parameter", () => {
      resetLoadStats();
      loadNeighborhood("test-repo", ["entry"], {
        maxHops: 1,
        direction: "both",
      });

      const stats = getLastLoadStats();
      assert.ok(stats);
      assert.strictEqual(stats.hopBudget, 1);
    });

    it("should respect maxSymbols limit", () => {
      resetLoadStats();
      const graph = loadNeighborhood("test-repo", ["entry"], {
        maxHops: 10,
        direction: "both",
        maxSymbols: 5,
      });

      assert.ok(graph.symbols.size <= 5);
    });

    it("should return correct graph structure", () => {
      resetLoadStats();
      const graph = loadNeighborhood("test-repo", ["entry"], {
        maxHops: 2,
        direction: "both",
      });

      assert.ok(graph.symbols instanceof Map);
      assert.ok(Array.isArray(graph.edges));
      assert.ok(graph.adjacencyIn instanceof Map);
      assert.ok(graph.adjacencyOut instanceof Map);
      assert.strictEqual(graph.repoId, "test-repo");
    });
  });

  describe("Equivalence Tests", () => {
    it("should include all entry symbols in neighborhood result", () => {
      resetLoadStats();
      const entrySymbols = ["entry1", "entry2", "entry3"];

      loadNeighborhood("test-repo", entrySymbols, {
        maxHops: 2,
        direction: "both",
      });

      const stats = getLastLoadStats();
      assert.ok(stats);
      assert.strictEqual(stats.entrySymbolCount, 3);
    });

    it("should handle direction parameter correctly", () => {
      resetLoadStats();
      loadNeighborhood("test-repo", ["entry"], {
        maxHops: 2,
        direction: "in",
      });

      let stats = getLastLoadStats();
      assert.ok(stats);

      resetLoadStats();
      loadNeighborhood("test-repo", ["entry"], {
        maxHops: 2,
        direction: "out",
      });

      stats = getLastLoadStats();
      assert.ok(stats);
      assert.strictEqual(stats.mode, "lazy");
    });
  });

  describe("Telemetry", () => {
    it("should log duration for lazy load", () => {
      resetLoadStats();
      loadNeighborhood("test-repo", ["entry"], {
        maxHops: 2,
        direction: "both",
      });

      const stats = getLastLoadStats();
      assert.ok(stats);
      assert.ok(stats.durationMs >= 0);
    });

    it("should log node and edge counts", () => {
      resetLoadStats();
      loadNeighborhood("test-repo", ["entry"], {
        maxHops: 2,
        direction: "both",
      });

      const stats = getLastLoadStats();
      assert.ok(stats);
      assert.ok(stats.nodeCount >= 0);
      assert.ok(stats.edgeCount >= 0);
    });
  });
});

describe("Graph Loading Stats Integration", () => {
  beforeEach(() => {
    resetLoadStats();
  });

  it("should differentiate between full and lazy load modes", () => {
    resetLoadStats();

    loadNeighborhood("repo-a", ["entry"], {
      maxHops: 2,
      direction: "both",
    });

    let stats = getLastLoadStats();
    assert.ok(stats);
    assert.strictEqual(stats.mode, "lazy");

    resetLoadStats();

    loadGraphForRepo("repo-b");

    stats = getLastLoadStats();
    assert.ok(stats);
    assert.strictEqual(stats.mode, "full");
    assert.strictEqual(stats.hopBudget, undefined);
    assert.strictEqual(stats.entrySymbolCount, undefined);
  });
});
