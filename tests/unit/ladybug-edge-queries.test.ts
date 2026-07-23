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
    "insertEdges batch-types outside-repo import targets as external",
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
                s.placeholderTarget AS placeholderTarget,
                coalesce(s.external, false) AS external`,
      );
      const rows = [await result.getNext()];
      result.close();

      assert.strictEqual(rows[0]!.repoId, repoId);
      assert.strictEqual(rows[0]!.symbolStatus, "external");
      assert.strictEqual(rows[0]!.placeholderKind, "import");
      assert.strictEqual(
        rows[0]!.placeholderTarget,
        "describe (from node:test)",
      );
      assert.strictEqual(rows[0]!.external, true);
    },
  );

  it(
    "insertEdges uses explicit target metadata without cross-contaminating batch rows",
    { skip: !ladybugAvailable },
    async () => {
      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:kuzu:Connection",
          edgeType: "import",
          weight: 0.6,
          confidence: 1,
          resolution: "exact",
          provenance: "import:kuzu:Connection",
          createdAt: "2026-03-04T00:00:00Z",
          targetMeta: {
            symbolStatus: "external",
            placeholderKind: "import",
            placeholderTarget: "Connection (from kuzu)",
          },
        },
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:src/db/ladybug-queries.ts:SymbolRow",
          edgeType: "import",
          weight: 0.6,
          confidence: 1,
          resolution: "unresolved",
          provenance: "import:src/db/ladybug-queries.ts:SymbolRow",
          createdAt: "2026-03-04T00:00:00Z",
          targetMeta: {
            symbolStatus: "unresolved",
            placeholderKind: "import",
            placeholderTarget: "SymbolRow (from src/db/ladybug-queries.ts)",
          },
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol)
         WHERE s.symbolId IN ['unresolved:kuzu:Connection', 'unresolved:src/db/ladybug-queries.ts:SymbolRow']
         RETURN s.symbolId AS symbolId,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget,
                coalesce(s.external, false) AS external
         ORDER BY symbolId`,
      );
      const rows = await result.getAll();
      result.close();

      assert.deepStrictEqual(rows, [
        {
          symbolId: "unresolved:kuzu:Connection",
          symbolStatus: "external",
          placeholderKind: "import",
          placeholderTarget: "Connection (from kuzu)",
          external: true,
        },
        {
          symbolId: "unresolved:src/db/ladybug-queries.ts:SymbolRow",
          symbolStatus: "unresolved",
          placeholderKind: "import",
          placeholderTarget: "SymbolRow (from src/db/ladybug-queries.ts)",
          external: false,
        },
      ]);
    },
  );

  it(
    "insertEdges repairs stale placeholder metadata on real file-backed targets",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "edge-real-target",
        repoId,
        fileId,
        kind: "function",
        name: "realTarget",
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: "real-target-fp",
        signatureJson: JSON.stringify({ text: "function realTarget" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        roleTagsJson: null,
        searchText: "realTarget function",
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         SET s.symbolStatus = 'unresolved',
             s.placeholderKind = 'call',
             s.placeholderTarget = 'stale.call'`,
      );

      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "edge-real-target",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "call:realTarget",
          createdAt: "2026-03-04T00:00:00Z",
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         RETURN s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "insertEdges clears stale external metadata on real file-backed targets",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "edge-real-target",
        repoId,
        fileId,
        kind: "function",
        name: "realTarget",
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: "real-target-fp",
        signatureJson: JSON.stringify({ text: "function realTarget" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        roleTagsJson: null,
        searchText: "realTarget function",
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         SET s.external = true,
             s.symbolStatus = 'external',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::realTarget'`,
      );

      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "edge-real-target",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "call:realTarget",
          createdAt: "2026-03-04T00:00:00Z",
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "upsertSymbolBatch clears stale external metadata on real file-backed symbols",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         SET s.external = true,
             s.symbolStatus = 'external',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::edge_from'`,
      );

      await queries.upsertSymbolBatch(
        conn as unknown as import("kuzu").Connection,
        [
          {
            symbolId: "edge-from",
            repoId,
            fileId,
            kind: "function",
            name: "edgeFrom",
            exported: true,
            visibility: "public",
            language: "ts",
            rangeStartLine: 1,
            rangeStartCol: 0,
            rangeEndLine: 3,
            rangeEndCol: 1,
            astFingerprint: "edge-from-fp",
            signatureJson: JSON.stringify({ text: "function edgeFrom" }),
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            roleTagsJson: null,
            searchText: "edgeFrom function",
            updatedAt: "2026-03-04T00:00:00Z",
          },
        ],
      );

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "insertEdges keeps stale-external real sources queryable as real symbols",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         SET s.external = true,
             s.symbolStatus = 'real',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::edge_from'`,
      );

      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "edge-to",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "call:edgeTo",
          createdAt: "2026-03-04T00:00:00Z",
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "insertEdge keeps stale-external real sources queryable as real symbols",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         SET s.external = true,
             s.symbolStatus = 'real',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::edge_from'`,
      );

      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-to",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "call:edgeTo",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-from'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "insertEdge clears stale external metadata on real file-backed targets",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "edge-real-target",
        repoId,
        fileId,
        kind: "function",
        name: "realTarget",
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 3,
        rangeEndCol: 1,
        astFingerprint: "real-target-fp",
        signatureJson: JSON.stringify({ text: "function realTarget" }),
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        roleTagsJson: null,
        searchText: "realTarget function",
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         SET s.external = true,
             s.symbolStatus = 'external',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::realTarget'`,
      );

      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-real-target",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        provenance: "call:realTarget",
        createdAt: "2026-03-04T00:00:00Z",
      });

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-real-target'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
    },
  );

  it(
    "insertEdge does not downgrade a file-backed target from unresolved metadata",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'edge-to'}),
               (f:File {fileId: '${fileId}'})
         SET s.repoId = '${repoId}',
             s.external = false,
             s.symbolStatus = 'real',
             s.placeholderKind = '',
             s.placeholderTarget = '',
             s.name = 'realTarget',
             s.kind = 'function',
             s.language = 'ts',
             s.rangeStartLine = 4,
             s.rangeStartCol = 2,
             s.rangeEndLine = 6,
             s.rangeEndCol = 1,
             s.signatureJson = '{"text":"function realTarget"}',
             s.source = 'treesitter',
             s.scipSymbol = NULL,
             s.astFingerprint = 'real-target-fingerprint'
         MERGE (s)-[:SYMBOL_IN_FILE]->(f)`,
      );

      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "edge-to",
        edgeType: "call",
        weight: 1,
        confidence: 0.5,
        resolution: "unresolved",
        provenance: "call:unresolved",
        createdAt: "2026-07-23T00:00:00Z",
        targetMeta: {
          symbolStatus: "unresolved",
          placeholderKind: "call",
          placeholderTarget: "edge-to",
        },
      });

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'edge-to'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget,
                s.name AS name,
                s.kind AS kind,
                s.language AS language,
                s.astFingerprint AS astFingerprint`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, false);
      assert.strictEqual(row.symbolStatus, "real");
      assert.strictEqual(row.placeholderKind, "");
      assert.strictEqual(row.placeholderTarget, "");
      assert.strictEqual(row.name, "realTarget");
      assert.strictEqual(row.kind, "function");
      assert.strictEqual(row.language, "ts");
      assert.strictEqual(row.astFingerprint, "real-target-fingerprint");
    },
  );

  it(
    "insertEdges preserves existing external metadata on real target IDs",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: '${repoId}'})
         MERGE (s:Symbol {symbolId: 'scip:external:Widget'})
         SET s.repoId = '${repoId}',
             s.external = true,
             s.symbolStatus = 'external',
             s.placeholderKind = 'scip',
             s.placeholderTarget = 'pkg::Widget'
         MERGE (s)-[:SYMBOL_IN_REPO]->(r)`,
      );

      await queries.insertEdges(conn as unknown as import("kuzu").Connection, [
        {
          repoId,
          fromSymbolId: "edge-from",
          toSymbolId: "scip:external:Widget",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          provenance: "scip:pkg::Widget",
          createdAt: "2026-03-04T00:00:00Z",
        },
      ]);

      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'scip:external:Widget'})
         RETURN coalesce(s.external, false) AS external,
                s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await result.getNext();
      result.close();

      assert.strictEqual(row.external, true);
      assert.strictEqual(row.symbolStatus, "external");
      assert.strictEqual(row.placeholderKind, "scip");
      assert.strictEqual(row.placeholderTarget, "pkg::Widget");
    },
  );

  it(
    "pruneIsolatedPlaceholderSymbols removes derived relationships before deleting nodes",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        `MATCH (r:Repo {repoId: '${repoId}'})
         CREATE (s:Symbol {
           symbolId: 'unresolved:call:staleClustered',
           repoId: '${repoId}',
           symbolStatus: 'unresolved',
           placeholderKind: 'call',
           placeholderTarget: 'staleClustered',
           external: false
         })
         CREATE (c:ShadowCluster {
           shadowClusterId: 'shadow-stale-placeholder',
           repoId: '${repoId}',
           algorithm: 'test',
           label: 'stale',
           symbolCount: 1,
           modularity: 0.0,
           versionId: 'v-test',
           createdAt: '2026-03-04T00:00:00Z'
         })
         CREATE (s)-[:SYMBOL_IN_REPO]->(r)
         CREATE (s)-[:BELONGS_TO_SHADOW_CLUSTER]->(c)`,
      );

      const pruned = await queries.pruneIsolatedPlaceholderSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.strictEqual(pruned, 1);
      const result = await conn.query(
        `MATCH (s:Symbol {symbolId: 'unresolved:call:staleClustered'})
         RETURN count(s) AS count`,
      );
      const row = await result.getNext();
      result.close();
      assert.strictEqual(Number(row.count), 0);
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
    "getBoundedDependencySymbolsFromSources applies a deterministic hard limit",
    { skip: !ladybugAvailable },
    async () => {
      await exec(
        conn,
        "MATCH (s:Symbol {symbolId: 'edge-to'}) SET s.name = 'alpha', s.kind = 'function'",
      );
      await exec(
        conn,
        "CREATE (:Symbol {symbolId: 'edge-z', name: 'omega', kind: 'function'})",
      );
      await exec(
        conn,
        "MATCH (f:File {fileId: 'edge-file'}), (s:Symbol) WHERE s.symbolId IN ['edge-to', 'edge-z'] CREATE (s)-[:SYMBOL_IN_FILE]->(f)",
      );
      for (const toSymbolId of ["edge-z", "edge-to"]) {
        await queries.insertEdge(
          conn as unknown as import("kuzu").Connection,
          {
            repoId,
            fromSymbolId: "edge-from",
            toSymbolId,
            edgeType: "call",
            weight: 1,
            confidence: 1,
            resolution: "exact",
            provenance: null,
            createdAt: "2026-03-04T00:00:00Z",
          },
        );
      }

      const dependencies =
        await queries.getBoundedDependencySymbolsFromSources(
          conn as unknown as import("kuzu").Connection,
          ["edge-from"],
          1,
        );

      assert.deepStrictEqual([...dependencies.keys()], ["edge-to"]);
      assert.deepStrictEqual(dependencies.get("edge-to"), {
        symbolId: "edge-to",
        name: "alpha",
        kind: "function",
        fileId,
      });
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
        toSymbolId: "unresolved:zod:z",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "unresolved",
        provenance: "import:zod:z",
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
    "getUnresolvedCallTargetIdsByRepo returns distinct unresolved call targets",
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
        fromSymbolId: "edge-from-2",
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
        toSymbolId: "unresolved:call:customTarget",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "unresolved",
        provenance: "call:customTarget",
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

      const queriesWithUnresolvedTargets = queries as typeof queries & {
        getUnresolvedCallTargetIdsByRepo?: (
          conn: import("kuzu").Connection,
          repoId: string,
        ) => Promise<string[]>;
      };

      assert.strictEqual(
        typeof queriesWithUnresolvedTargets.getUnresolvedCallTargetIdsByRepo,
        "function",
      );

      const targetIds =
        await queriesWithUnresolvedTargets.getUnresolvedCallTargetIdsByRepo!(
          conn as unknown as import("kuzu").Connection,
          repoId,
        );

      assert.deepStrictEqual(targetIds.sort(), [
        "unresolved:call:console.log",
        "unresolved:call:customTarget",
      ]);
    },
  );

  it(
    "deleteCallEdgesToTargetsByRepo deletes only matching repo-scoped call edges",
    { skip: !ladybugAvailable },
    async () => {
      const otherRepoId = "edge-other-repo";
      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId: otherRepoId,
        rootPath: "C:/tmp/edge-other-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });

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
        fromSymbolId: "edge-from-2",
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
        toSymbolId: "unresolved:call:customTarget",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "unresolved",
        provenance: "call:customTarget",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.insertEdge(conn as unknown as import("kuzu").Connection, {
        repoId,
        fromSymbolId: "edge-from",
        toSymbolId: "unresolved:call:console.log",
        edgeType: "import",
        weight: 0.6,
        confidence: 1,
        resolution: "unresolved",
        provenance: "import:console.log",
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
        repoId: otherRepoId,
        fromSymbolId: "other-edge-from",
        toSymbolId: "unresolved:call:console.log",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "unresolved",
        provenance: "call:console.log",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        "MATCH (r:Repo {repoId: 'edge-repo'}), (s:Symbol {symbolId: 'edge-from'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)",
      );

      const queriesWithTargetDelete = queries as typeof queries & {
        deleteCallEdgesToTargetsByRepo?: (
          conn: import("kuzu").Connection,
          repoId: string,
          targetSymbolIds: string[],
        ) => Promise<void>;
      };

      assert.strictEqual(
        typeof queriesWithTargetDelete.deleteCallEdgesToTargetsByRepo,
        "function",
      );

      await queriesWithTargetDelete.deleteCallEdgesToTargetsByRepo!(
        conn as unknown as import("kuzu").Connection,
        repoId,
        ["unresolved:call:console.log", "edge-to"],
      );

      const remainingRepoCalls = await queries.getUnresolvedCallEdgesByRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      const remainingOtherRepoCalls = await queries.getUnresolvedCallEdgesByRepo(
        conn as unknown as import("kuzu").Connection,
        otherRepoId,
      );
      const importRows = await queries.getEdgesFrom(
        conn as unknown as import("kuzu").Connection,
        "edge-from",
      );

      assert.deepStrictEqual(remainingRepoCalls, [
        {
          fromSymbolId: "edge-from",
          toSymbolId: "unresolved:call:customTarget",
        },
      ]);
      assert.deepStrictEqual(remainingOtherRepoCalls, [
        {
          fromSymbolId: "other-edge-from",
          toSymbolId: "unresolved:call:console.log",
        },
      ]);
      assert.ok(
        importRows.some(
          (edge) =>
            edge.edgeType === "import" &&
            edge.toSymbolId === "unresolved:call:console.log",
        ),
      );
      assert.ok(
        importRows.some(
          (edge) => edge.edgeType === "call" && edge.toSymbolId === "edge-to",
        ),
      );
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
