import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let initLadybugDb: (dbPath: string) => Promise<void>;
let closeLadybugDb: () => Promise<void>;
let getLadybugConn: () => Promise<import("kuzu").Connection>;
let getSchemaVersion: (
  conn: import("kuzu").Connection,
) => Promise<number | null>;
let LADYBUG_SCHEMA_VERSION: number;
let ladybugQueries: typeof import("../../dist/db/ladybug-queries.js");
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migMod = await import("../../dist/db/migrations/index.js");
  ladybugQueries = await import("../../dist/db/ladybug-queries.js");
  initLadybugDb = ladybugMod.initLadybugDb;
  closeLadybugDb = ladybugMod.closeLadybugDb;
  getLadybugConn = ladybugMod.getLadybugConn;
  getSchemaVersion = schemaMod.getSchemaVersion;
  LADYBUG_SCHEMA_VERSION = migMod.LADYBUG_SCHEMA_VERSION;
  ladybugAvailable = true;
} catch {
  // Module not built or kuzu unavailable
}

/**
 * Create a v4 database (base schema without Memory tables).
 * We open the DB, create the core tables + SchemaVersion at v4, then close.
 */
/** Helper to close a query result regardless of union type */
function closeResult(r: unknown): void {
  if (
    r &&
    typeof r === "object" &&
    "close" in r &&
    typeof (r as Record<string, unknown>).close === "function"
  ) {
    (r as { close(): void }).close();
  }
}

async function createV4Database(dbPath: string): Promise<void> {
  const kuzu = await import("kuzu");

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  // Create minimal tables needed for a v4 DB.
  // Metrics is included (without pageRank/kCore) so m011 ALTER TABLE
  // statements succeed — matches what a real v4 DB would have had.
  const ddl = [
    `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Metrics (symbolId STRING PRIMARY KEY, fanIn INT64 DEFAULT 0, fanOut INT64 DEFAULT 0, churn30d INT64 DEFAULT 0, testRefsJson STRING, updatedAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
  ];
  for (const stmt of ddl) {
    closeResult(await conn.query(stmt));
  }

  // Stamp as v4
  const now = new Date().toISOString();
  closeResult(
    await conn.query(
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 4, createdAt: '${now}', updatedAt: '${now}'})`,
    ),
  );

  await conn.close();
  await db.close();
}

