import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync } from "fs";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  createVersion,
  upsertFile,
  upsertSymbolTransaction,
  getFilesByRepo,
  resetQueryCache,
  getChangedSymbolsSinceVersion,
} from "../../dist/db/queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("getChangedSymbolsSinceVersion", () => {
  const testDbPath = join(__dirname, "test-stale-slice-warning.db");
  const repoId = "test-stale-slice";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    resetQueryCache();
    const db = getDb();
    runMigrations(db);

    createRepo({
      repo_id: repoId,
      root_path: "/fake/repo",
      config_json: "{}",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    upsertFile({
      repo_id: repoId,
      rel_path: "src/index.ts",
      content_hash: "hash1",
      language: "ts",
      byte_size: 500,
      last_indexed_at: "2024-01-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    closeDb();
    resetQueryCache();
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  it("returns empty array when no symbols changed", () => {
    // Version was created at T1
    const versionCreatedAt = "2024-06-01T12:00:00.000Z";
    createVersion({
      version_id: "v1000000000000",
      repo_id: repoId,
      created_at: versionCreatedAt,
      reason: "test-v1",
    });

    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Symbol updated before the version
    upsertSymbolTransaction({
      symbol_id: `${repoId}-sym1`,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "func1",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 10,
      range_end_col: 1,
      ast_fingerprint: "fp1",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-06-01T11:59:59.000Z", // before the version
    });

    const stale = getChangedSymbolsSinceVersion(
      repoId,
      [`${repoId}-sym1`],
      "v1000000000000",
    );

    assert.deepStrictEqual(stale, [], "Should return empty array when no symbols changed");
  });

  it("returns symbolIds whose updated_at is newer than sinceVersion created_at", () => {
    // Version was created at T1
    const versionCreatedAt = "2024-06-01T12:00:00.000Z";
    createVersion({
      version_id: "v1000000000001",
      repo_id: repoId,
      created_at: versionCreatedAt,
      reason: "test-v1",
    });

    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // sym1 updated AFTER the version (stale)
    upsertSymbolTransaction({
      symbol_id: `${repoId}-sym-stale`,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "staleFunc",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 10,
      range_end_col: 1,
      ast_fingerprint: "fp-stale",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-06-01T13:00:00.000Z", // after the version
    });

    // sym2 updated BEFORE the version (not stale)
    upsertSymbolTransaction({
      symbol_id: `${repoId}-sym-fresh`,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "freshFunc",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 11,
      range_start_col: 0,
      range_end_line: 20,
      range_end_col: 1,
      ast_fingerprint: "fp-fresh",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-06-01T11:00:00.000Z", // before the version
    });

    const stale = getChangedSymbolsSinceVersion(
      repoId,
      [`${repoId}-sym-stale`, `${repoId}-sym-fresh`],
      "v1000000000001",
    );

    assert.strictEqual(stale.length, 1, "Should return exactly one stale symbol");
    assert.ok(stale.includes(`${repoId}-sym-stale`), "Should include the stale symbol");
    assert.ok(!stale.includes(`${repoId}-sym-fresh`), "Should not include the fresh symbol");
  });

  it("returns empty array for empty symbolIds input", () => {
    createVersion({
      version_id: "v1000000000002",
      repo_id: repoId,
      created_at: "2024-06-01T12:00:00.000Z",
      reason: "test-v1",
    });

    const stale = getChangedSymbolsSinceVersion(repoId, [], "v1000000000002");
    assert.deepStrictEqual(stale, [], "Should return empty array for empty symbolIds");
  });

  it("returns empty array when sinceVersion does not exist", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    upsertSymbolTransaction({
      symbol_id: `${repoId}-sym-x`,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "funcX",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fp-x",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-12-01T00:00:00.000Z",
    });

    const stale = getChangedSymbolsSinceVersion(
      repoId,
      [`${repoId}-sym-x`],
      "v9999999999999-nonexistent",
    );

    assert.deepStrictEqual(stale, [], "Should return empty array when version does not exist");
  });

  it("returns empty array for empty sinceVersion string", () => {
    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    upsertSymbolTransaction({
      symbol_id: `${repoId}-sym-empty`,
      repo_id: repoId,
      file_id: fileId,
      kind: "function",
      name: "funcEmpty",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fp-empty",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-12-01T00:00:00.000Z",
    });

    const stale = getChangedSymbolsSinceVersion(
      repoId,
      [`${repoId}-sym-empty`],
      "",
    );

    assert.deepStrictEqual(stale, [], "Should return empty array for empty sinceVersion");
  });

  it("handles large symbol arrays by chunking correctly", () => {
    // Create a version
    const versionCreatedAt = "2024-06-01T12:00:00.000Z";
    createVersion({
      version_id: "v1000000000003",
      repo_id: repoId,
      created_at: versionCreatedAt,
      reason: "test-chunking",
    });

    const files = getFilesByRepo(repoId);
    const fileId = files[0].file_id;

    // Create 1500 symbols: first 1000 are not stale, last 500 are stale
    const symbolIds: string[] = [];
    const db = getDb();

    // Insert symbols in a transaction for performance
    const insertMany = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        const symbolId = `${repoId}-chunk-sym-${i}`;
        symbolIds.push(symbolId);
        const isStale = i >= 1000;
        const updatedAt = isStale
          ? "2024-06-01T13:00:00.000Z" // after version
          : "2024-06-01T11:00:00.000Z"; // before version

        db.prepare(
          `INSERT OR REPLACE INTO symbols
           (symbol_id, repo_id, file_id, kind, name, exported, visibility, language,
            range_start_line, range_start_col, range_end_line, range_end_col,
            ast_fingerprint, signature_json, summary, invariants_json, side_effects_json, updated_at)
           VALUES (?, ?, ?, 'function', ?, 1, 'public', 'ts', ?, 0, ?, 1, ?, null, null, null, null, ?)`,
        ).run(
          symbolId,
          repoId,
          fileId,
          `chunkFunc${i}`,
          i + 1,
          i + 5,
          `fp-chunk-${i}`,
          updatedAt,
        );
      }
    });

    insertMany(1500);

    const stale = getChangedSymbolsSinceVersion(
      repoId,
      symbolIds,
      "v1000000000003",
    );

    assert.strictEqual(
      stale.length,
      500,
      "Should return exactly 500 stale symbols (the last 500 with updated_at after version)",
    );

    // Verify the stale symbols are the correct ones (i >= 1000)
    for (const symbolId of stale) {
      const idx = parseInt(symbolId.replace(`${repoId}-chunk-sym-`, ""), 10);
      assert.ok(idx >= 1000, `Symbol ${symbolId} at index ${idx} should be >= 1000`);
    }
  });
});
