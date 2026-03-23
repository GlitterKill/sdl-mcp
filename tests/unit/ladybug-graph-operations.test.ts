import { describe, it, beforeEach, afterEach } from "node:test";
import { queryAll as coreQueryAll } from "../../dist/db/ladybug-core.js";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-graph-ops-test-db.lbug");

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

describe("LadybugDB Graph Operations", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let graphOps: typeof import("../../dist/graph/buildGraph.js");
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      graphOps = await import("../../dist/graph/buildGraph.js");
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
    "getNeighbors respects direction + edgeType",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertRepo(kConn, {
        repoId: "repo",
        rootPath: "C:/repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00.000Z",
      });

      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "b",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "c",
        edgeType: "import",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "d",
        toSymbolId: "a",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });

      const outAll = await graphOps.getNeighbors(kConn, "repo", "a", "out");
      assert.deepStrictEqual(new Set(outAll), new Set(["b", "c"]));

      const outCalls = await graphOps.getNeighbors(
        kConn,
        "repo",
        "a",
        "out",
        "call",
      );
      assert.deepStrictEqual(outCalls, ["b"]);

      const incoming = await graphOps.getNeighbors(kConn, "repo", "a", "in");
      assert.deepStrictEqual(incoming, ["d"]);

      const both = await graphOps.getNeighbors(kConn, "repo", "a", "both");
      assert.deepStrictEqual(new Set(both), new Set(["b", "c", "d"]));
    },
  );

  it(
    "getPath uses shortest path traversal",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertRepo(kConn, {
        repoId: "repo",
        rootPath: "C:/repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00.000Z",
      });

      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "b",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "b",
        toSymbolId: "c",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });
      await queries.insertEdge(kConn, {
        repoId: "repo",
        fromSymbolId: "a",
        toSymbolId: "c",
        edgeType: "import",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "static",
        createdAt: "2026-03-04T00:00:00.000Z",
      });

      const path = await graphOps.getPath(kConn, "repo", "a", "c", 5);
      assert.deepStrictEqual(path, ["a", "c"]);
    },
  );

  it(
    "loadNeighborhood returns reachable symbolIds + filtered edges",
    { skip: !ladybugAvailable },
    async () => {
      const kConn = conn as unknown as import("kuzu").Connection;

      await queries.upsertRepo(kConn, {
        repoId: "repo",
        rootPath: "C:/repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00.000Z",
      });

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
          createdAt: "2026-03-04T00:00:00.000Z",
        },
        {
          repoId: "repo",
          fromSymbolId: "b",
          toSymbolId: "c",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: "2026-03-04T00:00:00.000Z",
        },
        {
          repoId: "repo",
          fromSymbolId: "c",
          toSymbolId: "d",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: "2026-03-04T00:00:00.000Z",
        },
        {
          repoId: "repo",
          fromSymbolId: "x",
          toSymbolId: "y",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "static",
          createdAt: "2026-03-04T00:00:00.000Z",
        },
      ]);

      const subgraph = await graphOps.loadNeighborhood(kConn, "repo", ["a"], {
        maxHops: 2,
        direction: "out",
        maxSymbols: 100,
      });

      assert.deepStrictEqual(
        new Set(subgraph.symbolIds),
        new Set(["a", "b", "c"]),
      );
      assert.ok(
        subgraph.edges.every((e) => subgraph.symbolIds.has(e.fromSymbolId)),
      );
      assert.ok(
        subgraph.edges.every((e) => subgraph.symbolIds.has(e.toSymbolId)),
      );
      assert.ok(subgraph.edges.every((e) => e.fromSymbolId !== "x"));
    },
  );
});