async function createV8DatabaseWithoutSummaryMetadata(
  dbPath: string,
): Promise<void> {
  const kuzu = await import("kuzu");

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  const ddl = [
    `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING, embeddingJinaCode STRING, embeddingJinaCodeCardHash STRING, embeddingJinaCodeUpdatedAt STRING, embeddingNomic STRING, embeddingNomicCardHash STRING, embeddingNomicUpdatedAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Cluster (clusterId STRING PRIMARY KEY, repoId STRING, label STRING, symbolCount INT32 DEFAULT 0, cohesionScore DOUBLE DEFAULT 0.0, versionId STRING, createdAt STRING, searchText STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Process (processId STRING PRIMARY KEY, repoId STRING, entrySymbolId STRING, label STRING, depth INT32 DEFAULT 0, versionId STRING, createdAt STRING, searchText STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
    // Metrics table at v8: no pageRank/kCore columns — m011 must ALTER it.
    `CREATE NODE TABLE IF NOT EXISTS Metrics (symbolId STRING PRIMARY KEY, fanIn INT64 DEFAULT 0, fanOut INT64 DEFAULT 0, churn30d INT64 DEFAULT 0, testRefsJson STRING, canonicalTestJson STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (FROM Symbol TO Symbol, edgeType STRING DEFAULT 'call', weight DOUBLE DEFAULT 1.0, confidence DOUBLE DEFAULT 1.0, resolution STRING DEFAULT 'exact', resolverId STRING DEFAULT 'pass1-generic', resolutionPhase STRING DEFAULT 'pass1', provenance STRING, createdAt STRING)`,
  ];

  for (const stmt of ddl) {
    closeResult(await conn.query(stmt));
  }

  const now = new Date().toISOString();
  closeResult(
    await conn.query(
      `CREATE (r:Repo {repoId: 'repo-1', rootPath: '/repo', configJson: '{}', createdAt: '${now}'})`,
    ),
  );
  closeResult(
    await conn.query(
      `CREATE (f:File {fileId: 'file-1', relPath: 'src/example.ts', contentHash: 'hash-1', language: 'typescript', byteSize: 42, lastIndexedAt: '${now}', directory: 'src'})`,
    ),
  );
  closeResult(
    await conn.query(
      `CREATE (s:Symbol {symbolId: 'sym-1', kind: 'function', name: 'exampleFn', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 3, rangeEndCol: 1, astFingerprint: 'fp-1', signatureJson: '{}', summary: 'Example summary', invariantsJson: null, sideEffectsJson: null, roleTagsJson: '[]', searchText: 'exampleFn Example summary', updatedAt: '${now}', embeddingJinaCode: null, embeddingJinaCodeCardHash: null, embeddingJinaCodeUpdatedAt: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null})`,
    ),
  );
  closeResult(
    await conn.query(
      `MATCH (f:File {fileId: 'file-1'}), (r:Repo {repoId: 'repo-1'}), (s:Symbol {symbolId: 'sym-1'}) CREATE (f)-[:FILE_IN_REPO]->(r), (s)-[:SYMBOL_IN_FILE]->(f), (s)-[:SYMBOL_IN_REPO]->(r)`,
    ),
  );
  closeResult(
    await conn.query(
      `CREATE (s:Symbol {symbolId: 'unresolved:call:legacyHelper', kind: null, name: null, exported: false, visibility: null, language: null, rangeStartLine: null, rangeStartCol: null, rangeEndLine: null, rangeEndCol: null, astFingerprint: null, signatureJson: null, summary: null, invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: null, updatedAt: '${now}', embeddingJinaCode: null, embeddingJinaCodeCardHash: null, embeddingJinaCodeUpdatedAt: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null})`,
    ),
  );
  closeResult(
    await conn.query(
      `MATCH (r:Repo {repoId: 'repo-1'}), (s:Symbol {symbolId: 'unresolved:call:legacyHelper'}) CREATE (s)-[:SYMBOL_IN_REPO]->(r)`,
    ),
  );
  closeResult(
    await conn.query(
      `MATCH (source:Symbol {symbolId: 'sym-1'}), (target:Symbol {symbolId: 'unresolved:call:legacyHelper'}) CREATE (source)-[:DEPENDS_ON {edgeType: 'call', weight: 0.5, confidence: 0.5, resolution: 'unresolved', resolverId: 'legacy', resolutionPhase: 'pass1', provenance: 'unresolved-call:legacyHelper', createdAt: '${now}'}]->(target)`,
    ),
  );
  closeResult(
    await conn.query(
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 8, createdAt: '${now}', updatedAt: '${now}'})`,
    ),
  );

  await conn.close();
  await db.close();
}

