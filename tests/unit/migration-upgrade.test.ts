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

  // Create minimal tables needed for a v4 DB
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
