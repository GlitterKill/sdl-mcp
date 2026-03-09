import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  __dirname,
  "..",
  "..",
  ".kuzu-slice-build-test-db.kuzu",
);

interface KuzuConnection {
  query: (
    q: string,
    params?: Record<string, unknown>,
  ) => Promise<{
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

async function cleanupTestDb(
  db: KuzuDatabase,
  conn: KuzuConnection,
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

async function setupSchema(conn: KuzuConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/kuzu-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("Kuzu Slice Build (integration)", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let slice: typeof import("../../dist/graph/slice.js");
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      slice = await import("../../dist/graph/slice.js");
      queries = await import("../../dist/db/kuzu-queries.js");
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "builds a slice from explicit entry symbols",
    { skip: !kuzuAvailable },
    async () => {
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
      });

      for (const symbolId of ["sym1", "sym2", "sym3"]) {
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
          fromSymbolId: "sym1",
          toSymbolId: "sym2",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
        {
          repoId: "repo",
          fromSymbolId: "sym2",
          toSymbolId: "sym3",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: now,
        },
      ]);

      const result = await slice.buildSlice({
        repoId: "repo",
        versionId: "v1",
        conn: kConn,
        entrySymbols: ["sym1"],
        budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
        cardDetail: "deps",
        minConfidence: 0.5,
      });

      assert.strictEqual(result.repoId, "repo");
      assert.ok(result.startSymbols.includes("sym1"));
      assert.ok(result.cards.some((c) => c.symbolId === "sym1"));

      const i1 = result.symbolIndex.indexOf("sym1");
      const i2 = result.symbolIndex.indexOf("sym2");
      assert.ok(i1 >= 0 && i2 >= 0);

      assert.ok(
        result.edges.some(
          ([from, to, type]) => from === i1 && to === i2 && type === "call",
        ),
      );
    },
  );
});
