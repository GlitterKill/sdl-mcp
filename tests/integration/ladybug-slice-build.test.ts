import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let testDbDir = "";

interface LadybugConnection {
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

interface LadybugDatabase {
  close: () => Promise<void>;
}

async function createTestDb(): Promise<{
  db: LadybugDatabase;
  conn: LadybugConnection;
}> {
  testDbDir = mkdtempSync(join(tmpdir(), "sdl-slice-build-db-"));
  const testDbPath = join(testDbDir, "sdl-mcp-graph.lbug");

  const kuzu = await import("kuzu");
  const db = new kuzu.Database(testDbPath);
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
    if (testDbDir && existsSync(testDbDir)) {
      rmSync(testDbDir, { recursive: true, force: true });
    }
  } catch {}
  testDbDir = "";
}

async function setupSchema(conn: LadybugConnection): Promise<void> {
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Slice Build (integration)", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let slice: typeof import("../../dist/graph/slice.js");
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;
  let setupError: unknown = null;

  beforeEach(async () => {
    ladybugAvailable = true;
    setupError = null;
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      slice = await import("../../dist/graph/slice.js");
      queries = await import("../../dist/db/ladybug-queries.js");
    } catch (error) {
      ladybugAvailable = false;
      setupError = error;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "builds a slice from explicit entry symbols",
    async (t) => {
      if (!ladybugAvailable) {
        const reason =
          setupError instanceof Error
            ? setupError.message
            : "LadybugDB setup unavailable";
        t.skip(reason);
        return;
      }

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

      const { slice: result } = await slice.buildSlice({
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
