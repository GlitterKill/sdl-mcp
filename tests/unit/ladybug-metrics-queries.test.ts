import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-metrics-test-db.lbug");

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
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

async function exec(conn: LadybugConnection, q: string): Promise<void> {
  const result = await conn.query(q);
  result.close();
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  await exec(
    conn,
    `
    CREATE NODE TABLE IF NOT EXISTS Repo (
      repoId STRING PRIMARY KEY,
      rootPath STRING,
      configJson STRING,
      createdAt STRING
    )
  `,
  );
  await exec(
    conn,
    `
    CREATE NODE TABLE IF NOT EXISTS File (
      fileId STRING PRIMARY KEY,
      relPath STRING,
      contentHash STRING,
      language STRING,
      byteSize INT64,
      lastIndexedAt STRING,
      directory STRING
    )
  `,
  );
  await exec(
    conn,
    `
    CREATE NODE TABLE IF NOT EXISTS Symbol (
      symbolId STRING PRIMARY KEY,
      repoId STRING,
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
      symbolStatus STRING DEFAULT 'real',
      updatedAt STRING
    )
  `,
  );
  await exec(
    conn,
    `
    CREATE NODE TABLE IF NOT EXISTS Metrics (
      symbolId STRING PRIMARY KEY,
      fanIn INT64 DEFAULT 0,
      fanOut INT64 DEFAULT 0,
      churn30d INT64 DEFAULT 0,
      testRefsJson STRING,
      canonicalTestJson STRING,
      pageRank DOUBLE DEFAULT 0.0,
      kCore INT64 DEFAULT 0,
      updatedAt STRING
    )
  `,
  );
  await exec(
    conn,
    `
    CREATE NODE TABLE IF NOT EXISTS MetricsFingerprint (
      repoId STRING PRIMARY KEY,
      metricsHash STRING,
      rowCount INT64,
      updatedAt STRING
    )
  `,
  );
  await exec(
    conn,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
  );
  await exec(
    conn,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
  );
  await exec(
    conn,
    `
    CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (
      FROM Symbol TO Symbol,
      edgeType STRING DEFAULT 'call',
      weight DOUBLE DEFAULT 1.0,
      confidence DOUBLE DEFAULT 1.0,
      resolution STRING DEFAULT 'exact',
      provenance STRING,
      createdAt STRING
    )
  `,
  );
}

