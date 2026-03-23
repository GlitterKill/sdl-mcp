/**
 * Tests for LadybugDB Schema Definition (T1.2)
 *
 * Tests:
 * - Schema creation
 * - Idempotency (safe to call multiple times)
 * - Sample insert/query for each node/rel table
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createSchema, getSchemaVersion } from "../../dist/db/ladybug-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DB_PATH = join(tmpdir(), ".lbug-schema-test-db.lbug");

interface LadybugConnection {
  query: (q: string) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

interface LadybugDatabase {
  close: () => void | Promise<void>;
}

async function createTestDb() {
  const kuzu = await import("kuzu");

  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });

  const db = new kuzu.Database(TEST_DB_PATH) as unknown as LadybugDatabase;
  const conn = new kuzu.Connection(
    db as unknown as import("kuzu").Database,
  ) as unknown as LadybugConnection;
  return { db, conn, kuzu };
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

describe("LadybugDB Schema", () => {
  describe("createSchema", () => {
    it("should create schema without errors", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should be idempotent - safe to call multiple times", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);
        await createSchema(conn as unknown as import("kuzu").Connection);
        await createSchema(conn as unknown as import("kuzu").Connection);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should export schema version", async () => {
      const { LADYBUG_SCHEMA_VERSION } =
        await import("../../dist/db/ladybug-schema.js");
      assert.strictEqual(LADYBUG_SCHEMA_VERSION, 6);
    });
  });

  describe("Node Tables - Basic Operations", () => {
    it("should insert and query Repo", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (r:Repo {repoId: 'test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (r:Repo {repoId: 'test-repo'}) RETURN r.repoId, r.rootPath`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["r.repoId"], "test-repo");
        assert.strictEqual(row["r.rootPath"], "/test");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query File", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (f:File {fileId: 'f1', relPath: 'src/test.ts', contentHash: 'abc123', language: 'typescript', byteSize: 100, lastIndexedAt: '2024-01-01', directory: 'src'})`,
        );
        const result = await conn.query(
          `MATCH (f:File {fileId: 'f1'}) RETURN f.relPath, f.language`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["f.relPath"], "src/test.ts");
        assert.strictEqual(row["f.language"], "typescript");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Symbol", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (s:Symbol {symbolId: 'sym1', kind: 'function', name: 'testFn', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1, astFingerprint: 'fp1', signatureJson: '{}', updatedAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (s:Symbol {symbolId: 'sym1'}) RETURN s.name, s.kind`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["s.name"], "testFn");
        assert.strictEqual(row["s.kind"], "function");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Version", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (v:Version {versionId: 'v1', createdAt: '2024-01-01', reason: 'test', versionHash: 'h1'})`,
        );
        const result = await conn.query(
          `MATCH (v:Version {versionId: 'v1'}) RETURN v.versionId, v.reason`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["v.versionId"], "v1");
        assert.strictEqual(row["v.reason"], "test");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SymbolVersion", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (sv:SymbolVersion {id: 'sv1', versionId: 'v1', symbolId: 'sym1', astFingerprint: 'fp1', signatureJson: '{}'})`,
        );
        const result = await conn.query(
          `MATCH (sv:SymbolVersion {id: 'sv1'}) RETURN sv.symbolId, sv.versionId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["sv.symbolId"], "sym1");
        assert.strictEqual(row["sv.versionId"], "v1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Metrics", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (m:Metrics {symbolId: 'sym1', fanIn: 5, fanOut: 3, churn30d: 10, testRefsJson: '[]', updatedAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (m:Metrics {symbolId: 'sym1'}) RETURN m.fanIn, m.fanOut`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(Number(row["m.fanIn"]), 5);
        assert.strictEqual(Number(row["m.fanOut"]), 3);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Cluster", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (c:Cluster {clusterId: 'c1', repoId: 'test-repo', label: 'Test Cluster', symbolCount: 10, cohesionScore: 0.85, versionId: 'v1', createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (c:Cluster {clusterId: 'c1'}) RETURN c.label, c.cohesionScore`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["c.label"], "Test Cluster");
        assert.ok(Math.abs((row["c.cohesionScore"] as number) - 0.85) < 0.01);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Process", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (p:Process {processId: 'p1', repoId: 'test-repo', entrySymbolId: 'sym1', label: 'Test Process', depth: 3, versionId: 'v1', createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (p:Process {processId: 'p1'}) RETURN p.label, p.depth`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["p.label"], "Test Process");
        assert.strictEqual(row["p.depth"], 3);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SliceHandle", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (sh:SliceHandle {handle: 'sh1', repoId: 'test-repo', createdAt: '2024-01-01', expiresAt: '2024-12-31', sliceHash: 'hash1'})`,
        );
        const result = await conn.query(
          `MATCH (sh:SliceHandle {handle: 'sh1'}) RETURN sh.sliceHash, sh.repoId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["sh.sliceHash"], "hash1");
        assert.strictEqual(row["sh.repoId"], "test-repo");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query CardHash", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (ch:CardHash {cardHash: 'ch1', cardBlob: '{"test": true}', createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (ch:CardHash {cardHash: 'ch1'}) RETURN ch.cardHash`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["ch.cardHash"], "ch1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query Audit", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (a:Audit {eventId: 1, timestamp: '2024-01-01', tool: 'test-tool', decision: 'allow', repoId: 'test-repo', detailsJson: '{}'})`,
        );
        const result = await conn.query(
          `MATCH (a:Audit {eventId: 1}) RETURN a.tool, a.decision`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["a.tool"], "test-tool");
        assert.strictEqual(row["a.decision"], "allow");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query AgentFeedback", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (af:AgentFeedback {feedbackId: 1, repoId: 'test-repo', versionId: 'v1', sliceHandle: 'sh1', usefulSymbolsJson: '["sym1"]', missingSymbolsJson: '[]', taskType: 'debug', createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (af:AgentFeedback {feedbackId: 1}) RETURN af.taskType, af.sliceHandle`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["af.taskType"], "debug");
        assert.strictEqual(row["af.sliceHandle"], "sh1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SymbolEmbedding", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (se:SymbolEmbedding {symbolId: 'sym1', model: 'text-embedding-3-small', embeddingVector: '[0.1, 0.2, 0.3]', version: '1', cardHash: 'ch1', createdAt: '2024-01-01', updatedAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (se:SymbolEmbedding {symbolId: 'sym1'}) RETURN se.model, se.version`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["se.model"], "text-embedding-3-small");
        assert.strictEqual(row["se.version"], "1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SummaryCache", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (sc:SummaryCache {symbolId: 'sym1', summary: 'Test summary', provider: 'openai', model: 'gpt-4', cardHash: 'ch1', costUsd: 0.001, createdAt: '2024-01-01', updatedAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (sc:SummaryCache {symbolId: 'sym1'}) RETURN sc.summary, sc.provider`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["sc.summary"], "Test summary");
        assert.strictEqual(row["sc.provider"], "openai");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SyncArtifact", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (sa:SyncArtifact {artifactId: 'sa1', repoId: 'test-repo', versionId: 'v1', commitSha: 'abc123', branch: 'main', artifactHash: 'h1', compressedData: 'data', createdAt: '2024-01-01', sizeBytes: 1024})`,
        );
        const result = await conn.query(
          `MATCH (sa:SyncArtifact {artifactId: 'sa1'}) RETURN sa.commitSha, sa.branch`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["sa.commitSha"], "abc123");
        assert.strictEqual(row["sa.branch"], "main");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SymbolReference", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (sr:SymbolReference {refId: 1, repoId: 'test-repo', symbolName: 'testFn', fileId: 'f1', lineNumber: 10, createdAt: '2024-01-01'})`,
        );
        const result = await conn.query(
          `MATCH (sr:SymbolReference {refId: 1}) RETURN sr.symbolName, sr.lineNumber`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["sr.symbolName"], "testFn");
        assert.strictEqual(Number(row["sr.lineNumber"]), 10);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });
  });

  describe("Relationship Tables", () => {
    it("should insert and query FILE_IN_REPO", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (r:Repo {repoId: 'rel-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (f:File {fileId: 'rel-f1', relPath: 'src/test.ts', contentHash: 'abc', language: 'typescript', byteSize: 100, directory: 'src'})`,
        );
        await exec(
          conn,
          `MATCH (f:File {fileId: 'rel-f1'}), (r:Repo {repoId: 'rel-test-repo'}) CREATE (f)-[:FILE_IN_REPO]->(r)`,
        );
        const result = await conn.query(
          `MATCH (f:File {fileId: 'rel-f1'})-[:FILE_IN_REPO]->(r:Repo) RETURN r.repoId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["r.repoId"], "rel-test-repo");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query SYMBOL_IN_FILE", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (f:File {fileId: 'rel-f1', relPath: 'src/test.ts', contentHash: 'abc', language: 'typescript', byteSize: 100, directory: 'src'})`,
        );
        await exec(
          conn,
          `CREATE (s:Symbol {symbolId: 'rel-sym1', kind: 'function', name: 'fn1', exported: true, language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1, astFingerprint: 'fp', updatedAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (s:Symbol {symbolId: 'rel-sym1'}), (f:File {fileId: 'rel-f1'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)`,
        );
        const result = await conn.query(
          `MATCH (s:Symbol {symbolId: 'rel-sym1'})-[:SYMBOL_IN_FILE]->(f:File) RETURN f.fileId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["f.fileId"], "rel-f1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query DEPENDS_ON with properties", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (s1:Symbol {symbolId: 'rel-sym1', kind: 'function', name: 'fn1', exported: true, language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1, astFingerprint: 'fp', updatedAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (s2:Symbol {symbolId: 'rel-sym2', kind: 'function', name: 'fn2', exported: true, language: 'typescript', rangeStartLine: 10, rangeStartCol: 0, rangeEndLine: 15, rangeEndCol: 1, astFingerprint: 'fp', updatedAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (s1:Symbol {symbolId: 'rel-sym1'}), (s2:Symbol {symbolId: 'rel-sym2'}) CREATE (s1)-[:DEPENDS_ON {edgeType: 'call', weight: 1.0, confidence: 0.9, resolution: 'exact', provenance: 'ts-compiler', createdAt: '2024-01-01'}]->(s2)`,
        );
        const result = await conn.query(
          `MATCH (s1:Symbol {symbolId: 'rel-sym1'})-[e:DEPENDS_ON]->(s2:Symbol) RETURN e.edgeType, e.confidence`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["e.edgeType"], "call");
        assert.ok(Math.abs((row["e.confidence"] as number) - 0.9) < 0.01);
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query VERSION_OF_REPO", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (r:Repo {repoId: 'rel-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (v:Version {versionId: 'rel-v1', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (v:Version {versionId: 'rel-v1'}), (r:Repo {repoId: 'rel-test-repo'}) CREATE (v)-[:VERSION_OF_REPO]->(r)`,
        );
        const result = await conn.query(
          `MATCH (v:Version {versionId: 'rel-v1'})-[:VERSION_OF_REPO]->(r:Repo) RETURN r.repoId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["r.repoId"], "rel-test-repo");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query BELONGS_TO_CLUSTER", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (s:Symbol {symbolId: 'rel-sym1', kind: 'function', name: 'fn1', exported: true, language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1, astFingerprint: 'fp', updatedAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (c:Cluster {clusterId: 'rel-c1', repoId: 'rel-test-repo', label: 'Cluster', symbolCount: 1, cohesionScore: 1.0, versionId: 'rel-v1', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (s:Symbol {symbolId: 'rel-sym1'}), (c:Cluster {clusterId: 'rel-c1'}) CREATE (s)-[:BELONGS_TO_CLUSTER]->(c)`,
        );
        const result = await conn.query(
          `MATCH (s:Symbol {symbolId: 'rel-sym1'})-[:BELONGS_TO_CLUSTER]->(c:Cluster) RETURN c.clusterId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["c.clusterId"], "rel-c1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query PARTICIPATES_IN", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (s:Symbol {symbolId: 'rel-sym1', kind: 'function', name: 'fn1', exported: true, language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1, astFingerprint: 'fp', updatedAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (p:Process {processId: 'rel-p1', repoId: 'rel-test-repo', entrySymbolId: 'rel-sym1', label: 'Process', depth: 1, versionId: 'rel-v1', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (s:Symbol {symbolId: 'rel-sym1'}), (p:Process {processId: 'rel-p1'}) CREATE (s)-[:PARTICIPATES_IN]->(p)`,
        );
        const result = await conn.query(
          `MATCH (s:Symbol {symbolId: 'rel-sym1'})-[:PARTICIPATES_IN]->(p:Process) RETURN p.processId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["p.processId"], "rel-p1");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query CLUSTER_IN_REPO", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (r:Repo {repoId: 'rel-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (c:Cluster {clusterId: 'rel-c1', repoId: 'rel-test-repo', label: 'Cluster', symbolCount: 1, cohesionScore: 1.0, versionId: 'rel-v1', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (c:Cluster {clusterId: 'rel-c1'}), (r:Repo {repoId: 'rel-test-repo'}) CREATE (c)-[:CLUSTER_IN_REPO]->(r)`,
        );
        const result = await conn.query(
          `MATCH (c:Cluster {clusterId: 'rel-c1'})-[:CLUSTER_IN_REPO]->(r:Repo) RETURN r.repoId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["r.repoId"], "rel-test-repo");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });

    it("should insert and query PROCESS_IN_REPO", async () => {
      const { db, conn } = await createTestDb();
      try {
        const { createSchema } =
          await import("../../dist/db/ladybug-schema.js");
        await createSchema(conn as unknown as import("kuzu").Connection);

        await exec(
          conn,
          `CREATE (r:Repo {repoId: 'rel-test-repo', rootPath: '/test', configJson: '{}', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `CREATE (p:Process {processId: 'rel-p1', repoId: 'rel-test-repo', entrySymbolId: 'rel-sym1', label: 'Process', depth: 1, versionId: 'rel-v1', createdAt: '2024-01-01'})`,
        );
        await exec(
          conn,
          `MATCH (p:Process {processId: 'rel-p1'}), (r:Repo {repoId: 'rel-test-repo'}) CREATE (p)-[:PROCESS_IN_REPO]->(r)`,
        );
        const result = await conn.query(
          `MATCH (p:Process {processId: 'rel-p1'})-[:PROCESS_IN_REPO]->(r:Repo) RETURN r.repoId`,
        );
        assert.strictEqual(result.hasNext(), true);
        const row = await result.getNext();
        result.close();
        assert.strictEqual(row["r.repoId"], "rel-test-repo");
      } finally {
        await cleanupTestDb(db, conn);
      }
    });
  });
});
