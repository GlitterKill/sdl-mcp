/**
 * Integration tests for canonical test computation and persistence (T4-C).
 *
 * Uses a real temp DB (via SDL_DB_PATH) and tests at the
 * computeCanonicalTest + getCanonicalTest layer, plus the full
 * upsertMetrics → getCanonicalTest round-trip.
 *
 * All 4 scenarios:
 *   1. Closest test file selected via BFS
 *   2. Re-indexing recomputes and persists updated canonical test
 *   3. Multiple test paths — closest wins
 *   4. Private/unexported symbol with no test edges — returns null
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";

import { getDb } from "../../src/db/db.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  upsertMetrics,
  getCanonicalTest,
  getMetrics,
} from "../../src/db/queries.js";
import { computeCanonicalTest } from "../../src/graph/metrics.js";
import type { Graph } from "../../src/graph/buildGraph.js";
import type { SymbolRow, EdgeRow } from "../../src/db/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ID = "test-canonical-test-integration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextFileId = 100_000; // start high to avoid collisions

function nextFileId(): number {
  return _nextFileId++;
}

function makeSymbol(id: string, fileId: number): SymbolRow {
  return {
    symbol_id: id,
    repo_id: REPO_ID,
    file_id: fileId,
    kind: "function",
    name: id,
    exported: 1,
    visibility: "public",
    language: "typescript",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 10,
    range_end_col: 1,
    ast_fingerprint: `fp-${id}`,
    signature_json: null,
    summary: null,
    invariants_json: null,
    side_effects_json: null,
    updated_at: new Date().toISOString(),
  };
}

function makeEdge(from: string, to: string): EdgeRow {
  return {
    repo_id: REPO_ID,
    from_symbol_id: from,
    to_symbol_id: to,
    type: "call",
    weight: 1.0,
    provenance: null,
    created_at: new Date().toISOString(),
    confidence: 1.0,
    resolution_strategy: "exact",
  };
}

interface SymbolDef {
  id: string;
  relPath: string;
}

interface EdgeDef {
  from: string;
  to: string;
}

/**
 * Build a minimal in-memory Graph from symbol/edge definitions.
 * Does NOT write anything to the DB — suitable for pure BFS tests.
 */
