import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { updateMetricsForRepo } from "../../dist/graph/metrics.js";
import {
  upsertMetrics,
  upsertFile,
  upsertSymbolTransaction,
  createEdgeTransaction,
  getMetrics,
  getSymbolsByRepo,
  getFileByRepoPath,
  getFilesByRepo,
} from "../../dist/db/queries.js";
import { hashContent } from "../../dist/util/hashing.js";
import { getDb } from "../../dist/db/db.js";

describe("Incremental Metrics Calculation (PERF-L2.2)", () => {
  const repoId = "test-incr-metrics";
  let fileId1: number;
  let fileId2: number;
  let fileId3: number;

  before(() => {
    const db = getDb();

    // Cleanup from previous runs
    try {
      db.exec(`DELETE FROM edges WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM symbols WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM files WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM metrics WHERE symbol_id LIKE '${repoId}%'`);
      db.exec(`DELETE FROM repos WHERE repo_id = '${repoId}'`);
    } catch (error) {
      console.warn("Cleanup error (non-fatal):", error);
    }

    // Create the repo first (required for foreign key constraint)
    // config_json must include languages array for updateMetricsForRepo
    const configJson = JSON.stringify({
      repoId: repoId,
      rootPath: '/tmp/test-incr-metrics',
      languages: ['ts', 'tsx', 'js'],
      ignore: ['**/node_modules/**']
    });
    db.exec(`
      INSERT OR IGNORE INTO repos (repo_id, root_path, config_json, created_at)
      VALUES ('${repoId}', '/tmp/test-incr-metrics', '${configJson}', datetime('now'))
    `);

    upsertFile({
      repo_id: repoId,
      rel_path: "file1.ts",
      content_hash: hashContent("file1"),
      language: "typescript",
      byte_size: 10,
      last_indexed_at: new Date().toISOString(),
    });
    fileId1 = getFileByRepoPath(repoId, "file1.ts")!.file_id;

    upsertFile({
      repo_id: repoId,
      rel_path: "file2.ts",
      content_hash: hashContent("file2"),
      language: "typescript",
      byte_size: 10,
      last_indexed_at: new Date().toISOString(),
    });
    fileId2 = getFileByRepoPath(repoId, "file2.ts")!.file_id;

    upsertFile({
      repo_id: repoId,
      rel_path: "file3.ts",
      content_hash: hashContent("file3"),
      language: "typescript",
      byte_size: 10,
      last_indexed_at: new Date().toISOString(),
    });
    fileId3 = getFileByRepoPath(repoId, "file3.ts")!.file_id;

    const now = new Date().toISOString();

    upsertSymbolTransaction({
      symbol_id: "symbol1",
      repo_id: repoId,
      file_id: fileId1,
      kind: "function",
      name: "func1",
      exported: 1,
      visibility: "public",
      language: "typescript",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fingerprint1",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: now,
    });

    upsertSymbolTransaction({
      symbol_id: "symbol2",
      repo_id: repoId,
      file_id: fileId1,
      kind: "function",
      name: "func2",
      exported: 1,
      visibility: "public",
      language: "typescript",
      range_start_line: 6,
      range_start_col: 0,
      range_end_line: 10,
      range_end_col: 1,
      ast_fingerprint: "fingerprint2",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: now,
    });

    upsertSymbolTransaction({
      symbol_id: "symbol3",
      repo_id: repoId,
      file_id: fileId2,
      kind: "function",
      name: "func3",
      exported: 1,
      visibility: "public",
      language: "typescript",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fingerprint3",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: now,
    });

    upsertSymbolTransaction({
      symbol_id: "symbol4",
      repo_id: repoId,
      file_id: fileId3,
      kind: "function",
      name: "func4",
      exported: 1,
      visibility: "public",
      language: "typescript",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fingerprint4",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: now,
    });

    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: "symbol1",
      to_symbol_id: "symbol2",
      type: "call",
      weight: 1.0,
      provenance: "call",
      created_at: now,
    });

    createEdgeTransaction({
      repo_id: repoId,
      from_symbol_id: "symbol3",
      to_symbol_id: "symbol1",
      type: "import",
      weight: 0.6,
      provenance: "import",
      created_at: now,
    });
  });

  after(() => {
    const db = getDb();
    try {
      db.exec(`DELETE FROM edges WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM symbols WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM files WHERE repo_id = '${repoId}'`);
      db.exec(`DELETE FROM metrics WHERE symbol_id LIKE '${repoId}%'`);
      db.exec(`DELETE FROM repos WHERE repo_id = '${repoId}'`);
    } catch (error) {
      console.warn("Cleanup error (non-fatal):", error);
    }
  });

  describe("Full metrics update", () => {
    it("should update all symbols without changedFileIds", async () => {
      await updateMetricsForRepo(repoId);

      const symbols = getSymbolsByRepo(repoId);
      assert.strictEqual(symbols.length, 4, "Should have 4 symbols");

      const metrics1 = getMetrics("symbol1");
      const metrics2 = getMetrics("symbol2");
      const metrics3 = getMetrics("symbol3");
      const metrics4 = getMetrics("symbol4");

      assert.ok(metrics1, "symbol1 should have metrics");
      assert.ok(metrics2, "symbol2 should have metrics");
      assert.ok(metrics3, "symbol3 should have metrics");
      assert.ok(metrics4, "symbol4 should have metrics");

      assert.strictEqual(
        metrics1?.fan_out,
        1,
        "symbol1 should have fan_out=1 (calls symbol2)",
      );
      assert.strictEqual(
        metrics1?.fan_in,
        1,
        "symbol1 should have fan_in=1 (called by symbol3)",
      );
      assert.strictEqual(
        metrics2?.fan_in,
        1,
        "symbol2 should have fan_in=1 (called by symbol1)",
      );
      assert.strictEqual(
        metrics3?.fan_out,
        1,
        "symbol3 should have fan_out=1 (imports symbol1)",
      );
    });
  });

  describe("Incremental metrics update", () => {
    it("should only update affected symbols for changed files", async () => {
      const oldMetric1 = getMetrics("symbol1");
      const oldMetric2 = getMetrics("symbol2");
      const oldMetric3 = getMetrics("symbol3");
      const oldMetric4 = getMetrics("symbol4");

      await updateMetricsForRepo(repoId, new Set([fileId1]));

      const newMetric1 = getMetrics("symbol1");
      const newMetric2 = getMetrics("symbol2");
      const newMetric3 = getMetrics("symbol3");
      const newMetric4 = getMetrics("symbol4");

      assert.ok(
        newMetric1?.updated_at !== oldMetric1?.updated_at,
        "symbol1 (in changed file) should be updated",
      );
      assert.ok(
        newMetric2?.updated_at !== oldMetric2?.updated_at,
        "symbol2 (in changed file) should be updated",
      );
      assert.ok(
        newMetric3?.updated_at !== oldMetric3?.updated_at,
        "symbol3 (edge neighbor) should be updated",
      );
      assert.strictEqual(
        newMetric4?.updated_at,
        oldMetric4?.updated_at,
        "symbol4 (unrelated) should NOT be updated",
      );
    });

    it("should track edge neighbors correctly", async () => {
      const oldMetric1 = getMetrics("symbol1");
      const oldMetric3 = getMetrics("symbol3");
      const oldMetric4 = getMetrics("symbol4");

      await updateMetricsForRepo(repoId, new Set([fileId2]));

      const newMetric1 = getMetrics("symbol1");
      const newMetric3 = getMetrics("symbol3");
      const newMetric4 = getMetrics("symbol4");

      assert.ok(
        newMetric3?.updated_at !== oldMetric3?.updated_at,
        "symbol3 (in changed file) should be updated",
      );
      assert.ok(
        newMetric1?.updated_at !== oldMetric1?.updated_at,
        "symbol1 (edge neighbor - symbol3 imports symbol1) should be updated",
      );
      assert.strictEqual(
        newMetric4?.updated_at,
        oldMetric4?.updated_at,
        "symbol4 (unrelated) should NOT be updated",
      );
    });

    it("should handle multiple changed files", async () => {
      const oldMetric1 = getMetrics("symbol1");
      const oldMetric2 = getMetrics("symbol2");
      const oldMetric3 = getMetrics("symbol3");
      const oldMetric4 = getMetrics("symbol4");

      await updateMetricsForRepo(repoId, new Set([fileId1, fileId2]));

      const newMetric1 = getMetrics("symbol1");
      const newMetric2 = getMetrics("symbol2");
      const newMetric3 = getMetrics("symbol3");
      const newMetric4 = getMetrics("symbol4");

      assert.ok(
        newMetric1?.updated_at !== oldMetric1?.updated_at,
        "symbol1 (in changed file) should be updated",
      );
      assert.ok(
        newMetric2?.updated_at !== oldMetric2?.updated_at,
        "symbol2 (in changed file) should be updated",
      );
      assert.ok(
        newMetric3?.updated_at !== oldMetric3?.updated_at,
        "symbol3 (in changed file and edge neighbor) should be updated",
      );
      assert.strictEqual(
        newMetric4?.updated_at,
        oldMetric4?.updated_at,
        "symbol4 (unrelated) should NOT be updated",
      );
    });
  });

  describe("Changed files parameter", () => {
    it("should update all symbols when changedFileIds is undefined", async () => {
      await updateMetricsForRepo(repoId);

      const symbols = getSymbolsByRepo(repoId);
      assert.strictEqual(symbols.length, 4, "Should have 4 symbols");

      const metrics1 = getMetrics("symbol1");
      assert.ok(metrics1, "symbol1 should have metrics");
    });

    it("should not update anything with empty changedFileIds", async () => {
      const oldMetric1 = getMetrics("symbol1");
      const oldMetric2 = getMetrics("symbol2");

      await updateMetricsForRepo(repoId, new Set());

      assert.strictEqual(
        getMetrics("symbol1")?.updated_at,
        oldMetric1?.updated_at,
        "Should not update with empty changedFileIds",
      );
      assert.strictEqual(
        getMetrics("symbol2")?.updated_at,
        oldMetric2?.updated_at,
        "Should not update with empty changedFileIds",
      );
    });
  });
});