async function createV15DatabaseWithLegacyScipExternal(
  dbPath: string,
): Promise<void> {
  const kuzu = await import("kuzu");

  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  const ddl = [
    `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, repoId STRING, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, summaryQuality DOUBLE DEFAULT 0.0, summarySource STRING DEFAULT 'unknown', invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING, embeddingMiniLM STRING, embeddingMiniLMCardHash STRING, embeddingMiniLMUpdatedAt STRING, embeddingMiniLMVec DOUBLE[768], embeddingNomic STRING, embeddingNomicCardHash STRING, embeddingNomicUpdatedAt STRING, embeddingJinaCode STRING, embeddingJinaCodeCardHash STRING, embeddingJinaCodeUpdatedAt STRING, embeddingNomicVec DOUBLE[768], embeddingJinaCodeVec DOUBLE[768], external BOOL DEFAULT false, scipSymbol STRING, source STRING DEFAULT 'treesitter', packageName STRING, packageVersion STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (FROM Symbol TO Symbol, edgeType STRING DEFAULT 'call', weight DOUBLE DEFAULT 1.0, confidence DOUBLE DEFAULT 1.0, resolution STRING DEFAULT 'exact', resolverId STRING DEFAULT 'pass1-generic', resolutionPhase STRING DEFAULT 'pass1', provenance STRING, createdAt STRING)`,
  ];
  for (const stmt of ddl) {
    closeResult(await conn.query(stmt));
  }

  const now = new Date().toISOString();
  const scipSymbol = "scip-typescript npm lodash 4.17.21 lodash/chunk().";
  for (const stmt of [
    `CREATE (r:Repo {repoId: 'repo-1', rootPath: '/repo', configJson: '{}', createdAt: '${now}'})`,
    `CREATE (f:File {fileId: 'file-1', relPath: 'src/example.ts', contentHash: 'hash-1', language: 'typescript', byteSize: 42, lastIndexedAt: '${now}', directory: 'src'})`,
    `CREATE (source:Symbol {symbolId: 'sym-1', repoId: 'repo-1', kind: 'function', name: 'exampleFn', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 3, rangeEndCol: 1, astFingerprint: 'fp-1', signatureJson: '{}', summary: 'Example summary', summaryQuality: 0, summarySource: 'unknown', invariantsJson: null, sideEffectsJson: null, roleTagsJson: '[]', searchText: 'exampleFn Example summary', updatedAt: '${now}', embeddingMiniLM: null, embeddingMiniLMCardHash: null, embeddingMiniLMUpdatedAt: null, embeddingMiniLMVec: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null, embeddingJinaCode: null, embeddingJinaCodeCardHash: null, embeddingJinaCodeUpdatedAt: null, embeddingNomicVec: null, embeddingJinaCodeVec: null, external: false, scipSymbol: null, source: 'treesitter', packageName: null, packageVersion: null})`,
    `CREATE (placeholder:Symbol {symbolId: 'unresolved:call:legacyHelper', repoId: 'repo-1', kind: 'function', name: 'legacyHelper', exported: false, visibility: null, language: 'typescript', rangeStartLine: null, rangeStartCol: null, rangeEndLine: null, rangeEndCol: null, astFingerprint: null, signatureJson: null, summary: 'stale unresolved dependency placeholder', summaryQuality: 0, summarySource: 'unknown', invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: 'legacyHelper placeholder', updatedAt: '${now}', embeddingMiniLM: null, embeddingMiniLMCardHash: null, embeddingMiniLMUpdatedAt: null, embeddingMiniLMVec: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null, embeddingJinaCode: null, embeddingJinaCodeCardHash: null, embeddingJinaCodeUpdatedAt: null, embeddingNomicVec: null, embeddingJinaCodeVec: null, external: false, scipSymbol: null, source: 'treesitter', packageName: null, packageVersion: null})`,
    `CREATE (external:Symbol {symbolId: 'scip-external-legacy-chunk', repoId: 'repo-1', kind: 'function', name: 'chunk', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 0, rangeStartCol: 0, rangeEndLine: 0, rangeEndCol: 0, astFingerprint: 'scip-external-legacy-chunk', signatureJson: null, summary: 'legacy SCIP external chunk', summaryQuality: 0, summarySource: 'unknown', invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: 'chunk legacy SCIP external', updatedAt: '${now}', embeddingMiniLM: null, embeddingMiniLMCardHash: null, embeddingMiniLMUpdatedAt: null, embeddingMiniLMVec: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null, embeddingJinaCode: null, embeddingJinaCodeCardHash: null, embeddingJinaCodeUpdatedAt: null, embeddingNomicVec: null, embeddingJinaCodeVec: null, external: true, scipSymbol: '${scipSymbol}', source: 'scip', packageName: 'lodash', packageVersion: '4.17.21'})`,
    `MATCH (f:File {fileId: 'file-1'}), (r:Repo {repoId: 'repo-1'}), (source:Symbol {symbolId: 'sym-1'}), (placeholder:Symbol {symbolId: 'unresolved:call:legacyHelper'}), (external:Symbol {symbolId: 'scip-external-legacy-chunk'}) CREATE (f)-[:FILE_IN_REPO]->(r), (source)-[:SYMBOL_IN_FILE]->(f), (source)-[:SYMBOL_IN_REPO]->(r), (placeholder)-[:SYMBOL_IN_REPO]->(r), (external)-[:SYMBOL_IN_REPO]->(r)`,
    `MATCH (source:Symbol {symbolId: 'sym-1'}), (placeholder:Symbol {symbolId: 'unresolved:call:legacyHelper'}), (external:Symbol {symbolId: 'scip-external-legacy-chunk'}) CREATE (source)-[:DEPENDS_ON {edgeType: 'call', weight: 0.5, confidence: 0.5, resolution: 'unresolved', resolverId: 'legacy', resolutionPhase: 'pass1', provenance: 'unresolved-call:legacyHelper', createdAt: '${now}'}]->(placeholder), (source)-[:DEPENDS_ON {edgeType: 'import', weight: 0.6, confidence: 0.95, resolution: 'exact', resolverId: 'scip', resolutionPhase: 'scip', provenance: 'scip-external:${scipSymbol}', createdAt: '${now}'}]->(external)`,
    `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 15, createdAt: '${now}', updatedAt: '${now}'})`,
  ]) {
    closeResult(await conn.query(stmt));
  }

  await conn.close();
  await db.close();
}

