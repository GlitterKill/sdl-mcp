import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { handleSymbolGetCards } from "../../dist/mcp/tools/symbol.js";
import { SymbolGetCardsRequestSchema } from "../../src/mcp/tools.js";
import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("handleSymbolGetCards", () => {
  const graphDbPath = join(__dirname, ".lbug-get-cards-test-db");

  let symbolIdA: string;
  let symbolIdB: string;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-get-cards",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-get-cards",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: REPO_ID,
      relPath: "src/test.ts",
      contentHash: "hash-test",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    symbolIdA = `sym-cards-a-${REPO_ID}`;
    symbolIdB = `sym-cards-b-${REPO_ID}`;

    await ladybugDb.upsertSymbol(conn, {
      symbolId: symbolIdA,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "fnAlpha",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: "fp-abc",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });

    await ladybugDb.upsertSymbol(conn, {
      symbolId: symbolIdB,
      repoId: REPO_ID,
      fileId: "file-1",
      kind: "function",
      name: "fnBeta",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: "fp-abc",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
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

    assert.ok("etag" in firstCard || "notModified" in firstCard);
    if ("etag" in firstCard && "symbolId" in firstCard) {
      assert.strictEqual(firstCard.symbolId, symbolIdB);
    }

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

    assert.ok(!("notModified" in card), "Expected full card, got notModified");
    assert.ok("etag" in card);
    assert.ok("symbolId" in card);
  });

  it("returns notModified for symbolIds whose etag matches knownEtags", async () => {
    const firstResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });

    const firstCard = firstResult.cards[0];
    assert.ok("etag" in firstCard, "Expected first fetch to return full card with etag");
    const etag = (firstCard as { etag: string }).etag;

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
    const firstResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });
    const firstCard = firstResult.cards[0];
    assert.ok("etag" in firstCard);
    const etag = (firstCard as { etag: string }).etag;

    const batchResult = await handleSymbolGetCards({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, symbolIdB],
      knownEtags: { [symbolIdA]: etag },
    });

    assert.strictEqual(batchResult.cards.length, 2);

    const resultA = batchResult.cards[0];
    const resultB = batchResult.cards[1];

    assert.ok(
      "notModified" in resultA && (resultA as { notModified: boolean }).notModified,
      "Expected notModified for symbolIdA (ETag match)",
    );

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
