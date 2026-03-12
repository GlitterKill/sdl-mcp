import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";

import {
  initLadybugDb,
  closeLadybugDb,
  getLadybugConn,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  getEmbeddingProvider,
  refreshSymbolEmbeddings,
  rerankByEmbeddings,
} from "../../dist/indexer/embeddings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Semantic Embedding Pipeline", () => {
  const testDir = join(__dirname, "test-semantic-embedding");
  const graphDbPath = join(testDir, "graph");
  const repoId = "embed-test-repo";

  const symbols: ladybugDb.SymbolRow[] = [
    {
      symbolId: "sym-auth",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "authenticateUser",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 10,
      rangeEndCol: 1,
      astFingerprint: "fp-auth",
      signatureJson: JSON.stringify(
        "(username: string, password: string) => Promise<User>",
      ),
      summary: "Authenticate a user with username and password credentials",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-fetch",
      repoId,
      fileId: "file1",
      kind: "function",
      name: "fetchUserData",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 15,
      rangeStartCol: 0,
      rangeEndLine: 25,
      rangeEndCol: 1,
      astFingerprint: "fp-fetch",
      signatureJson: JSON.stringify("(userId: string) => Promise<UserData>"),
      summary: "Fetch user profile data from the database",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
    {
      symbolId: "sym-render",
      repoId,
      fileId: "file2",
      kind: "function",
      name: "renderDashboard",
      exported: true,
      visibility: "public",
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 20,
      rangeEndCol: 1,
      astFingerprint: "fp-render",
      signatureJson: JSON.stringify("(data: DashboardData) => JSX.Element"),
      summary: "Render the main dashboard UI component",
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(async () => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: "/fake/embed-repo",
      configJson: JSON.stringify({
        repoId,
        rootPath: "/fake/embed-repo",
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
      fileId: "file1",
      repoId,
      relPath: "src/auth.ts",
      contentHash: "hash1",
      language: "ts",
      byteSize: 500,
      lastIndexedAt: now,
    });
    await ladybugDb.upsertFile(conn, {
      fileId: "file2",
      repoId,
      relPath: "src/dashboard.ts",
      contentHash: "hash2",
      language: "ts",
      byteSize: 800,
      lastIndexedAt: now,
    });

    for (const sym of symbols) {
      await ladybugDb.upsertSymbol(conn, sym);
    }
  });

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("mock provider generates embeddings with expected dimension", async () => {
    const provider = getEmbeddingProvider("mock");
    const embeddings = await provider.embed([
      "authenticate user login",
      "render dashboard view",
    ]);
    assert.strictEqual(embeddings.length, 2);
    assert.strictEqual(embeddings[0].length, 64);
    assert.strictEqual(embeddings[1].length, 64);
  });

  it("refreshSymbolEmbeddings creates embeddings for all symbols", async () => {
    const result = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });

    assert.strictEqual(result.embedded, 3);
    assert.strictEqual(result.skipped, 0);

    // Verify embeddings exist in DB
    // Mock provider now correctly stores as "mock-fallback" so embeddings
    // are not confused with real model vectors on provider switch.
    const conn = await getLadybugConn();
    for (const sym of symbols) {
      const embedding = await ladybugDb.getSymbolEmbedding(conn, sym.symbolId);
      assert.ok(embedding, `Embedding should exist for ${sym.symbolId}`);
      assert.strictEqual(embedding.model, "mock-fallback");
      assert.ok(embedding.embeddingVector.length > 0);
    }
  });

  it("refreshSymbolEmbeddings skips unchanged symbols", async () => {
    // First run — embeds all
    const first = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });
    assert.strictEqual(first.embedded, 3);
    assert.strictEqual(first.skipped, 0);

    // Second run with same symbols — should skip all
    const second = await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });
    assert.strictEqual(second.embedded, 0);
    assert.strictEqual(second.skipped, 3);
  });

  it("rerankByEmbeddings reranks based on semantic similarity", async () => {
    // Embed all symbols first
    await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });

    const candidates = symbols.map((sym, i) => ({
      symbol: sym,
      lexicalScore: 1.0 - i * 0.1,
    }));

    const reranked = await rerankByEmbeddings({
      query: "user authentication login",
      symbols: candidates,
      provider: "mock",
      alpha: 0.5,
      model: "all-MiniLM-L6-v2",
    });

    assert.strictEqual(reranked.length, 3);
    // Each result should have all score fields
    for (const item of reranked) {
      assert.strictEqual(typeof item.lexicalScore, "number");
      assert.strictEqual(typeof item.semanticScore, "number");
      assert.strictEqual(typeof item.finalScore, "number");
      assert.ok(item.finalScore >= 0, "finalScore should be non-negative");
    }
    // Results should be sorted by finalScore descending
    for (let i = 1; i < reranked.length; i++) {
      assert.ok(
        reranked[i - 1].finalScore >= reranked[i].finalScore,
        "Results should be sorted by finalScore descending",
      );
    }
  });

  it("countSymbolEmbeddings returns correct count", async () => {
    const conn = await getLadybugConn();

    // Before embedding
    const countBefore = await ladybugDb.countSymbolEmbeddings(conn, repoId);
    assert.strictEqual(countBefore, 0);

    // After embedding
    await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });

    const countAfter = await ladybugDb.countSymbolEmbeddings(conn, repoId);
    assert.strictEqual(countAfter, 3);
  });

  it("rerankByEmbeddings handles missing embeddings by generating on-the-fly", async () => {
    // Don't pre-embed — rerankByEmbeddings should handle missing embeddings
    const candidates = symbols.slice(0, 2).map((sym, i) => ({
      symbol: sym,
      lexicalScore: 1.0 - i * 0.2,
    }));

    const reranked = await rerankByEmbeddings({
      query: "authenticate",
      symbols: candidates,
      provider: "mock",
      alpha: 0.6,
      model: "all-MiniLM-L6-v2",
    });

    assert.strictEqual(reranked.length, 2);
    // All should have valid scores even though they were generated on-the-fly
    for (const item of reranked) {
      assert.strictEqual(typeof item.semanticScore, "number");
      assert.ok(
        !Number.isNaN(item.semanticScore),
        "semanticScore should not be NaN",
      );
    }
  });

  it("alpha=1 makes final score equal to lexical score", async () => {
    await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });

    const candidates = symbols.map((sym, i) => ({
      symbol: sym,
      lexicalScore: 1.0 - i * 0.3,
    }));

    const reranked = await rerankByEmbeddings({
      query: "test",
      symbols: candidates,
      provider: "mock",
      alpha: 1.0,
      model: "all-MiniLM-L6-v2",
    });

    for (let i = 0; i < reranked.length; i++) {
      assert.ok(
        Math.abs(
          reranked[i].finalScore -
            candidates.find(
              (c) => c.symbol.symbolId === reranked[i].symbol.symbolId,
            )!.lexicalScore,
        ) < 0.001,
        `With alpha=1, finalScore should equal lexicalScore`,
      );
    }
  });

  it("alpha=0 makes final score equal to semantic score", async () => {
    await refreshSymbolEmbeddings({
      repoId,
      provider: "mock",
      model: "all-MiniLM-L6-v2",
      symbols,
    });

    const candidates = symbols.map((sym, i) => ({
      symbol: sym,
      lexicalScore: 1.0 - i * 0.3,
    }));

    const reranked = await rerankByEmbeddings({
      query: "test",
      symbols: candidates,
      provider: "mock",
      alpha: 0.0,
      model: "all-MiniLM-L6-v2",
    });

    for (let i = 0; i < reranked.length; i++) {
      assert.ok(
        Math.abs(reranked[i].finalScore - reranked[i].semanticScore) < 0.001,
        `With alpha=0, finalScore should equal semanticScore`,
      );
    }
  });
});