function buildInMemoryGraph(
  symbolDefs: SymbolDef[],
  edgeDefs: EdgeDef[],
): { graph: Graph; fileById: Map<number, string> } {
  const fileById = new Map<number, string>();
  const pathToFileId = new Map<string, number>();

  for (const def of symbolDefs) {
    if (!pathToFileId.has(def.relPath)) {
      const fid = nextFileId();
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
    if (!adjacencyIn.has(e.to)) adjacencyIn.set(e.to, []);
    const inList = adjacencyIn.get(e.to);
    if (inList) inList.push(edge);
  }

  const graph: Graph = {
    repoId: REPO_ID,
    symbols,
    edges,
    adjacencyIn,
    adjacencyOut,
  };

  return { graph, fileById };
}

/**
 * Insert a symbol and its metrics row into the real DB for persistence tests.
 */
function insertSymbolAndMetrics(params: {
  symbolId: string;
  relPath: string;
  canonicalTestJson?: string | null;
}): void {
  const db = getDb();

  // Ensure repo exists
  const repoExists = db
    .prepare("SELECT 1 FROM repos WHERE repo_id = ?")
    .get(REPO_ID);
  if (!repoExists) {
    db.prepare(
      "INSERT INTO repos (repo_id, root_path, config_json, created_at) VALUES (?, ?, ?, datetime('now'))",
    ).run(REPO_ID, "/tmp/test-canonical-integration", "{}");
  }

  // Ensure file exists
  const fileRow = db
    .prepare("SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?")
    .get(REPO_ID, params.relPath) as { file_id: number } | null;

  let fileId: number;
  if (fileRow) {
    fileId = fileRow.file_id;
  } else {
    const insertFile = db.prepare(
      `INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
    );
    const r = insertFile.run(
      REPO_ID,
      params.relPath,
      `hash-${params.relPath}`,
      "ts",
      100,
      params.relPath.includes("/") ? params.relPath.split("/")[0] : ".",
    );
    fileId = Number(r.lastInsertRowid);
  }

  // Upsert symbol
  db.prepare(
    `INSERT INTO symbols (
       symbol_id, repo_id, file_id, kind, name, exported, visibility,
       signature_json, summary, invariants_json, side_effects_json,
       ast_fingerprint, range_start_line, range_start_col, range_end_line, range_end_col,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol_id) DO UPDATE SET
       file_id = excluded.file_id,
       updated_at = excluded.updated_at`,
  ).run(
    params.symbolId,
    REPO_ID,
    fileId,
    "function",
    params.symbolId,
    1,
    "public",
    null,
    null,
    null,
    null,
    `fp-${params.symbolId}`,
    1,
    0,
    10,
    1,
  );

  // Upsert metrics
  upsertMetrics({
    symbolId: params.symbolId,
    fanIn: 0,
    fanOut: 0,
    churn30d: 0,
    testRefsJson: JSON.stringify([]),
    canonicalTestJson: params.canonicalTestJson ?? null,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("canonical test integration (T4-C)", () => {
  before(() => {
    const db = getDb();
    runMigrations(db);

    // Clean up any data from previous runs
    db.exec(`DELETE FROM metrics  WHERE symbol_id LIKE 'ct-integ-%'`);
    db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
    db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
    db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
  });

  after(() => {
    const db = getDb();
    db.exec(`DELETE FROM metrics  WHERE symbol_id LIKE 'ct-integ-%'`);
    db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
    db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
    db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
  });

  // -------------------------------------------------------------------------
  // Test 1: Closest test file is selected via BFS
  // -------------------------------------------------------------------------
  it("Test 1: closest test file is selected (distance=1 direct edge A→B.test.ts)", () => {
    const symA = "ct-integ-sym-A";
    const symB = "ct-integ-sym-B";

    const { graph, fileById } = buildInMemoryGraph(
      [
        { id: symA, relPath: "src/util.ts" },
        { id: symB, relPath: "tests/util.test.ts" },
      ],
      [{ from: symA, to: symB }],
    );

    const result = computeCanonicalTest(symA, graph, fileById);

    assert.ok(result !== null, "should find a canonical test");
    assert.strictEqual(
      result.file,
      "tests/util.test.ts",
      "canonical test file should be tests/util.test.ts",
    );
    assert.strictEqual(result.distance, 1, "distance should be 1");
    assert.ok(
      Math.abs(result.proximity - 0.5) < 1e-9,
      `proximity should be 0.5 (1/(1+1)), got ${result.proximity}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Re-indexing recomputes canonical test (persistence round-trip)
  // -------------------------------------------------------------------------
  it("Test 2: upsertMetrics with new canonicalTestJson overwrites stored value", () => {
    const symId = "ct-integ-reindex-sym";

    // Insert initial record with an old canonical test
    insertSymbolAndMetrics({
      symbolId: symId,
      relPath: "src/old.ts",
      canonicalTestJson: JSON.stringify({
        file: "tests/old.test.ts",
        distance: 2,
        proximity: 1 / 3,
      }),
    });

    // Verify initial value is stored
    const initial = getCanonicalTest(symId);
    assert.ok(initial !== null, "initial canonicalTest should be stored");
    assert.strictEqual(
      initial.file,
      "tests/old.test.ts",
      "initial file should match",
    );
    assert.strictEqual(initial.distance, 2, "initial distance should be 2");

    // Simulate re-indexing: call upsertMetrics with a new canonical test
    upsertMetrics({
      symbolId: symId,
      fanIn: 1,
      fanOut: 2,
      churn30d: 0,
      testRefsJson: JSON.stringify(["tests/new.test.ts"]),
      canonicalTestJson: JSON.stringify({
        file: "tests/new.test.ts",
        distance: 1,
        proximity: 0.5,
      }),
      updatedAt: new Date().toISOString(),
    });

    // Verify updated value
    const updated = getCanonicalTest(symId);
    assert.ok(updated !== null, "updated canonicalTest should be stored");
    assert.strictEqual(
      updated.file,
      "tests/new.test.ts",
      "updated file should match",
    );
    assert.strictEqual(updated.distance, 1, "updated distance should be 1");
    assert.ok(
      Math.abs(updated.proximity - 0.5) < 1e-9,
      `updated proximity should be 0.5, got ${updated.proximity}`,
    );

    // Also verify via getMetrics that canonical_test_json is updated
    const metricsRow = getMetrics(symId);
    assert.ok(metricsRow !== null, "metrics row should exist");
    assert.ok(
      metricsRow.canonical_test_json !== null,
      "canonical_test_json should be non-null",
    );
    const parsedJson = JSON.parse(metricsRow.canonical_test_json!) as {
      file: string;
    };
    assert.strictEqual(
      parsedJson.file,
      "tests/new.test.ts",
      "raw JSON in metrics should reflect updated file",
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Multiple test paths — closest distance wins
  // -------------------------------------------------------------------------
  it("Test 3: multiple test paths — symbol at distance 1 wins over distance 2", () => {
    const symU = "ct-integ-multi-U";
    const symIntermediate = "ct-integ-multi-I";
    const symTestNear = "ct-integ-multi-near";
    const symTestFar = "ct-integ-multi-far";

    const { graph, fileById } = buildInMemoryGraph(
      [
        { id: symU, relPath: "src/util.ts" },
        { id: symIntermediate, relPath: "src/intermediate.ts" },
        { id: symTestNear, relPath: "tests/a.test.ts" },
        { id: symTestFar, relPath: "tests/b.test.ts" },
      ],
      [
        // U → TestNear (distance 1)
        { from: symU, to: symTestNear },
        // U → Intermediate → TestFar (distance 2)
        { from: symU, to: symIntermediate },
        { from: symIntermediate, to: symTestFar },
      ],
    );

    const result = computeCanonicalTest(symU, graph, fileById);

    assert.ok(result !== null, "should find a canonical test");
    assert.strictEqual(
      result.distance,
      1,
      "closest test (distance=1) should be selected",
    );
    assert.strictEqual(
      result.file,
      "tests/a.test.ts",
      "nearest test file (tests/a.test.ts) should win",
    );
    assert.ok(
      Math.abs(result.proximity - 0.5) < 1e-9,
      `proximity should be 0.5 for distance=1, got ${result.proximity}`,
    );
  });

  // -------------------------------------------------------------------------
  // Test 4: Symbol with no edges to any test file — returns null
  // -------------------------------------------------------------------------
  it("Test 4: symbol with no test edges returns null from computeCanonicalTest", () => {
    const symPrivate = "ct-integ-private-sym";

    // Build a graph with a symbol that only connects to non-test files
    const { graph, fileById } = buildInMemoryGraph(
      [
        { id: symPrivate, relPath: "src/internal.ts" },
        { id: "ct-integ-helper", relPath: "src/helper.ts" },
      ],
      [
        // Only edges to non-test files
        { from: symPrivate, to: "ct-integ-helper" },
      ],
    );

    const result = computeCanonicalTest(symPrivate, graph, fileById);

    assert.strictEqual(
      result,
      null,
      "should return null when no test files are reachable",
    );
  });

  // -------------------------------------------------------------------------
  // Test 4b: Empty graph (no edges at all) — returns null
  // -------------------------------------------------------------------------
  it("Test 4b: isolated symbol with no edges returns null", () => {
    const symIsolated = "ct-integ-isolated-sym";

    const { graph, fileById } = buildInMemoryGraph(
      [{ id: symIsolated, relPath: "src/standalone.ts" }],
      [],
    );

    const result = computeCanonicalTest(symIsolated, graph, fileById);

    assert.strictEqual(result, null, "should return null for isolated symbol");
  });

  // -------------------------------------------------------------------------
  // Test 5: Persistence — getCanonicalTest returns null when not set
  // -------------------------------------------------------------------------
  it("Test 5: getCanonicalTest returns null when canonical_test_json is null", () => {
    const symNoTest = "ct-integ-no-test-sym";

    insertSymbolAndMetrics({
      symbolId: symNoTest,
      relPath: "src/private.ts",
      canonicalTestJson: null,
    });

    const result = getCanonicalTest(symNoTest);
    assert.strictEqual(
      result,
      null,
      "getCanonicalTest should return null when canonical_test_json is null",
    );
  });

  // -------------------------------------------------------------------------
  // Test 6: Proximity formula is deterministic for each distance value
  // -------------------------------------------------------------------------
  it("Test 6: proximity values are deterministic — 1/(1+distance)", () => {
    const scenarios: Array<{
      distance: number;
      expectedProximity: number;
      defs: SymbolDef[];
      edges: EdgeDef[];
    }> = [
      {
        distance: 0,
        expectedProximity: 1.0,
        defs: [{ id: "ct-integ-prox-D0", relPath: "tests/d0.test.ts" }],
        edges: [],
      },
      {
        distance: 1,
        expectedProximity: 0.5,
        defs: [
          { id: "ct-integ-prox-D1", relPath: "src/d1.ts" },
          { id: "ct-integ-prox-D1t", relPath: "tests/d1.test.ts" },
        ],
        edges: [{ from: "ct-integ-prox-D1", to: "ct-integ-prox-D1t" }],
      },
      {
        distance: 2,
        expectedProximity: 1 / 3,
        defs: [
          { id: "ct-integ-prox-D2", relPath: "src/d2.ts" },
          { id: "ct-integ-prox-D2b", relPath: "src/d2b.ts" },
          { id: "ct-integ-prox-D2t", relPath: "tests/d2.test.ts" },
        ],
        edges: [
          { from: "ct-integ-prox-D2", to: "ct-integ-prox-D2b" },
          { from: "ct-integ-prox-D2b", to: "ct-integ-prox-D2t" },
        ],
      },
    ];

    for (const scenario of scenarios) {
      const { graph, fileById } = buildInMemoryGraph(
        scenario.defs,
        scenario.edges,
      );
      const entryId = scenario.defs[0].id;
      const result = computeCanonicalTest(entryId, graph, fileById);

      assert.ok(result !== null, `distance=${scenario.distance}: should find test`);
      assert.strictEqual(
        result.distance,
        scenario.distance,
        `distance should be ${scenario.distance}`,
      );
      assert.ok(
        Math.abs(result.proximity - scenario.expectedProximity) < 1e-9,
        `distance=${scenario.distance}: proximity should be ${scenario.expectedProximity}, got ${result.proximity}`,
      );
    }
  });
});
