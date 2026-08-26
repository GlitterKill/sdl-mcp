import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initValidatedTestLadybugClone } from "../helpers/ladybug-validated-clone.ts";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
  withWriteConn,
} from "../../dist/db/ladybug.js";
import {
  exec,
  queryAll,
  querySingle,
} from "../../dist/db/ladybug-core.js";
import {
  getDerivedState,
  getDerivedStateSummary,
  markGraphIntegrityVerifiedInTransactionIfVerifying,
} from "../../dist/db/ladybug-derived-state.js";
import { LADYBUG_SCHEMA_VERSION } from "../../dist/db/migrations/index.js";
import * as m024 from "../../dist/db/migrations/m024-add-symbol-test-case.js";
import { runPendingMigrations } from "../../dist/db/migration-runner.js";

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
    `CREATE NODE TABLE Symbol (
      symbolId STRING PRIMARY KEY,
      repoId STRING,
      roleTagsJson STRING,
      embeddingJinaCode STRING,
      embeddingJinaCodeCardHash STRING,
      embeddingJinaCodeUpdatedAt STRING,
      embeddingNomic STRING,
      embeddingNomicCardHash STRING,
      embeddingNomicUpdatedAt STRING,
      embeddingJinaCodeVec DOUBLE[768],
      embeddingNomicVec DOUBLE[768]
    )`,
    `CREATE NODE TABLE SymbolVersion (
      id STRING PRIMARY KEY,
      versionId STRING,
      symbolId STRING,
      sideEffectsJson STRING
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
    `CREATE (s:Symbol {
      symbolId: 'legacy-symbol',
      roleTagsJson: '["test"]'
    })`,
    `CREATE (sv:SymbolVersion {
      id: 'legacy-version:legacy-symbol',
      versionId: 'legacy-version',
      symbolId: 'legacy-symbol',
      sideEffectsJson: '[]'
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

  it("does not stamp m024 when core symbol tables are missing", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m024-invalid-"));
    const kuzu = await import("kuzu");
    const db = new kuzu.Database(join(root, "invalid.lbug"));
    const conn = new kuzu.Connection(db);

    try {
      for (const ddl of [
        `CREATE NODE TABLE DerivedState (
          repoId STRING PRIMARY KEY,
          graphIntegrityState STRING,
          graphIntegrityVersionId STRING,
          graphIntegrityDigest STRING,
          graphIntegrityError STRING,
          graphIntegrityRevision INT64,
          graphIntegrityVerifiedRevision INT64,
          graphIntegrityFilelessPruningSupported BOOL,
          graphIntegrityManifestEstablished BOOL
        )`,
        `CREATE NODE TABLE SchemaVersion (
          id STRING PRIMARY KEY,
          schemaVersion INT64,
          createdAt STRING,
          updatedAt STRING
        )`,
      ]) {
        const result = await conn.query(ddl);
        (Array.isArray(result) ? result[0] : result).close();
      }
      await exec(
        conn,
        `CREATE (sv:SchemaVersion {
           id: 'current',
           schemaVersion: 23,
           createdAt: '2026-07-21T00:00:00.000Z',
           updatedAt: '2026-07-21T00:00:00.000Z'
         })`,
      );

      await assert.rejects(
        runPendingMigrations(conn, 23, [m024]),
        /Symbol/u,
      );
      const schemaVersion = await querySingle<{ schemaVersion: unknown }>(
        conn,
        "MATCH (v:SchemaVersion {id: 'current'}) RETURN v.schemaVersion AS schemaVersion",
      );
      assert.equal(Number(schemaVersion?.schemaVersion), 23);
    } finally {
      await conn.close();
      await db.close();
    }
  });

  it("migrates a populated m022 graph through m026 without deleting nodes", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m024-"));
    const dbPath = join(root, "v22.lbug");
    await createVersion22Database(dbPath);

    await initValidatedTestLadybugClone(dbPath);
    const conn = await getLadybugConn();
    const rows = await Promise.all([
      getDerivedState("repo"),
      getDerivedState("repo-b"),
    ]);
    const summary = await getDerivedStateSummary("repo");

    assert.equal(LADYBUG_SCHEMA_VERSION, 26);
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
          versionId: null,
          digest: null,
          error: null,
        },
        {
          state: "unknown",
          revision: null,
          verifiedRevision: null,
          pruningSupported: null,
          manifestEstablished: false,
          versionId: null,
          digest: null,
          error: null,
        },
      ],
    );
    assert.equal(summary?.graphIntegrityRevision, null);

    const schemaVersion = await querySingle<{ schemaVersion: unknown }>(
      conn,
      "MATCH (v:SchemaVersion {id: 'current'}) RETURN v.schemaVersion AS schemaVersion",
    );
    assert.equal(Number(schemaVersion?.schemaVersion), 26);
    assert.deepEqual(
      await queryAll(
        conn,
        "MATCH (s:Symbol) RETURN s.symbolId AS symbolId, s.testCaseJson AS testCaseJson ORDER BY s.symbolId",
      ),
      [{ symbolId: "legacy-symbol", testCaseJson: null }],
    );
    assert.deepEqual(
      await queryAll(
        conn,
        "MATCH (s:SymbolVersion) RETURN s.id AS id, s.testCaseJson AS testCaseJson ORDER BY s.id",
      ),
      [{ id: "legacy-version:legacy-symbol", testCaseJson: null }],
    );
  });

  it("finishes a partial DDL rerun and creates both manifest relationships", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-m023-partial-"));
    const dbPath = join(root, "partial.lbug");
    await createVersion22Database(dbPath, true);

    await initValidatedTestLadybugClone(dbPath);
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

    await initValidatedTestLadybugClone(dbPath);
    const conn = await getLadybugConn();
    const indexes = await queryAll<Record<string, unknown>>(
      conn,
      "CALL show_indexes() RETURN *",
    );
    const catalog = JSON.stringify(indexes);
    assert.doesNotMatch(catalog, /idx_graph_integrity/i);
  });
  it("publishes verification only while the transaction owns the same version and revision", async () => {
    root = mkdtempSync(join(tmpdir(), "sdl-integrity-publication-"));
    await initLadybugDb(join(root, "publication.lbug"));

    await withWriteConn(async (conn) => {
      await exec(
        conn,
        `MERGE (r:Repo {repoId: 'repo'})
         SET r.rootPath = 'repo', r.configJson = '{}', r.createdAt = '2026-08-07T00:00:00.000Z'
         MERGE (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verifying',
             d.graphIntegrityVersionId = 'v1',
             d.graphIntegrityRevision = 3`,
      );

      assert.equal(
        await markGraphIntegrityVerifiedInTransactionIfVerifying(
          conn,
          "repo",
          "v1",
          3,
          "a".repeat(64),
        ),
        true,
      );
      let state = await getDerivedState("repo");
      assert.equal(state?.graphIntegrityState, "verified");
      assert.equal(state?.graphIntegrityVerifiedRevision, 3);

      await exec(
        conn,
        `MATCH (d:DerivedState {repoId: 'repo'})
         SET d.graphIntegrityState = 'verifying',
             d.graphIntegrityVersionId = 'v2',
             d.graphIntegrityRevision = 4,
             d.graphIntegrityVerifiedRevision = 3`,
      );
      assert.equal(
        await markGraphIntegrityVerifiedInTransactionIfVerifying(
          conn,
          "repo",
          "v1",
          3,
          "b".repeat(64),
        ),
        false,
      );
      state = await getDerivedState("repo");
      assert.equal(state?.graphIntegrityState, "verifying");
      assert.equal(state?.graphIntegrityVersionId, "v2");
      assert.equal(state?.graphIntegrityRevision, 4);
      assert.equal(state?.graphIntegrityVerifiedRevision, 3);
    });
  });
});
