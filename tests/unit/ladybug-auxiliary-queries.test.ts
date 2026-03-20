import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-auxiliary-test-db.lbug");

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

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Auxiliary Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "audit log insert + repo filter + time range",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      await queries.insertAuditEvent(kConn, {
        eventId: "e1",
        timestamp: "2026-03-04T00:00:00.000Z",
        tool: "tool",
        decision: "success",
        repoId: "repoA",
        symbolId: null,
        detailsJson: "{}",
      });
      await queries.insertAuditEvent(kConn, {
        eventId: "e2",
        timestamp: "2026-03-04T01:00:00.000Z",
        tool: "tool",
        decision: "success",
        repoId: "repoB",
        symbolId: null,
        detailsJson: "{}",
      });
      await queries.insertAuditEvent(kConn, {
        eventId: "e3",
        timestamp: "2026-03-04T02:00:00.000Z",
        tool: "tool",
        decision: "success",
        repoId: "repoA",
        symbolId: null,
        detailsJson: "{}",
      });

      const all = await queries.getAuditEvents(kConn, { limit: 10 });
      assert.deepStrictEqual(
        all.map((e) => e.eventId),
        ["e3", "e2", "e1"],
      );

      const repoAOnly = await queries.getAuditEvents(kConn, {
        repoId: "repoA",
        limit: 10,
      });
      assert.deepStrictEqual(
        repoAOnly.map((e) => e.eventId),
        ["e3", "e1"],
      );

      const range = await queries.getAuditEvents(kConn, {
        sinceTimestamp: "2026-03-04T00:30:00.000Z",
        untilTimestamp: "2026-03-04T01:30:00.000Z",
        limit: 10,
      });
      assert.deepStrictEqual(
        range.map((e) => e.eventId),
        ["e2"],
      );
    },
  );

  it(
    "agent feedback CRUD + aggregation",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;
      await queries.upsertAgentFeedback(kConn, {
        feedbackId: "fb1",
        repoId: "repoA",
        versionId: "v1",
        sliceHandle: "h1",
        usefulSymbolsJson: JSON.stringify(["s1", "s2"]),
        missingSymbolsJson: JSON.stringify(["s3"]),
        taskTagsJson: JSON.stringify(["debug"]),
        taskType: "debug",
        taskText: "text",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.upsertAgentFeedback(kConn, {
        feedbackId: "fb2",
        repoId: "repoA",
        versionId: "v2",
        sliceHandle: "h2",
        usefulSymbolsJson: JSON.stringify(["s1"]),
        missingSymbolsJson: "[]",
        taskTagsJson: null,
        taskType: null,
        taskText: null,
        createdAt: "2026-03-04T01:00:00.000Z",
      });

      const fb1 = await queries.getAgentFeedback(kConn, "fb1");
      assert.ok(fb1);
      assert.strictEqual(fb1.sliceHandle, "h1");

      const byRepo = await queries.getAgentFeedbackByRepo(kConn, "repoA", 10);
      assert.deepStrictEqual(
        byRepo.map((r) => r.feedbackId),
        ["fb2", "fb1"],
      );

      const byVersion = await queries.getAgentFeedbackByVersion(
        kConn,
        "repoA",
        "v1",
        10,
      );
      assert.deepStrictEqual(
        byVersion.map((r) => r.feedbackId),
        ["fb1"],
      );

      const aggregated = await queries.getAggregatedFeedback(kConn, "repoA");
      assert.strictEqual(aggregated.totalFeedback, 2);
      assert.strictEqual(aggregated.symbolPositiveCounts.get("s1"), 2);
      assert.strictEqual(aggregated.symbolPositiveCounts.get("s2"), 1);
      assert.strictEqual(aggregated.symbolNegativeCounts.get("s3"), 1);
      assert.strictEqual(aggregated.taskTypeCounts.get("debug"), 2);

      const aggregatedSince = await queries.getAggregatedFeedback(
        kConn,
        "repoA",
        "2026-03-04T00:30:00.000Z",
      );
      assert.strictEqual(aggregatedSince.totalFeedback, 1);
      assert.strictEqual(aggregatedSince.symbolPositiveCounts.get("s1"), 1);
    },
  );

  it("symbol embeddings CRUD", { skip: !ladybugAvailable }, async () => {
    const kConn = conn as unknown as import("kuzu").Connection;
    await queries.upsertSymbolEmbedding(kConn, {
      symbolId: "s1",
      model: "m",
      embeddingVector: Buffer.from("hello").toString("base64"),
      version: "v1",
      cardHash: "ch1",
      createdAt: "2026-03-04T00:00:00.000Z",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    await queries.upsertSymbolEmbedding(kConn, {
      symbolId: "s2",
      model: "m",
      embeddingVector: Buffer.from("world").toString("base64"),
      version: "v1",
      cardHash: "ch2",
      createdAt: "2026-03-04T00:00:00.000Z",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });

    const single = await queries.getSymbolEmbedding(kConn, "s1");
    assert.ok(single);
    assert.strictEqual(single.cardHash, "ch1");

    const batch = await queries.getSymbolEmbeddings(kConn, [
      "s1",
      "s2",
      "missing",
    ]);
    assert.strictEqual(batch.size, 2);
    assert.ok(batch.get("s2"));

    await queries.deleteSymbolEmbeddings(kConn, ["s1"]);
    const deleted = await queries.getSymbolEmbedding(kConn, "s1");
    assert.strictEqual(deleted, null);
  });

  it(
    "summary cache upsert/get + delete by repo",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertRepo(kConn, {
        repoId: "repoA",
        rootPath: "C:/repoA",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.upsertFile(kConn, {
        fileId: "f1",
        repoId: "repoA",
        relPath: "src/a.ts",
        contentHash: "h",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
      await queries.upsertSymbol(kConn, {
        symbolId: "s1",
        repoId: "repoA",
        fileId: "f1",
        kind: "function",
        name: "foo",
        exported: true,
        visibility: null,
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 1,
        rangeEndLine: 1,
        rangeEndCol: 10,
        astFingerprint: "fp",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00.000Z",
      });

      await queries.upsertSummaryCache(kConn, {
        symbolId: "s1",
        summary: "summary",
        provider: "mock",
        model: "m",
        cardHash: "card-1",
        costUsd: 0.123,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      });

      const cached = await queries.getSummaryCache(kConn, "s1");
      assert.ok(cached);
      assert.strictEqual(cached.cardHash, "card-1");

      await queries.deleteSummaryCacheByRepo(kConn, "repoA");
      const deleted = await queries.getSummaryCache(kConn, "s1");
      assert.strictEqual(deleted, null);
    },
  );

  it(
    "symbol references insert + lookup + delete by file",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertRepo(kConn, {
        repoId: "repoA",
        rootPath: "C:/repoA",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.upsertFile(kConn, {
        fileId: "f1",
        repoId: "repoA",
        relPath: "test/foo.test.ts",
        contentHash: "h",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });

      await queries.insertSymbolReference(kConn, {
        refId: "ref1",
        repoId: "repoA",
        symbolName: "foo",
        fileId: "f1",
        lineNumber: 10,
        createdAt: "2026-03-04T00:00:00.000Z",
      });

      const refs = await queries.getTestRefsForSymbol(kConn, "repoA", "foo");
      assert.deepStrictEqual(refs, ["test/foo.test.ts"]);

      await queries.deleteSymbolReferencesByFileId(kConn, "f1");
      const afterDelete = await queries.getTestRefsForSymbol(
        kConn,
        "repoA",
        "foo",
      );
      assert.deepStrictEqual(afterDelete, []);
    },
  );

  it(
    "tool policy + tsconfig hash caches",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertToolPolicyHash(kConn, {
        policyHash: "ph1",
        policyBlob: '{"a":1}',
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      const ph = await queries.getToolPolicyHash(kConn, "ph1");
      assert.ok(ph);
      assert.strictEqual(ph.policyBlob, '{"a":1}');

      await queries.upsertTsconfigHash(kConn, {
        tsconfigHash: "th1",
        tsconfigBlob: '{"compilerOptions":{}}',
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      const th = await queries.getTsconfigHash(kConn, "th1");
      assert.ok(th);
      assert.strictEqual(th.tsconfigBlob, '{"compilerOptions":{}}');
    },
  );

  it("sync artifact upsert/get/list", { skip: !ladybugAvailable }, async () => {
    const kConn = conn as unknown as import("kuzu").Connection;

    await queries.upsertSyncArtifact(kConn, {
      artifactId: "a1",
      repoId: "repoA",
      versionId: "v1",
      commitSha: "abc",
      branch: "main",
      artifactHash: "h1",
      compressedData: "base64data",
      createdAt: "2026-03-04T00:00:00.000Z",
      sizeBytes: 10,
    });
    await queries.upsertSyncArtifact(kConn, {
      artifactId: "a2",
      repoId: "repoA",
      versionId: "v2",
      commitSha: null,
      branch: null,
      artifactHash: "h2",
      compressedData: "base64data2",
      createdAt: "2026-03-04T01:00:00.000Z",
      sizeBytes: 20,
    });

    const single = await queries.getSyncArtifact(kConn, "a1");
    assert.ok(single);
    assert.strictEqual(single.versionId, "v1");

    const list = await queries.getSyncArtifactsByRepo(kConn, "repoA", 10);
    assert.deepStrictEqual(
      list.map((a) => a.artifactId),
      ["a2", "a1"],
    );
  });
});