describe("LadybugDB Metrics Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let ladybugAvailable = true;
  let queries: typeof import("../../dist/db/ladybug-queries.js");

  beforeEach(async () => {
    try {
      const testDb = await createTestDb();
      db = testDb.db;
      conn = testDb.conn;
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch (err) {
      ladybugAvailable = false;
      console.log("LadybugDB not available, skipping tests:", err);
    }
  });

  afterEach(async () => {
    if (db && conn) {
      await cleanupTestDb(db, conn);
    }
  });

  describe("upsertMetrics", { skip: !ladybugAvailable }, () => {
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

    it("should replace a full repo metrics set with COPY", async () => {
      await exec(
        conn,
        `CREATE (r:Repo {repoId: 'metrics-replace-a', rootPath: '/a', configJson: '{}', createdAt: '2024-01-01'})`,
      );
      await exec(
        conn,
        `CREATE (r:Repo {repoId: 'metrics-replace-b', rootPath: '/b', configJson: '{}', createdAt: '2024-01-01'})`,
      );
      for (const [symbolId, repoId] of [
        ["replace-a-1", "metrics-replace-a"],
        ["replace-a-2", "metrics-replace-a"],
        ["replace-b-1", "metrics-replace-b"],
      ] as const) {
        await exec(
          conn,
          `CREATE (s:Symbol {symbolId: '${symbolId}', repoId: '${repoId}', symbolStatus: 'real'})`,
        );
        await exec(
          conn,
          `MATCH (s:Symbol {symbolId: '${symbolId}'}), (r:Repo {repoId: '${repoId}'})
           CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
        );
        await queries.upsertMetrics(
          conn as unknown as import("kuzu").Connection,
          {
            symbolId,
            fanIn: 1,
            fanOut: 1,
            churn30d: 1,
            testRefsJson: "[]",
            canonicalTestJson: null,
            pageRank: 0.5,
            kCore: 3,
            updatedAt: "2024-01-01T00:00:00Z",
          },
        );
      }

      await queries.replaceMetricsForRepoCopy(
        conn as unknown as import("kuzu").Connection,
        "metrics-replace-a",
        [
          {
            symbolId: "replace-a-1",
            fanIn: 10,
            fanOut: 20,
            churn30d: 30,
            testRefsJson: '["a,test","b"]',
            canonicalTestJson: '{"path":"tests/example.test.ts"}',
            pageRank: 0,
            kCore: 0,
            updatedAt: "2024-01-02T00:00:00Z",
          },
          {
            symbolId: "replace-a-2",
            fanIn: 0,
            fanOut: 2,
            churn30d: 0,
            testRefsJson: "[]",
            canonicalTestJson: null,
            pageRank: 0,
            kCore: 0,
            updatedAt: "2024-01-02T00:00:00Z",
          },
        ],
      );

      const replaced = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "replace-a-1",
      );
      const nullCanonical = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "replace-a-2",
      );
      const untouchedOtherRepo = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "replace-b-1",
      );
      assert.ok(replaced);
      assert.strictEqual(replaced.fanIn, 10);
      assert.strictEqual(replaced.testRefsJson, '["a,test","b"]');
      assert.strictEqual(
        replaced.canonicalTestJson,
        '{"path":"tests/example.test.ts"}',
      );
      assert.ok(nullCanonical);
      assert.strictEqual(nullCanonical.canonicalTestJson, null);
      assert.ok(untouchedOtherRepo);
      assert.strictEqual(untouchedOtherRepo.fanIn, 1);
      assert.strictEqual(untouchedOtherRepo.pageRank, 0.5);
      assert.strictEqual(untouchedOtherRepo.kCore, 3);
    });
  });

  describe("metrics fingerprint", { skip: !ladybugAvailable }, () => {
    it("stores, replaces, reads, and deletes a repo metrics fingerprint", async () => {
      const queryModule = queries as unknown as Record<string, unknown>;
      assert.equal(typeof queryModule.getMetricsFingerprint, "function");
      assert.equal(typeof queryModule.upsertMetricsFingerprint, "function");
      assert.equal(typeof queryModule.deleteMetricsFingerprint, "function");

      const getMetricsFingerprint = queryModule.getMetricsFingerprint as (
        conn: unknown,
        repoId: string,
      ) => Promise<{
        repoId: string;
        metricsHash: string;
        rowCount: number;
        updatedAt: string;
      } | null>;
      const upsertMetricsFingerprint =
        queryModule.upsertMetricsFingerprint as (
          conn: unknown,
          row: {
            repoId: string;
            metricsHash: string;
            rowCount: number;
            updatedAt: string;
          },
        ) => Promise<void>;
      const deleteMetricsFingerprint =
        queryModule.deleteMetricsFingerprint as (
          conn: unknown,
          repoId: string,
        ) => Promise<void>;

      assert.equal(
        await getMetricsFingerprint(conn, "fingerprint-repo"),
        null,
      );

      await upsertMetricsFingerprint(conn, {
        repoId: "fingerprint-repo",
        metricsHash: "hash-a",
        rowCount: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.deepEqual(await getMetricsFingerprint(conn, "fingerprint-repo"), {
        repoId: "fingerprint-repo",
        metricsHash: "hash-a",
        rowCount: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      await upsertMetricsFingerprint(conn, {
        repoId: "fingerprint-repo",
        metricsHash: "hash-b",
        rowCount: 3,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      assert.deepEqual(await getMetricsFingerprint(conn, "fingerprint-repo"), {
        repoId: "fingerprint-repo",
        metricsHash: "hash-b",
        rowCount: 3,
        updatedAt: "2026-01-02T00:00:00.000Z",
      });

      await deleteMetricsFingerprint(conn, "fingerprint-repo");
      assert.equal(
        await getMetricsFingerprint(conn, "fingerprint-repo"),
        null,
      );
    });
  });

  describe("getMetrics", { skip: !ladybugAvailable }, () => {
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

  describe("getMetricsBySymbolIds", { skip: !ladybugAvailable }, () => {
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

  describe("metrics recovery helpers", { skip: !ladybugAvailable }, () => {
    async function createRepoSymbol(
      symbolId: string,
      repoId: string,
      symbolStatus = "real",
    ): Promise<void> {
      await exec(
        conn,
        `
        CREATE (s:Symbol {symbolId: '${symbolId}', repoId: '${repoId}', kind: 'function', name: '${symbolId}', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', symbolStatus: '${symbolStatus}', updatedAt: '2024-01-01'})
      `,
      );
      await exec(
        conn,
        `
        MATCH (s:Symbol {symbolId: '${symbolId}'}), (r:Repo {repoId: '${repoId}'})
        CREATE (s)-[:SYMBOL_IN_REPO]->(r)
      `,
      );
    }

    beforeEach(async () => {
      await exec(
        conn,
        `CREATE (r:Repo {repoId: 'metrics-recovery-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
      );
      await exec(
        conn,
        `CREATE (r:Repo {repoId: 'other-metrics-recovery-repo', rootPath: '/other', configJson: '{}', createdAt: '2024-01-01'})`,
      );
    });

    it("finds only real repo symbols missing Metrics rows", async () => {
      await createRepoSymbol("metrics-present", "metrics-recovery-repo");
      await createRepoSymbol("metrics-missing", "metrics-recovery-repo");
      await createRepoSymbol(
        "metrics-external",
        "metrics-recovery-repo",
        "external",
      );
      await createRepoSymbol(
        "metrics-other-repo",
        "other-metrics-recovery-repo",
      );
      await queries.upsertMetrics(
        conn as unknown as import("kuzu").Connection,
        {
          symbolId: "metrics-present",
          fanIn: 1,
          fanOut: 2,
          churn30d: 0,
          testRefsJson: "[]",
          canonicalTestJson: null,
          updatedAt: "2024-01-01T00:00:00Z",
        },
      );

      const missing = await queries.getSymbolsMissingMetricsByRepo(
        conn as unknown as import("kuzu").Connection,
        "metrics-recovery-repo",
      );

      assert.deepStrictEqual(
        missing.map((row) => row.symbolId),
        ["metrics-missing"],
      );
    });

    it("computes grouped fan counts for repo-local dependency edges", async () => {
      await createRepoSymbol("fan-a", "metrics-recovery-repo");
      await createRepoSymbol("fan-b", "metrics-recovery-repo");
      await createRepoSymbol("fan-c", "metrics-recovery-repo");
      await createRepoSymbol("fan-external", "metrics-recovery-repo", "external");
      await createRepoSymbol("fan-other", "other-metrics-recovery-repo");
      for (const [from, to] of [
        ["fan-a", "fan-b"],
        ["fan-b", "fan-c"],
        ["fan-c", "fan-b"],
        ["fan-external", "fan-b"],
        ["fan-a", "fan-external"],
        ["fan-a", "fan-other"],
      ]) {
        await exec(
          conn,
          `
          MATCH (a:Symbol {symbolId: '${from}'}), (b:Symbol {symbolId: '${to}'})
          CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
        `,
        );
      }

      const fanIn = new Map(
        (
          await queries.getRepoFanInCounts(
            conn as unknown as import("kuzu").Connection,
            "metrics-recovery-repo",
          )
        ).map((row) => [row.symbolId, row.count]),
      );
      const fanOut = new Map(
        (
          await queries.getRepoFanOutCounts(
            conn as unknown as import("kuzu").Connection,
            "metrics-recovery-repo",
          )
        ).map((row) => [row.symbolId, row.count]),
      );

      assert.strictEqual(fanIn.get("fan-b"), 2);
      assert.strictEqual(fanIn.get("fan-c"), 1);
      assert.strictEqual(fanIn.has("fan-a"), false);
      assert.strictEqual(fanOut.get("fan-a"), 1);
      assert.strictEqual(fanOut.get("fan-b"), 1);
      assert.strictEqual(fanOut.get("fan-c"), 1);
    });

    it("copies missing-only Metrics rows with numeric defaults", async () => {
      const csvPath = join(dirname(TEST_DB_PATH), "metrics-recovery-copy.csv");
      writeFileSync(
        csvPath,
        [
          "symbolId,fanIn,fanOut,churn30d,testRefsJson,canonicalTestJson,pageRank,kCore,updatedAt",
          '"copy-metrics-1",3,4,0,"[]",,0,0,"2024-01-01T00:00:00Z"',
          '"copy-metrics-2",0,1,0,"[]",,0,0,"2024-01-01T00:00:00Z"',
        ].join("\n"),
        "utf8",
      );

      await queries.copyMissingMetricsRows(
        conn as unknown as import("kuzu").Connection,
        csvPath,
      );

      const first = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "copy-metrics-1",
      );
      const second = await queries.getMetrics(
        conn as unknown as import("kuzu").Connection,
        "copy-metrics-2",
      );

      assert.ok(first);
      assert.strictEqual(first.fanIn, 3);
      assert.strictEqual(first.fanOut, 4);
      assert.strictEqual(first.canonicalTestJson, null);
      assert.strictEqual(first.pageRank, 0);
      assert.ok(second);
      assert.strictEqual(second.fanIn, 0);
      assert.strictEqual(second.fanOut, 1);
      rmSync(csvPath, { force: true });
    });
  });

  describe("getTopSymbolsByFanIn", { skip: !ladybugAvailable }, () => {
    beforeEach(async () => {
      await exec(
        conn,
        `
        CREATE (r:Repo {repoId: 'top-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})
      `,
      );
      await exec(
        conn,
        `
        CREATE (f:File {fileId: 'file-1', relPath: 'src/test.ts', contentHash: 'abc', language: 'typescript', byteSize: 100, lastIndexedAt: '2024-01-01', directory: 'src'})
      `,
      );

      for (let i = 1; i <= 5; i++) {
        await exec(
          conn,
          `
          CREATE (s:Symbol {symbolId: 'top-sym-${i}', kind: 'function', name: 'func${i}', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: ${i}, rangeStartCol: 0, rangeEndLine: ${i + 1}, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
        `,
        );
        await exec(
          conn,
          `
          MATCH (s:Symbol {symbolId: 'top-sym-${i}'}), (r:Repo {repoId: 'top-test-repo'})
          CREATE (s)-[:SYMBOL_IN_REPO]->(r)
        `,
        );
        await exec(
          conn,
          `
          MATCH (s:Symbol {symbolId: 'top-sym-${i}'}), (f:File {fileId: 'file-1'})
          CREATE (s)-[:SYMBOL_IN_FILE]->(f)
        `,
        );
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

  describe("computeFanInOut", { skip: !ladybugAvailable }, () => {
    beforeEach(async () => {
      await exec(
        conn,
        `
        CREATE (s1:Symbol {symbolId: 'fan-sym-1', kind: 'function', name: 'func1', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `,
      );
      await exec(
        conn,
        `
        CREATE (s2:Symbol {symbolId: 'fan-sym-2', kind: 'function', name: 'func2', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `,
      );
      await exec(
        conn,
        `
        CREATE (s3:Symbol {symbolId: 'fan-sym-3', kind: 'function', name: 'func3', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 2, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
      `,
      );

      await exec(
        conn,
        `
        MATCH (a:Symbol {symbolId: 'fan-sym-1'}), (b:Symbol {symbolId: 'fan-sym-2'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `,
      );
      await exec(
        conn,
        `
        MATCH (a:Symbol {symbolId: 'fan-sym-3'}), (b:Symbol {symbolId: 'fan-sym-2'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `,
      );
      await exec(
        conn,
        `
        MATCH (a:Symbol {symbolId: 'fan-sym-2'}), (b:Symbol {symbolId: 'fan-sym-3'})
        CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
      `,
      );
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

  describe("batchComputeFanInOut", { skip: !ladybugAvailable }, () => {
    beforeEach(async () => {
      for (let i = 1; i <= 10; i++) {
        await exec(
          conn,
          `
          CREATE (s:Symbol {symbolId: 'batch-fan-sym-${i}', kind: 'function', name: 'func${i}', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: ${i}, rangeStartCol: 0, rangeEndLine: ${i + 1}, rangeEndCol: 0, astFingerprint: '', signatureJson: '{}', summary: '', invariantsJson: 'null', sideEffectsJson: 'null', updatedAt: '2024-01-01'})
        `,
        );
      }

      for (let i = 2; i <= 10; i++) {
        await exec(
          conn,
          `
          MATCH (a:Symbol {symbolId: 'batch-fan-sym-1'}), (b:Symbol {symbolId: 'batch-fan-sym-${i}'})
          CREATE (a)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 1.0}]->(b)
        `,
        );
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
