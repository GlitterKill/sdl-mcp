import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(__dirname, "..", "..", ".kuzu-edge-test-db.kuzu");

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

describe("KuzuDB Edge Queries", () => {
  let db: KuzuDatabase;
  let conn: KuzuConnection;
  let queries: typeof import("../../dist/db/kuzu-queries.js");
  let kuzuAvailable = true;

  const repoId = "edge-repo";
  const fileId = "edge-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/kuzu-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/edge-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId,
        repoId,
        relPath: "src/edge.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 1,
        lastIndexedAt: null,
      });

      await exec(conn, "CREATE (:Symbol {symbolId: 'edge-from'})");
      await exec(conn, "CREATE (:Symbol {symbolId: 'edge-to'})");
      await exec(
        conn,
        "MATCH (r:Repo {repoId: 'edge-repo'}), (s:Symbol {symbolId: 'edge-from'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
      );
      await exec(
        conn,
        "MATCH (f:File {fileId: 'edge-file'}), (s:Symbol {symbolId: 'edge-from'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
      );
    } catch {
      kuzuAvailable = false;
    }
  });

  afterEach(async () => {
    if (!kuzuAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it("insertEdge deduplicates by from+to+type", { skip: !kuzuAvailable }, async () => {
    const edge = {
      repoId,
      fromSymbolId: "edge-from",
      toSymbolId: "edge-to",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    };

    await queries.insertEdge(conn as unknown as import("kuzu").Connection, edge);
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, edge);

    const edges = await queries.getEdgesFrom(
      conn as unknown as import("kuzu").Connection,
      "edge-from",
    );
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0]!.toSymbolId, "edge-to");
    assert.strictEqual(edges[0]!.edgeType, "call");
  });

  it("insertEdges handles 1000+ edges", { skip: !kuzuAvailable }, async () => {
    const edges: Array<import("../../dist/db/kuzu-queries.js").EdgeRow> = [];
    for (let i = 0; i < 1000; i++) {
      edges.push({
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: `edge-to-${i}`,
        edgeType: "import",
        weight: 0.5,
        confidence: 0.9,
        resolution: "exact",
        provenance: null,
        createdAt: "2026-03-04T00:00:00Z",
      });
    }

    await queries.insertEdges(conn as unknown as import("kuzu").Connection, edges);
    const count = await queries.getEdgeCount(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.ok(count >= 1000);
  });

  it("getEdgesFromSymbols / projections", { skip: !kuzuAvailable }, async () => {
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "edge-from",
      toSymbolId: "edge-to",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });

    const map = await queries.getEdgesFromSymbols(
      conn as unknown as import("kuzu").Connection,
      ["edge-from", "missing-from"],
    );
    assert.strictEqual(map.size, 2);
    assert.strictEqual(map.get("edge-from")!.length, 1);
    assert.strictEqual(map.get("missing-from")!.length, 0);

    const sliceMap = await queries.getEdgesFromSymbolsForSlice(
      conn as unknown as import("kuzu").Connection,
      ["edge-from"],
    );
    const item = sliceMap.get("edge-from")![0]!;
    assert.deepStrictEqual(Object.keys(item).sort(), [
      "confidence",
      "edgeType",
      "fromSymbolId",
      "toSymbolId",
      "weight",
    ]);

    const liteMap = await queries.getEdgesFromSymbolsLite(
      conn as unknown as import("kuzu").Connection,
      ["edge-from"],
    );
    const liteItem = liteMap.get("edge-from")![0]!;
    assert.deepStrictEqual(Object.keys(liteItem).sort(), [
      "edgeType",
      "fromSymbolId",
      "toSymbolId",
    ]);
  });

  it("getEdgesToSymbols groups incoming edges", { skip: !kuzuAvailable }, async () => {
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "edge-from",
      toSymbolId: "edge-to",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });

    const incoming = await queries.getEdgesToSymbols(
      conn as unknown as import("kuzu").Connection,
      ["edge-to", "missing-to"],
    );
    assert.strictEqual(incoming.size, 2);
    assert.strictEqual(incoming.get("edge-to")!.length, 1);
    assert.strictEqual(incoming.get("missing-to")!.length, 0);
  });

  it("deleteEdgesByFileId removes edges for symbols in file", { skip: !kuzuAvailable }, async () => {
    await exec(conn, "CREATE (:Symbol {symbolId: 'edge-in-file'})");
    await exec(
      conn,
      "MATCH (f:File {fileId: 'edge-file'}), (s:Symbol {symbolId: 'edge-in-file'}) CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
    );
    await exec(
      conn,
      "MATCH (r:Repo {repoId: 'edge-repo'}), (s:Symbol {symbolId: 'edge-in-file'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
    );

    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "edge-in-file",
      toSymbolId: "edge-to",
      edgeType: "config",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });

    await queries.deleteEdgesByFileId(
      conn as unknown as import("kuzu").Connection,
      fileId,
    );

    const remaining = await queries.getEdgesFrom(
      conn as unknown as import("kuzu").Connection,
      "edge-in-file",
    );
    assert.strictEqual(remaining.length, 0);
  });

  it("getEdgeCountsByType returns counts", { skip: !kuzuAvailable }, async () => {
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "edge-from",
      toSymbolId: "edge-to",
      edgeType: "call",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });
    await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
      repoId,
      fromSymbolId: "edge-from",
      toSymbolId: "edge-to-2",
      edgeType: "import",
      weight: 1,
      confidence: 1,
      resolution: "exact",
      provenance: null,
      createdAt: "2026-03-04T00:00:00Z",
    });

    const counts = await queries.getEdgeCountsByType(
      conn as unknown as import("kuzu").Connection,
      repoId,
    );
    assert.strictEqual(counts.call, 1);
    assert.strictEqual(counts.import, 1);
  });
});
