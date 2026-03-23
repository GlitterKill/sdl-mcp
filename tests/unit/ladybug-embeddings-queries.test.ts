import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createSchema } from "../../dist/db/ladybug-schema.js";
import {
  upsertSymbolEmbedding,
  getSymbolEmbedding,
  getSymbolEmbeddings,
  deleteSymbolEmbeddings,
  upsertSummaryCache,
  getSummaryCache,
  getSummaryCaches,
  upsertSyncArtifact,
  getSyncArtifact,
  getSyncArtifactsByRepo,
  insertSymbolReference,
  insertSymbolReferences,
  getTestRefsForSymbol,
  deleteSymbolReferencesByFileId,
  type SymbolEmbeddingRow,
  type SummaryCacheRow,
  type SyncArtifactRow,
  type SymbolReferenceRow,
} from "../../dist/db/ladybug-embeddings.js";
import { upsertRepo, upsertFile } from "../../dist/db/ladybug-queries.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-embeddings-queries-test-db.lbug");

interface LadybugConnection {
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: LadybugConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn: conn as unknown as LadybugConnection };
}

async function cleanupTestDb(
  db: LadybugDatabase,
  conn: LadybugConnection,
): Promise<void> {
  try {
    await conn.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  try {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  } catch {}
}

const repoId = "repo-embeddings";
const fileId = "repo-embeddings:src/main.ts";
const now = "2026-03-18T12:00:00.000Z";

describe("ladybug-embeddings queries", () => {
  let db: LadybugDatabase;
  let conn: import("kuzu").Connection;

  beforeEach(async () => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
    process.env.SDL_GRAPH_DB_PATH = TEST_DB_PATH;

    const created = await createTestDb();
    db = created.db;
    conn = created.conn as unknown as import("kuzu").Connection;

    await createSchema(conn);

    await upsertRepo(conn, {
      repoId,
      rootPath: "C:/tmp/repo-embeddings",
      configJson: "{}",
      createdAt: now,
    });

    await upsertFile(conn, {
      fileId,
      repoId,
      relPath: "src/main.ts",
      contentHash: "filehash",
      language: "typescript",
      byteSize: 100,
      lastIndexedAt: null,
    });
  });

  afterEach(async () => {
    await cleanupTestDb(db, conn as unknown as LadybugConnection);
  });

  // --- Symbol Embeddings ---

  function makeEmbedding(symbolId: string): SymbolEmbeddingRow {
    return {
      symbolId,
      model: "nomic-embed-text-v1.5",
      embeddingVector: JSON.stringify([0.1, 0.2, 0.3]),
      version: "v1",
      cardHash: "hash-" + symbolId,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("upsertSymbolEmbedding and getSymbolEmbedding round-trips", async () => {
    await upsertSymbolEmbedding(conn, makeEmbedding("sym-emb-1"));

    const found = await getSymbolEmbedding(conn, "sym-emb-1");
    assert.ok(found);
    assert.strictEqual(found.symbolId, "sym-emb-1");
    assert.strictEqual(found.model, "nomic-embed-text-v1.5");
    assert.strictEqual(found.version, "v1");
  });

  it("getSymbolEmbedding returns null for unknown symbolId", async () => {
    const found = await getSymbolEmbedding(conn, "missing-sym");
    assert.strictEqual(found, null);
  });

  it("getSymbolEmbeddings returns map of embeddings", async () => {
    await upsertSymbolEmbedding(conn, makeEmbedding("sym-batch-1"));
    await upsertSymbolEmbedding(conn, makeEmbedding("sym-batch-2"));

    const result = await getSymbolEmbeddings(conn, [
      "sym-batch-1",
      "sym-batch-2",
      "sym-batch-missing",
    ]);

    assert.strictEqual(result.size, 2);
    assert.ok(result.has("sym-batch-1"));
    assert.ok(result.has("sym-batch-2"));
    assert.ok(!result.has("sym-batch-missing"));
  });

  it("getSymbolEmbeddings returns empty map for empty input", async () => {
    const result = await getSymbolEmbeddings(conn, []);
    assert.strictEqual(result.size, 0);
  });

  it("deleteSymbolEmbeddings removes specified embeddings", async () => {
    await upsertSymbolEmbedding(conn, makeEmbedding("sym-del-1"));
    await upsertSymbolEmbedding(conn, makeEmbedding("sym-del-2"));

    await deleteSymbolEmbeddings(conn, ["sym-del-1"]);

    const found1 = await getSymbolEmbedding(conn, "sym-del-1");
    const found2 = await getSymbolEmbedding(conn, "sym-del-2");
    assert.strictEqual(found1, null);
    assert.ok(found2);
  });

  it("deleteSymbolEmbeddings is no-op for empty array", async () => {
    await assert.doesNotReject(deleteSymbolEmbeddings(conn, []));
  });

  // --- Summary Cache ---

  function makeSummary(symbolId: string): SummaryCacheRow {
    return {
      symbolId,
      summary: `Summary for ${symbolId}`,
      provider: "anthropic",
      model: "claude-3",
      cardHash: "card-" + symbolId,
      costUsd: 0.003,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("upsertSummaryCache and getSummaryCache round-trips", async () => {
    await upsertSummaryCache(conn, makeSummary("sym-sum-1"));

    const found = await getSummaryCache(conn, "sym-sum-1");
    assert.ok(found);
    assert.strictEqual(found.symbolId, "sym-sum-1");
    assert.strictEqual(found.provider, "anthropic");
    assert.strictEqual(found.summary, "Summary for sym-sum-1");
  });

  it("getSummaryCache returns null for unknown symbolId", async () => {
    const found = await getSummaryCache(conn, "missing-sym");
    assert.strictEqual(found, null);
  });

  it("getSummaryCaches returns map", async () => {
    await upsertSummaryCache(conn, makeSummary("sym-sc-1"));
    await upsertSummaryCache(conn, makeSummary("sym-sc-2"));

    const result = await getSummaryCaches(conn, ["sym-sc-1", "sym-sc-2"]);
    assert.strictEqual(result.size, 2);
    assert.ok(result.has("sym-sc-1"));
    assert.ok(result.has("sym-sc-2"));
  });

  it("getSummaryCaches returns empty map for empty input", async () => {
    const result = await getSummaryCaches(conn, []);
    assert.strictEqual(result.size, 0);
  });

  // --- Sync Artifacts ---

  function makeArtifact(artifactId: string): SyncArtifactRow {
    return {
      artifactId,
      repoId,
      versionId: "v1",
      commitSha: "abc123",
      branch: "main",
      artifactHash: "art-hash-" + artifactId,
      compressedData: "base64data",
      createdAt: now,
      sizeBytes: 1024,
    };
  }

  it("upsertSyncArtifact and getSyncArtifact round-trips", async () => {
    await upsertSyncArtifact(conn, makeArtifact("art-1"));

    const found = await getSyncArtifact(conn, "art-1");
    assert.ok(found);
    assert.strictEqual(found.artifactId, "art-1");
    assert.strictEqual(found.repoId, repoId);
    assert.strictEqual(found.commitSha, "abc123");
  });

  it("getSyncArtifact returns null for unknown artifactId", async () => {
    const found = await getSyncArtifact(conn, "missing-art");
    assert.strictEqual(found, null);
  });

  it("getSyncArtifactsByRepo returns artifacts for repo", async () => {
    await upsertSyncArtifact(conn, makeArtifact("art-repo-1"));
    await upsertSyncArtifact(conn, makeArtifact("art-repo-2"));

    const results = await getSyncArtifactsByRepo(conn, repoId, 10);
    assert.strictEqual(results.length, 2);
  });

  it("getSyncArtifactsByRepo respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await upsertSyncArtifact(
        conn,
        makeArtifact(`art-lim-${i}`),
      );
    }

    const results = await getSyncArtifactsByRepo(conn, repoId, 2);
    assert.strictEqual(results.length, 2);
  });

  // --- Symbol References ---

  function makeRef(refId: string, overrides: Partial<SymbolReferenceRow> = {}): SymbolReferenceRow {
    return {
      refId,
      repoId,
      symbolName: "myFunction",
      fileId,
      lineNumber: 42,
      createdAt: now,
      ...overrides,
    };
  }

  it("insertSymbolReference and getTestRefsForSymbol round-trips", async () => {
    await insertSymbolReference(conn, makeRef("ref-1"));

    const refs = await getTestRefsForSymbol(conn, repoId, "myFunction");
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0], "src/main.ts");
  });

  it("insertSymbolReferences inserts batch", async () => {
    await insertSymbolReferences(conn, [
      makeRef("ref-batch-1", { symbolName: "batchFn" }),
      makeRef("ref-batch-2", { symbolName: "batchFn" }),
    ]);

    const refs = await getTestRefsForSymbol(conn, repoId, "batchFn");
    // Both refs point to same file, so DISTINCT should return 1
    assert.strictEqual(refs.length, 1);
  });

  it("insertSymbolReferences is no-op for empty array", async () => {
    await assert.doesNotReject(insertSymbolReferences(conn, []));
  });

  it("deleteSymbolReferencesByFileId removes refs for given fileId", async () => {
    await insertSymbolReference(conn, makeRef("ref-del-1"));

    await deleteSymbolReferencesByFileId(conn, fileId);

    const refs = await getTestRefsForSymbol(conn, repoId, "myFunction");
    assert.strictEqual(refs.length, 0);
  });
});
