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

describe("migration: fresh database", { skip: !ladybugAvailable }, () => {
  const testRoot = join(
    tmpdir(),
    `sdl-mcp-mig-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  afterEach(async () => {
    await closeLadybugDb();
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("fresh DB initializes at latest schema version", async () => {
    mkdirSync(testRoot, { recursive: true });
    const dbPath = join(testRoot, "fresh.lbug");

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const version = await getSchemaVersion(conn);

    assert.strictEqual(version, LADYBUG_SCHEMA_VERSION);
  });
});
