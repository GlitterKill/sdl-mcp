import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

const TEST_DB_PATH = join(tmpdir(), ".lbug-shadow-clusters-test-db.lbug");

async function resetDb(): Promise<void> {
  await closeLadybugDb();
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

async function seedRepoAndSymbols(
  repoId: string,
  symbolIds: string[],
): Promise<void> {
  const conn = await getLadybugConn();
  const now = "2026-04-09T00:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: "C:/shadow-clusters-test",
    configJson: JSON.stringify({ policy: {} }),
    createdAt: now,
  });
  await ladybugDb.upsertFile(conn, {
    fileId: `${repoId}-file`,
    repoId,
    relPath: "src/main.ts",
    contentHash: "hash",
    language: "ts",
    byteSize: 100,
    lastIndexedAt: now,
  });
  for (const symbolId of symbolIds) {
    await ladybugDb.upsertSymbol(conn, {
      symbolId,
      repoId,
      fileId: `${repoId}-file`,
      kind: "function",
      name: symbolId,
      exported: true,
      visibility: null,
      language: "ts",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 4,
      rangeEndCol: 0,
      astFingerprint: `${symbolId}-fp`,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: now,
    });
  }
}

describe("LadybugDB Shadow Cluster Queries", () => {
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  it("round-trips a shadow cluster and its members", async () => {
    await resetDb();
    await seedRepoAndSymbols("repo-shadow-1", ["s1", "s2", "s3"]);
    const conn = await getLadybugConn();

    await ladybugDb.upsertShadowCluster(conn, {
      shadowClusterId: "repo-shadow-1:louvain:0",
      repoId: "repo-shadow-1",
      algorithm: "louvain",
      label: "Louvain community 0",
      symbolCount: 3,
      modularity: 0.5,
      versionId: "v1",
      createdAt: "2026-04-09T00:00:00.000Z",
    });

    await ladybugDb.upsertShadowClusterMembersBatch(conn, [
      {
        symbolId: "s1",
        shadowClusterId: "repo-shadow-1:louvain:0",
        membershipScore: 1.0,
      },
      {
        symbolId: "s2",
        shadowClusterId: "repo-shadow-1:louvain:0",
        membershipScore: 1.0,
      },
      {
        symbolId: "s3",
        shadowClusterId: "repo-shadow-1:louvain:0",
        membershipScore: 1.0,
      },
    ]);

    const clusters = await ladybugDb.getShadowClustersForRepo(
      conn,
      "repo-shadow-1",
    );
    assert.strictEqual(clusters.length, 1);
    assert.strictEqual(clusters[0].shadowClusterId, "repo-shadow-1:louvain:0");
    assert.strictEqual(clusters[0].algorithm, "louvain");
    assert.strictEqual(clusters[0].symbolCount, 3);

    const members = await ladybugDb.getShadowClusterMembersForRepo(
      conn,
      "repo-shadow-1",
    );
    assert.strictEqual(members.length, 3);
    const ids = new Set(members.map((m) => m.symbolId));
    assert.ok(ids.has("s1"));
    assert.ok(ids.has("s2"));
    assert.ok(ids.has("s3"));

    const s1ShadowCluster = await ladybugDb.getShadowClusterForSymbol(
      conn,
      "s1",
    );
    assert.ok(s1ShadowCluster);
    assert.strictEqual(
      s1ShadowCluster?.shadowClusterId,
      "repo-shadow-1:louvain:0",
    );
  });

  it("writes are idempotent per shadowClusterId", async () => {
    await resetDb();
    await seedRepoAndSymbols("repo-shadow-2", ["s1", "s2"]);
    const conn = await getLadybugConn();

    for (let i = 0; i < 3; i++) {
      await ladybugDb.upsertShadowCluster(conn, {
        shadowClusterId: "repo-shadow-2:louvain:0",
        repoId: "repo-shadow-2",
        algorithm: "louvain",
        label: `iteration ${i}`,
        symbolCount: 2,
        modularity: 0.1 * i,
        versionId: "v1",
        createdAt: "2026-04-09T00:00:00.000Z",
      });
    }

    const clusters = await ladybugDb.getShadowClustersForRepo(
      conn,
      "repo-shadow-2",
    );
    assert.strictEqual(clusters.length, 1);
    // Last upsert wins
    assert.strictEqual(clusters[0].label, "iteration 2");
  });

  it("deleteShadowClustersByRepo is scoped to shadow data only", async () => {
    await resetDb();
    await seedRepoAndSymbols("repo-shadow-3", ["s1"]);
    const conn = await getLadybugConn();

    // Seed a canonical cluster alongside
    await ladybugDb.upsertCluster(conn, {
      clusterId: "canonical-1",
      repoId: "repo-shadow-3",
      label: "Canonical cluster",
      symbolCount: 1,
      cohesionScore: 0,
      versionId: "v1",
      createdAt: "2026-04-09T00:00:00.000Z",
      searchText: "canonical",
    });

    await ladybugDb.upsertShadowCluster(conn, {
      shadowClusterId: "repo-shadow-3:louvain:0",
      repoId: "repo-shadow-3",
      algorithm: "louvain",
      label: "Shadow",
      symbolCount: 1,
      modularity: 0.0,
      versionId: "v1",
      createdAt: "2026-04-09T00:00:00.000Z",
    });

    await ladybugDb.deleteShadowClustersByRepo(conn, "repo-shadow-3");

    const shadowClusters = await ladybugDb.getShadowClustersForRepo(
      conn,
      "repo-shadow-3",
    );
    assert.strictEqual(shadowClusters.length, 0);

    const canonicalClusters = await ladybugDb.getClustersForRepo(
      conn,
      "repo-shadow-3",
    );
    assert.strictEqual(canonicalClusters.length, 1);
    assert.strictEqual(canonicalClusters[0].clusterId, "canonical-1");
  });

  it("returns empty map for missing symbol IDs", async () => {
    await resetDb();
    await seedRepoAndSymbols("repo-shadow-4", []);
    const conn = await getLadybugConn();

    const empty = await ladybugDb.getShadowClustersForSymbols(conn, []);
    assert.strictEqual(empty.size, 0);

    const missing = await ladybugDb.getShadowClustersForSymbols(conn, [
      "nonexistent",
    ]);
    assert.strictEqual(missing.size, 0);

    const none = await ladybugDb.getShadowClusterForSymbol(conn, "nonexistent");
    assert.strictEqual(none, null);
  });
});
