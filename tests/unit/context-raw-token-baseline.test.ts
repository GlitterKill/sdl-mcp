import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  collectContextRawTokenSources,
  estimateContextRawEquivalentTokens,
  calculateContextRawEquivalentTokens,
} from "../../dist/mcp/tools/context.js";

describe("sdl.context raw token baseline", () => {
  it("collects source files and symbols from returned context evidence", () => {
    const symbolId = "a".repeat(64);
    const otherSymbolId = "b".repeat(64);
    const sources = collectContextRawTokenSources({
      finalEvidence: [
        {
          type: "symbolCard",
          reference: `symbol:${symbolId}`,
          summary:
            "function handleAgentContext | src/mcp/tools/context.ts | fileAlias: Context",
        },
        {
          type: "skeleton",
          reference: `file:${otherSymbolId}`,
          summary: "symbol | Skeleton (10 lines, ~50 tokens)",
        },
        {
          type: "hotPath",
          reference: `hotpath:${symbolId}`,
          summary: "symbol | Hot path (5 lines, ~20 tokens)",
        },
        {
          type: "skeleton",
          reference: "file:src/server.ts",
          summary: "File skeleton (700 lines, ~4000 tokens)",
        },
      ],
    });

    assert.deepEqual([...sources.symbolIds].sort(), [
      symbolId,
      otherSymbolId,
    ]);
    assert.deepEqual([...sources.relPaths].sort(), [
      "src/mcp/tools/context.ts",
      "src/server.ts",
    ]);
    assert.equal(sources.evidenceCount, 4);
  });

  it("collects root-level file references", () => {
    const sources = collectContextRawTokenSources({
      finalEvidence: [
        {
          type: "skeleton",
          reference: "file:README.md",
          summary: "File skeleton (80 lines, ~400 tokens)",
        },
        {
          type: "symbolCard",
          reference: "symbol:ignored",
          summary: "config | package.json | fileAlias: package",
        },
      ],
    });

    assert.deepEqual([...sources.relPaths].sort(), [
      "README.md",
      "package.json",
    ]);
  });

  it("collects code window and diagnostic file references", () => {
    const sources = collectContextRawTokenSources({
      finalEvidence: [
        {
          type: "codeWindow",
          reference: "window:src/mcp/tools/context.ts:20",
          summary: "window excerpt",
        },
        {
          type: "diagnostic",
          reference: "diagnostic:README.md:12",
          summary: "diagnostic excerpt",
        },
      ],
    });

    assert.deepEqual([...sources.relPaths].sort(), [
      "README.md",
      "src/mcp/tools/context.ts",
    ]);
  });

  it("does not apply per-result fallback to already resolved evidence", () => {
    const rawTokens = calculateContextRawEquivalentTokens({
      fileRawTokens: 125,
      evidenceCount: 3,
      resolvedEvidenceCount: 3,
    });

    assert.equal(rawTokens, 125);
  });

  it("adds per-result fallback only for unresolved evidence", () => {
    const rawTokens = calculateContextRawEquivalentTokens({
      fileRawTokens: 125,
      evidenceCount: 4,
      resolvedEvidenceCount: 2,
    });

    assert.equal(rawTokens, 725);
  });

  it("does not treat zero-token resolved files as unresolved", () => {
    const rawTokens = calculateContextRawEquivalentTokens({
      fileRawTokens: 0,
      evidenceCount: 2,
      resolvedEvidenceCount: 1,
    });

    assert.equal(rawTokens, 300);
  });

  it("does not use aggregate metrics as a returned-evidence baseline", async () => {
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      metrics: { totalTokens: 10_000 },
      finalEvidence: [
        { type: "searchResult", reference: "search:1", summary: "first" },
      ],
    });

    assert.equal(rawTokens, 300);
  });

  it("counts repeated returned evidence while deduping source files", () => {
    const item = {
      type: "symbolCard",
      reference: `symbol:${"c".repeat(64)}`,
      summary: "function foo | src/foo.ts | fileAlias: Foo",
    };
    const sources = collectContextRawTokenSources({
      finalEvidence: [item, item],
    });

    assert.equal(sources.evidenceCount, 2);
    assert.deepEqual([...sources.relPaths], ["src/foo.ts"]);
  });

  it("applies the unresolved floor per returned evidence occurrence", async () => {
    const item = { type: "searchResult", reference: "search:1", summary: "same" };
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      finalEvidence: [item, item],
    });

    assert.equal(rawTokens, 600);
  });

  it("ignores action evidence because actionsTaken is model-hidden", async () => {
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      finalEvidence: [],
      actionsTaken: [
        {
          evidence: [
            { type: "searchResult", reference: "search:1", summary: "hidden" },
          ],
        },
      ],
    });

    assert.equal(rawTokens, 0);
  });

  it("uses a per-result floor when returned evidence cannot be resolved to files", async () => {
    const rawTokens = await estimateContextRawEquivalentTokens("missing-repo", {
      metrics: { totalTokens: 50 },
      finalEvidence: [
        { type: "searchResult", reference: "search:1", summary: "first" },
        { type: "searchResult", reference: "search:2", summary: "second" },
        { type: "diagnostic", reference: "diag:1", summary: "third" },
      ],
    });

    assert.equal(rawTokens, 900);
  });

  it("uses DB-resolved files for window and diagnostic evidence", async () => {
    const repoId = "context-raw-token-baseline-db-test";
    const graphDbPath = mkdtempSync(
      join(tmpdir(), "sdl-context-raw-baseline-db-"),
    );
    const now = new Date().toISOString();

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);

    try {
      const conn = await getLadybugConn();
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: "/tmp/context-raw-token-baseline",
        configJson: "{}",
        createdAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "file-context",
        repoId,
        relPath: "src/mcp/tools/context.ts",
        contentHash: "hash-context",
        language: "ts",
        byteSize: 4000,
        lastIndexedAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "file-readme",
        repoId,
        relPath: "README.md",
        contentHash: "hash-readme",
        language: "markdown",
        byteSize: 800,
        lastIndexedAt: now,
      });

      const rawTokens = await estimateContextRawEquivalentTokens(repoId, {
        metrics: { totalTokens: 10_000 },
        finalEvidence: [
          {
            type: "codeWindow",
            reference: "window:src/mcp/tools/context.ts:20",
            summary: "window excerpt",
          },
          {
            type: "diagnostic",
            reference: "diagnostic:README.md:12",
            summary: "diagnostic excerpt",
          },
        ],
      });

      assert.equal(rawTokens, 1200);
    } finally {
      await closeLadybugDb();
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });
});
