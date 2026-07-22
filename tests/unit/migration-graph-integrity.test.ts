import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import {
  exec,
  queryAll,
  querySingle,
} from "../../dist/db/ladybug-core.js";
import {
  getDerivedState,
  getDerivedStateSummary,
} from "../../dist/db/ladybug-derived-state.js";
import { LADYBUG_SCHEMA_VERSION } from "../../dist/db/migrations/index.js";

async function createVersion22Database(
  dbPath: string,
  partialM023 = false,
): Promise<void> {
  const kuzu = await import("kuzu");
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  const ddls = [
    `CREATE NODE TABLE Repo (
      repoId STRING PRIMARY KEY,
      rootPath STRING,
      configJson STRING,
      createdAt STRING
    )`,
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
      lastError STRING,
      graphIntegrityState STRING DEFAULT 'unknown',
      graphIntegrityVersionId STRING,
      graphIntegrityDigest STRING,
      graphIntegrityError STRING
    )`,
    `CREATE NODE TABLE SchemaVersion (
      id STRING PRIMARY KEY,
      schemaVersion INT64,
      createdAt STRING,
      updatedAt STRING
    )`,
  ];
  if (partialM023) {
    ddls.push(
      "ALTER TABLE DerivedState ADD graphIntegrityRevision INT64 DEFAULT NULL",
      `CREATE NODE TABLE GraphIntegrityFileState (
        stateId STRING PRIMARY KEY,
        repoId STRING,
        fileId STRING,
        relPath STRING,
        symbolCount INT64,
        digest STRING,
        filelessReferencesJson STRING
      )`,
    );
  }
  for (const ddl of ddls) {
    const result = await conn.query(ddl);
    (Array.isArray(result) ? result[0] : result).close();
  }
  for (const statement of [
    "CREATE (r:Repo {repoId: 'repo', rootPath: '.', configJson: '{}', createdAt: '2026-07-21T00:00:00.000Z'})",
    "CREATE (r:Repo {repoId: 'repo-b', rootPath: './b', configJson: '{}', createdAt: '2026-07-21T00:00:00.000Z'})",
    `CREATE (d:DerivedState {
      repoId: 'repo',
      graphIntegrityState: 'verified',
      graphIntegrityVersionId: 'legacy-v1',
      graphIntegrityDigest: '${"a".repeat(64)}',
      graphIntegrityError: 'history'
    })`,
    `CREATE (d:DerivedState {
      repoId: 'repo-b',
      graphIntegrityState: 'failed',
      graphIntegrityVersionId: 'legacy-v2',
      graphIntegrityDigest: '${"b".repeat(64)}',
      graphIntegrityError: 'older failure'
    })`,
    `CREATE (sv:SchemaVersion {
      id: 'current',
      schemaVersion: 22,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z'
    })`,
  ]) {
    const result = await conn.query(statement);
    (Array.isArray(result) ? result[0] : result).close();
  }
  await conn.close();
  await db.close();
}

describe("migration: graph integrity revisions and manifest", () => {
  let root = "";

  afterEach(async () => {
    await closeLadybugDb().catch(() => {});
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
    root = "";
  });

  it("migrates all m022 rows to unknown nullable revision state", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m023-"));
    const dbPath = join(root, "v22.lbug");
    await createVersion22Database(dbPath);

    await initLadybugDb(dbPath);
    const rows = await Promise.all([
      getDerivedState("repo"),
      getDerivedState("repo-b"),
    ]);
    const summary = await getDerivedStateSummary("repo");

    assert.equal(LADYBUG_SCHEMA_VERSION, 23);
    assert.deepEqual(
      rows.map((row) => ({
        state: row?.graphIntegrityState,
        revision: row?.graphIntegrityRevision,
        verifiedRevision: row?.graphIntegrityVerifiedRevision,
        pruningSupported: row?.graphIntegrityFilelessPruningSupported,
        manifestEstablished: row?.graphIntegrityManifestEstablished,
        versionId: row?.graphIntegrityVersionId,
        digest: row?.graphIntegrityDigest,
        error: row?.graphIntegrityError,
      })),
      [
        {
          state: "unknown",
          revision: null,
          verifiedRevision: null,
          pruningSupported: null,
          manifestEstablished: false,
          versionId: "legacy-v1",
          digest: "a".repeat(64),
          error: "history",
        },
        {
          state: "unknown",
          revision: null,
          verifiedRevision: null,
          pruningSupported: null,
          manifestEstablished: false,
          versionId: "legacy-v2",
          digest: "b".repeat(64),
          error: "older failure",
        },
      ],
    );
    assert.equal(summary?.graphIntegrityRevision, null);
  });

  it("finishes a partial DDL rerun and creates both manifest relationships", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m023-partial-"));
    const dbPath = join(root, "partial.lbug");
    await createVersion22Database(dbPath, true);

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    await exec(
      conn,
      `CREATE (f:GraphIntegrityFileState {
         stateId: 'repo:file',
         repoId: 'repo',
         fileId: 'file',
         relPath: 'src/file.ts',
         symbolCount: 1,
         digest: $digest,
         filelessReferencesJson: '[]'
       })`,
      { digest: "b".repeat(64) },
    );
    await exec(
      conn,
      `CREATE (s:GraphIntegrityFilelessState {
         stateId: 'repo:symbol',
         repoId: 'repo',
         symbolId: 'symbol',
         canonicalSymbolJson: '{}',
         referenceCount: 1
       })`,
    );
    await exec(
      conn,
      "MATCH (f:GraphIntegrityFileState {stateId: 'repo:file'}), (r:Repo {repoId: 'repo'}) CREATE (f)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(r)",
    );
    await exec(
      conn,
      "MATCH (s:GraphIntegrityFilelessState {stateId: 'repo:symbol'}), (r:Repo {repoId: 'repo'}) CREATE (s)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(r)",
    );

    const fileRel = await querySingle<{ count: unknown }>(
      conn,
      "MATCH (:GraphIntegrityFileState)-[:GRAPH_INTEGRITY_FILE_STATE_IN_REPO]->(:Repo) RETURN count(*) AS count",
    );
    const filelessRel = await querySingle<{ count: unknown }>(
      conn,
      "MATCH (:GraphIntegrityFilelessState)-[:GRAPH_INTEGRITY_FILELESS_STATE_IN_REPO]->(:Repo) RETURN count(*) AS count",
    );
    assert.equal(Number(fileRel?.count), 1);
    assert.equal(Number(filelessRel?.count), 1);
  });

  it("creates no custom-property indexes for manifest tables", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m023-indexes-"));
    const dbPath = join(root, "indexes.lbug");
    await createVersion22Database(dbPath);

    await initLadybugDb(dbPath);
    const conn = await getLadybugConn();
    const indexes = await queryAll<Record<string, unknown>>(
      conn,
      "CALL show_indexes() RETURN *",
    );
    const catalog = JSON.stringify(indexes);
    assert.doesNotMatch(catalog, /idx_graph_integrity/i);
  });
});
