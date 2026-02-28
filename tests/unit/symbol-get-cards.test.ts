import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { getDb } from "../../dist/db/db.js";
import { runMigrations } from "../../dist/db/migrations.js";
import { handleSymbolGetCards } from "../../dist/mcp/tools/symbol.js";
import { SymbolGetCardsRequestSchema } from "../../src/mcp/tools.js";

/**
 * Tests for handleSymbolGetCards — the batch symbol card API.
 *
 * These tests verify:
 * - Schema validation (max 100 symbolIds, min 1)
 * - Output order preserved relative to input
 * - notModified returned for symbolIds whose ETag matches knownEtags
 * - Full card returned for symbolIds with no matching knownEtag
 * - Mixed batch behavior (some hits, some misses)
 */

const REPO_ID = "test-get-cards-repo";

// Minimal valid symbol row fields used across tests
const BASE_SYMBOL = {
  kind: "function",
  name: "testFn",
  exported: 0,
  visibility: null,
  signature_json: null,
  summary: null,
  invariants_json: null,
  side_effects_json: null,
  ast_fingerprint: "fp-abc",
  range_start_line: 1,
  range_start_col: 0,
  range_end_line: 5,
  range_end_col: 1,
};

describe("handleSymbolGetCards", () => {
  let symbolIdA: string;
  let symbolIdB: string;
  let fileId: number;

  before(() => {
    const db = getDb();
    runMigrations(db);

    // Clean up any prior run
    try {
      db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
    } catch {
      // non-fatal
    }

    db.exec(`
      INSERT INTO repos (repo_id, root_path, config_json, created_at)
      VALUES ('${REPO_ID}', '/tmp/test-get-cards', '{}', datetime('now'))
    `);

    db.exec(`
      INSERT INTO files (repo_id, rel_path, content_hash, language, byte_size, last_indexed_at, directory)
      VALUES ('${REPO_ID}', 'src/test.ts', 'hash-test', 'ts', 100, datetime('now'), 'src')
    `);

    const fileRow = db
      .prepare(
        "SELECT file_id FROM files WHERE repo_id = ? AND rel_path = ?",
      )
      .get(REPO_ID, "src/test.ts") as { file_id: number };
    fileId = fileRow.file_id;

    // Insert two symbols
    symbolIdA = "sym-cards-a-" + REPO_ID;
    symbolIdB = "sym-cards-b-" + REPO_ID;

    db.prepare(`
      INSERT INTO symbols (
        symbol_id, repo_id, file_id, kind, name, exported, visibility,
        signature_json, summary, invariants_json, side_effects_json,
        ast_fingerprint, range_start_line, range_start_col, range_end_line, range_end_col,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      symbolIdA,
      REPO_ID,
      fileId,
      BASE_SYMBOL.kind,
      "fnAlpha",
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

    db.prepare(`
      INSERT INTO symbols (
        symbol_id, repo_id, file_id, kind, name, exported, visibility,
        signature_json, summary, invariants_json, side_effects_json,
        ast_fingerprint, range_start_line, range_start_col, range_end_line, range_end_col,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      symbolIdB,
      REPO_ID,
      fileId,
      BASE_SYMBOL.kind,
      "fnBeta",
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
  });

  after(() => {
    const db = getDb();
    try {
      db.exec(`DELETE FROM symbols  WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM files    WHERE repo_id = '${REPO_ID}'`);
      db.exec(`DELETE FROM repos    WHERE repo_id = '${REPO_ID}'`);
    } catch {
      // non-fatal
    }
  });

  it("returns one result per symbolId in the input array", async () => {
    const result = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, symbolIdB],
    });

    assert.strictEqual(result.cards.length, 2);
  });

  it("preserves input order in output cards array", async () => {
    const result = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdB, symbolIdA],
    });

    assert.strictEqual(result.cards.length, 2);

    const firstCard = result.cards[0];
    const secondCard = result.cards[1];

    // First result should correspond to symbolIdB
    assert.ok("etag" in firstCard || "notModified" in firstCard);
    if ("etag" in firstCard && "symbolId" in firstCard) {
      assert.strictEqual(firstCard.symbolId, symbolIdB);
    }

    // Second result should correspond to symbolIdA
    assert.ok("etag" in secondCard || "notModified" in secondCard);
    if ("etag" in secondCard && "symbolId" in secondCard) {
      assert.strictEqual(secondCard.symbolId, symbolIdA);
    }
  });

  it("returns full card for symbolIds with no matching knownEtag", async () => {
    const result = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });

    assert.strictEqual(result.cards.length, 1);
    const card = result.cards[0];

    // Should be a full CardWithETag, not a notModified
    assert.ok(!("notModified" in card), "Expected full card, got notModified");
    assert.ok("etag" in card, "Expected card to have etag");
    assert.ok("symbolId" in card, "Expected card to have symbolId");
  });

  it("returns notModified for symbolIds whose etag matches knownEtags", async () => {
    // First fetch to get the real ETag
    const firstResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });

    const firstCard = firstResult.cards[0];
    assert.ok("etag" in firstCard, "Expected first fetch to return full card with etag");
    const etag = (firstCard as { etag: string }).etag;

    // Second fetch with the known ETag — should get notModified
    const secondResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
      knownEtags: { [symbolIdA]: etag },
    });

    assert.strictEqual(secondResult.cards.length, 1);
    const cachedCard = secondResult.cards[0];
    assert.ok(
      "notModified" in cachedCard && (cachedCard as { notModified: boolean }).notModified,
      "Expected notModified response when ETag matches",
    );
  });

  it("handles mixed batch with some hits and some misses", async () => {
    // Fetch symbolIdA first to get its ETag
    const firstResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });
    const firstCard = firstResult.cards[0];
    assert.ok("etag" in firstCard);
    const etag = (firstCard as { etag: string }).etag;

    // Now batch both, providing ETag only for symbolIdA
    const batchResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, symbolIdB],
      knownEtags: { [symbolIdA]: etag },
    });

    assert.strictEqual(batchResult.cards.length, 2);

    const resultA = batchResult.cards[0];
    const resultB = batchResult.cards[1];

    // symbolIdA should be notModified (ETag matched)
    assert.ok(
      "notModified" in resultA && (resultA as { notModified: boolean }).notModified,
      "Expected notModified for symbolIdA (ETag match)",
    );

    // symbolIdB should be a full card (no ETag provided)
    assert.ok(!("notModified" in resultB), "Expected full card for symbolIdB");
    assert.ok("etag" in resultB, "Expected etag in symbolIdB result");
  });

  it("schema rejects requests with more than 100 symbolIds", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `sym-${i}`);

    assert.throws(
      () =>
        SymbolGetCardsRequestSchema.parse({
          repoId: REPO_ID,
          symbolIds: tooMany,
        }),
      /too_big|Array must contain at most 100/i,
    );
  });

  it("schema rejects requests with zero symbolIds", () => {
    assert.throws(
      () =>
        SymbolGetCardsRequestSchema.parse({
          repoId: REPO_ID,
          symbolIds: [],
        }),
      /too_small|Array must contain at least 1/i,
    );
  });

  it("schema accepts requests with exactly 100 symbolIds", () => {
    const exactly100 = Array.from({ length: 100 }, (_, i) => `sym-${i}`);

    const parsed = SymbolGetCardsRequestSchema.parse({
      repoId: REPO_ID,
      symbolIds: exactly100,
    });

    assert.strictEqual(parsed.symbolIds.length, 100);
  });
});
