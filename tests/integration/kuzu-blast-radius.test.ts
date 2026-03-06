import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-blast-radius-test-db.kuzu");

interface KuzuConnection {
  query: (q: string, params?: Record<string, unknown>) => Promise<{
    hasNext: () => boolean;
    getNext: () => Promise<Record<string, unknown>>;
    close: () => void;
    getAllSync?: () => Record<string, unknown>[];
  }>;
  close: () => Promise<void>;
}

interface KuzuDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{ db: KuzuDatabase; conn: KuzuConnection }> {
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

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("Kuzu Blast Radius (integration)", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let blast: typeof import("../../dist/delta/blastRadius.js");
  let kuzuAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/kuzu-queries.js");
      blast = await import("../../dist/delta/blastRadius.js");
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("returns dependents for changed symbols using incoming edges", { skip: !kuzuAvailable }, async () => {
    const kConn = conn as unknown as import("kuzu").Connection;
    const now = "2026-03-04T00:00:00.000Z";

    await queries.upsertRepo(kConn, {
      repoId: "repo",
      rootPath: "C:/repo",
      configJson: "{}",
      createdAt: now,
    });

    await queries.upsertFile(kConn, {
      fileId: "file-1",
      repoId: "repo",
      relPath: "src/app.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 123,
      lastIndexedAt: now,
      directory: "src",
    });

    for (const symbolId of ["a", "b", "c"]) {
      await queries.upsertSymbol(kConn, {
        symbolId,
        repoId: "repo",
        fileId: "file-1",
        kind: "function",
        name: symbolId,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 1,
        astFingerprint: `${symbolId}-fp`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }

    await queries.insertEdges(kConn, [
      {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "b",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: now,
      },
      {
        repoId: "repo",
        fromSymbolId: "c",
        toSymbolId: "a",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: now,
      },
    ]);

    const results = await blast.computeBlastRadius(kConn, ["b"], {
      repoId: "repo",
      maxHops: 3,
      maxResults: 10,
    });

    assert.ok(results.length >= 2);
    assert.strictEqual(results[0].symbolId, "a");
    assert.strictEqual(results[0].distance, 1);
    assert.strictEqual(results[0].signal, "directDependent");

    const c = results.find((r) => r.symbolId === "c");
    assert.ok(c);
    assert.strictEqual(c.distance, 2);
    assert.strictEqual(c.signal, "graph");
  });
});
