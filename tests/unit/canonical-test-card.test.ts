import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { getDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import { SymbolGetCardResponseSchema } from "../../dist/mcp/tools.js";

/**
 * Tests for canonicalTest exposure in symbol cards (T4-B).
 *
 * These tests verify:
 * 1. When canonical_test_json is stored in the metrics table, getCard returns
 *    metrics.canonicalTest with the correct file, distance, and proximity.
 * 2. When no canonical_test_json is stored, metrics.canonicalTest is absent.
 * 3. Zod schema validation passes for cards with and without canonicalTest.
 */

const REPO_ID = "test-canonical-test-card";

const BASE_SYMBOL = {
  kind: "function",
  exported: 1,
  visibility: "public",
  signature_json: null,
  summary: null,
  invariants_json: null,
  side_effects_json: null,
  ast_fingerprint: "fp-canonical-test",
  range_start_line: 1,
  range_start_col: 0,
  range_end_line: 10,
  range_end_col: 1,
};

describe("canonicalTest in symbol cards (T4-B)", () => {
  let fileId: number;
  const symbolIdWithTest = `sym-with-canonical-test-${REPO_ID}`;
  const symbolIdNoTest = `sym-no-canonical-test-${REPO_ID}`;

  before(() => {
    const db = getDb();
    runMigrations(db);

    // Clean up any prior run
    try {
      db.exec(`DELETE FROM metrics  WHERE symbol_id LIKE '%${REPO_ID}%'`);
      db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
    } catch {
      // non-fatal
    }

    db.exec(`
      INSERT INTO repos (repo_id, root_path, config_json, created_at)
      VALUES ('${REPO_ID}', '/tmp/test-canonical-card', '{}', datetime('now'))
    `);

    db.exec(`
      INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
      VALUES ('${REPO_ID}', 'src/util.ts', 'hash-util', 'ts', 100, datetime('now'), 'src')
    `);

    const fileRow = db
      .prepare(
        "SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?",
      )
      .get(REPO_ID, "src/util.ts") as { file_id: number };
    fileId = fileRow.file_id;

    // Insert the symbol that has a canonical test
    db.prepare(`
      INSERT INTO symbols (
        symbol_id, repo_id, file_id, kind, name, exported, visibility,
        signature_json, summary, invariants_json, side_effects_json,
        ast_fingerprint, range_start_line, range_start_col, range_end_line, range_end_col,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      symbolIdWithTest,
      REPO_ID,
      fileId,
      BASE_SYMBOL.kind,
      "add",
      BASE_SYMBOL.exported,
      BASE_SYMBOL.visibility,
      BASE_SYMBOL.signature_json,
      BASE_SYMBOL.summary,
      BASE_SYMBOL.invariants_json,
      BASE_SYMBOL.side_effects_json,
      BASE_SYMBOL.ast_fingerprint,
      BASE_SYMBOL.range_start_line,
      BASE_SYMBOL.range_start_col,
      BASE_SYMBOL.range_end_line,
      BASE_SYMBOL.range_end_col,
    );

    // Insert the symbol with no canonical test
    db.prepare(`
      INSERT INTO symbols (
        symbol_id, repo_id, file_id, kind, name, exported, visibility,
        signature_json, summary, invariants_json, side_effects_json,
        ast_fingerprint, range_start_line, range_start_col, range_end_line, range_end_col,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      symbolIdNoTest,
      REPO_ID,
      fileId,
      BASE_SYMBOL.kind,
      "subtract",
      BASE_SYMBOL.exported,
      BASE_SYMBOL.visibility,
      BASE_SYMBOL.signature_json,
      BASE_SYMBOL.summary,
      BASE_SYMBOL.invariants_json,
      BASE_SYMBOL.side_effects_json,
      BASE_SYMBOL.ast_fingerprint,
      BASE_SYMBOL.range_start_line,
      BASE_SYMBOL.range_start_col,
      BASE_SYMBOL.range_end_line,
      BASE_SYMBOL.range_end_col,
    );

    // Insert metrics for symbolIdWithTest — includes canonical_test_json
    const canonicalTestData = JSON.stringify({
      file: "tests/util.test.ts",
      distance: 1,
      proximity: 0.5,
    });
    db.prepare(`
      INSERT INTO metrics (symbol_id, fan_in, fan_out, churn_30d, test_refs_json, canonical_test_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      symbolIdWithTest,
      2,
      1,
      3,
      JSON.stringify(["tests/util.test.ts"]),
      canonicalTestData,
    );

    // Insert metrics for symbolIdNoTest — canonical_test_json is NULL
    db.prepare(`
      INSERT INTO metrics (symbol_id, fan_in, fan_out, churn_30d, test_refs_json, canonical_test_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(symbolIdNoTest, 0, 0, 0, JSON.stringify([]), null);
  });

  after(() => {
    const db = getDb();
    try {
      db.exec(`DELETE FROM metrics  WHERE symbol_id LIKE '%${REPO_ID}%'`);
      db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
    } catch {
      // non-fatal
    }
  });

  it("Test 1: symbol card includes metrics.canonicalTest when canonical_test_json is stored", async () => {
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: symbolIdWithTest,
    });

    // handleSymbolGetCard returns { card: CardWithETag } or NotModifiedResponse
    assert.ok(!("notModified" in result), "Expected full card response, not notModified");

    const response = result as { card: Record<string, unknown> };
    assert.ok(response.card, "Response should have a card property");
    assert.ok(response.card["metrics"], "Card should have metrics");

    const metrics = response.card["metrics"] as {
      canonicalTest?: { file: string; distance: number; proximity: number };
    };
    assert.ok(metrics.canonicalTest, "canonicalTest should be defined in metrics");
    assert.strictEqual(
      metrics.canonicalTest.file,
      "tests/util.test.ts",
      "canonicalTest.file should match the stored test path",
    );
    assert.strictEqual(
      metrics.canonicalTest.distance,
      1,
      "canonicalTest.distance should be 1",
    );
    assert.ok(
      Math.abs(metrics.canonicalTest.proximity - 0.5) < 1e-9,
      `canonicalTest.proximity should be 0.5, got ${metrics.canonicalTest.proximity}`,
    );
  });

  it("Test 2: symbol card has no metrics.canonicalTest when canonical_test_json is null", async () => {
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: symbolIdNoTest,
    });

    assert.ok(!("notModified" in result), "Expected full card response, not notModified");

    const response = result as { card: Record<string, unknown> };
    assert.ok(response.card, "Response should have a card property");
    assert.ok(response.card["metrics"], "Card should have metrics");

    const metrics = response.card["metrics"] as { canonicalTest?: unknown };
    assert.strictEqual(
      metrics.canonicalTest,
      undefined,
      "canonicalTest should be absent when canonical_test_json is null",
    );
  });

  it("Test 3: Zod schema validation passes for cards with and without canonicalTest", async () => {
    // Card with canonicalTest
    const resultWith = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: symbolIdWithTest,
    });
    assert.ok(!("notModified" in resultWith), "Expected full card for symbol with test");

    assert.doesNotThrow(() => {
      SymbolGetCardResponseSchema.parse(resultWith);
    }, "Schema parse should succeed for card with canonicalTest");

    // Card without canonicalTest
    const resultWithout = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolId: symbolIdNoTest,
    });
    assert.ok(!("notModified" in resultWithout), "Expected full card for symbol without test");

    assert.doesNotThrow(() => {
      SymbolGetCardResponseSchema.parse(resultWithout);
    }, "Schema parse should succeed for card without canonicalTest");
  });
});
