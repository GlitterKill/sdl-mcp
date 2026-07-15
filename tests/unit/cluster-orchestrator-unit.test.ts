import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import {
  computeAndStoreClustersAndProcesses,
  shouldFailOnClusterFtsRebuildFailure,
  shouldRebuildClusterFtsAfterReplacement,
} from "../../dist/indexer/cluster-orchestrator.js";
import { CentralityWorkerTimeoutError } from "../../dist/graph/centrality-worker-runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  tmpdir(),
  ".lbug-cluster-orchestrator-unit-test-db.lbug",
);

function removeLadybugDbFiles(dbPath: string): void {
  for (const p of [
    dbPath,
    `${dbPath}.wal`,
    `${dbPath}.shadow`,
    `${dbPath}.lock`,
  ]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
}

async function resetDb(): Promise<void> {
  await closeLadybugDb();
  removeLadybugDbFiles(TEST_DB_PATH);
  mkdirSync(dirname(TEST_DB_PATH), { recursive: true });
  await initLadybugDb(TEST_DB_PATH);
}

async function seedRepo(repoId: string): Promise<void> {
  const conn = await getLadybugConn();
  const now = "2026-03-19T09:00:00.000Z";
  await ladybugDb.upsertRepo(conn, {
    repoId,
    rootPath: "C:/cluster-orchestrator-test",
    configJson: JSON.stringify({ policy: {} }),
    createdAt: now,
  });
}

async function seedFile(
  repoId: string,
  fileId: string,
  relPath: string,
): Promise<void> {
  const conn = await getLadybugConn();
  await ladybugDb.upsertFile(conn, {
    fileId,
    repoId,
    relPath,
    contentHash: `${fileId}-hash`,
    language: "ts",
    byteSize: 200,
    lastIndexedAt: "2026-03-19T09:00:00.000Z",
  });
}

async function seedSymbol(params: {
  repoId: string;
  fileId: string;
  symbolId: string;
  name: string;
}): Promise<void> {
  const conn = await getLadybugConn();
  await ladybugDb.upsertSymbol(conn, {
    symbolId: params.symbolId,
    repoId: params.repoId,
    fileId: params.fileId,
    kind: "function",
    name: params.name,
    exported: true,
    visibility: null,
    language: "ts",
    rangeStartLine: 1,
    rangeStartCol: 0,
    rangeEndLine: 4,
    rangeEndCol: 0,
    astFingerprint: `${params.symbolId}-fp`,
    signatureJson: null,
    summary: null,
    invariantsJson: null,
    sideEffectsJson: null,
    updatedAt: "2026-03-19T09:00:00.000Z",
  });
}

describe("cluster-orchestrator.computeAndStoreClustersAndProcesses", () => {
  before(() => {
    process.env.SDL_MCP_DISABLE_NATIVE_ADDON = "1";
  });

  after(async () => {
    await closeLadybugDb();
    removeLadybugDbFiles(TEST_DB_PATH);
  });

  it("exports computeAndStoreClustersAndProcesses", () => {
    assert.equal(typeof computeAndStoreClustersAndProcesses, "function");
  });

  it("drops and rebuilds Cluster FTS around topology-changing replacement", () => {
    const source = readFileSync(
      "src/indexer/cluster-orchestrator.ts",
      "utf8",
    );

    assert.match(
      source,
      /dropFtsIndex\(\s*wConn,\s*"Cluster",\s*ENTITY_FTS_INDEX_NAMES\.cluster/s,
      "cluster replacement must drop the Cluster FTS index before deleting old Cluster nodes",
    );
    assert.match(
      source,
      /finally\s*{[\s\S]*ensureFtsIndexForNonEmptyTable\(\s*wConn,\s*"Cluster",\s*ENTITY_FTS_INDEX_NAMES\.cluster/s,
      "cluster replacement must rebuild the Cluster FTS index after replacement",
    );
    assert.doesNotMatch(
      source,
      /if\s*\(\s*droppedClusterFtsIndex\s*\)[\s\S]*createFtsIndex\(/s,
      "Cluster FTS rebuild must not be gated only on a drop that happened in the current run",
    );
    assert.match(
      source,
      /const totalClusterCount = await ladybugDb\.countClusters\(wConn\)/s,
      "Cluster FTS empty-table guard must use the global Cluster row count",
    );
    assert.match(
      source,
      /if\s*\(\s*replaceClusters\s*\)[\s\S]*dropFtsIndex\(/s,
      "Cluster replacement must prove/drop Cluster FTS before deleting rows regardless of global capability state",
    );
    assert.match(
      source,
      /shouldRebuildClusterFtsAfterReplacement\(\{[\s\S]*totalClusterCount/s,
      "non-empty replacements must recreate Cluster FTS even when the index was already absent",
    );
    assert.match(
      source,
      /const shouldRepairMissing =\s*!\s*replaceClusters && totalClusterCount > 0/s,
      "Cluster FTS repair must run even when cluster topology is unchanged",
    );
    assert.doesNotMatch(
      source,
      /replacementError\s*===\s*undefined\s*&&\s*nextClusterStates\.length\s*===\s*0/s,
      "successful zero-cluster skip must not be based only on the current repo",
    );
    assert.match(
      source,
      /ensureResult\.status === "failed"/s,
      "cluster replacement must explicitly handle Cluster FTS rebuild failures",
    );
    assert.match(
      source,
      /shouldFailOnClusterFtsRebuildFailure/,
      "Cluster FTS repair failures should be classified before throwing",
    );
    assert.ok(
      source.indexOf("dropFtsIndex(") < source.indexOf("deleteClustersByRepo"),
      "Cluster FTS drop must happen before deleteClustersByRepo",
    );
  });

  it("uses table-wide Cluster FTS rebuild decisions", () => {
    assert.equal(
      shouldRebuildClusterFtsAfterReplacement({
        replaceClusters: true,
        replacementError: undefined,
        dropStatus: "absent",
        totalClusterCount: 1,
      }),
      true,
      "non-empty table must recreate FTS even when the index was already absent",
    );
    assert.equal(
      shouldRebuildClusterFtsAfterReplacement({
        replaceClusters: true,
        replacementError: undefined,
        dropStatus: "dropped",
        totalClusterCount: 0,
      }),
      false,
      "globally empty Cluster table must not recreate empty-table FTS",
    );
    assert.equal(
      shouldRebuildClusterFtsAfterReplacement({
        replaceClusters: true,
        replacementError: new Error("replacement failed"),
        dropStatus: "absent",
        totalClusterCount: 1,
      }),
      false,
      "failed replacement does not need restoration when the index was absent before",
    );
    assert.equal(
      shouldRebuildClusterFtsAfterReplacement({
        replaceClusters: true,
        replacementError: new Error("replacement failed"),
        dropStatus: "dropped",
        totalClusterCount: 1,
      }),
      true,
      "failed replacement must restore a dropped table-wide FTS index when rows remain",
    );
  });

  it("fails hard only when a previously present Cluster FTS index must be restored", () => {
    assert.equal(
      shouldFailOnClusterFtsRebuildFailure({ dropStatus: "dropped" }),
      true,
      "dropped index rebuild failures leave the table without a previously present index",
    );
    assert.equal(
      shouldFailOnClusterFtsRebuildFailure({ dropStatus: "absent" }),
      false,
      "absent-index repair is optional and should not fail cluster refresh",
    );
    assert.equal(
      shouldFailOnClusterFtsRebuildFailure({ dropStatus: "skipped" }),
      false,
      "unchanged-topology repair is optional and should not fail cluster refresh",
    );
  });

  it("returns zero counts when repo has no symbols", async () => {
    await resetDb();
    await seedRepo("repo-empty");
    const conn = await getLadybugConn();

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-empty",
      versionId: "v1",
    });

    assert.strictEqual(result.clustersComputed, 0);
    assert.strictEqual(result.processesTraced, 0);
    assert.strictEqual(result.centralityComputed, 0);
    assert.strictEqual(result.shadowClustersComputed, 0);
    assert.equal(result.algorithmRefresh.dirty, false);
  });

  it("returns zero cluster/process counts for a symbol graph with no call edges", async () => {
    await resetDb();
    await seedRepo("repo-single");
    await seedFile("repo-single", "file-1", "src/single.ts");
    await seedSymbol({
      repoId: "repo-single",
      fileId: "file-1",
      symbolId: "sym-only",
      name: "worker",
    });
    const conn = await getLadybugConn();

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-single",
      versionId: "v1",
    });

    // Clusters/processes and optional algorithms require call edges, so these
    // stay at 0 and no native algorithm projection is attempted.
    assert.strictEqual(result.clustersComputed, 0);
    assert.strictEqual(result.processesTraced, 0);
    assert.strictEqual(result.shadowClustersComputed, 0);
    assert.strictEqual(result.centralityComputed, 0);
    assert.equal(result.algorithmRefresh.pageRank.status, "skipped");
  });

  it("computes clusters and traces processes for a simple call chain", async () => {
    await resetDb();
    await seedRepo("repo-chain");
    await seedFile("repo-chain", "file-1", "src/chain.ts");
    await seedSymbol({
      repoId: "repo-chain",
      fileId: "file-1",
      symbolId: "sym-main",
      name: "main",
    });
    await seedSymbol({
      repoId: "repo-chain",
      fileId: "file-1",
      symbolId: "sym-foo",
      name: "foo",
    });
    await seedSymbol({
      repoId: "repo-chain",
      fileId: "file-1",
      symbolId: "sym-bar",
      name: "bar",
    });
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-chain",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-chain",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-chain",
      versionId: "v2",
      minClusterSize: 2,
      maxProcessDepth: 5,
      entryPatterns: ["^main$"],
    });

    assert.ok(result.clustersComputed >= 1);
    assert.ok(result.processesTraced >= 1);
    assert.ok((await ladybugDb.countClusters(conn)) >= 1);

    const cluster = await ladybugDb.getClusterForSymbol(conn, "sym-main");
    assert.ok(cluster);
    const members = await ladybugDb.getClusterMembers(conn, cluster.clusterId);
    assert.ok(members.length >= 2);
  });

  it("reuses folded centrality when metrics already covered the same graph", async () => {
    await resetDb();
    await seedRepo("repo-folded-centrality");
    await seedFile("repo-folded-centrality", "file-1", "src/folded.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-folded-centrality",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-folded-centrality",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-folded-centrality",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);
    let centralityCalled = false;

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-folded-centrality",
      versionId: "v1",
      algorithmRefresh: {
        enabled: true,
        pageRank: { enabled: true },
        kCore: { enabled: true },
        louvain: { enabled: false, maxCallEdges: 10_000 },
        workerTimeoutMs: 120_000,
      },
      foldedCentrality: {
        status: "succeeded",
        symbolCount: 3,
        callEdgeCount: 2,
        pageRankCount: 3,
        kCoreCount: 3,
      },
      centralityRunner: async () => {
        centralityCalled = true;
        return { pageRank: [], kCore: [] };
      },
    });

    assert.equal(centralityCalled, false);
    assert.equal(result.centralityComputed, 3);
    assert.equal(result.algorithmRefresh.pageRank.status, "succeeded");
    assert.equal(result.algorithmRefresh.kCore.status, "succeeded");
    assert.equal(result.algorithmRefresh.dirty, false);
  });

  it("reports cluster and process write subphase timings", async () => {
    await resetDb();
    await seedRepo("repo-write-timings");
    await seedFile("repo-write-timings", "file-1", "src/write-timings.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-write-timings",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-write-timings",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-write-timings",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-write-timings",
      versionId: "v1",
      minClusterSize: 2,
      maxProcessDepth: 5,
      entryPatterns: ["^main$"],
      includeTimings: true,
    });

    assert.ok(result.timings);
    assert.equal(typeof result.timings["clusterWrite.loadExisting"], "number");
    assert.equal(typeof result.timings["clusterWrite.writeRows"], "number");
    assert.equal(typeof result.timings["processWrite.loadExisting"], "number");
    assert.equal(typeof result.timings["processWrite.writeRows"], "number");
  });

  it("respects maxProcessDepth when storing process steps", async () => {
    await resetDb();
    await seedRepo("repo-depth");
    await seedFile("repo-depth", "file-1", "src/depth.ts");
    await seedSymbol({
      repoId: "repo-depth",
      fileId: "file-1",
      symbolId: "sym-main",
      name: "main",
    });
    await seedSymbol({
      repoId: "repo-depth",
      fileId: "file-1",
      symbolId: "sym-foo",
      name: "foo",
    });
    await seedSymbol({
      repoId: "repo-depth",
      fileId: "file-1",
      symbolId: "sym-bar",
      name: "bar",
    });
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-depth",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-depth",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-depth",
      versionId: "v3",
      maxProcessDepth: 1,
      entryPatterns: ["^main$"],
      minClusterSize: 1,
    });

    assert.ok(result.processesTraced >= 1);
    const processesForMain = await ladybugDb.getProcessesForSymbol(
      conn,
      "sym-main",
    );
    assert.ok(processesForMain.length >= 1);
    const flow = await ladybugDb.getProcessFlow(
      conn,
      processesForMain[0]!.processId,
    );
    assert.deepStrictEqual(
      flow.map((step) => step.symbolId),
      ["sym-main", "sym-foo"],
    );
  });

  it("skips canonical cluster and process rewrites for stable topology", async () => {
    await resetDb();
    await seedRepo("repo-stable");
    await seedFile("repo-stable", "file-1", "src/stable.ts");
    await seedSymbol({
      repoId: "repo-stable",
      fileId: "file-1",
      symbolId: "sym-main",
      name: "main",
    });
    await seedSymbol({
      repoId: "repo-stable",
      fileId: "file-1",
      symbolId: "sym-foo",
      name: "foo",
    });
    await seedSymbol({
      repoId: "repo-stable",
      fileId: "file-1",
      symbolId: "sym-bar",
      name: "bar",
    });
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-stable",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-stable",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-stable",
      versionId: "v1",
      minClusterSize: 2,
      maxProcessDepth: 5,
      entryPatterns: ["^main$"],
    });

    await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-stable",
      versionId: "v2",
      minClusterSize: 2,
      maxProcessDepth: 5,
      entryPatterns: ["^main$"],
    });

    const clusters = await ladybugDb.getClustersForRepo(conn, "repo-stable");
    assert.ok(clusters.length >= 1);
    assert.equal(clusters[0]?.versionId, "v1");

    const processes = await ladybugDb.getProcessesForRepo(conn, "repo-stable");
    assert.ok(processes.length >= 1);
    assert.equal(processes[0]?.versionId, "v1");

    const clusterMembers = await ladybugDb.getClusterMembersForRepo(
      conn,
      "repo-stable",
    );
    assert.ok(clusterMembers.length >= 2);

    const processSteps = await ladybugDb.getProcessStepsForRepo(
      conn,
      "repo-stable",
    );
    assert.ok(processSteps.length >= 2);
  });

  it("survives stable refreshes while cluster/process FTS indexes are active", () => {
    const childDbPath = join(
      tmpdir(),
      `.lbug-cluster-orchestrator-fts-${process.pid}-${Date.now()}.lbug`,
    );
    removeLadybugDbFiles(childDbPath);
    const script = `
      import { closeLadybugDb, getLadybugConn, initLadybugDb } from "./dist/db/ladybug.js";
      import * as ladybugDb from "./dist/db/ladybug-queries.js";
      import { computeAndStoreClustersAndProcesses } from "./dist/indexer/cluster-orchestrator.js";
      import { ensureFtsIndexForNonEmptyTable, ENTITY_FTS_INDEX_NAMES } from "./dist/retrieval/index-lifecycle.js";

      const dbPath = process.env.TEST_DB_PATH;
      if (!dbPath) throw new Error("TEST_DB_PATH is required");
      const repoId = "repo-fts-stable-child";
      const now = "2026-03-19T09:00:00.000Z";
      await initLadybugDb(dbPath);
      const conn = await getLadybugConn();
      await ladybugDb.upsertRepo(conn, {
        repoId,
        rootPath: "C:/cluster-orchestrator-fts-child",
        configJson: JSON.stringify({ policy: {} }),
        createdAt: now,
      });
      await ladybugDb.upsertFile(conn, {
        fileId: "file-1",
        repoId,
        relPath: "src/fts-stable.ts",
        contentHash: "file-1-hash",
        language: "ts",
        byteSize: 200,
        lastIndexedAt: now,
      });
      for (const [symbolId, name] of [
        ["sym-main", "main"],
        ["sym-foo", "foo"],
        ["sym-bar", "bar"],
      ]) {
        await ladybugDb.upsertSymbol(conn, {
          symbolId,
          repoId,
          fileId: "file-1",
          kind: "function",
          name,
          exported: true,
          visibility: null,
          language: "ts",
          rangeStartLine: 1,
          rangeStartCol: 0,
          rangeEndLine: 4,
          rangeEndCol: 0,
          astFingerprint: symbolId + "-fp",
          signatureJson: null,
          summary: null,
          invariantsJson: null,
          sideEffectsJson: null,
          updatedAt: now,
        });
      }
      await ladybugDb.insertEdges(conn, [
        {
          repoId,
          fromSymbolId: "sym-main",
          toSymbolId: "sym-foo",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          resolverId: "unit-test",
          resolutionPhase: "pass2",
          provenance: "manual",
          createdAt: now,
        },
        {
          repoId,
          fromSymbolId: "sym-foo",
          toSymbolId: "sym-bar",
          edgeType: "call",
          weight: 1,
          confidence: 1,
          resolution: "exact",
          resolverId: "unit-test",
          resolutionPhase: "pass2",
          provenance: "manual",
          createdAt: now,
        },
      ]);

      const compute = (versionId) => computeAndStoreClustersAndProcesses({
        conn,
        repoId,
        versionId,
        minClusterSize: 2,
        maxProcessDepth: 5,
        entryPatterns: ["^main$"],
        algorithmRefresh: { enabled: false },
      });

      await compute("v1");
      const clusterFts = await ensureFtsIndexForNonEmptyTable(
        conn,
        "Cluster",
        ENTITY_FTS_INDEX_NAMES.cluster,
      );
      const processFts = await ensureFtsIndexForNonEmptyTable(
        conn,
        "Process",
        ENTITY_FTS_INDEX_NAMES.process,
      );
      if (clusterFts.status === "failed" || processFts.status === "failed") {
        process.stdout.write("fts-unavailable");
        await closeLadybugDb();
        process.exit(0);
      }

      await compute("v2");
      const clusters = await ladybugDb.getClustersForRepo(conn, repoId);
      const processes = await ladybugDb.getProcessesForRepo(conn, repoId);
      if (clusters[0]?.versionId !== "v1") {
        throw new Error("stable cluster refresh rewrote Cluster rows");
      }
      if (processes[0]?.versionId !== "v1") {
        throw new Error("stable process refresh rewrote Process rows");
      }
      process.stdout.write(JSON.stringify({
        clusterVersionId: clusters[0]?.versionId,
        processVersionId: processes[0]?.versionId,
      }));
      await closeLadybugDb();
    `;

    try {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        {
          cwd: join(__dirname, "..", ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            SDL_MCP_DISABLE_NATIVE_ADDON: "1",
            SDL_LOG_LEVEL: "error",
            TEST_DB_PATH: childDbPath,
          },
        },
      );

      if (result.stdout.includes("fts-unavailable")) {
        assert.equal(result.status, 0, result.stderr);
        return;
      }

      assert.equal(
        result.status,
        0,
        `child refresh should not crash with active FTS indexes\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /"clusterVersionId":"v1"/);
      assert.match(result.stdout, /"processVersionId":"v1"/);
    } finally {
      removeLadybugDbFiles(childDbPath);
    }
  });

  it("keeps centrality writes when Louvain fails", async () => {
    await resetDb();
    await seedRepo("repo-louvain-fails");
    await seedFile("repo-louvain-fails", "file-1", "src/louvain.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-louvain-fails",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-louvain-fails",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-louvain-fails",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-louvain-fails",
      versionId: "v1",
      minClusterSize: 2,
      centralityRunner: async () => ({
        pageRank: [
          { symbolId: "sym-main", score: 0.1 },
          { symbolId: "sym-foo", score: 0.8 },
          { symbolId: "sym-bar", score: 0.1 },
        ],
        kCore: [
          { symbolId: "sym-main", coreness: 1 },
          { symbolId: "sym-foo", coreness: 2 },
          { symbolId: "sym-bar", coreness: 1 },
        ],
      }),
      algorithmCapabilityDetector: async () => ({ supported: true }),
      louvainRunner: async () => {
        throw new Error("simulated louvain failure");
      },
    });

    assert.equal(result.centralityComputed, 3);
    assert.equal(result.algorithmRefresh.dirty, true);
    assert.equal(result.algorithmRefresh.louvain.status, "failed");
    const centrality = await ladybugDb.querySingle<{
      pageRank: unknown;
      kCore: unknown;
    }>(
      conn,
      "MATCH (m:Metrics {symbolId: $symbolId}) RETURN m.pageRank AS pageRank, m.kCore AS kCore",
      { symbolId: "sym-foo" },
    );
    assert.equal(Number(centrality?.pageRank), 0.8);
    assert.equal(Number(centrality?.kCore), 2);
  });

  it("skips Louvain above maxCallEdges without marking algorithms stale", async () => {
    await resetDb();
    await seedRepo("repo-louvain-skipped");
    await seedFile("repo-louvain-skipped", "file-1", "src/skip.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-louvain-skipped",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-louvain-skipped",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-louvain-skipped",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);
    let louvainCalled = false;
    await ladybugDb.upsertShadowCluster(conn, {
      shadowClusterId: "repo-louvain-skipped:louvain:old",
      repoId: "repo-louvain-skipped",
      algorithm: "louvain",
      label: "old community",
      symbolCount: 2,
      modularity: 0,
      versionId: "old",
      createdAt: "2026-03-19T09:00:00.000Z",
    });

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-louvain-skipped",
      versionId: "v1",
      algorithmRefresh: {
        enabled: true,
        pageRank: { enabled: false },
        kCore: { enabled: false },
        louvain: { enabled: true, maxCallEdges: 1 },
        workerTimeoutMs: 120_000,
      },
      louvainRunner: async () => {
        louvainCalled = true;
        return [];
      },
    });

    assert.equal(louvainCalled, false);
    assert.equal(result.algorithmRefresh.louvain.status, "skipped");
    assert.equal(result.algorithmRefresh.dirty, false);
    const shadowClusters = await ladybugDb.getShadowClustersForRepo(
      conn,
      "repo-louvain-skipped",
    );
    assert.equal(shadowClusters.length, 0);
  });

  it("uses DB call-edge count for Louvain policy when shared graph undercounts", async () => {
    await resetDb();
    await seedRepo("repo-louvain-db-count");
    await seedFile("repo-louvain-db-count", "file-1", "src/db-count.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-louvain-db-count",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-louvain-db-count",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-louvain-db-count",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);
    let louvainCalled = false;

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-louvain-db-count",
      versionId: "v1",
      algorithmRefresh: {
        enabled: true,
        pageRank: { enabled: false },
        kCore: { enabled: false },
        louvain: { enabled: true, maxCallEdges: 1 },
        workerTimeoutMs: 120_000,
      },
      sharedGraph: {
        callEdges: [{ callerId: "sym-main", calleeId: "sym-foo" }],
        clusterEdges: [{ fromSymbolId: "sym-main", toSymbolId: "sym-foo" }],
      },
      louvainRunner: async () => {
        louvainCalled = true;
        return [];
      },
    });

    assert.equal(louvainCalled, false);
    assert.equal(result.algorithmRefresh.louvain.status, "skipped");
    assert.match(
      result.algorithmRefresh.louvain.reason ?? "",
      /call-edge-count 2 exceeds maxCallEdges 1/,
    );
    assert.equal(result.algorithmRefresh.dirty, false);
  });

  it("clears stale Louvain shadow clusters when algorithm capability is unavailable", async () => {
    await resetDb();
    await seedRepo("repo-louvain-unsupported");
    await seedFile("repo-louvain-unsupported", "file-1", "src/unsupported.ts");
    for (const [symbolId, name] of [
      ["sym-main", "main"],
      ["sym-foo", "foo"],
      ["sym-bar", "bar"],
    ] as const) {
      await seedSymbol({
        repoId: "repo-louvain-unsupported",
        fileId: "file-1",
        symbolId,
        name,
      });
    }
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-louvain-unsupported",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
      {
        repoId: "repo-louvain-unsupported",
        fromSymbolId: "sym-foo",
        toSymbolId: "sym-bar",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);
    await ladybugDb.upsertShadowCluster(conn, {
      shadowClusterId: "repo-louvain-unsupported:louvain:old",
      repoId: "repo-louvain-unsupported",
      algorithm: "louvain",
      label: "old community",
      symbolCount: 2,
      modularity: 0,
      versionId: "old",
      createdAt: "2026-03-19T09:00:00.000Z",
    });
    let louvainCalled = false;

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-louvain-unsupported",
      versionId: "v1",
      algorithmRefresh: {
        enabled: true,
        pageRank: { enabled: false },
        kCore: { enabled: false },
        louvain: { enabled: true, maxCallEdges: 50_000 },
        workerTimeoutMs: 120_000,
      },
      algorithmCapabilityDetector: async () => ({
        supported: false,
        reason: "unit unsupported",
      }),
      louvainRunner: async () => {
        louvainCalled = true;
        return [];
      },
    });

    assert.equal(louvainCalled, false);
    assert.equal(result.algorithmRefresh.louvain.status, "skipped");
    assert.equal(result.algorithmRefresh.louvain.reason, "unit unsupported");
    assert.equal(result.algorithmRefresh.dirty, false);
    const shadowClusters = await ladybugDb.getShadowClustersForRepo(
      conn,
      "repo-louvain-unsupported",
    );
    assert.equal(shadowClusters.length, 0);
  });

  it("marks algorithms dirty when the centrality worker times out", async () => {
    await resetDb();
    await seedRepo("repo-centrality-timeout");
    await seedFile("repo-centrality-timeout", "file-1", "src/timeout.ts");
    await seedSymbol({
      repoId: "repo-centrality-timeout",
      fileId: "file-1",
      symbolId: "sym-main",
      name: "main",
    });
    await seedSymbol({
      repoId: "repo-centrality-timeout",
      fileId: "file-1",
      symbolId: "sym-foo",
      name: "foo",
    });
    const conn = await getLadybugConn();
    await ladybugDb.insertEdges(conn, [
      {
        repoId: "repo-centrality-timeout",
        fromSymbolId: "sym-main",
        toSymbolId: "sym-foo",
        edgeType: "call",
        weight: 1,
        confidence: 1,
        resolution: "exact",
        resolverId: "unit-test",
        resolutionPhase: "pass2",
        provenance: "manual",
        createdAt: "2026-03-19T09:00:00.000Z",
      },
    ]);

    const result = await computeAndStoreClustersAndProcesses({
      conn,
      repoId: "repo-centrality-timeout",
      versionId: "v1",
      centralityRunner: async () => {
        throw new CentralityWorkerTimeoutError(1);
      },
      algorithmRefresh: {
        enabled: true,
        pageRank: { enabled: true },
        kCore: { enabled: true },
        louvain: { enabled: false, maxCallEdges: 50_000 },
        workerTimeoutMs: 1,
      },
    });

    assert.equal(result.algorithmRefresh.dirty, true);
    assert.equal(result.algorithmRefresh.pageRank.status, "timedOut");
    assert.equal(result.algorithmRefresh.kCore.status, "timedOut");
    assert.ok(result.clustersComputed >= 0);
    assert.ok(result.processesTraced >= 0);
  });
});
