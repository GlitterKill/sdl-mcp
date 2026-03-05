import { describe, it } from "node:test";
import assert from "node:assert";
import { computeCanonicalTest } from "../../src/graph/metrics.js";
import type { Graph } from "../../src/graph/metrics.js";
import type { SymbolRow, EdgeRow } from "../../src/db/kuzu-queries.js";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

let nextFileId = 1;

function makeSymbol(
  id: string,
  fileId: string,
): SymbolRow {
  return {
    symbolId: id,
    repoId: "test-repo",
    fileId,
    kind: "function",
    name: id,
    exported: true,
    visibility: "public",
    language: "typescript",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 10,
    rangeEndCol: 1,
    astFingerprint: `fp-${id}`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: new Date().toISOString(),
  };
}

function makeEdge(from: string, to: string): EdgeRow {
  return {
    repoId: "test-repo",
    fromSymbolId: from,
    toSymbolId: to,
    edgeType: "call",
    weight: 1.0,
    confidence: 1.0,
    resolution: "exact",
    provenance: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a minimal Graph from a list of symbol-id/relPath pairs and edges.
 * Returns both the Graph and the fileById map needed by computeCanonicalTest.
 */
function buildGraph(
  symbolDefs: Array<{ id: string; relPath: string }>,
  edgeDefs: Array<{ from: string; to: string }>,
): { graph: Graph; fileById: Map<string, string> } {
  const fileById = new Map<string, string>();
  const pathToFileId = new Map<string, string>();

  // Assign file IDs — multiple symbols can share the same file
  for (const def of symbolDefs) {
    if (!pathToFileId.has(def.relPath)) {
      const fid = `f${nextFileId++}`;
      pathToFileId.set(def.relPath, fid);
      fileById.set(fid, def.relPath);
    }
  }

  const symbols = new Map<string, SymbolRow>();
  for (const def of symbolDefs) {
    const fileId = pathToFileId.get(def.relPath)!;
    symbols.set(def.id, makeSymbol(def.id, fileId));
  }

  const adjacencyOut = new Map<string, EdgeRow[]>();
  const adjacencyIn = new Map<string, EdgeRow[]>();
  for (const def of symbolDefs) {
    adjacencyOut.set(def.id, []);
    adjacencyIn.set(def.id, []);
  }

  const edges: EdgeRow[] = [];
  for (const e of edgeDefs) {
    const edge = makeEdge(e.from, e.to);
    edges.push(edge);
    const outList = adjacencyOut.get(e.from);
    if (outList) outList.push(edge);
    // Ensure adjacencyIn entry exists for target even if it wasn't in symbolDefs
    if (!adjacencyIn.has(e.to)) adjacencyIn.set(e.to, []);
    const inList = adjacencyIn.get(e.to);
    if (inList) inList.push(edge);
  }

  const graph: Graph = {
    repoId: "test-repo",
    symbols,
    edges,
    adjacencyIn,
    adjacencyOut,
  };

  return { graph, fileById };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCanonicalTest BFS", () => {
  describe("basic path finding", () => {
    it("finds a test node via forward BFS (A → B → test_B.test.ts)", () => {
      // A calls B, B is in test_B.test.ts
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "tests/test_B.test.ts" },
        ],
        [{ from: "A", to: "B" }],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null, "should find a test node");
      assert.strictEqual(result.distance, 1, "distance should be 1 hop");
      assert.ok(
        result.file.includes("test_B.test.ts"),
        `file should be the test file, got: ${result.file}`,
      );
    });

    it("returns distance=2 when test is two hops away (A → B → C.test.ts)", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "C", relPath: "src/c.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null, "should find a test node");
      assert.strictEqual(result.distance, 2, "distance should be 2 hops");
    });

    it("finds a test node via backward BFS (test calls A)", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "tests/a.spec.ts" },
        ],
        [{ from: "T", to: "A" }], // T calls A (backward from A's perspective)
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null, "should find the test node via backward BFS");
      assert.strictEqual(result.distance, 1, "distance should be 1 hop");
      assert.ok(
        result.file.includes("a.spec.ts"),
        `file should be the spec file, got: ${result.file}`,
      );
    });
  });

  describe("ranking: shorter distance wins", () => {
    it("returns the closer test when two test paths of different lengths exist", () => {
      // A → B → FarTest.test.ts (distance 2)
      // A → NearTest.test.ts (distance 1)
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "NearTest", relPath: "tests/near.test.ts" },
          { id: "FarTest", relPath: "tests/far.test.ts" },
        ],
        [
          { from: "A", to: "NearTest" },
          { from: "A", to: "B" },
          { from: "B", to: "FarTest" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null, "should find a test node");
      assert.strictEqual(result.distance, 1, "shorter path should win");
      assert.ok(
        result.file.includes("near.test.ts"),
        `nearer test should win, got: ${result.file}`,
      );
    });
  });

  describe("cyclic graph handling", () => {
    it("terminates and returns null when A → B → A cycle with no test nodes", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "A" }, // creates cycle
        ],
      );

      // Should not throw or hang
      const result = computeCanonicalTest("A", graph, fileById);
      assert.strictEqual(result, null, "should return null with no test nodes");
    });

    it("terminates and finds test even in a graph with cycles", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "T", relPath: "src/a.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "A" }, // cycle
          { from: "A", to: "T" }, // test is reachable
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null, "should find test node despite cycle");
      assert.strictEqual(result.distance, 1);
    });
  });

  describe("no test nodes reachable", () => {
    it("returns null when no test files are reachable", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "C", relPath: "src/c.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.strictEqual(result, null, "should return null");
    });

    it("returns null for an isolated symbol with no edges", () => {
      const { graph, fileById } = buildGraph(
        [{ id: "A", relPath: "src/a.ts" }],
        [],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.strictEqual(result, null, "should return null for isolated symbol");
    });
  });

  describe("proximity math", () => {
    it("proximity = 1.0 for distance=0 (symbol IS a test)", () => {
      const { graph, fileById } = buildGraph(
        [{ id: "T", relPath: "tests/t.test.ts" }],
        [],
      );

      const result = computeCanonicalTest("T", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 0);
      assert.strictEqual(result.proximity, 1.0);
    });

    it("proximity = 0.5 for distance=1 (1/(1+1))", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "tests/t.test.ts" },
        ],
        [{ from: "A", to: "T" }],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 1);
      assert.ok(
        Math.abs(result.proximity - 0.5) < 1e-9,
        `proximity should be 0.5, got ${result.proximity}`,
      );
    });

    it("proximity = 1/3 for distance=2 (1/(1+2))", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "T", relPath: "tests/t.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "T" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 2);
      const expected = 1 / 3;
      assert.ok(
        Math.abs(result.proximity - expected) < 1e-9,
        `proximity should be 1/3 (~${expected.toFixed(4)}), got ${result.proximity}`,
      );
    });

    it("proximity = 1/4 for distance=3 (1/(1+3))", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "C", relPath: "src/c.ts" },
          { id: "T", relPath: "tests/t.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
          { from: "C", to: "T" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 3);
      const expected = 1 / 4;
      assert.ok(
        Math.abs(result.proximity - expected) < 1e-9,
        `proximity should be 0.25, got ${result.proximity}`,
      );
    });

    it("proximity = 1/5 for distance=4 (1/(1+4))", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "C", relPath: "src/c.ts" },
          { id: "D", relPath: "src/d.ts" },
          { id: "T", relPath: "tests/t.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
          { from: "C", to: "D" },
          { from: "D", to: "T" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 4);
      const expected = 1 / 5;
      assert.ok(
        Math.abs(result.proximity - expected) < 1e-9,
        `proximity should be 0.2, got ${result.proximity}`,
      );
    });

    it("proximity = 1/6 for distance=5 (1/(1+5))", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
          { id: "C", relPath: "src/c.ts" },
          { id: "D", relPath: "src/d.ts" },
          { id: "E", relPath: "src/e.ts" },
          { id: "T", relPath: "tests/t.test.ts" },
        ],
        [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
          { from: "C", to: "D" },
          { from: "D", to: "E" },
          { from: "E", to: "T" },
        ],
      );

      const result = computeCanonicalTest("A", graph, fileById);
      assert.ok(result !== null);
      assert.strictEqual(result.distance, 5);
      const expected = 1 / 6;
      assert.ok(
        Math.abs(result.proximity - expected) < 1e-9,
        `proximity should be ~0.1667, got ${result.proximity}`,
      );
    });
  });

  describe("test file pattern matching", () => {
    it("recognizes *.test.ts pattern", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "src/a.test.ts" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("recognizes *.test.js pattern", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "src/a.test.js" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("recognizes *.spec.ts pattern", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "src/a.spec.ts" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("recognizes *.spec.js pattern", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "src/a.spec.js" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("recognizes files under tests/ directory", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "tests/a-test.ts" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("recognizes files under __tests__/ directory", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "T", relPath: "__tests__/a.ts" },
        ],
        [{ from: "A", to: "T" }],
      );
      assert.ok(computeCanonicalTest("A", graph, fileById) !== null);
    });

    it("does NOT match plain source files", () => {
      const { graph, fileById } = buildGraph(
        [
          { id: "A", relPath: "src/a.ts" },
          { id: "B", relPath: "src/b.ts" },
        ],
        [{ from: "A", to: "B" }],
      );
      assert.strictEqual(computeCanonicalTest("A", graph, fileById), null);
    });
  });
});