describe("migration: upgrade existing DB", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-upgrade-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("migrates v4 DB to latest version", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4.lbug");

    // Create a v4 database
    await createV4Database(dbPath);

    // Now init (should apply migrations)
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);

    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
    assert.ok(LADYBUG_SCHEMA_VERSION >= 5, "Version should be at least 5");
  });

  it("Memory table exists after migration", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4-memory.lbug");

    await createV4Database(dbPath);
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();

    // Query the Memory table — should not throw
    const result = await conn.query("MATCH (m:Memory) RETURN count(m) AS cnt");
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{ cnt: unknown }>;
    qr.close();

    // Empty but table exists
    assert.ok(rows.length > 0);
  });

  it("idempotent: re-init on already-migrated DB is a no-op", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v4-idempotent.lbug");

    await createV4Database(dbPath);
    await initLadybugDb(dbPath);
    await closeLadybugDb();

    // Re-init on same DB — should not throw, should stay at same version
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);
    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
  });

  it("upgrades old v8 DBs that are missing Symbol summary metadata columns", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v8-summary-metadata.lbug");

    await createV8DatabaseWithoutSummaryMetadata(dbPath);
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const result = await conn.query(
      `MATCH (s:Symbol {symbolId: 'sym-1'})
       RETURN s.summaryQuality AS summaryQuality,
              s.summarySource AS summarySource,
              s.repoId AS repoId`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      summaryQuality: unknown;
      summarySource: unknown;
      repoId: unknown;
    }>;
    qr.close();

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].summaryQuality, 0);
    assert.strictEqual(rows[0].summarySource, "unknown");
    assert.strictEqual(rows[0].repoId, "repo-1");
  });

  it("v8 -> latest: m016 backfills Symbol placeholder status columns", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v8-placeholder-status.lbug");

    await createV8DatabaseWithoutSummaryMetadata(dbPath);
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const result = await conn.query(
      `MATCH (real:Symbol {symbolId: 'sym-1'})
       MATCH (placeholder:Symbol {symbolId: 'unresolved:call:legacyHelper'})
       RETURN real.symbolStatus AS realStatus,
              placeholder.symbolStatus AS placeholderStatus,
              placeholder.placeholderKind AS placeholderKind,
              placeholder.placeholderTarget AS placeholderTarget`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      realStatus: unknown;
      placeholderStatus: unknown;
      placeholderKind: unknown;
      placeholderTarget: unknown;
    }>;
    qr.close();

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].realStatus, "real");
    assert.strictEqual(rows[0].placeholderStatus, "unresolved");
    assert.strictEqual(rows[0].placeholderKind, "call");
    assert.strictEqual(rows[0].placeholderTarget, "legacyHelper");

    const repoSymbols = await ladybugQueries.getSymbolsByRepo(conn, "repo-1");
    assert.deepStrictEqual(
      repoSymbols.map((row) => row.symbolId),
      ["sym-1"],
      "repo symbol projections should stay limited to real file-backed symbols",
    );

    const snapshotRows = await ladybugQueries.getSymbolsByRepoForSnapshot(
      conn,
      "repo-1",
    );
    assert.deepStrictEqual(
      snapshotRows.map((row) => row.symbolId),
      ["sym-1"],
      "version snapshots should exclude dependency placeholders after migration",
    );

    const count = await ladybugQueries.getSymbolCount(conn, "repo-1");
    assert.strictEqual(
      count,
      1,
      "repo symbol count should exclude dependency placeholders after migration",
    );

    const hydrated = await ladybugQueries.getSearchableSymbolsByIds(
      conn,
      "repo-1",
      ["sym-1", "unresolved:call:legacyHelper"],
    );
    assert.deepStrictEqual(
      [...hydrated.keys()],
      ["sym-1"],
      "search hydration should exclude unresolved placeholder candidates after migration",
    );
  });

  it("v15 -> latest: m016 types legacy placeholders and SCIP externals", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v15-placeholder-and-scip-status.lbug");

    await createV15DatabaseWithLegacyScipExternal(dbPath);
    await initLadybugDb(dbPath);

    const conn = await getLadybugConn();
    const result = await conn.query(
      `MATCH (s:Symbol {repoId: 'repo-1'})
       RETURN s.symbolId AS symbolId,
              s.symbolStatus AS symbolStatus,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget,
              coalesce(s.external, false) AS external
       ORDER BY symbolId`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      symbolId: unknown;
      symbolStatus: unknown;
      placeholderKind: unknown;
      placeholderTarget: unknown;
      external: unknown;
    }>;
    qr.close();

    assert.deepStrictEqual(rows, [
      {
        symbolId: "scip-external-legacy-chunk",
        symbolStatus: "external",
        placeholderKind: "scip",
        placeholderTarget: "scip-typescript npm lodash 4.17.21 lodash/chunk().",
        external: true,
      },
      {
        symbolId: "sym-1",
        symbolStatus: "real",
        placeholderKind: null,
        placeholderTarget: null,
        external: false,
      },
      {
        symbolId: "unresolved:call:legacyHelper",
        symbolStatus: "unresolved",
        placeholderKind: "call",
        placeholderTarget: "legacyHelper",
        external: false,
      },
    ]);

    const repoSymbols = await ladybugQueries.getSymbolsByRepo(conn, "repo-1");
    assert.deepStrictEqual(
      repoSymbols.map((row) => row.symbolId),
      ["sym-1"],
      "repo graph snapshots should exclude unresolved and external placeholders",
    );

    const snapshotRows = await ladybugQueries.getSymbolsByRepoForSnapshot(
      conn,
      "repo-1",
    );
    assert.deepStrictEqual(
      snapshotRows.map((row) => row.symbolId),
      ["sym-1"],
      "version snapshots should exclude non-real symbols",
    );

    const count = await ladybugQueries.getSymbolCount(conn, "repo-1");
    assert.strictEqual(count, 1);

    const placeholderSearch = await ladybugQueries.searchSymbols(
      conn,
      "repo-1",
      "legacyHelper",
      10,
    );
    assert.equal(
      placeholderSearch.some(
        (row) => row.symbolId === "unresolved:call:legacyHelper",
      ),
      false,
      "search should not expose unresolved placeholders with stale names",
    );

    const externalSearch = await ladybugQueries.searchSymbols(
      conn,
      "repo-1",
      "chunk",
      10,
    );
    assert.equal(
      externalSearch.some(
        (row) => row.symbolId === "scip-external-legacy-chunk",
      ),
      true,
      "SCIP externals should remain searchable by default",
    );

    const filteredExternalSearch = await ladybugQueries.searchSymbols(
      conn,
      "repo-1",
      "chunk",
      10,
      undefined,
      true,
    );
    assert.equal(
      filteredExternalSearch.some(
        (row) => row.symbolId === "scip-external-legacy-chunk",
      ),
      false,
      "excludeExternal should suppress migrated SCIP externals",
    );

    const hydrated = await ladybugQueries.getSearchableSymbolsByIds(
      conn,
      "repo-1",
      ["sym-1", "unresolved:call:legacyHelper", "scip-external-legacy-chunk"],
    );
    assert.deepStrictEqual([...hydrated.keys()].sort(), [
      "scip-external-legacy-chunk",
      "sym-1",
    ]);

    const filteredHydrated = await ladybugQueries.getSearchableSymbolsByIds(
      conn,
      "repo-1",
      ["sym-1", "scip-external-legacy-chunk"],
      true,
    );
    assert.deepStrictEqual(
      [...filteredHydrated.keys()],
      ["sym-1"],
      "excludeExternal hydration should keep only real symbols",
    );
  });

  it("v16 -> latest: m017 repairs placeholder metadata and prunes isolated placeholders", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v16-placeholder-quality.lbug");
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(dbPath);
    const seedConn = new kuzu.Connection(db);
    const now = new Date().toISOString();

    for (const stmt of [
      `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, repoId STRING, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING, external BOOL DEFAULT false, symbolStatus STRING DEFAULT 'real', placeholderKind STRING, placeholderTarget STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
      `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
      `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
      `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
      `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (FROM Symbol TO Symbol, edgeType STRING DEFAULT 'call', weight DOUBLE DEFAULT 1.0, confidence DOUBLE DEFAULT 1.0, resolution STRING DEFAULT 'exact', resolverId STRING DEFAULT 'pass1-generic', resolutionPhase STRING DEFAULT 'pass1', provenance STRING, createdAt STRING)`,
    ]) {
      closeResult(await seedConn.query(stmt));
    }

    for (const stmt of [
      `CREATE (r:Repo {repoId: 'repo-1', rootPath: '/repo', configJson: '{}', createdAt: '${now}'})`,
      `CREATE (source:Symbol {symbolId: 'source', repoId: 'repo-1', kind: 'function', name: 'source', exported: true, visibility: 'public', language: 'ts', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 1, rangeEndCol: 1, astFingerprint: 'source', signatureJson: '{}', summary: null, invariantsJson: null, sideEffectsJson: null, roleTagsJson: '[]', searchText: 'source', updatedAt: '${now}', external: false, symbolStatus: 'real', placeholderKind: '', placeholderTarget: ''})`,
      `CREATE (external:Symbol {symbolId: 'unresolved:zod:z', repoId: 'repo-1', kind: null, name: null, exported: false, visibility: null, language: null, rangeStartLine: null, rangeStartCol: null, rangeEndLine: null, rangeEndCol: null, astFingerprint: null, signatureJson: null, summary: null, invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: null, updatedAt: '${now}', external: false, symbolStatus: 'unresolved', placeholderKind: 'import', placeholderTarget: 'wrong'})`,
      `CREATE (call:Symbol {symbolId: 'unresolved:call:makeThing', repoId: 'repo-1', kind: null, name: null, exported: false, visibility: null, language: null, rangeStartLine: null, rangeStartCol: null, rangeEndLine: null, rangeEndCol: null, astFingerprint: null, signatureJson: null, summary: null, invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: null, updatedAt: '${now}', external: true, symbolStatus: 'external', placeholderKind: 'import', placeholderTarget: 'wrong'})`,
      `CREATE (isolated:Symbol {symbolId: 'unresolved:call:staleThing', repoId: 'repo-1', kind: null, name: null, exported: false, visibility: null, language: null, rangeStartLine: null, rangeStartCol: null, rangeEndLine: null, rangeEndCol: null, astFingerprint: null, signatureJson: null, summary: null, invariantsJson: null, sideEffectsJson: null, roleTagsJson: null, searchText: null, updatedAt: '${now}', external: false, symbolStatus: 'unresolved', placeholderKind: 'call', placeholderTarget: 'staleThing'})`,
      `MATCH (r:Repo {repoId: 'repo-1'}), (source:Symbol {symbolId: 'source'}), (external:Symbol {symbolId: 'unresolved:zod:z'}), (call:Symbol {symbolId: 'unresolved:call:makeThing'}), (isolated:Symbol {symbolId: 'unresolved:call:staleThing'}) CREATE (source)-[:SYMBOL_IN_REPO]->(r), (external)-[:SYMBOL_IN_REPO]->(r), (call)-[:SYMBOL_IN_REPO]->(r), (isolated)-[:SYMBOL_IN_REPO]->(r)`,
      `MATCH (source:Symbol {symbolId: 'source'}), (external:Symbol {symbolId: 'unresolved:zod:z'}), (call:Symbol {symbolId: 'unresolved:call:makeThing'}) CREATE (source)-[:DEPENDS_ON {edgeType: 'import', weight: 0.6, confidence: 1.0, resolution: 'exact', resolverId: 'legacy', resolutionPhase: 'pass1', provenance: 'import:zod:z', createdAt: '${now}'}]->(external), (source)-[:DEPENDS_ON {edgeType: 'call', weight: 0.5, confidence: 0.7, resolution: 'unresolved', resolverId: 'legacy', resolutionPhase: 'pass1', provenance: 'unresolved-call:makeThing', createdAt: '${now}'}]->(call)`,
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 16, createdAt: '${now}', updatedAt: '${now}'})`,
    ]) {
      closeResult(await seedConn.query(stmt));
    }
    await seedConn.close();
    await db.close();

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const result = await conn.query(
      `MATCH (s:Symbol {repoId: 'repo-1'})
       WHERE s.symbolId STARTS WITH 'unresolved:'
       RETURN s.symbolId AS symbolId,
              s.symbolStatus AS symbolStatus,
              s.placeholderKind AS placeholderKind,
              s.placeholderTarget AS placeholderTarget,
              coalesce(s.external, false) AS external
       ORDER BY symbolId`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      symbolId: unknown;
      symbolStatus: unknown;
      placeholderKind: unknown;
      placeholderTarget: unknown;
      external: unknown;
    }>;
    qr.close();

    assert.deepStrictEqual(rows, [
      {
        symbolId: "unresolved:call:makeThing",
        symbolStatus: "unresolved",
        placeholderKind: "call",
        placeholderTarget: "makeThing",
        external: false,
      },
      {
        symbolId: "unresolved:zod:z",
        symbolStatus: "external",
        placeholderKind: "import",
        placeholderTarget: "z (from zod)",
        external: true,
      },
    ]);
  });

  it("v17 -> latest: m018 creates semantic enrichment provider tables", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v17-semantic-enrichment.lbug");
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(dbPath);
    const seedConn = new kuzu.Connection(db);
    const now = new Date().toISOString();

    for (const stmt of [
      `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
      `CREATE (r:Repo {repoId: 'repo-1', rootPath: '/repo', configJson: '{}', createdAt: '${now}'})`,
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 17, createdAt: '${now}', updatedAt: '${now}'})`,
    ]) {
      closeResult(await seedConn.query(stmt));
    }
    await seedConn.close();
    await db.close();

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);
    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);

    for (const stmt of [
      `CREATE (r:SemanticProviderRun {runId: 'run-1', repoId: 'repo-1', providerType: 'scip', providerId: 'scip-typescript', providerVersion: '1.0.0', languagesJson: '["typescript"]', sourceIndexPath: 'index.scip', sourceHash: 'hash-1', cacheKey: 'cache-1', configHash: 'config-1', ledgerVersion: 'v1', status: 'completed', startedAt: '${now}', finishedAt: '${now}', documentsProcessed: 1, symbolsMatched: 2, edgesCreated: 3, edgesUpgraded: 4, edgesReplaced: 0, edgesSkipped: 1, diagnosticsCount: 1, precisionScore: 0.95, cacheHit: false, canAffectPass2: true, selected: true, metadataJson: '{}', error: null})`,
      `CREATE (d:SemanticDiagnostic {id: 'diag-1', repoId: 'repo-1', runId: 'run-1', providerType: 'scip', providerId: 'scip-typescript', languageId: 'typescript', sourcePath: 'src/example.ts', severity: 'warning', message: 'demo', code: 'W1', rangeJson: '{}', createdAt: '${now}'})`,
      `CREATE (m:SemanticPrecisionMetric {id: 'metric-1', repoId: 'repo-1', runId: 'run-1', languageId: 'typescript', providerType: 'scip', providerId: 'scip-typescript', score: 0.95, filesCovered: 1, filesEligible: 1, symbolMatchRate: 1.0, resolvedEdgeRate: 1.0, diagnosticsAvailable: true, pass2SkipRate: 1.0, computedAt: '${now}', metadataJson: '{}'})`,
    ]) {
      closeResult(await conn.query(stmt));
    }

    const result = await conn.query(
      `MATCH (r:SemanticProviderRun {runId: 'run-1'})
       MATCH (d:SemanticDiagnostic {id: 'diag-1'})
       MATCH (m:SemanticPrecisionMetric {id: 'metric-1'})
       RETURN r.cacheKey AS cacheKey,
              r.canAffectPass2 AS canAffectPass2,
              d.sourcePath AS sourcePath,
              m.metadataJson AS metadataJson`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      cacheKey: unknown;
      canAffectPass2: unknown;
      sourcePath: unknown;
      metadataJson: unknown;
    }>;
    qr.close();

    assert.deepStrictEqual(rows, [
      {
        cacheKey: "cache-1",
        canAffectPass2: true,
        sourcePath: "src/example.ts",
        metadataJson: "{}",
      },
    ]);
  });

  it("v18 -> latest: m019 creates predictive prefetch outcome tables", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v18-prefetch-outcomes.lbug");
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(dbPath);
    const seedConn = new kuzu.Connection(db);
    const now = new Date().toISOString();

    for (const stmt of [
      `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
      `CREATE (r:Repo {repoId: 'repo-1', rootPath: '/repo', configJson: '{}', createdAt: '${now}'})`,
      `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: 18, createdAt: '${now}', updatedAt: '${now}'})`,
    ]) {
      closeResult(await seedConn.query(stmt));
    }
    await seedConn.close();
    await db.close();

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);
    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
    assert.ok(LADYBUG_SCHEMA_VERSION >= 19);

    await ladybugQueries.upsertPrefetchOutcomeAndAggregate(
      conn,
      {
        outcomeId: "outcome-1",
        prefetchId: "prefetch-1",
        aggregateKey: "repo-1|implement|client-a|search-cards|card",
        repoId: "repo-1",
        taskType: "implement",
        clientKey: "client-a",
        strategy: "search-cards",
        resourceKind: "card",
        resourceKey: "card:symbol-a",
        outcome: "offered",
        latencySavedMs: 0,
        tokensSavedEstimate: 0,
        plannedCost: 220,
        createdAt: now,
      },
      {
        aggregateKey: "repo-1|implement|client-a|search-cards|card",
        repoId: "repo-1",
        taskType: "implement",
        clientKey: "client-a",
        strategy: "search-cards",
        resourceKind: "card",
        offered: 1,
        used: 0,
        accepted: 0,
        wasted: 0,
        suppressed: 0,
        latencySavedMs: 0,
        tokensSavedEstimate: 0,
        score: 0,
        scoreEwma: 0,
        hitRateEwma: 0,
        acceptedRateEwma: 0,
        wasteRateEwma: 0,
        ewmaSamples: 0,
        lastOutcomeAt: now,
        updatedAt: now,
      },
    );

    const result = await conn.query(
      `MATCH (o:PrefetchOutcome {outcomeId: 'outcome-1'})
       MATCH (a:PrefetchPolicyAggregate {aggregateKey: 'repo-1|implement|client-a|search-cards|card'})
       RETURN o.prefetchId AS prefetchId, a.offered AS offered`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      prefetchId: unknown;
      offered: unknown;
    }>;
    qr.close();

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].prefetchId, "prefetch-1");
    assert.strictEqual(Number(rows[0].offered), 1);
  });

  it("v8 -> latest: m011 adds pageRank/kCore columns to Metrics", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v8-m011-centrality.lbug");

    await createV8DatabaseWithoutSummaryMetadata(dbPath);

    // Seed a Metrics row at v8 (pre-m011) so we can verify defaults on upgrade.
    {
      const kuzu = await import("kuzu");
      const db = new kuzu.Database(dbPath);
      const conn = new kuzu.Connection(db);
      const now = new Date().toISOString();
      closeResult(
        await conn.query(
          `CREATE (m:Metrics {symbolId: 'sym-1', fanIn: 2, fanOut: 1, churn30d: 0, testRefsJson: null, canonicalTestJson: null, updatedAt: '${now}'})`,
        ),
      );
      await conn.close();
      await db.close();
    }

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);
    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);

    const result = await conn.query(
      `MATCH (m:Metrics {symbolId: 'sym-1'}) RETURN m.pageRank AS pageRank, m.kCore AS kCore, m.fanIn AS fanIn`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{
      pageRank: unknown;
      kCore: unknown;
      fanIn: unknown;
    }>;
    qr.close();
    assert.strictEqual(rows.length, 1);
    // m011 ADD ... DEFAULT 0.0 / 0 should populate existing rows.
    assert.strictEqual(Number(rows[0].pageRank), 0);
    assert.strictEqual(Number(rows[0].kCore), 0);
    assert.strictEqual(Number(rows[0].fanIn), 2);
  });

  it("v8 -> latest: m011 creates ShadowCluster node/rel tables", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v8-m011-shadow.lbug");

    await createV8DatabaseWithoutSummaryMetadata(dbPath);
    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();

    // ShadowCluster node table should exist and accept inserts.
    const now = new Date().toISOString();
    closeResult(
      await conn.query(
        `CREATE (sc:ShadowCluster {shadowClusterId: 'test-sc', repoId: 'repo-1', algorithm: 'louvain', label: 'test', symbolCount: 1, modularity: 0.5, versionId: 'v1', createdAt: '${now}'})`,
      ),
    );
    const result = await conn.query(
      `MATCH (sc:ShadowCluster) RETURN count(sc) AS c`,
    );
    const qr = Array.isArray(result) ? result[0] : result;
    const rows = (await qr.getAll()) as Array<{ c: unknown }>;
    qr.close();
    assert.strictEqual(Number(rows[0].c), 1);
  });

  it("best-effort: DB newer than code logs warning but does not throw", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "v-future.lbug");

    // Create a DB and stamp it with a version higher than code knows
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(dbPath);
    const conn = new kuzu.Connection(db);

    const ddl = [
      `CREATE NODE TABLE IF NOT EXISTS Repo (repoId STRING PRIMARY KEY, rootPath STRING, configJson STRING, createdAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS File (fileId STRING PRIMARY KEY, relPath STRING, contentHash STRING, language STRING, byteSize INT64, lastIndexedAt STRING, directory STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING)`,
      `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
      `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
      `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
    ];
    for (const stmt of ddl) {
      closeResult(await conn.query(stmt));
    }
    const now = new Date().toISOString();
    const futureVersion = LADYBUG_SCHEMA_VERSION + 10;
    closeResult(
      await conn.query(
        `CREATE (sv:SchemaVersion {id: 'current', schemaVersion: ${futureVersion}, createdAt: '${now}', updatedAt: '${now}'})`,
      ),
    );
    await conn.close();
    await db.close();

    // Should NOT throw — best-effort mode
    await assert.doesNotReject(async () => {
      await initLadybugDb(dbPath);
    });
  });
});
