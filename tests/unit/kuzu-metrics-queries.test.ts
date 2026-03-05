import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-metrics-test-db");

interface KuzuConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
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
  mkdirSync(TEST_DB_PATH, { recursive: true });

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
  await exec(conn, `
    CREATE NODE TABLE IF NOT EXISTS Repo (
      repoId STRING PRIMARY KEY,
      rootPath STRING,
      configJson STRING,
      createdAt STRING
    )
  `);
  await exec(conn, `
    CREATE NODE TABLE IF NOT EXISTS File (
      fileId STRING PRIMARY KEY,
      relPath STRING,
      contentHash STRING,
      language STRING,
      byteSize INT64,
      lastIndexedAt STRING,
      directory STRING
    )
  `);
  await exec(conn, `
    CREATE NODE TABLE IF NOT EXISTS Symbol (
      symbolId STRING PRIMARY KEY,
      kind STRING,
      name STRING,
      exported BOOLEAN,
      visibility STRING,
      language STRING,
      rangeStartLine INT64,
      rangeStartCol INT64,
      rangeEndLine INT64,
      rangeEndCol INT64,
      astFingerprint STRING,
      signatureJson STRING,
      summary STRING,
      invariantsJson STRING,
      sideEffectsJson STRING,
      updatedAt STRING
    )
  `);
  await exec(conn, `
    CREATE NODE TABLE IF NOT EXISTS Metrics (
      symbolId STRING PRIMARY KEY,
      fanIn INT64 DEFAULT 0,
      fanOut INT64 DEFAULT 0,
      churn30d INT64 DEFAULT 0,
      testRefsJson STRING,
      canonicalTestJson STRING,
      updatedAt STRING
    )
  `);
  await exec(conn,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
  );
  await exec(conn,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
  );
  await exec(conn, `
    CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (
      FROM Symbol TO Symbol,
      edgeType STRING DEFAULT 'call',
      weight DOUBLE DEFAULT 1.0,
      confidence DOUBLE DEFAULT 1.0,
      resolution STRING DEFAULT 'exact',
      provenance STRING,
      createdAt STRING
    )
  `);
}

