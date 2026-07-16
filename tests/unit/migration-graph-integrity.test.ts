import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { getDerivedStateSummary } from "../../dist/db/ladybug-derived-state.js";
import { LADYBUG_SCHEMA_VERSION } from "../../dist/db/migrations/index.js";

async function createVersion21Database(dbPath: string): Promise<void> {
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  for (const ddl of [
    `CREATE NODE TABLE DerivedState (
      repoId STRING PRIMARY KEY,
      clustersDirty BOOL DEFAULT false,
      processesDirty BOOL DEFAULT false,
      algorithmsDirty BOOL DEFAULT false,
      summariesDirty BOOL DEFAULT false,
      embeddingsDirty BOOL DEFAULT false,
      targetVersionId STRING,
      computedVersionId STRING,
      updatedAt STRING,
      lastError STRING
    )`,
    `CREATE NODE TABLE SchemaVersion (
      id STRING PRIMARY KEY,
      schemaVersion INT64,
      createdAt STRING,
      updatedAt STRING
    )`,
  ]) {
    const result = await conn.query(ddl);
    const queryResult = Array.isArray(result) ? result[0] : result;
    queryResult.close();
  }
  for (const statement of [
    `CREATE (d:DerivedState {
      repoId: 'repo',
      clustersDirty: false,
      processesDirty: false,
      algorithmsDirty: false,
      summariesDirty: false,
      embeddingsDirty: false,
      targetVersionId: 'legacy-v1',
      computedVersionId: 'legacy-v1',
      updatedAt: '2026-07-16T00:00:00.000Z',
      lastError: null
    })`,
    `CREATE (sv:SchemaVersion {
      id: 'current',
      schemaVersion: 21,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z'
    })`,
  ]) {
    const result = await conn.query(statement);
    const queryResult = Array.isArray(result) ? result[0] : result;
    queryResult.close();
  }
  await conn.close();
  await db.close();
}

describe("migration: graph integrity state", () => {
  let root = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("migrates legacy derived state to unknown with one full-refresh action", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-graph-integrity-migration-"));
    const dbPath = join(root, "v21.lbug");
    await createVersion21Database(dbPath);

    await initLadybugDb(dbPath);
    const summary = await getDerivedStateSummary("repo");

    assert.equal(LADYBUG_SCHEMA_VERSION, 22);
    assert.equal(summary?.graphIntegrityState, "unknown");
    assert.equal(summary?.graphIntegrityVersionId, null);
    assert.equal(summary?.graphIntegrityDigest, null);
    assert.equal(
      summary?.nextBestAction,
      'Graph integrity is unverified. Run sdl.index.refresh with mode:"full" to establish a verified baseline.',
    );
    assert.equal("graphIntegrityError" in (summary ?? {}), false);
  });
});
