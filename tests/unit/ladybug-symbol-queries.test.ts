import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(tmpdir(), ".lbug-symbol-test-db.lbug");

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

function scipExternalSymbol(symbolId: string) {
  return {
    symbolId,
    kind: "function",
    name: "externalApi",
    exported: true,
    language: "external",
    rangeStartLine: 0,
    rangeStartCol: 0,
    rangeEndLine: 0,
    rangeEndCol: 0,
    external: true,
    scipSymbol: "scip-typescript npm dep 1.0.0 dep/index.ts/externalApi().",
    source: "scip" as const,
    packageName: "dep",
    packageVersion: "1.0.0",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

describe("LadybugDB Symbol Queries", () => {
  let db: LadybugDatabase;
  let conn: LadybugConnection;
  let queries: typeof import("../../dist/db/ladybug-queries.js");
  let ladybugAvailable = true;

  const repoId = "sym-repo";
  const fileId = "sym-file";

  beforeEach(async () => {
    try {
      ({ db, conn } = await createTestDb());
      await setupSchema(conn);
      queries = await import("../../dist/db/ladybug-queries.js");

      await queries.upsertRepo(conn as unknown as import("kuzu").Connection, {
        repoId,
        rootPath: "C:/tmp/sym-repo",
        configJson: "{}",
        createdAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId,
        repoId,
        relPath: "src/file.ts",
        contentHash: "hash",
        language: "ts",
        byteSize: 10,
        lastIndexedAt: null,
      });
    } catch {
      ladybugAvailable = false;
    }
  });

  afterEach(async () => {
    if (!ladybugAvailable) return;
    await cleanupTestDb(db, conn);
  });

  it(
    "upsertSymbol/getSymbol round-trip with JSON fields",
    { skip: !ladybugAvailable },
    async () => {
      const symbolId = "sym-1";
      const signatureJson = JSON.stringify({ name: "fn", args: ["a", "b"] });

      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId,
        repoId,
        fileId,
        kind: "function",
        name: "myFn",
        exported: true,
        visibility: "public",
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 1,
        astFingerprint: "fp",
        signatureJson,
        summary: "hello",
        invariantsJson: JSON.stringify({ ok: true }),
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const symbol = await queries.getSymbol(
        conn as unknown as import("kuzu").Connection,
        symbolId,
      );
      assert.ok(symbol);
      assert.strictEqual(symbol.symbolId, symbolId);
      assert.strictEqual(symbol.fileId, fileId);
      assert.strictEqual(symbol.repoId, repoId);
      assert.strictEqual(symbol.signatureJson, signatureJson);
      assert.strictEqual(symbol.exported, true);
    },
  );

  it(
    "getSymbolsByFile/getSymbolsByRepo",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-a",
        repoId,
        fileId,
        kind: "function",
        name: "a",
        exported: false,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 10,
        astFingerprint: "a",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const byFile = await queries.getSymbolsByFile(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );
      assert.strictEqual(byFile.length, 1);
      assert.strictEqual(byFile[0]!.symbolId, "sym-a");

      const byRepo = await queries.getSymbolsByRepo(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(byRepo.length, 1);
      assert.strictEqual(byRepo[0]!.symbolId, "sym-a");
    },
  );

  it(
    "getSymbolsByIds handles 500+ IDs",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-batch-1",
        repoId,
        fileId,
        kind: "function",
        name: "b1",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 1,
        astFingerprint: "b1",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const ids: string[] = [];
      for (let i = 1; i <= 550; i++) {
        ids.push(`sym-batch-${i}`);
      }

      const result = await queries.getSymbolsByIds(
        conn as unknown as import("kuzu").Connection,
        ids,
      );

      assert.strictEqual(result.size, 1);
      assert.ok(result.has("sym-batch-1"));
    },
  );

  it(
    "findSymbolsInRange orders contained symbols first",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-range-outer",
        repoId,
        fileId,
        kind: "function",
        name: "outer",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 100,
        rangeEndCol: 0,
        astFingerprint: "o",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-range-inner",
        repoId,
        fileId,
        kind: "function",
        name: "inner",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 10,
        rangeStartCol: 0,
        rangeEndLine: 20,
        rangeEndCol: 0,
        astFingerprint: "i",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const found = await queries.findSymbolsInRange(
        conn as unknown as import("kuzu").Connection,
        repoId,
        fileId,
        9,
        21,
      );

      assert.ok(found.length >= 2);
      assert.strictEqual(found[0]!.symbolId, "sym-range-inner");
    },
  );

  it(
    "deleteSymbolsByFileId removes symbols but preserves file",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-del",
        repoId,
        fileId,
        kind: "function",
        name: "del",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "d",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      await queries.deleteSymbolsByFileId(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );

      const symbolsAfter = await queries.getSymbolsByFile(
        conn as unknown as import("kuzu").Connection,
        fileId,
      );
      assert.strictEqual(symbolsAfter.length, 0);

      const fileAfter = await queries.getFileByRepoPath(
        conn as unknown as import("kuzu").Connection,
        repoId,
        "src/file.ts",
      );
      assert.ok(fileAfter);
    },
  );

  it(
    "getSymbolsByRepoForSnapshot returns projection",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-snap",
        repoId,
        fileId,
        kind: "function",
        name: "snap",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "snapfp",
        signatureJson: "{}",
        summary: "s",
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const rows = await queries.getSymbolsByRepoForSnapshot(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(Object.keys(rows[0]!).sort(), [
        "astFingerprint",
        "invariantsJson",
        "sideEffectsJson",
        "signatureJson",
        "summary",
        "symbolId",
      ]);
    },
  );

  it(
    "getSymbolCount counts symbols in repo",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-count",
        repoId,
        fileId,
        kind: "function",
        name: "count",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "c",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });

      const count = await queries.getSymbolCount(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );
      assert.strictEqual(count, 1);
    },
  );

  it(
    "normalizeDependencyPlaceholderSymbols counts external-only file-backed repairs",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-external-stale",
        repoId,
        fileId,
        kind: "function",
        name: "externalStale",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 0,
        astFingerprint: "external-stale",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'sym-external-stale'})
         SET s.external = true`,
      );

      const result = await queries.normalizeDependencyPlaceholderSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.strictEqual(result.fileBackedRepaired, 1);
      const dbResult = await conn.query(
        `MATCH (s:Symbol {symbolId: 'sym-external-stale'})
         RETURN coalesce(s.external, false) AS external`,
      );
      const row = await dbResult.getNext();
      dbResult.close();
      assert.strictEqual(row.external, false);
    },
  );

  it(
    "batchMergeExternalSymbols rewrites immutable external canonical fields",
    { skip: !ladybugAvailable },
    async () => {
      const symbol = scipExternalSymbol("external:active-rewrite");
      const typedConn = conn as unknown as import("kuzu").Connection;
      await queries.batchMergeExternalSymbols(typedConn, repoId, [symbol]);
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: '${symbol.symbolId}'})
         SET s.astFingerprint = 'stale',
             s.signatureJson = '{"stale":true}'`,
      );

      await queries.batchMergeExternalSymbols(typedConn, repoId, [symbol]);

      const dbResult = await conn.query(
        `MATCH (s:Symbol {symbolId: '${symbol.symbolId}'})
         RETURN s.astFingerprint AS astFingerprint,
                s.signatureJson AS signatureJson`,
      );
      const row = await dbResult.getNext();
      dbResult.close();
      assert.strictEqual(row.astFingerprint, symbol.symbolId);
      assert.strictEqual(row.signatureJson, null);
    },
  );

  it(
    "normalizeDependencyPlaceholderSymbols physically canonicalizes stable fields",
    { skip: !ladybugAvailable },
    async () => {
      const typedConn = conn as unknown as import("kuzu").Connection;
      await queries.upsertSymbol(typedConn, {
        symbolId: "sym-placeholder-source",
        repoId,
        fileId,
        kind: "function",
        name: "source",
        exported: true,
        visibility: null,
        language: "typescript",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 1,
        rangeEndCol: 1,
        astFingerprint: "source",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-07-16T00:00:00.000Z",
      });
      const placeholderId = "unresolved:call:legacyTarget";
      await queries.insertEdges(typedConn, [
        {
          repoId,
          fromSymbolId: "sym-placeholder-source",
          toSymbolId: placeholderId,
          edgeType: "call",
          weight: 0.5,
          confidence: 0.5,
          resolution: "unresolved",
          provenance: "legacy",
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ]);
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: '${placeholderId}'})
         SET s.name = 'legacyTarget',
             s.kind = 'placeholder',
             s.language = NULL,
             s.rangeStartLine = NULL,
             s.rangeStartCol = NULL,
             s.rangeEndLine = NULL,
             s.rangeEndCol = NULL,
             s.astFingerprint = NULL,
             s.signatureJson = '{"legacy":true}',
             s.source = NULL,
             s.scipSymbol = 'legacy'`,
      );

      const repaired = await queries.normalizeDependencyPlaceholderSymbols(
        typedConn,
        repoId,
      );
      assert.strictEqual(repaired.dependencyPlaceholdersRepaired, 1);
      const dbResult = await conn.query(
        `MATCH (s:Symbol {symbolId: '${placeholderId}'})
         RETURN s.name AS name,
                s.kind AS kind,
                s.language AS language,
                s.rangeStartLine AS rangeStartLine,
                s.rangeStartCol AS rangeStartCol,
                s.rangeEndLine AS rangeEndLine,
                s.rangeEndCol AS rangeEndCol,
                s.astFingerprint AS astFingerprint,
                s.signatureJson AS signatureJson,
                s.source AS source,
                s.scipSymbol AS scipSymbol`,
      );
      const row = await dbResult.getNext();
      dbResult.close();
      assert.deepStrictEqual(
        {
          ...row,
          rangeStartLine: Number(row.rangeStartLine),
          rangeStartCol: Number(row.rangeStartCol),
          rangeEndLine: Number(row.rangeEndLine),
          rangeEndCol: Number(row.rangeEndCol),
        },
        {
          name: placeholderId,
          kind: "unknown",
          language: "unknown",
          rangeStartLine: 0,
          rangeStartCol: 0,
          rangeEndLine: 0,
          rangeEndCol: 0,
          astFingerprint: placeholderId,
          signatureJson: null,
          source: "treesitter",
          scipSymbol: null,
        },
      );
    },
  );

  it(
    "normalizeDependencyPlaceholderSymbols preserves provider metadata endpoints",
    { skip: !ladybugAvailable },
    async () => {
      await queries.upsertSymbol(conn as unknown as import("kuzu").Connection, {
        symbolId: "sym-provider-metadata",
        repoId,
        fileId,
        kind: "method",
        name: "default",
        exported: true,
        visibility: null,
        language: "rust",
        rangeStartLine: 0,
        rangeStartCol: 0,
        rangeEndLine: 0,
        rangeEndCol: 0,
        astFingerprint: "provider-metadata",
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: "2026-03-04T00:00:00Z",
      });
      await exec(
        conn,
        `MATCH (s:Symbol {symbolId: 'sym-provider-metadata'})
         SET s.source = 'scip',
             s.symbolStatus = 'unresolved',
             s.placeholderKind = 'provider-metadata',
             s.placeholderTarget = 'rust-analyzer cargo pkg 1.0.0 src/lib/Foo#default().'`,
      );

      const result = await queries.normalizeDependencyPlaceholderSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.strictEqual(result.fileBackedRepaired, 0);
      const dbResult = await conn.query(
        `MATCH (s:Symbol {symbolId: 'sym-provider-metadata'})
         RETURN s.symbolStatus AS symbolStatus,
                s.placeholderKind AS placeholderKind,
                s.placeholderTarget AS placeholderTarget`,
      );
      const row = await dbResult.getNext();
      dbResult.close();
      assert.strictEqual(row.symbolStatus, "unresolved");
      assert.strictEqual(row.placeholderKind, "provider-metadata");
      assert.strictEqual(
        row.placeholderTarget,
        "rust-analyzer cargo pkg 1.0.0 src/lib/Foo#default().",
      );
    },
  );

  it(
    "normalizeProviderFirstCallEdgeProvenance repairs legacy string provenance",
    { skip: !ladybugAvailable },
    async () => {
      for (const symbolId of ["sym-provider-source", "sym-provider-target"]) {
        await queries.upsertSymbol(
          conn as unknown as import("kuzu").Connection,
          {
            symbolId,
            repoId,
            fileId,
            kind: "function",
            name: symbolId,
            exported: true,
            visibility: null,
            language: "typescript",
            rangeStartLine: 1,
            rangeStartCol: 0,
            rangeEndLine: 1,
            rangeEndCol: 1,
            astFingerprint: symbolId,
            signatureJson: null,
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            updatedAt: "2026-03-04T00:00:00Z",
          },
        );
      }
      await exec(
        conn,
        `MATCH (a:Symbol {symbolId: 'sym-provider-source'})
         MATCH (b:Symbol {symbolId: 'sym-provider-target'})
         CREATE (a)-[:DEPENDS_ON {
           edgeType: 'call',
           weight: 1.0,
           confidence: 0.95,
           resolution: 'exact',
           resolverId: 'provider-first:scip-io',
           resolutionPhase: 'provider-first',
           provenance: 'import:legacy',
           createdAt: '2026-03-04T00:00:00Z'
         }]->(b)`,
      );

      const repaired = await queries.normalizeProviderFirstCallEdgeProvenance(
        conn as unknown as import("kuzu").Connection,
        repoId,
      );

      assert.strictEqual(repaired, 1);
      const dbResult = await conn.query(
        `MATCH (:Symbol {symbolId: 'sym-provider-source'})-[d:DEPENDS_ON]->(:Symbol {symbolId: 'sym-provider-target'})
         RETURN d.provenance AS provenance`,
      );
      const row = await dbResult.getNext();
      dbResult.close();
      const provenance = JSON.parse(String(row.provenance)) as {
        dedupeKey?: unknown;
        previousProvenance?: unknown;
        repaired?: unknown;
      };
      assert.strictEqual(provenance.repaired, true);
      assert.strictEqual(provenance.previousProvenance, "import:legacy");
      assert.strictEqual(
        provenance.dedupeKey,
        "sym-provider-source|sym-provider-target|call|scip-io",
      );
    },
  );

  it(
    "normalizeDependencyPlaceholderSymbols scopes file-backed repairs by file id",
    { skip: !ladybugAvailable },
    async () => {
      const otherFileId = "sym-file-other";
      await queries.upsertFile(conn as unknown as import("kuzu").Connection, {
        fileId: otherFileId,
        repoId,
        relPath: "src/other.ts",
        contentHash: "other-hash",
        language: "ts",
        byteSize: 10,
        lastIndexedAt: null,
      });
      for (const [symbolId, targetFileId] of [
        ["sym-external-scoped", fileId],
        ["sym-external-unscoped", otherFileId],
      ] as const) {
        await queries.upsertSymbol(
          conn as unknown as import("kuzu").Connection,
          {
            symbolId,
            repoId,
            fileId: targetFileId,
            kind: "function",
            name: symbolId,
            exported: true,
            visibility: null,
            language: "typescript",
            rangeStartLine: 1,
            rangeStartCol: 0,
            rangeEndLine: 1,
            rangeEndCol: 0,
            astFingerprint: symbolId,
            signatureJson: null,
            summary: null,
            invariantsJson: null,
            sideEffectsJson: null,
            updatedAt: "2026-03-04T00:00:00Z",
          },
        );
        await exec(
          conn,
          `MATCH (s:Symbol {symbolId: '${symbolId}'})
           SET s.external = true`,
        );
      }

      const result = await queries.normalizeDependencyPlaceholderSymbols(
        conn as unknown as import("kuzu").Connection,
        repoId,
        { fileIds: new Set([fileId]) },
      );

      assert.strictEqual(result.fileBackedRepaired, 1);
      const dbResult = await conn.query(
        `MATCH (s:Symbol)
         WHERE s.symbolId IN ['sym-external-scoped', 'sym-external-unscoped']
         RETURN s.symbolId AS symbolId, coalesce(s.external, false) AS external
         ORDER BY s.symbolId`,
      );
      const rows: Record<string, boolean> = {};
      while (dbResult.hasNext()) {
        const row = await dbResult.getNext();
        rows[String(row.symbolId)] = Boolean(row.external);
      }
      dbResult.close();
      assert.deepStrictEqual(rows, {
        "sym-external-scoped": false,
        "sym-external-unscoped": true,
      });
    },
  );
});