describe("KuzuDB Metrics Queries", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let kuzuAvailable = true;
  let queries: typeof import("../../dist/db/kuzu-queries.js");

  beforeEach(async () => {
    try {
      const testDb = await createTestDb();
      db = testDb.db;
      conn = testDb.conn;
      await setupSchema(conn);
      queries = await import("../../dist/db/kuzu-queries.js");
    } catch (err) {
      kuzuAvailable = false;
      console.log("KuzuDB not available, skipping tests:", err);
    }
  });

  afterEach(async () => {
    if (db && conn) {
      await cleanupTestDb(db, conn);
    }
  });

  describe("upsertMetrics", { skip: !kuzuAvailable }, () => {
    it("should insert new metrics", async () => {
      const metrics = {
        symbolId: "sym-1",
        fanIn: 5,
        fanOut: 3,
        churn30d: 10,
        testRefsJson: "[]",
        canonicalTestJson: null,
        updatedAt: "2024-01-01T00:00:00Z",
      };

      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        metrics,
      );

      const result = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "sym-1",
      );
      assert.ok(result);
      assert.strictEqual(result.symbolId, "sym-1");
      assert.strictEqual(result.fanIn, 5);
      assert.strictEqual(result.fanOut, 3);
      assert.strictEqual(result.churn30d, 10);
    });

    it("should update existing metrics (upsert)", async () => {
      const metrics1 = {
        symbolId: "sym-2",
        fanIn: 5,
        fanOut: 3,
        churn30d: 10,
        testRefsJson: "[]",
        canonicalTestJson: null,
        updatedAt: "2024-01-01T00:00:00Z",
      };

      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        metrics1,
      );

      const metrics2 = {
        ...metrics1,
        fanIn: 15,
        fanOut: 8,
        updatedAt: "2024-01-02T00:00:00Z",
      };

      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        metrics2,
      );

      const result = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "sym-2",
      );
      assert.ok(result);
      assert.strictEqual(result.fanIn, 15);
      assert.strictEqual(result.fanOut, 8);
    });

    it("should handle special characters in JSON fields", async () => {
      const metrics = {
        symbolId: "sym-3",
        fanIn: 0,
        fanOut: 0,
        churn30d: 0,
        testRefsJson: '["test path"]',
        canonicalTestJson: '{"key": "value"}',
        updatedAt: "2024-01-01T00:00:00Z",
      };

      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        metrics,
      );

      const result = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "sym-3",
      );
      assert.ok(result);
      assert.strictEqual(result.testRefsJson, '["test path"]');
      assert.strictEqual(result.canonicalTestJson, '{"key": "value"}');
    });
  });

  describe("getMetrics", { skip: !kuzuAvailable }, () => {
    it("should return null for non-existent symbol", async () => {
      const result = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "non-existent",
      );
      assert.strictEqual(result, null);
    });

    it("should return metrics for existing symbol", async () => {
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "sym-4",
          fanIn: 42,
          fanOut: 17,
          churn30d: 5,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );

      const result = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "sym-4",
      );
      assert.ok(result);
      assert.strictEqual(result.fanIn, 42);
      assert.strictEqual(result.fanOut, 17);
    });
  });

  describe("getMetricsBySymbolIds", { skip: !kuzuAvailable }, () => {
    it("should return empty map for empty input", async () => {
      const result = await queries.getMetricsBySymbolIds(
        conn as unknown as import("kuzu").Connection,
        [],
      );
      assert.strictEqual(result.size, 0);
    });

    it("should batch fetch metrics for multiple symbols", async () => {
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "batch-1",
          fanIn: 1,
          fanOut: 2,
          churn30d: 3,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "batch-2",
          fanIn: 4,
          fanOut: 5,
          churn30d: 6,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "batch-3",
          fanIn: 7,
          fanOut: 8,
          churn30d: 9,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );

      const result = await queries.getMetricsBySymbolIds(
        conn as unknown as import("kuzu").Connection,
        ["batch-1", "batch-2", "batch-3", "non-existent"],
      );

      assert.strictEqual(result.size, 3);
      assert.strictEqual(result.get("batch-1")?.fanIn, 1);
      assert.strictEqual(result.get("batch-2")?.fanIn, 4);
      assert.strictEqual(result.get("batch-3")?.fanIn, 7);
      assert.strictEqual(result.has("non-existent"), false);
    });

    it("should handle 500+ IDs (batch fetch)", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 550; i++) {
        const id = `large-batch-${i}`;
        ids.push(id);
        await queries.upsertMetrics(
          conn as unknown as import("kuzu").Connection,
          {
            symbolId: id,
            fanIn: i,
            fanOut: i * 2,
            churn30d: 0,
            testRefsJson: "[]",
            canonicalTestJson: null,
            updatedAt: "2024-01-01T00:00:00Z",
          },
        );
      }

      const result = await queries.getMetricsBySymbolIds(
        conn as unknown as import("kuzu").Connection,
        ids,
      );

      assert.strictEqual(result.size, 550);
      assert.strictEqual(result.get("large-batch-0")?.fanIn, 0);
      assert.strictEqual(result.get("large-batch-549")?.fanIn, 549);
    });
  });

  describe("getTopSymbolsByFanIn", { skip: !kuzuAvailable }, () => {
    beforeEach(async () => {
      await exec(conn, `
        CREATE (r:Repo {repoId: 'top-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})
      `);
      await exec(conn, `
        CREATE (f:File {fileId: 'file-1', relPath: 'src/test.ts', contentHash: 'abc', language: 'typescript', byteSize: 100, lastIndexedAt: '2024-01-01', directory: 'src'})
      `);

      for (let i = 1; i <= 5; i++) {
        await exec(conn, `
          CREATE (s:Symbol {symbolId: 'top-sym-${i}', kind: 'function', name: 'func${i}', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: ${i}, rangeStartCol: 0, rangeEndLine: ${i + 1}, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
        `);
        await exec(conn, `
          MATCH (s:Symbol {symbolId: 'top-sym-${i}'}), (r:Repo {repoId: 'top-test-repo'})
          CREATE (s)-[:SYMBOL_IN_REPO]->(r)
        `);
        await exec(conn, `
          MATCH (s:Symbol {symbolId: 'top-sym-${i}'}), (f:File {fileId: 'file-1'})
          CREATE (s)-[:SYMBOL_IN_FILE]->(f)
        `);
      }

      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "top-sym-1",
          fanIn: 100,
          fanOut: 5,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "top-sym-2",
          fanIn: 50,
          fanOut: 3,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "top-sym-3",
          fanIn: 75,
          fanOut: 4,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "top-sym-4",
          fanIn: 25,
          fanOut: 2,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "top-sym-5",
          fanIn: 10,
          fanOut: 1,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );
    });

    it("should return symbols ordered by fanIn descending", async () => {
      const result = await queries.getTopSymbolsByFanIn(
        conn as unknown as import("kuzu").Connection,
        "top-test-repo",
        10,
      );

      assert.strictEqual(result.length, 5);
      assert.strictEqual(result[0].symbolId, "top-sym-1");
      assert.strictEqual(result[0].fanIn, 100);
      assert.strictEqual(result[1].symbolId, "top-sym-3");
      assert.strictEqual(result[1].fanIn, 75);
      assert.strictEqual(result[2].symbolId, "top-sym-2");
      assert.strictEqual(result[2].fanIn, 50);
    });

    it("should respect limit parameter", async () => {
      const result = await queries.getTopSymbolsByFanIn(
        conn as unknown as import("kuzu").Connection,
        "top-test-repo",
        2,
      );

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].fanIn, 100);
      assert.strictEqual(result[1].fanIn, 75);
    });

    it("should return empty array for non-existent repo", async () => {
      const result = await queries.getTopSymbolsByFanIn(
        conn as unknown as import("kuzu").Connection,
        "non-existent-repo",
        10,
      );

      assert.strictEqual(result.length, 0);
    });
  });

  describe("computeFanInOut", { skip: !kuzuAvailable }, () => {
    beforeEach(async () => {
      await exec(conn, `
        CREATE (s1:Symbol {symbolId: 'fan-sym-1', kind: 'function', name: 'func1', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `);
      await exec(conn, `
        CREATE (s2:Symbol {symbolId: 'fan-sym-2', kind: 'function', name: 'func2', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `);
      await exec(conn, `
        CREATE (s3:Symbol {symbolId: 'fan-sym-3', kind: 'function', name: 'func3', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `);

      await exec(conn, `
        MATCH (a:Symbol {symbolId: 'fan-sym-1'}), (b:Symbol {symbolId: 'fan-sym-2'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `);
      await exec(conn, `
        MATCH (a:Symbol {symbolId: 'fan-sym-3'}), (b:Symbol {symbolId: 'fan-sym-2'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `);
      await exec(conn, `
        MATCH (a:Symbol {symbolId: 'fan-sym-2'}), (b:Symbol {symbolId: 'fan-sym-3'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `);
    });

    it("should compute fanIn (incoming DEPENDS_ON edges)", async () => {
      const result = await queries.computeFanInOut(
        conn as unknown as import("kuzu").Connection,
        "fan-sym-2",
      );
      assert.strictEqual(result.fanIn, 2);
    });

    it("should compute fanOut (outgoing DEPENDS_ON edges)", async () => {
      const result = await queries.computeFanInOut(
        conn as unknown as import("kuzu").Connection,
        "fan-sym-2",
      );
      assert.strictEqual(result.fanOut, 1);
    });

    it("should return 0 for symbol with no edges", async () => {
      const result = await queries.computeFanInOut(
        conn as unknown as import("kuzu").Connection,
        "fan-sym-1",
      );
      assert.strictEqual(result.fanIn, 0);
      assert.strictEqual(result.fanOut, 1);
    });

    it("should return 0,0 for non-existent symbol", async () => {
      const result = await queries.computeFanInOut(
        conn as unknown as import("kuzu").Connection,
        "non-existent",
      );
      assert.strictEqual(result.fanIn, 0);
      assert.strictEqual(result.fanOut, 0);
    });
  });

  describe("batchComputeFanInOut", { skip: !kuzuAvailable }, () => {
    beforeEach(async () => {
      for (let i = 1; i <= 10; i++) {
        await exec(conn, `
          CREATE (s:Symbol {symbolId: 'batch-fan-sym-${i}', kind: 'function', name: 'func${i}', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: ${i}, rangeStartCol: 0, rangeEndLine: ${i + 1}, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
        `);
      }

      for (let i = 2; i <= 10; i++) {
        await exec(conn, `
          MATCH (a:Symbol {symbolId: 'batch-fan-sym-1'}), (b:Symbol {symbolId: 'batch-fan-sym-${i}'})
          CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
        `);
      }
    });

    it("should return empty map for empty input", async () => {
      const result = await queries.batchComputeFanInOut(
        conn as unknown as import("kuzu").Connection,
        [],
      );
      assert.strictEqual(result.size, 0);
    });

    it("should batch compute fanIn/fanOut for multiple symbols", async () => {
      const ids = ["batch-fan-sym-1", "batch-fan-sym-2", "batch-fan-sym-3"];
      const result = await queries.batchComputeFanInOut(
        conn as unknown as import("kuzu").Connection,
        ids,
      );

      assert.strictEqual(result.size, 3);
      assert.strictEqual(result.get("batch-fan-sym-1")?.fanIn, 0);
      assert.strictEqual(result.get("batch-fan-sym-1")?.fanOut, 9);
      assert.strictEqual(result.get("batch-fan-sym-2")?.fanIn, 1);
      assert.strictEqual(result.get("batch-fan-sym-2")?.fanOut, 0);
    });

    it("should handle 500+ IDs (batch compute)", async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 550; i++) {
        ids.push(`batch-fan-sym-${i}`);
      }

      const result = await queries.batchComputeFanInOut(
        conn as unknown as import("kuzu").Connection,
        ids,
      );

      assert.strictEqual(result.size, 550);
      assert.strictEqual(result.get("batch-fan-sym-1")?.fanOut, 9);
    });
  });
});
