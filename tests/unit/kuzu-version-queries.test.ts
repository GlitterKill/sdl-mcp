import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-version-test-db");

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

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("KuzuDB Version & Snapshot Queries", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  const repoId = "ver-repo";
  const fileId = "ver-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/kuzu-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/ver-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId,
        repoId,
        relPath: "src/ver.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("createVersion/getLatestVersion/getVersionsByRepo", { skip: !kuzuAvailable }, async () => {
    await queries.createVersion(conn as unknown as import("kuzu").Connection, {
      versionId: "v1",
      repoId,
      createdAt: "2026-03-04T00:00:00Z",
      reason: "init",
      prevVersionHash: null,
      versionHash: "h1",
    });
    await queries.createVersion(conn as unknown as import("kuzu").Connection, {
      versionId: "v2",
      repoId,
      createdAt: "2026-03-05T00:00:00Z",
      reason: "next",
      prevVersionHash: "h1",
      versionHash: "h2",
    });

    const latest = await queries.getLatestVersion(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.ok(latest);
    assert.strictEqual(latest.versionId, "v2");

    const versions = await queries.getVersionsByRepo(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.strictEqual(versions.length, 2);
    assert.deepStrictEqual(
      versions.map((v) => v.versionId),
      ["v2", "v1"],
    );
  });

  it("snapshotSymbolVersion/getSymbolVersionsAtVersion", { skip: !kuzuAvailable }, async () => {
    await queries.snapshotSymbolVersion(conn as unknown as import("kuzu").Connection, {
      versionId: "v1",
      symbolId: "sym-1",
      astFingerprint: "fp",
      signatureJson: "{}",
      summary: "s",
      invariantsJson: null,
      sideEffectsJson: null,
    });

    const rows = await queries.getSymbolVersionsAtVersion(
      conn as unknown as import("kuzu").Connection,
      "v1",
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.symbolId, "sym-1");
    assert.strictEqual(rows[0]!.id, "v1:sym-1");
  });

  it("getFanInAtVersion counts only callers present at version", { skip: !kuzuAvailable }, async () => {
    await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
      symbolId: "caller-1",
      repoId,
      fileId,
      kind: "function",
      name: "caller1",
      exported: true,
      visibility: null,
      language: "typescript",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 0,
      astFingerprint: "c1",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-03-04T00:00:00Z",
    });
    await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
      symbolId: "caller-2",
      repoId,
      fileId,
      kind: "function",
      name: "caller2",
      exported: true,
      visibility: null,
      language: "typescript",
      rangeStartLine: 2,
      rangeStartCol: 0,
      rangeEndLine: 2,
      rangeEndCol: 0,
      astFingerprint: "c2",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-03-04T00:00:00Z",
    });
    await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
      symbolId: "callee",
      repoId,
      fileId,
      kind: "function",
      name: "callee",
      exported: true,
      visibility: null,
      language: "typescript",
      rangeStartLine: 3,
      rangeStartCol: 0,
      rangeEndLine: 3,
      rangeEndCol: 0,
      astFingerprint: "t",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-03-04T00:00:00Z",
    });

    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "caller-1",
      toSymbolId: "callee",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "caller-2",
      toSymbolId: "callee",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.snapshotSymbolVersion(conn as unknown as import("kuzu").Connection, {
      versionId: "v1",
      symbolId: "caller-1",
      astFingerprint: "c1",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
    });
    await queries.snapshotSymbolVersion(conn as unknown as import("kuzu").Connection, {
      versionId: "v1",
      symbolId: "callee",
      astFingerprint: "t",
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
    });

    const fanIn = await queries.getFanInAtVersion(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "callee",
      "v1",
    );
    assert.strictEqual(fanIn, 1);
  });

  it("getFanInAtVersion falls back to current metrics when missing snapshot", { skip: !kuzuAvailable }, async () => {
    await queries.upsertMetrics(conn as unknown as import("kuzu").Connection, {
      symbolId: "callee",
      fanIn: 2,
      fanOut: 0,
      churn30d: 0,
      testRefsJson: null,
      canonicalTestJson: null,
      updatedAt: "2026-03-04T00:00:00Z",
    });

    const fanIn = await queries.getFanInAtVersion(
      conn as unknown as import("kuzu").Connection,
      repoId,
      "callee",
      "v-nope",
    );
    assert.strictEqual(fanIn, 2);
  });
});

