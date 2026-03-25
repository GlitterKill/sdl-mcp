import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { clearAllCaches } from "../../dist/graph/cache.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  SymbolGetCardRequestSchema,
  SymbolGetCardsRequestSchema,
} from "../../dist/mcp/tools.js";
import {
  handleSymbolGetCard,
  handleSymbolGetCards,
} from "../../dist/mcp/tools/symbol.js";
import { errorToMcpResponse } from "../../dist/mcp/errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
describe("symbol natural identifiers", () => {
  let testDbPath = "";
  beforeEach(async () => {
    clearAllCaches();
    testDbPath = join(
      tmpdir(),
      `.lbug-symbol-natural-identifiers-test-db-${randomUUID()}.lbug`,
    );
    for (const p of [testDbPath, testDbPath + ".wal", testDbPath + ".lock"]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
    mkdirSync(dirname(testDbPath), { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(testDbPath);
    const conn = await getLadybugConn();
    const now = "2026-03-20T12:00:00.000Z";

    await ladybugDb.upsertRepo(conn, {
      repoId: "repo",
      rootPath: "C:/repo",
      configJson: JSON.stringify({ policy: {} }),
      createdAt: now,
    });

    await ladybugDb.createVersion(conn, {
      versionId: "v1",
      repoId: "repo",
      createdAt: now,
      reason: "test",
      prevVersionHash: null,
      versionHash: "hash-v1",
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-tree",
      repoId: "repo",
      relPath: "src/tree.ts",
      contentHash: "hash-tree",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file-alt",
      repoId: "repo",
      relPath: "src/alt/tree.ts",
      contentHash: "hash-alt",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    const symbols = [
      {
        symbolId: "sym-tree-main",
        fileId: "file-tree",
        name: "renderNode",
        exported: true,
      },
      {
        symbolId: "sym-tree-alt",
        fileId: "file-alt",
        name: "renderNode",
        exported: false,
      },
      {
        symbolId: "sym-parse-node",
        fileId: "file-tree",
        name: "parseNode",
        exported: true,
      },
    ];

    for (const symbol of symbols) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId: symbol.symbolId,
        repoId: "repo",
        fileId: symbol.fileId,
        kind: "function",
        name: symbol.name,
        exported: symbol.exported,
        visibility: null,
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 5,
        rangeEndCol: 0,
        astFingerprint: `${symbol.symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }
  });

  afterEach(async () => {
    clearAllCaches();
    await closeLadybugDb();
    for (const p of [testDbPath, testDbPath + ".wal", testDbPath + ".lock"]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("accepts symbolRef inputs and rejects mixed symbolId + symbolRef inputs", () => {
    assert.equal(
      SymbolGetCardRequestSchema.safeParse({
        repoId: "repo",
        symbolRef: { name: "renderNode", file: "src/tree.ts" },
      }).success,
      true,
    );
    assert.equal(
      SymbolGetCardsRequestSchema.safeParse({
        repoId: "repo",
        symbolRefs: [{ name: "renderNode" }],
      }).success,
      true,
    );

    assert.equal(
      SymbolGetCardRequestSchema.safeParse({
        repoId: "repo",
        symbolId: "sym-tree-main",
        symbolRef: { name: "renderNode" },
      }).success,
      false,
    );
    assert.equal(
      SymbolGetCardsRequestSchema.safeParse({
        repoId: "repo",
        symbolIds: ["sym-tree-main"],
        symbolRefs: [{ name: "renderNode" }],
      }).success,
      false,
    );
  });

  it("resolves an exact symbolRef to a symbol card", async () => {
    const response = await handleSymbolGetCard({
      repoId: "repo",
      symbolRef: { name: "renderNode", file: "src/tree.ts" },
    });

    assert.ok("card" in response, "expected a card response");
    if ("card" in response) {
      assert.equal(response.card.symbolId, "sym-tree-main");
      assert.equal(response.card.name, "renderNode");
    }
  });

  it("returns ranked candidates when a symbolRef is ambiguous", async () => {
    await assert.rejects(
      () =>
        handleSymbolGetCard({
          repoId: "repo",
          symbolRef: { name: "renderNode" },
        }),
      (error: unknown) => {
        const response = errorToMcpResponse(error) as {
          error?: {
            classification?: string;
            retryable?: boolean;
            fallbackTools?: string[];
            candidates?: Array<{ symbolId: string; file: string }>;
          };
        };

        assert.equal(response.error?.classification, "ambiguous_input");
        assert.equal(response.error?.retryable, false);
        assert.ok(
          response.error?.fallbackTools?.includes("sdl.symbol.search"),
          "expected sdl.symbol.search as a fallback",
        );
        assert.ok(
          (response.error?.candidates?.length ?? 0) >= 2,
          "expected ranked candidates in the error response",
        );
        return true;
      },
    );
  });

  it("returns partial success metadata for mixed symbolRefs batches", async () => {
    const response = await handleSymbolGetCards({
      repoId: "repo",
      symbolRefs: [
        { name: "renderNode", file: "src/tree.ts" },
        { name: "missingNode" },
      ],
    });

    assert.equal(response.cards.length, 1);
    assert.equal(response.partial, true);
    assert.deepStrictEqual(response.succeeded, ["sym-tree-main"]);
    assert.deepStrictEqual(response.failed, ["missingNode"]);
    assert.equal(response.failures?.[0]?.classification, "not_found");
  });
});
