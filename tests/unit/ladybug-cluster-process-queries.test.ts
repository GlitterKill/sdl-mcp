import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { closeKuzuDb, getKuzuConn, initKuzuDb } from "../../dist/db/kuzu.js";
import * as kuzuDb from "../../dist/db/kuzu-queries.js";

const REPO_ID = "test-cluster-process-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("kuzu cluster/process queries", () => {
  const graphDbPath = join(__dirname, ".kuzu-cluster-process-queries-test-db");

  let symbolA: string;
  let symbolB: string;
  let symbolC: string;

  before(async () => {
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
    mkdirSync(graphDbPath, { recursive: true });

    await closeKuzuDb();
    await initKuzuDb(graphDbPath);
    const conn = await getKuzuConn();

    const now = new Date().toISOString();

    await kuzuDb.upsertRepo(conn, {
      repoId: REPO_ID,
      rootPath: "/tmp/test-cluster-process",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-cluster-process",
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

    await kuzuDb.upsertFile(conn, {
      fileId: "file-1",
      repoId: REPO_ID,
      relPath: "src/test.ts",
      contentHash: "hash-test",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    symbolA = `A-${REPO_ID}`;
    symbolB = `B-${REPO_ID}`;
    symbolC = `C-${REPO_ID}`;

    for (const [symbolId, name] of [
      [symbolA, "A"],
      [symbolB, "B"],
      [symbolC, "C"],
    ] as const) {
      await kuzuDb.upsertSymbol(conn, {
        symbolId,
        repoId: REPO_ID,
        fileId: "file-1",
        kind: "function",
        name,
        exported: false,
        visibility: null,
        language: "ts",
        rangeStartLine: 1,
        rangeStartCol: 0,
        rangeEndLine: 5,
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
    await closeKuzuDb();
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("supports cluster and process CRUD", async () => {
    const conn = await getKuzuConn();
    const now = new Date().toISOString();

    // --- Cluster CRUD ---
    const cluster1 = `${REPO_ID}-cluster-1`;
    const cluster2 = `${REPO_ID}-cluster-2`;

    await kuzuDb.upsertCluster(conn, {
      clusterId: cluster1,
      repoId: REPO_ID,
      label: "cluster 1",
      symbolCount: 2,
      cohesionScore: 0.5,
      versionId: null,
      createdAt: now,
    });

    await kuzuDb.upsertCluster(conn, {
      clusterId: cluster2,
      repoId: REPO_ID,
      label: "cluster 2",
      symbolCount: 1,
      cohesionScore: 0.2,
      versionId: null,
      createdAt: now,
    });

    await kuzuDb.upsertClusterMember(conn, {
      symbolId: symbolA,
      clusterId: cluster1,
      membershipScore: 1.0,
    });
    await kuzuDb.upsertClusterMember(conn, {
      symbolId: symbolB,
      clusterId: cluster1,
      membershipScore: 1.0,
    });
    await kuzuDb.upsertClusterMember(conn, {
      symbolId: symbolC,
      clusterId: cluster2,
      membershipScore: 1.0,
    });

    const clusters = await kuzuDb.getClustersForRepo(conn, REPO_ID);
    assert.strictEqual(clusters.length, 2);

    const clusterForA = await kuzuDb.getClusterForSymbol(conn, symbolA);
    assert.ok(clusterForA);
    assert.strictEqual(clusterForA.clusterId, cluster1);

    const members1 = await kuzuDb.getClusterMembers(conn, cluster1);
    assert.deepStrictEqual(
      members1.map((m) => m.symbolId),
      [symbolA, symbolB].sort(),
    );

    // Inter-cluster dependency: A -> C
    await kuzuDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: symbolA,
      toSymbolId: symbolC,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: null,
      createdAt: now,
    });

    const related = await kuzuDb.getRelatedClusters(conn, cluster1, 10);
    assert.ok(related.some((r) => r.clusterId === cluster2 && r.edgeCount >= 1));

    await kuzuDb.deleteClustersByRepo(conn, REPO_ID);
    assert.strictEqual((await kuzuDb.getClustersForRepo(conn, REPO_ID)).length, 0);
    assert.strictEqual(await kuzuDb.getClusterForSymbol(conn, symbolA), null);

    // --- Process CRUD ---
    const processId = `${REPO_ID}-process-1`;
    await kuzuDb.upsertProcess(conn, {
      processId,
      repoId: REPO_ID,
      entrySymbolId: symbolA,
      label: "process 1",
      depth: 2,
      versionId: null,
      createdAt: now,
    });

    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolA,
      stepOrder: 0,
      role: "entry",
    });
    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolB,
      stepOrder: 1,
      role: "intermediate",
    });
    await kuzuDb.upsertProcessStep(conn, {
      processId,
      symbolId: symbolC,
      stepOrder: 2,
      role: "exit",
    });

    const procsForB = await kuzuDb.getProcessesForSymbol(conn, symbolB);
    assert.strictEqual(procsForB.length, 1);
    assert.strictEqual(procsForB[0]!.processId, processId);
    assert.strictEqual(procsForB[0]!.stepOrder, 1);

    const flow = await kuzuDb.getProcessFlow(conn, processId);
    assert.deepStrictEqual(
      flow.map((s) => s.symbolId),
      [symbolA, symbolB, symbolC],
    );

    const afterA = await kuzuDb.getProcessStepsAfterSymbol(conn, processId, symbolA);
    assert.deepStrictEqual(
      afterA.map((s) => s.symbolId),
      [symbolB, symbolC],
    );

    await kuzuDb.deleteProcessesByRepo(conn, REPO_ID);
    assert.strictEqual((await kuzuDb.getProcessesForSymbol(conn, symbolB)).length, 0);
  });
});

