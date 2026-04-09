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
let ladybugAvailable = false;

try {
  const ladybugMod = await import("../../dist/db/ladybug.js");
  const schemaMod = await import("../../dist/db/ladybug-schema.js");
  const migMod = await import("../../dist/db/migrations/index.js");
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
    `CREATE NODE TABLE IF NOT EXISTS Symbol (symbolId STRING PRIMARY KEY, kind STRING, name STRING, exported BOOLEAN, visibility STRING, language STRING, rangeStartLine INT64, rangeStartCol INT64, rangeEndLine INT64, rangeEndCol INT64, astFingerprint STRING, signatureJson STRING, summary STRING, invariantsJson STRING, sideEffectsJson STRING, roleTagsJson STRING, searchText STRING, updatedAt STRING, embeddingMiniLM STRING, embeddingMiniLMCardHash STRING, embeddingMiniLMUpdatedAt STRING, embeddingNomic STRING, embeddingNomicCardHash STRING, embeddingNomicUpdatedAt STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Cluster (clusterId STRING PRIMARY KEY, repoId STRING, label STRING, symbolCount INT32 DEFAULT 0, cohesionScore DOUBLE DEFAULT 0.0, versionId STRING, createdAt STRING, searchText STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS Process (processId STRING PRIMARY KEY, repoId STRING, entrySymbolId STRING, label STRING, depth INT32 DEFAULT 0, versionId STRING, createdAt STRING, searchText STRING)`,
    `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (id STRING PRIMARY KEY, schemaVersion INT64, createdAt STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (FROM File TO Repo)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (FROM Symbol TO File)`,
    // Metrics table at v8: no pageRank/kCore columns — m011 must ALTER it.
    `CREATE NODE TABLE IF NOT EXISTS Metrics (symbolId STRING PRIMARY KEY, fanIn INT64 DEFAULT 0, fanOut INT64 DEFAULT 0, churn30d INT64 DEFAULT 0, testRefsJson STRING, canonicalTestJson STRING, updatedAt STRING)`,
    `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (FROM Symbol TO Repo)`,
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
      `CREATE (s:Symbol {symbolId: 'sym-1', kind: 'function', name: 'exampleFn', exported: true, visibility: 'public', language: 'typescript', rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 3, rangeEndCol: 1, astFingerprint: 'fp-1', signatureJson: '{}', summary: 'Example summary', invariantsJson: null, sideEffectsJson: null, roleTagsJson: '[]', searchText: 'exampleFn Example summary', updatedAt: '${now}', embeddingMiniLM: null, embeddingMiniLMCardHash: null, embeddingMiniLMUpdatedAt: null, embeddingNomic: null, embeddingNomicCardHash: null, embeddingNomicUpdatedAt: null})`,
    ),
  );
  closeResult(
    await conn.query(
      `MATCH (f:File {fileId: 'file-1'}), (r:Repo {repoId: 'repo-1'}), (s:Symbol {symbolId: 'sym-1'}) CREATE (f)-[:FILE_IN_REPO]->(r), (s)-[:SYMBOL_IN_FILE]->(f), (s)-[:SYMBOL_IN_REPO]->(r)`,
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
