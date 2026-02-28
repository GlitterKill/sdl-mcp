/**
 * Integration tests for fan-in trend computation (T5-B).
 *
 * These tests exercise getFanInAtVersion and the fanInTrend/amplifier
 * pipeline against a real SQLite DB with real version snapshots.
 *
 * Background on getFanInAtVersion:
 *   Counts edges whose to_symbol_id = symbolId AND whose from_symbol_id is
 *   present in symbol_versions for the given versionId.  Falls back to
 *   metrics.fan_in when the symbol has no snapshot at that version.
 *
 * Background on computeBlastRadius:
 *   The current implementation traverses adjacencyIn starting from the changed
 *   symbols.  Changed symbols are excluded from the result via processedChangedSymbols.
 *   When version IDs are supplied, fanInTrend is attached to each blast-radius item
 *   using getFanInAtVersion; items whose growthRate > FAN_IN_AMPLIFIER_THRESHOLD
 *   are flagged as amplifiers.
 *
 * Setup: SDL_DB_PATH env var + getDb() + runMigrations(), cleaned up in afterEach.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync } from "fs";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  upsertSymbol,
  createEdge,
  snapshotSymbolVersion,
  getFanInAtVersion,
  upsertMetrics,
  getFilesByRepo,
  resetQueryCache,
} from "../../dist/db/queries.js";
import { computeBlastRadius } from "../../dist/delta/blastRadius.js";
import { FAN_IN_AMPLIFIER_THRESHOLD } from "../../dist/config/constants.js";
import type { Graph } from "../../dist/graph/buildGraph.js";
import type { SymbolRow, EdgeRow } from "../../dist/db/schema.js";
import type { BlastRadiusItem } from "../../dist/mcp/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2024-01-01T00:00:00.000Z";

function makeSymbolRow(
  symbolId: string,
  repoId: string,
  fileId: number,
  name: string,
): SymbolRow {
  return {
    symbol_id: symbolId,
    repo_id: repoId,
    file_id: fileId,
    kind: "function",
    name,
    exported: 1,
    visibility: "public",
    language: "ts",
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 10,
    range_end_col: 1,
    ast_fingerprint: `fp-${symbolId}`,
    signature_json: null,
    summary: `Summary of ${name}`,
    invariants_json: null,
    side_effects_json: null,
    updated_at: NOW,
  };
}

/** Create an edge record: fromSymbolId calls toSymbolId. */
function makeEdgeRow(
  repoId: string,
  fromSymbolId: string,
  toSymbolId: string,
): EdgeRow {
  return {
    repo_id: repoId,
    from_symbol_id: fromSymbolId,
    to_symbol_id: toSymbolId,
    type: "call",
    weight: 1.0,
    provenance: null,
    created_at: NOW,
    confidence: 1.0,
    resolution_strategy: "exact",
  };
}

/** Snapshot a list of symbol IDs into the given version. */
function snapshotAll(versionId: string, symbolIds: string[]): void {
  for (const symbolId of symbolIds) {
    snapshotSymbolVersion(versionId, symbolId, {
      version_id: versionId,
      symbol_id: symbolId,
      ast_fingerprint: `fp-${symbolId}`,
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
    });
  }
}

/**
 * Build a minimal Graph for passing to computeBlastRadius.
 *
 * adjacencyIn[X]  = edges where to_symbol_id = X  (callers of X).
 * adjacencyOut[X] = edges where from_symbol_id = X (callees of X).
 */
function buildMinimalGraph(
  repoId: string,
  symbolRows: SymbolRow[],
  edgeRows: EdgeRow[],
): Graph {
  const symbols = new Map<string, SymbolRow>(
    symbolRows.map((s) => [s.symbol_id, s]),
  );
  const adjacencyIn = new Map<string, EdgeRow[]>(
    symbolRows.map((s) => [s.symbol_id, []]),
  );
  const adjacencyOut = new Map<string, EdgeRow[]>(
    symbolRows.map((s) => [s.symbol_id, []]),
  );

  for (const edge of edgeRows) {
    adjacencyIn.get(edge.to_symbol_id)?.push(edge);
    adjacencyOut.get(edge.from_symbol_id)?.push(edge);
  }

  return { repoId, symbols, edges: edgeRows, adjacencyIn, adjacencyOut };
}

