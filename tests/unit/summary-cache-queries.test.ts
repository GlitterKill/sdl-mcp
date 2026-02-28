import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { unlinkSync, existsSync } from "fs";
import { getDb, closeDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import {
  createRepo,
  upsertFile,
  upsertSymbolTransaction,
  getFilesByRepo,
  resetQueryCache,
  getSummaryCache,
  upsertSummaryCache,
  deleteSummaryCacheByRepo,
} from "../../dist/db/queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("symbol_summary_cache queries", () => {
  const testDbPath = join(__dirname, "test-summary-cache.db");
  const repoId = "test-summary-cache-repo";
  const repoId2 = "test-summary-cache-repo-2";

  beforeEach(() => {
    process.env.SDL_DB_PATH = testDbPath;
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }

    resetQueryCache();
    const db = getDb();
    runMigrations(db);

    // Set up repo 1
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

    // Set up repo 2
    createRepo({
      repo_id: repoId2,
      root_path: "/fake/repo2",
      config_json: "{}",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    upsertFile({
      repo_id: repoId2,
      rel_path: "src/other.ts",
      content_hash: "hash2",
      language: "ts",
      byte_size: 200,
      last_indexed_at: "2024-01-01T00:00:00.000Z",
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

  it("inserts a row and reads it back with all fields intact", () => {
    const row = {
      symbol_id: "sym-001",
      summary: "Computes the hash of a content string.",
      provider: "openai",
      model: "gpt-4o-mini",
      card_hash: "abc123cardHash",
      cost_usd: 0.0001,
      created_at: "2024-06-01T10:00:00.000Z",
      updated_at: "2024-06-01T10:00:00.000Z",
    };

    upsertSummaryCache(row);

    const retrieved = getSummaryCache("sym-001");
    assert.ok(retrieved !== null, "Should return a row for existing symbol_id");
    assert.strictEqual(retrieved.symbol_id, row.symbol_id);
    assert.strictEqual(retrieved.summary, row.summary);
    assert.strictEqual(retrieved.provider, row.provider);
    assert.strictEqual(retrieved.model, row.model);
    assert.strictEqual(retrieved.card_hash, row.card_hash);
    assert.strictEqual(retrieved.cost_usd, row.cost_usd);
    assert.strictEqual(retrieved.created_at, row.created_at);
    assert.strictEqual(retrieved.updated_at, row.updated_at);
  });

  it("returns null for a symbol_id that does not exist", () => {
    const result = getSummaryCache("nonexistent-symbol-id");
    assert.strictEqual(result, null);
  });

  it("upsert with same symbol_id updates summary and updated_at but preserves created_at", () => {
    const original = {
      symbol_id: "sym-002",
      summary: "Original summary.",
      provider: "openai",
      model: "gpt-4o-mini",
      card_hash: "hash-v1",
      cost_usd: 0.0001,
      created_at: "2024-06-01T10:00:00.000Z",
      updated_at: "2024-06-01T10:00:00.000Z",
    };
    upsertSummaryCache(original);

    const updated = {
      symbol_id: "sym-002",
      summary: "Updated summary.",
      provider: "anthropic",
      model: "claude-3-haiku",
      card_hash: "hash-v2",
      cost_usd: 0.0002,
      created_at: "2024-06-01T10:00:00.000Z", // same created_at (ignored on conflict)
      updated_at: "2024-06-02T12:00:00.000Z", // newer updated_at
    };
    upsertSummaryCache(updated);

    const retrieved = getSummaryCache("sym-002");
    assert.ok(retrieved !== null, "Row should exist after upsert");
    assert.strictEqual(retrieved.summary, "Updated summary.", "Summary should be updated");
    assert.strictEqual(retrieved.provider, "anthropic", "Provider should be updated");
    assert.strictEqual(retrieved.model, "claude-3-haiku", "Model should be updated");
    assert.strictEqual(retrieved.card_hash, "hash-v2", "card_hash should be updated");
    assert.strictEqual(retrieved.cost_usd, 0.0002, "cost_usd should be updated");
    assert.strictEqual(retrieved.updated_at, "2024-06-02T12:00:00.000Z", "updated_at should be updated");
  });

  it("deleteSummaryCacheByRepo removes rows for the given repo and leaves other repos untouched", () => {
    // Insert symbol for repo 1 (need a matching symbols row for the JOIN)
    const files1 = getFilesByRepo(repoId);
    const fileId1 = files1[0].file_id;

    upsertSymbolTransaction({
      symbol_id: "sym-repo1-A",
      repo_id: repoId,
      file_id: fileId1,
      kind: "function",
      name: "funcA",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 10,
      range_end_col: 1,
      ast_fingerprint: "fp-A",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-06-01T10:00:00.000Z",
    });

    // Insert symbol for repo 2
    const files2 = getFilesByRepo(repoId2);
    const fileId2 = files2[0].file_id;

    upsertSymbolTransaction({
      symbol_id: "sym-repo2-B",
      repo_id: repoId2,
      file_id: fileId2,
      kind: "function",
      name: "funcB",
      exported: 1,
      visibility: "public",
      language: "ts",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 5,
      range_end_col: 1,
      ast_fingerprint: "fp-B",
      signature_json: null,
      summary: null,
      invariants_json: null,
      side_effects_json: null,
      updated_at: "2024-06-01T10:00:00.000Z",
    });

    // Insert cache rows for both repos
    upsertSummaryCache({
      symbol_id: "sym-repo1-A",
      summary: "Summary for repo1 symbol A.",
      provider: "openai",
      model: "gpt-4o-mini",
      card_hash: "cardA",
      cost_usd: 0.0001,
      created_at: "2024-06-01T10:00:00.000Z",
      updated_at: "2024-06-01T10:00:00.000Z",
    });

    upsertSummaryCache({
      symbol_id: "sym-repo2-B",
      summary: "Summary for repo2 symbol B.",
      provider: "openai",
      model: "gpt-4o-mini",
      card_hash: "cardB",
      cost_usd: 0.0001,
      created_at: "2024-06-01T10:00:00.000Z",
      updated_at: "2024-06-01T10:00:00.000Z",
    });

    // Verify both rows exist
    assert.ok(getSummaryCache("sym-repo1-A") !== null, "repo1 row should exist before delete");
    assert.ok(getSummaryCache("sym-repo2-B") !== null, "repo2 row should exist before delete");

    // Delete only repo1's cache
    deleteSummaryCacheByRepo(repoId);

    // repo1's row should be gone
    assert.strictEqual(
      getSummaryCache("sym-repo1-A"),
      null,
      "repo1 cache row should be deleted",
    );

    // repo2's row should be unaffected
    const repo2Row = getSummaryCache("sym-repo2-B");
    assert.ok(repo2Row !== null, "repo2 cache row should be untouched");
    assert.strictEqual(repo2Row.summary, "Summary for repo2 symbol B.");
  });
});
