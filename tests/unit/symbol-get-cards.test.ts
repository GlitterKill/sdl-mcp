import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { handleSymbolGetCard } from "../../dist/mcp/tools/symbol.js";
import {
  SymbolGetCardRequestSchema,
  SymbolGetCardResponseSchema,
} from "../../dist/mcp/tools.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

/**
 * Tests for handleSymbolGetCard — the batch symbol card API.
 *
 * These tests verify:
 * - Schema validation (max 100 symbolIds, min 1)
 * - Output order preserved relative to input
 * - notModified returned for symbolIds whose ETag matches knownEtags
 * - Full card returned for symbolIds with no matching knownEtag
 * - Mixed batch behavior (some hits, some misses)
 */

const REPO_ID = "test-get-cards-repo";
const FOREIGN_REPO_ID = "test-get-cards-foreign-repo";

describe("handleSymbolGetCard", () => {
  const graphDbPath = join(tmpdir(), `.lbug-get-cards-test-db-${process.pid}`);

  let symbolIdA: string;
  let symbolIdB: string;
  let foreignSymbolId: string;

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

    await ladybugDb.upsertRepo(conn, {
      repoId: FOREIGN_REPO_ID,
      rootPath: "/tmp/foreign-repo",
      configJson: JSON.stringify({
        root: ".",
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

    await ladybugDb.upsertFile(conn, {
      fileId: "file-foreign-1",
      repoId: FOREIGN_REPO_ID,
      relPath: "src/foreign.ts",
      contentHash: "hash-foreign",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    symbolIdA = `sym-cards-a-${REPO_ID}`;
    symbolIdB = `sym-cards-b-${REPO_ID}`;
    foreignSymbolId = `sym-cards-foreign-${FOREIGN_REPO_ID}`;

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

    await ladybugDb.upsertSymbol(conn, {
      symbolId: foreignSymbolId,
      repoId: FOREIGN_REPO_ID,
      fileId: "file-foreign-1",
      kind: "function",
      name: "fnForeign",
      exported: false,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 5,
      rangeEndCol: 1,
      astFingerprint: "fp-foreign",
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
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, symbolIdB],
    });

    assert.strictEqual(result.cards.length, 2);
    assert.deepStrictEqual(
      result.cards.map((card) => ("symbolId" in card ? card.symbolId : null)),
      [symbolIdA, symbolIdB],
    );
    assert.strictEqual(result.partial, undefined);
    assert.strictEqual(result.succeeded, undefined);
    assert.strictEqual(result.failed, undefined);
    assert.strictEqual(result.failures, undefined);
    assert.strictEqual(
      SymbolGetCardResponseSchema.safeParse(result).success,
      true,
    );
  });

  it("returns ordered successes and item failures for a mixed explicit-ID batch", async () => {
    const missingId = "sym-cards-missing-middle";
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, missingId, symbolIdB],
    });

    assert.deepStrictEqual(
      result.cards.map((card) => ("symbolId" in card ? card.symbolId : null)),
      [symbolIdA, symbolIdB],
    );
    assert.strictEqual(result.partial, true);
    assert.deepStrictEqual(result.succeeded, [symbolIdA, symbolIdB]);
    assert.deepStrictEqual(result.failed, [missingId]);
    assert.deepStrictEqual(result.failures, [
      {
        input: missingId,
        message: `Symbol not found: ${missingId}`,
        code: "NOT_FOUND",
        classification: "not_found",
        retryable: false,
        fallbackTools: ["sdl.symbol.search", "sdl.action.search"],
        fallbackRationale:
          "Use sdl.symbol.search to discover the canonical symbol identifier.",
        candidates: [],
      },
    ]);
    assert.strictEqual(
      SymbolGetCardResponseSchema.safeParse(result).success,
      true,
    );
  });

  it("returns per-item not_found failures when every explicit ID is missing", async () => {
    const missingIds = ["sym-cards-missing-a", "sym-cards-missing-b"];
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: missingIds,
    });

    assert.deepStrictEqual(result.cards, []);
    assert.strictEqual(result.partial, false);
    assert.deepStrictEqual(result.succeeded, []);
    assert.deepStrictEqual(result.failed, missingIds);
    assert.deepStrictEqual(
      result.failures?.map((failure) => ({
        input: failure.input,
        code: failure.code,
        classification: failure.classification,
        retryable: failure.retryable,
        fallbackTools: failure.fallbackTools,
        fallbackRationale: failure.fallbackRationale,
        candidates: failure.candidates,
      })),
      missingIds.map((input) => ({
        input,
        code: "NOT_FOUND",
        classification: "not_found",
        retryable: false,
        fallbackTools: ["sdl.symbol.search", "sdl.action.search"],
        fallbackRationale:
          "Use sdl.symbol.search to discover the canonical symbol identifier.",
        candidates: [],
      })),
    );
  });

  it("preserves duplicate successes and failures in request order", async () => {
    const missingId = "sym-cards-duplicate-missing";
    const result = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, missingId, symbolIdA, missingId, symbolIdB],
    });

    assert.deepStrictEqual(
      result.cards.map((card) => ("symbolId" in card ? card.symbolId : null)),
      [symbolIdA, symbolIdA, symbolIdB],
    );
    assert.deepStrictEqual(result.succeeded, [symbolIdA, symbolIdA, symbolIdB]);
    assert.deepStrictEqual(result.failed, [missingId, missingId]);
    assert.deepStrictEqual(
      result.failures?.map((failure) => failure.input),
      [missingId, missingId],
    );
  });

  it("keys session refs by ordered successes after a leading miss", async () => {
    const missingId = "sym-cards-leading-missing";
    const context = { sessionId: "explicit-id-leading-miss-session" };
    const request = {
      repoId: REPO_ID,
      symbolIds: [missingId, symbolIdA],
    };

    const first = await handleSymbolGetCard(request, context);
    assert.strictEqual(first.cards.length, 1);
    assert.strictEqual(
      "symbolId" in first.cards[0] ? first.cards[0].symbolId : null,
      symbolIdA,
    );

    const second = await handleSymbolGetCard(request, context);
    assert.strictEqual(second.cards.length, 1);
    assert.strictEqual(second.cards[0].unchanged, true);
    assert.strictEqual(second.cards[0].ref.key, `card:${REPO_ID}:${symbolIdA}`);
  });

  it("keeps explicit-ID and symbolRef not_found metadata in parity", async () => {
    const missingId = "sym-cards-parity-missing";
    const byId = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [missingId],
    });
    const byRef = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolRefs: [{ name: "missingParitySymbol" }],
    });
    const metadata = (failure: NonNullable<typeof byRef.failures>[number]) => ({
      code: failure.code,
      classification: failure.classification,
      retryable: failure.retryable,
      fallbackTools: failure.fallbackTools,
      fallbackRationale: failure.fallbackRationale,
      candidates: failure.candidates,
    });

    assert.deepStrictEqual(
      metadata(byId.failures![0]),
      metadata(byRef.failures![0]),
    );
  });

  it("preserves input order in output cards array", async () => {
    const result = await handleSymbolGetCard({
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
    const result = await handleSymbolGetCard({
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
    const firstResult = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });

    const firstCard = firstResult.cards[0];
    assert.ok(
      "etag" in firstCard,
      "Expected first fetch to return full card with etag",
    );
    const etag = (firstCard as { etag: string }).etag;

    const secondResult = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
      knownEtags: { [symbolIdA]: etag },
    });

    assert.strictEqual(secondResult.cards.length, 1);
    const cachedCard = secondResult.cards[0];
    assert.ok(
      "notModified" in cachedCard &&
        (cachedCard as { notModified: boolean }).notModified,
      "Expected notModified response when ETag matches",
    );
  });

  it("handles mixed batch with some hits and some misses", async () => {
    const firstResult = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA],
    });
    const firstCard = firstResult.cards[0];
    assert.ok("etag" in firstCard);
    const etag = (firstCard as { etag: string }).etag;

    const batchResult = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdA, symbolIdB],
      knownEtags: { [symbolIdA]: etag },
    });

    assert.strictEqual(batchResult.cards.length, 2);

    const resultA = batchResult.cards[0];
    const resultB = batchResult.cards[1];

    assert.ok(
      "notModified" in resultA &&
        (resultA as { notModified: boolean }).notModified,
      "Expected notModified for symbolIdA (ETag match)",
    );

    assert.ok(!("notModified" in resultB), "Expected full card for symbolIdB");
    assert.ok("etag" in resultB, "Expected etag in symbolIdB result");
  });

  it("rejects symbolIds that belong to a different repo", async () => {
    await assert.rejects(
      () =>
        handleSymbolGetCard({
          repoId: REPO_ID,
          symbolIds: [symbolIdA, foreignSymbolId],
        }),
      /belongs to repo/,
    );
  });

  it("keeps a real database failure fatal for the whole batch", async () => {
    await closeLadybugDb();
    try {
      await assert.rejects(
        () =>
          handleSymbolGetCard({
            repoId: REPO_ID,
            symbolIds: [symbolIdA, "sym-cards-db-failure-missing"],
          }),
        (error: unknown) =>
          (error as { code?: string }).code === "DATABASE_ERROR",
      );
    } finally {
      await initLadybugDb(graphDbPath);
    }
  });

  it("schema rejects requests with more than 100 symbolIds", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `sym-${i}`);

    assert.throws(
      () =>
        SymbolGetCardRequestSchema.parse({
          repoId: REPO_ID,
          symbolIds: tooMany,
        }),
      /too_big|Array must contain at most 100/i,
    );
  });

  it("schema rejects requests with zero symbolIds", () => {
    assert.throws(
      () =>
        SymbolGetCardRequestSchema.parse({
          repoId: REPO_ID,
          symbolIds: [],
        }),
      /too_small|Array must contain at least 1/i,
    );
  });

  it("schema accepts requests with exactly 100 symbolIds", () => {
    const exactly100 = Array.from({ length: 100 }, (_, i) => `sym-${i}`);

    const parsed = SymbolGetCardRequestSchema.parse({
      repoId: REPO_ID,
      symbolIds: exactly100,
    });

    assert.strictEqual(parsed.symbolIds.length, 100);
  });

  it("returns a session ref on repeat unchanged delivery for the same session", async () => {
    const context = { sessionId: "get-cards-dedupe-repeat" };

    const first = await handleSymbolGetCard(
      { repoId: REPO_ID, symbolIds: [symbolIdA] },
      context,
    );
    assert.ok("etag" in first.cards[0], "first delivery returns the full card");

    const second = await handleSymbolGetCard(
      { repoId: REPO_ID, symbolIds: [symbolIdA] },
      context,
    );
    const repeat = second.cards[0];
    assert.strictEqual(repeat.unchanged, true);
    assert.strictEqual(repeat.ref.key, `card:${REPO_ID}:${symbolIdA}`);
    assert.ok(!("signature" in repeat), "ref entry carries no card body");
  });

  it("refsMode off returns the full card on repeat delivery", async () => {
    const context = { sessionId: "get-cards-dedupe-off" };

    await handleSymbolGetCard(
      { repoId: REPO_ID, symbolIds: [symbolIdA], refsMode: "off" },
      context,
    );
    const second = await handleSymbolGetCard(
      { repoId: REPO_ID, symbolIds: [symbolIdA], refsMode: "off" },
      context,
    );
    assert.ok("etag" in second.cards[0]);
    assert.ok(!("unchanged" in second.cards[0]));
  });

  it("repeat delivery without a sessionId returns the full card", async () => {
    const first = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdB],
    });
    const second = await handleSymbolGetCard({
      repoId: REPO_ID,
      symbolIds: [symbolIdB],
    });
    assert.ok("etag" in first.cards[0]);
    assert.ok("etag" in second.cards[0]);
  });
});
