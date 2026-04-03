import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  buildRepoOverview,
  clearOverviewCache,
} from "../../dist/graph/overview.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";

const REPO_ID = "test-overview-cluster-stats-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("repo overview cluster/process stats", () => {
  const graphDbPath = join(tmpdir(), ".lbug-overview-cluster-stats-test-db");
  const symbolA = `${REPO_ID}-a`;
  const symbolB = `${REPO_ID}-b`;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeLadybugDb();
    await initLadybugDb(graphDbPath);
    const conn = await getLadybugConn();

    const now = new Date().toISOString();

    await ladybugDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-overview-cluster-stats",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-overview-cluster-stats",
        ignore: [],
        languages: ["ts"],
        maxFileBytes: 2_000_000,
        includeNodeModulesTypes: true,
        packageJsonPath: null,
        tsconfigPath: null,
        workspaceGlobs: null,
      }),
      createdAt: now,
    });

    await ladybugDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: REPO_ID,
      relPath: "src/app.ts",
      contentHash: "hash",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    for (const [symbolId, name] of [
      [symbolA, "a"],
      [symbolB, "b"],
    ] as const) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId,
        repoId: REPO_ID,
        fileId: "file-1",
        kind: "function",
        name,
        exported: true,
        visibility: "public",
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 2,
        rangeEndCol: 1,
        astFingerprint: `fp-${symbolId}`,
        signatureJson: null,
        summary: null,
        invariantsJson: null,
        sideEffectsJson: null,
        updatedAt: now,
      });
    }
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("omits cluster/process stats when no data exists", async () => {
    const overview = await buildRepoOverview({
      repoId: REPO_ID,
      level: "stats",
    });
    assert.strictEqual(overview.clusters, undefined);
    assert.strictEqual(overview.processes, undefined);
  });

  it("defers cluster/process stats at stats level on cold cache", async () => {
    clearOverviewCache();
    const conn = await getLadybugConn();
    const now = new Date().toISOString();

    const clusterId = `${REPO_ID}-cluster-1`;
    await ladybugDb.upsertCluster(conn, {
      clusterId,
      repoId: REPO_ID,
      label: "cluster 1",
      symbolCount: 2,
      cohesionScore: 0.0,
      versionId: null,
      createdAt: now,
    });
    for (const symbolId of [symbolA, symbolB]) {
      await ladybugDb.upsertClusterMember(conn, {
        symbolId,
        clusterId,
        membershipScore: 1.0,
      });
    }

    const processId = `${REPO_ID}-process-1`;
    await ladybugDb.upsertProcess(conn, {
      processId,
      repoId: REPO_ID,
      entrySymbolId: symbolA,
      label: "process 1",
      depth: 2,
      versionId: null,
      createdAt: now,
    });
    await ladybugDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolA,
      stepOrder: 0,
      role: "entry",
    });
    await ladybugDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolB,
      stepOrder: 1,
      role: "exit",
    });

    // At stats level with cold cache, cluster/process data is deferred
    const statsOverview = await buildRepoOverview({
      repoId: REPO_ID,
      level: "stats",
    });

    assert.strictEqual(statsOverview.clusters, undefined);
    assert.strictEqual(statsOverview.processes, undefined);
    assert.strictEqual(statsOverview.clustersAvailable, false);
    assert.ok(typeof statsOverview.clustersHint === "string");
  });

  it("includes cluster/process stats at directories level", async () => {
    clearOverviewCache();

    const overview = await buildRepoOverview({
      repoId: REPO_ID,
      level: "directories",
    });

    assert.ok(overview.clusters);
    assert.strictEqual(overview.clusters.totalClusters, 1);
    assert.strictEqual(overview.clusters.averageClusterSize, 2);
    assert.strictEqual(overview.clusters.largestClusters.length, 1);
    assert.strictEqual(overview.clusters.largestClusters[0]!.size, 2);

    assert.ok(overview.processes);
    assert.strictEqual(overview.processes.totalProcesses, 1);
    assert.strictEqual(overview.processes.averageDepth, 2);
    assert.strictEqual(overview.processes.entryPoints, 1);
    assert.strictEqual(overview.processes.longestProcesses.length, 1);
    assert.strictEqual(overview.processes.longestProcesses[0]!.depth, 2);
  });

  it("stats level picks up cluster/process from cached higher-detail call", async () => {
    // Populate cache via a directories-level call first
    clearOverviewCache();
    await buildRepoOverview({ repoId: REPO_ID, level: "directories" });

    // Now stats level should reuse the cached cluster/process data
    const statsOverview = await buildRepoOverview({
      repoId: REPO_ID,
      level: "stats",
    });

    assert.ok(statsOverview.clusters);
    assert.strictEqual(statsOverview.clusters.totalClusters, 1);
    assert.ok(statsOverview.processes);
    assert.strictEqual(statsOverview.processes.totalProcesses, 1);
  });
});
