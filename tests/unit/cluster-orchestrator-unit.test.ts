import { after, before, describe, it } from "node:test";
import assert from "node:assert";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_DB_PATH = join(
  tmpdir(),
  ".lbug-cluster-orchestrator-unit-test-db.lbug",
);

async function resetDb(): Promise<void> {
  await closeLadybugDb();
  for (const p of [
    TEST_DB_PATH,
    `${TEST_DB_PATH}.wal`,
    `${TEST_DB_PATH}.shadow`,
    `${TEST_DB_PATH}.lock`,
  ]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
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
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
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

    assert.deepStrictEqual(result, {
      clustersComputed: 0,
      processesTraced: 0,
      centralityComputed: 0,
      shadowClustersComputed: 0,
    });
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

    // Clusters/processes require call edges, so these stay at 0.
    // Centrality (PageRank) still assigns a value to an isolated node in
    // the projected graph, so centralityComputed can be 1 when the algo
    // extension is available, or 0 when it falls back (no-op).
    assert.strictEqual(result.clustersComputed, 0);
    assert.strictEqual(result.processesTraced, 0);
    assert.strictEqual(result.shadowClustersComputed, 0);
    assert.ok(
      result.centralityComputed === 0 || result.centralityComputed === 1,
      `centralityComputed should be 0 (fallback) or 1 (isolated node), got ${result.centralityComputed}`,
    );
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

  it("refreshes cluster and process metadata without changing stable topology", async () => {
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
    assert.equal(clusters[0]?.versionId, "v2");

    const processes = await ladybugDb.getProcessesForRepo(conn, "repo-stable");
    assert.ok(processes.length >= 1);
    assert.equal(processes[0]?.versionId, "v2");

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
});