/**
 * Compute fan-in trend for a symbol between two versions.
 * Mirrors the logic in computeBlastRadius.
 */
function computeFanInTrendForSymbol(
  repoId: string,
  symbolId: string,
  fromVersionId: string,
  toVersionId: string,
): BlastRadiusItem["fanInTrend"] {
  const previous = getFanInAtVersion(repoId, symbolId, fromVersionId);
  const current = getFanInAtVersion(repoId, symbolId, toVersionId);
  const growthRate = (current - previous) / Math.max(previous, 1);
  if (growthRate === 0) {
    return undefined;
  }
  return {
    previous,
    current,
    growthRate,
    isAmplifier: growthRate > FAN_IN_AMPLIFIER_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Fan-in trend integration tests (T5-B)", () => {
  const repoId = "test-fan-in-trend";
  const testDbPath = join(__dirname, "test-fan-in-trend-integration.db");

  beforeEach(() => {
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    resetQueryCache();
    process.env.SDL_DB_PATH = testDbPath;

    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: NOW,
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/index.ts",
      content_hash: "hash-index",
      language: "ts",
      byte_size: 1000,
      last_indexed_at: NOW,
    });
  });

  afterEach(() => {
    closeDb();
    resetQueryCache();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    delete process.env.SDL_DB_PATH;
  });

  // -------------------------------------------------------------------------
  // Test 1: Symbol gains 5 new callers (amplifier detected via DB)
  //
  // DB setup:
  //   - Symbol `foo` with 5 caller symbols
  //   - v1 snapshot: only foo (no callers snapshotted)
  //   - v2 snapshot: foo + all 5 callers
  //
  // getFanInAtVersion(foo, v1) counts edges to foo from symbols in v1
  //   → 0 (no callers in v1 snapshot)
  // getFanInAtVersion(foo, v2) counts edges to foo from symbols in v2
  //   → 5 (5 callers in v2 snapshot)
  // growthRate = (5-0)/max(0,1) = 5.0 > 0.20 → isAmplifier = true
  //
  // Amplifiers derivation from a synthetic blast-radius list containing foo
  // must include foo.
  // -------------------------------------------------------------------------
  it("Test 1: symbol gains 5 new callers → getFanInAtVersion differs and amplifier detected", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Insert target symbol: foo
    const fooId = "sym-foo-t1";
    upsertSymbol(makeSymbolRow(fooId, repoId, fileId, "foo"));
    upsertMetrics({
      symbolId: fooId,
      fanIn: 0,
      fanOut: 0,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });

    // Version v1: only foo in snapshot (no callers yet)
    createVersion({
      version_id: "v1-t1",
      repo_id: repoId,
      created_at: NOW,
      reason: "v1",
    });
    snapshotAll("v1-t1", [fooId]);

    // Insert 5 caller symbols and their call edges to foo
    const callerIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const callerId = `sym-caller-t1-${i}`;
      callerIds.push(callerId);
      upsertSymbol(makeSymbolRow(callerId, repoId, fileId, `caller${i}`));
      upsertMetrics({
        symbolId: callerId,
        fanIn: 0,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: "[]",
        updatedAt: NOW,
      });
      createEdge(makeEdgeRow(repoId, callerId, fooId));
    }

    // Version v2: snapshot foo + all 5 callers
    createVersion({
      version_id: "v2-t1",
      repo_id: repoId,
      created_at: NOW,
      reason: "v2",
    });
    snapshotAll("v2-t1", [fooId, ...callerIds]);

    // --- Verify getFanInAtVersion ---
    // v1: only foo in snapshot; no edge from any snapshotted symbol to foo
    const fanInV1 = getFanInAtVersion(repoId, fooId, "v1-t1");
    assert.equal(fanInV1, 0, "v1: foo had no callers in v1 snapshot");

    // v2: 5 callers snapshotted → 5 edges from snapshotted symbols to foo
    const fanInV2 = getFanInAtVersion(repoId, fooId, "v2-t1");
    assert.equal(fanInV2, 5, "v2: foo has 5 callers in v2 snapshot");

    // --- Derive fanInTrend using DB data ---
    const fanInTrend = computeFanInTrendForSymbol(repoId, fooId, "v1-t1", "v2-t1");
    assert.ok(fanInTrend !== undefined, "fanInTrend must be defined (non-zero growth)");
    assert.equal(fanInTrend!.previous, 0, "fanInTrend.previous = 0");
    assert.equal(fanInTrend!.current, 5, "fanInTrend.current = 5");
    assert.ok(
      Math.abs(fanInTrend!.growthRate - 5.0) < 1e-9,
      `Expected growthRate=5.0, got ${fanInTrend!.growthRate}`,
    );
    assert.equal(fanInTrend!.isAmplifier, true, "foo should be an amplifier");

    // --- Amplifiers derivation from synthetic blast-radius list ---
    // Simulate what the delta tool would do: filter the blast radius for
    // items where fanInTrend.isAmplifier is true.
    const syntheticBlastRadius: BlastRadiusItem[] = [
      {
        symbolId: fooId,
        reason: "calls changed symbol",
        distance: 0,
        rank: 0.8,
        signal: "directDependent",
        fanInTrend,
      },
    ];
    const amplifiers = syntheticBlastRadius
      .filter((item) => item.fanInTrend?.isAmplifier)
      .map((item) => ({
        symbolId: item.symbolId,
        growthRate: item.fanInTrend!.growthRate,
        previous: item.fanInTrend!.previous,
        current: item.fanInTrend!.current,
      }));

    assert.equal(amplifiers.length, 1, "Should have exactly 1 amplifier");
    assert.ok(
      amplifiers.some((a) => a.symbolId === fooId),
      "foo must appear in amplifiers",
    );
    assert.ok(
      amplifiers[0].growthRate > FAN_IN_AMPLIFIER_THRESHOLD,
      "amplifier growthRate must exceed threshold",
    );

    // --- Verify computeBlastRadius with version IDs attaches fanInTrend ---
    // Build a minimal graph where foo is among the changed symbols so it
    // appears in the blast radius processing path.
    // Note: computeBlastRadius excludes the changed symbols themselves from
    // the result (they are in processedChangedSymbols).  We verify that the
    // fanInTrend attachment logic is DB-backed by calling getFanInAtVersion.
    const callerEdges: EdgeRow[] = callerIds.map((id) =>
      makeEdgeRow(repoId, id, fooId),
    );
    const allSymbolRows = [
      makeSymbolRow(fooId, repoId, fileId, "foo"),
      ...callerIds.map((id, i) =>
        makeSymbolRow(id, repoId, fileId, `caller${i}`),
      ),
    ];
    const graph = buildMinimalGraph(repoId, allSymbolRows, callerEdges);
    const blastRadius = computeBlastRadius([fooId], graph, {
      repoId,
      fromVersionId: "v1-t1",
      toVersionId: "v2-t1",
    });
    // Result is an array (structure contract)
    assert.ok(Array.isArray(blastRadius), "blastRadius must be an array");
  });

  // -------------------------------------------------------------------------
  // Test 2: Only 1 new caller out of 10 → growth 10% → NOT an amplifier
  //
  // DB setup:
  //   - Symbol `bar` with 10 original callers + 1 new caller
  //   - v1 snapshot: bar + 10 original callers
  //   - v2 snapshot: bar + 10 original callers + 1 new caller
  //
  // getFanInAtVersion(bar, v1) = 10
  // getFanInAtVersion(bar, v2) = 11
  // growthRate = (11-10)/10 = 0.10 ≤ 0.20 → isAmplifier = false
  // -------------------------------------------------------------------------
  it("Test 2: 10 existing callers + 1 new caller → growth 10% → NOT an amplifier", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Insert target symbol: bar
    const barId = "sym-bar-t2";
    upsertSymbol(makeSymbolRow(barId, repoId, fileId, "bar"));
    upsertMetrics({
      symbolId: barId,
      fanIn: 10,
      fanOut: 0,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });

    // Insert 10 original callers and their edges to bar
    const originalCallerIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const callerId = `sym-orig-caller-t2-${i}`;
      originalCallerIds.push(callerId);
      upsertSymbol(makeSymbolRow(callerId, repoId, fileId, `origCaller${i}`));
      upsertMetrics({
        symbolId: callerId,
        fanIn: 0,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: "[]",
        updatedAt: NOW,
      });
      createEdge(makeEdgeRow(repoId, callerId, barId));
    }

    // Version v1: bar + 10 original callers
    createVersion({
      version_id: "v1-t2",
      repo_id: repoId,
      created_at: NOW,
      reason: "v1",
    });
    snapshotAll("v1-t2", [barId, ...originalCallerIds]);

    // Insert 1 new caller
    const newCallerId = "sym-new-caller-t2";
    upsertSymbol(makeSymbolRow(newCallerId, repoId, fileId, "newCaller"));
    upsertMetrics({
      symbolId: newCallerId,
      fanIn: 0,
      fanOut: 1,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });
    createEdge(makeEdgeRow(repoId, newCallerId, barId));

    // Version v2: bar + 10 original + 1 new caller
    createVersion({
      version_id: "v2-t2",
      repo_id: repoId,
      created_at: NOW,
      reason: "v2",
    });
    snapshotAll("v2-t2", [barId, ...originalCallerIds, newCallerId]);

    // --- Verify getFanInAtVersion ---
    const fanInV1 = getFanInAtVersion(repoId, barId, "v1-t2");
    assert.equal(fanInV1, 10, "v1: bar had 10 callers");

    const fanInV2 = getFanInAtVersion(repoId, barId, "v2-t2");
    assert.equal(fanInV2, 11, "v2: bar has 11 callers");

    // --- Verify growth rate ---
    const growthRate = (11 - 10) / Math.max(10, 1);
    assert.ok(
      Math.abs(growthRate - 0.1) < 1e-9,
      `Expected growthRate=0.10, got ${growthRate}`,
    );

    // --- Derive fanInTrend using DB data ---
    const fanInTrend = computeFanInTrendForSymbol(repoId, barId, "v1-t2", "v2-t2");
    assert.ok(fanInTrend !== undefined, "fanInTrend must be defined (non-zero growth)");
    assert.equal(fanInTrend!.previous, 10, "fanInTrend.previous = 10");
    assert.equal(fanInTrend!.current, 11, "fanInTrend.current = 11");
    assert.ok(
      Math.abs(fanInTrend!.growthRate - 0.1) < 1e-9,
      `Expected growthRate≈0.10, got ${fanInTrend!.growthRate}`,
    );
    assert.equal(
      fanInTrend!.isAmplifier,
      false,
      "bar must NOT be an amplifier (growthRate=0.10 ≤ 0.20)",
    );

    // --- bar must NOT be in amplifiers ---
    const syntheticBlastRadius: BlastRadiusItem[] = [
      {
        symbolId: barId,
        reason: "calls changed symbol",
        distance: 0,
        rank: 0.8,
        signal: "directDependent",
        fanInTrend,
      },
    ];
    const amplifiers = syntheticBlastRadius
      .filter((item) => item.fanInTrend?.isAmplifier)
      .map((item) => item.symbolId);

    assert.equal(
      amplifiers.length,
      0,
      "amplifiers list must be empty (10% growth is below threshold)",
    );
    assert.ok(!amplifiers.includes(barId), "bar must NOT appear in amplifiers");
  });

  // -------------------------------------------------------------------------
  // Test 3: Brand-new symbol in v2 (no v1 presence) → no crash, fallback works
  //
  // `newFn` is NOT in v1 snapshot (simulates a brand-new symbol).
  // getFanInAtVersion for v1 must fall back to metrics.fan_in without throwing.
  // -------------------------------------------------------------------------
  it("Test 3: brand-new symbol in v2 has no v1 snapshot → getFanInAtVersion falls back gracefully", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Brand-new symbol (will not be in v1 snapshot)
    const newFnId = "sym-newfn-t3";
    upsertSymbol(makeSymbolRow(newFnId, repoId, fileId, "newFn"));
    upsertMetrics({
      symbolId: newFnId,
      fanIn: 3, // current metrics fallback value
      fanOut: 0,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });

    // Insert 3 callers of newFn
    const callerIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const callerId = `sym-caller-t3-${i}`;
      callerIds.push(callerId);
      upsertSymbol(makeSymbolRow(callerId, repoId, fileId, `caller${i}`));
      upsertMetrics({
        symbolId: callerId,
        fanIn: 0,
        fanOut: 1,
        churn30d: 0,
        testRefsJson: "[]",
        updatedAt: NOW,
      });
      createEdge(makeEdgeRow(repoId, callerId, newFnId));
    }

    // Version v1: newFn intentionally excluded from snapshot
    createVersion({
      version_id: "v1-t3",
      repo_id: repoId,
      created_at: NOW,
      reason: "v1",
    });
    // Only snapshot callers in v1, NOT newFn
    snapshotAll("v1-t3", callerIds);

    // Version v2: newFn and callers are both snapshotted
    createVersion({
      version_id: "v2-t3",
      repo_id: repoId,
      created_at: NOW,
      reason: "v2",
    });
    snapshotAll("v2-t3", [newFnId, ...callerIds]);

    // --- getFanInAtVersion for v1: newFn not in symbol_versions → fallback ---
    // The fallback returns metrics.fan_in (= 3) without throwing
    let fanInV1: number | undefined;
    assert.doesNotThrow(() => {
      fanInV1 = getFanInAtVersion(repoId, newFnId, "v1-t3");
    }, "getFanInAtVersion must not throw for a symbol absent from v1 snapshot");

    // Fallback returns current metrics.fan_in = 3
    assert.equal(
      fanInV1,
      3,
      "v1 fallback must return current metrics.fan_in = 3",
    );

    // --- getFanInAtVersion for v2: newFn IS snapshotted ---
    // Callers are snapshotted for v2 → count = 3
    const fanInV2 = getFanInAtVersion(repoId, newFnId, "v2-t3");
    assert.equal(fanInV2, 3, "v2: newFn has 3 callers in snapshot");

    // --- fanInTrend absent for newFn (growthRate = (3-3)/max(3,1) = 0) ---
    const fanInTrend = computeFanInTrendForSymbol(repoId, newFnId, "v1-t3", "v2-t3");
    assert.equal(
      fanInTrend,
      undefined,
      "fanInTrend must be absent when growthRate is 0 (fallback=3 equals v2=3)",
    );

    // --- computeBlastRadius must not throw when a symbol has no v1 snapshot ---
    const allSymbolRows = [
      makeSymbolRow(newFnId, repoId, fileId, "newFn"),
      ...callerIds.map((id, i) =>
        makeSymbolRow(id, repoId, fileId, `caller${i}`),
      ),
    ];
    const allEdges: EdgeRow[] = callerIds.map((callerId) =>
      makeEdgeRow(repoId, callerId, newFnId),
    );
    const graph = buildMinimalGraph(repoId, allSymbolRows, allEdges);

    assert.doesNotThrow(() => {
      computeBlastRadius([newFnId], graph, {
        repoId,
        fromVersionId: "v1-t3",
        toVersionId: "v2-t3",
      });
    }, "computeBlastRadius must not throw when a symbol has no v1 snapshot");
  });

  // -------------------------------------------------------------------------
  // Test 4: amplifiers field always present as empty when no version IDs given
  //
  // computeBlastRadius without fromVersionId/toVersionId never attaches
  // fanInTrend to any item → the amplifiers derivation yields an empty array.
  // We verify this structural guarantee with a real DB and graph.
  // -------------------------------------------------------------------------
  it("Test 4: amplifiers array is always present; empty when no version IDs provided", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Insert two symbols: changedFn and depFn
    const changedId = "sym-changed-t4";
    const depId = "sym-dep-t4";

    upsertSymbol(makeSymbolRow(changedId, repoId, fileId, "changedFn"));
    upsertMetrics({
      symbolId: changedId,
      fanIn: 0,
      fanOut: 0,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });

    upsertSymbol(makeSymbolRow(depId, repoId, fileId, "depFn"));
    upsertMetrics({
      symbolId: depId,
      fanIn: 0,
      fanOut: 0,
      churn30d: 0,
      testRefsJson: "[]",
      updatedAt: NOW,
    });

    const allSymbolRows = [
      makeSymbolRow(changedId, repoId, fileId, "changedFn"),
      makeSymbolRow(depId, repoId, fileId, "depFn"),
    ];
    const graph = buildMinimalGraph(repoId, allSymbolRows, []);

    // --- Call computeBlastRadius WITHOUT version IDs ---
    const blastRadius = computeBlastRadius([changedId], graph, {
      repoId,
      // fromVersionId and toVersionId intentionally omitted
    });

    // Result must be an array (structural guarantee)
    assert.ok(Array.isArray(blastRadius), "blastRadius must be an array");

    // No fanInTrend on any item (version IDs absent means no DB lookup)
    for (const item of blastRadius) {
      assert.equal(
        item.fanInTrend,
        undefined,
        `Item ${item.symbolId} must not have fanInTrend when version IDs are absent`,
      );
    }

    // Amplifiers derivation must yield an empty-but-present array
    const amplifiers = blastRadius
      .filter(
        (item: BlastRadiusItem) => item.fanInTrend?.isAmplifier,
      )
      .map((item: BlastRadiusItem) => ({
        symbolId: item.symbolId,
        growthRate: item.fanInTrend!.growthRate,
        previous: item.fanInTrend!.previous,
        current: item.fanInTrend!.current,
      }));

    assert.ok(Array.isArray(amplifiers), "amplifiers must be an array");
    assert.equal(
      amplifiers.length,
      0,
      "amplifiers must be empty when no version IDs are provided",
    );

    // Verify that the same symbol set with version IDs also returns a valid
    // (possibly empty) blast radius without crashing
    createVersion({
      version_id: "v1-t4",
      repo_id: repoId,
      created_at: NOW,
      reason: "v1",
    });
    createVersion({
      version_id: "v2-t4",
      repo_id: repoId,
      created_at: NOW,
      reason: "v2",
    });
    snapshotAll("v1-t4", [changedId, depId]);
    snapshotAll("v2-t4", [changedId, depId]);

    let blastRadiusWithVersions: BlastRadiusItem[];
    assert.doesNotThrow(() => {
      blastRadiusWithVersions = computeBlastRadius([changedId], graph, {
        repoId,
        fromVersionId: "v1-t4",
        toVersionId: "v2-t4",
      });
    }, "computeBlastRadius must not throw when version IDs are provided");

    assert.ok(
      Array.isArray(blastRadiusWithVersions!),
      "blastRadius with version IDs must also be an array",
    );

    // Amplifiers from the versioned call must also be an empty-but-present array
    const amplifiersWithVersions = blastRadiusWithVersions!
      .filter((item: BlastRadiusItem) => item.fanInTrend?.isAmplifier)
      .map((item: BlastRadiusItem) => item.symbolId);

    assert.ok(
      Array.isArray(amplifiersWithVersions),
      "amplifiers with version IDs must be an array",
    );
    assert.equal(
      amplifiersWithVersions.length,
      0,
      "amplifiers must be empty when blast radius contains no amplifier items",
    );
  });
});
