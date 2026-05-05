import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-edge-test-db.lbug");

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
  const { createSchema } = await import("../../dist/db/ladybug-schema.js");
  await createSchema(conn as unknown as import("kuzu").Connection);
}

describe("LadybugDB Edge Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "edge-repo";
  const fileId = "edge-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

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
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "insertEdge deduplicates by from+to+type",
    { skip: !ladybugAvailable },
    async () => {
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

      await queries.insertEdge(
        conn as unknown as import("kuzu").Connection,
        edge,
      );
      await queries.insertEdge(
        conn as unknown as import("kuzu").Connection,
        edge,
      );

      const edges = await queries.getEdgesFrom(
        conn as unknown as import("kuzu").Connection,
        "edge-from",
      );
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0]!.toSymbolId, "edge-to");
      assert.strictEqual(edges[0]!.edgeType, "call");
    },
  );

  it(
    "insertEdge types unresolved targets as dependency placeholders",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:call:makeSession",
        edgeType: "call",
        weight: 0.5,
        confidence: 0.5,
        resolution: "unresolved",
        provenance: "unresolved-call:makeSession",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'unresolved:call:makeSession'})
         RETURN s.repoId AS repoId,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const rows = [await result.getNext()];
      result.close();

      assert.strictEqual(rows[0]!.repoId, repoId);
      assert.strictEqual(rows[0]!.symbolStatus, "unresolved");
      assert.strictEqual(rows[0]!.placeholderKind, "call");
      assert.strictEqual(rows[0]!.placeholderTarget, "makeSession");

      const realSymbolIds = await queries.getSymbolIdsByRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.ok(
        !realSymbolIds.includes("unresolved:call:makeSession"),
        "repo symbol projections should exclude unresolved dependency placeholders",
      );
    },
  );

  it(
    "insertEdges handles 1000+ edges",
    { skip: !ladybugAvailable },
    async () => {
      const edges: Array<import("../../dist/db/ladybug-queries.js").EdgeRow> =
        [];
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

      await queries.insertEdges(
        conn as unknown as import("kuzu").Connection,
        edges,
      );
      const count = await queries.getEdgeCount(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.ok(count >= 1000);
    },
  );

  it(
    "insertEdges batch-types unresolved import targets",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:node:test:describe",
          edgeType: "import",
          weight: 0.6,
          confidence: 1,
          resolution: "exact",
          provenance: "import:node:test",
          createdAt: "2026-03-04T00:00:00Z",
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'unresolved:node:test:describe'})
         RETURN s.repoId AS repoId,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const rows = [await result.getNext()];
      result.close();

      assert.strictEqual(rows[0]!.repoId, repoId);
      assert.strictEqual(rows[0]!.symbolStatus, "unresolved");
      assert.strictEqual(rows[0]!.placeholderKind, "import");
      assert.strictEqual(
        rows[0]!.placeholderTarget,
        "describe (from node:test)",
      );
    },
  );

  it(
    "getEdgesFromSymbols / projections",
    { skip: !ladybugAvailable },
    async () => {
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
        "resolution",
        "resolutionPhase",
        "resolverId",
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
    },
  );

  it(
    "getEdgesToSymbols groups incoming edges",
    { skip: !ladybugAvailable },
    async () => {
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
    },
  );

  it(
    "getUnresolvedImportEdgesByRepo returns only unresolved import candidates",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:src/target.ts:Target",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "unresolved",
        provenance: "import:Target",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-to",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "exact",
        provenance: "import:ResolvedTarget",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:call:print",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "unresolved",
        provenance: "call:print",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const queriesWithUnresolvedImports = queries as typeof queries & {
        getUnresolvedImportEdgesByRepo?: (
          conn: import("kuzu").Connection,
          repoId: string,
          options?: { affectedPaths?: string[] },
        ) => Promise<Array<import("../../dist/db/ladybug-queries.js").EdgeRow>>;
      };

      assert.strictEqual(
        typeof queriesWithUnresolvedImports.getUnresolvedImportEdgesByRepo,
        "function",
      );

      const unresolvedImports =
        await queriesWithUnresolvedImports.getUnresolvedImportEdgesByRepo!(
          conn as unknown as import("kuzu").Connection,
          repoId,
        );

      assert.deepStrictEqual(
        unresolvedImports.map((edge) => Object.keys(edge).sort()),
        [["fromSymbolId", "provenance", "toSymbolId"]],
      );
      assert.deepStrictEqual(unresolvedImports, [
        {
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:src/target.ts:Target",
          provenance: "import:Target",
        },
      ]);

      const unrelatedImports =
        await queriesWithUnresolvedImports.getUnresolvedImportEdgesByRepo!(
          conn as unknown as import("kuzu").Connection,
          repoId,
          { affectedPaths: ["src/other.ts"] },
        );
      assert.deepStrictEqual(unrelatedImports, []);

      const targetScopedImports =
        await queriesWithUnresolvedImports.getUnresolvedImportEdgesByRepo!(
          conn as unknown as import("kuzu").Connection,
          repoId,
          { affectedPaths: ["src/target.ts"] },
        );
      assert.deepStrictEqual(targetScopedImports, unresolvedImports);
    },
  );

  it(
    "getUnresolvedCallEdgesByRepo returns only unresolved call candidates",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:call:console.log",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "unresolved",
        provenance: "call:console.log",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-to",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "call:resolvedTarget",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:src/target.ts:Target",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "unresolved",
        provenance: "import:Target",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const queriesWithUnresolvedCalls = queries as typeof queries & {
        getUnresolvedCallEdgesByRepo?: (
          conn: import("kuzu").Connection,
          repoId: string,
        ) => Promise<Array<{ fromSymbolId: string; toSymbolId: string }>>;
      };

      assert.strictEqual(
        typeof queriesWithUnresolvedCalls.getUnresolvedCallEdgesByRepo,
        "function",
      );

      const unresolvedCalls =
        await queriesWithUnresolvedCalls.getUnresolvedCallEdgesByRepo!(
          conn as unknown as import("kuzu").Connection,
          repoId,
        );

      assert.deepStrictEqual(
        unresolvedCalls.map((edge) => Object.keys(edge).sort()),
        [["fromSymbolId", "toSymbolId"]],
      );
      assert.deepStrictEqual(unresolvedCalls, [
        {
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:call:console.log",
        },
      ]);
    },
  );

  it(
    "getEdgesByRepoLite returns only lite edge fields",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-to",
        edgeType: "call",
        weight: 1,
        confidence: 0.9,
        resolution: "exact",
        provenance: "call:edgeTo",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const liteEdges = await queries.getEdgesByRepoLite(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.deepStrictEqual(
        liteEdges.map((edge) => Object.keys(edge).sort()),
        [["edgeType", "fromSymbolId", "toSymbolId"]],
      );
      assert.deepStrictEqual(liteEdges, [
        {
          fromSymbolId: "edge-from",
          toSymbolId: "edge-to",
          edgeType: "call",
        },
      ]);
    },
  );

  it(
    "persists resolver metadata on call edges",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdge(
        conn as unknown as import("kuzu").Connection,
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "edge-to",
          edgeType: "call",
          weight: 1,
          confidence: 0.98,
          resolution: "compiler-semantic",
          resolverId: "pass2-ts",
          resolutionPhase: "pass2",
          provenance: "ts-call:testFn",
          createdAt: "2026-03-04T00:00:00Z",
        } as any,
      );

      const result = await conn.query(
        `MATCH (:Symbol {symbolId: 'edge-from'})-[d:DEPENDS_ON {edgeType: 'call'}]->(:Symbol {symbolId: 'edge-to'})
       RETURN d.confidence AS confidence,
              d.resolution AS resolution,
              d.resolverId AS resolverId,
              d.resolutionPhase AS resolutionPhase`,
      );
      assert.strictEqual(result.hasNext(), true);
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.confidence, 0.98);
      assert.strictEqual(row.resolution, "compiler-semantic");
      assert.strictEqual(row.resolverId, "pass2-ts");
      assert.strictEqual(row.resolutionPhase, "pass2");
    },
  );

  it(
    "deleteEdgesByFileId removes edges for symbols in file",
    { skip: !ladybugAvailable },
    async () => {
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
    },
  );

  it(
    "getEdgeCountsByType returns counts",
    { skip: !ladybugAvailable },
    async () => {
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
    },
  );
});
