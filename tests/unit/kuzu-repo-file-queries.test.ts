import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-repo-file-test-db.kuzu");

interface KuzuConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    getAll: () => Promise<Record<string, unknown>[]>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface KuzuDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: KuzuDatabase;
  conn: KuzuConnection;
}> {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(TEST_DB_PATH);
  const conn = new kuzu.Connection(db);

  return { db, conn: conn as unknown as KuzuConnection };
}

async function cleanupTestDb(db: KuzuDatabase, conn: KuzuConnection): Promise<void> {
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

async function exec(conn: KuzuConnection, q: string): Promise<void> {
  const result = await conn.query(q);
  result.close();
}

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("KuzuDB Repo & File Queries", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/kuzu-queries.js");
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("upsertRepo/getRepo round-trip with path normalization", { skip: !kuzuAvailable }, async () => {
    const repoId = "repo-1";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:\\tmp\\my-repo",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    const repo = await queries.getRepo(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.ok(repo);
    assert.strictEqual(repo.repoId, repoId);
    assert.ok(!repo.rootPath.includes("\\"), "rootPath should be normalized");
  });

  it("upsertFile/getFilesByRepo/getFileByRepoPath", { skip: !kuzuAvailable }, async () => {
    const repoId = "repo-2";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:/tmp/repo-2",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-1",
      repoId,
      relPath: "src\\index.ts",
      contentHash: "hash-1",
      language: "ts",
      byteSize: 123,
      lastIndexedAt: null,
    });

    const files = await queries.getFilesByRepo(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0]?.directory, "src");
    assert.ok(!files[0]!.relPath.includes("\\"), "relPath should be normalized");

    const fileByPath = await queries.getFileByRepoPath(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "src\\index.ts",
    );
    assert.ok(fileByPath);
    assert.strictEqual(fileByPath.fileId, "file-1");
  });

  it("getFilesByDirectory and getFileCount", { skip: !kuzuAvailable }, async () => {
    const repoId = "repo-3";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:/tmp/repo-3",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-a",
      repoId,
      relPath: "src/a.ts",
      contentHash: "hash-a",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: null,
    });
    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-b",
      repoId,
      relPath: "src/utils/b.ts",
      contentHash: "hash-b",
      language: "ts",
      byteSize: 2,
      lastIndexedAt: null,
    });
    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-c",
      repoId,
      relPath: "README.md",
      contentHash: "hash-c",
      language: "md",
      byteSize: 3,
      lastIndexedAt: null,
    });

    const count = await queries.getFileCount(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.strictEqual(count, 3);

    const srcFiles = await queries.getFilesByDirectory(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "src",
    );
    assert.strictEqual(srcFiles.length, 1);
    assert.strictEqual(srcFiles[0]?.fileId, "file-a");
  });

  it("deleteFilesByIds cascades to symbols/edges/metrics", { skip: !kuzuAvailable }, async () => {
    const repoId = "repo-4";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:/tmp/repo-4",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-del",
      repoId,
      relPath: "src/del.ts",
      contentHash: "hash-del",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: null,
    });

    await exec(conn, "CREATE (:Symbol {symbolId: 'sym-del-a'})");
    await exec(conn, "CREATE (:Symbol {symbolId: 'sym-del-b'})");
    await exec(conn, "CREATE (:Metrics {symbolId: 'sym-del-a'})");

    await exec(
      conn,
      "MATCH (r:Repo {repoId: 'repo-4'}), (s:Symbol {symbolId: 'sym-del-a'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
    );
    await exec(
      conn,
      "MATCH (r:Repo {repoId: 'repo-4'}), (s:Symbol {symbolId: 'sym-del-b'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
    );
    await exec(
      conn,
      "MATCH (f:File {fileId: 'file-del'}), (s:Symbol {symbolId: 'sym-del-a'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
    );
    await exec(
      conn,
      "MATCH (f:File {fileId: 'file-del'}), (s:Symbol {symbolId: 'sym-del-b'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
    );
    await exec(
      conn,
      "MATCH (a:Symbol {symbolId: 'sym-del-a'}), (b:Symbol {symbolId: 'sym-del-b'}) CREATE (a)-[:DEPENDS_ON]->(b)",
    );

    await queries.deleteFilesByIds(conn as unknown as import("kuzu").Connection, [
      "file-del",
    ]);

    const file = await queries.getFileByRepoPath(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "src/del.ts",
    );
    assert.strictEqual(file, null);

    const symCount = await conn.query(
      "MATCH (s:Symbol) WHERE s.symbolId IN ['sym-del-a','sym-del-b'] RETURN count(s) AS c",
    );
    try {
      const row = await symCount.getNext();
      assert.strictEqual(Number(row.c ?? 0), 0);
    } finally {
      symCount.close();
    }

    const metricsCount = await conn.query(
      "MATCH (m:Metrics {symbolId: 'sym-del-a'}) RETURN count(m) AS c",
    );
    try {
      const row = await metricsCount.getNext();
      assert.strictEqual(Number(row.c ?? 0), 0);
    } finally {
      metricsCount.close();
    }

    const edgeCount = await conn.query(
      "MATCH ()-[d:DEPENDS_ON]->() RETURN count(d) AS c",
    );
    try {
      const row = await edgeCount.getNext();
      assert.strictEqual(Number(row.c ?? 0), 0);
    } finally {
      edgeCount.close();
    }
  });

  it("deleteRepo cascades to files", { skip: !kuzuAvailable }, async () => {
    const repoId = "repo-5";
    await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
      repoId,
      rootPath: "C:/tmp/repo-5",
      configJson: "{}",
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
      fileId: "file-x",
      repoId,
      relPath: "x.ts",
      contentHash: "hash-x",
      language: "ts",
      byteSize: 1,
      lastIndexedAt: null,
    });

    await queries.deleteRepo(conn as unknown as import("kuzu").Connection, repoId);

    const repo = await queries.getRepo(conn as unknown as import("kuzu").Connection, repoId);
    assert.strictEqual(repo, null);
  });
});
