import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { buildSlice } from "../../dist/graph/slice.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ID = "test-cluster-slice-cohesion-repo";

describe("cluster-aware slice cohesion (integration)", () => {
  const graphDbPath = join(tmpdir(), ".lbug-cluster-slice-cohesion-test-db");

  const symbolA1 = `${REPO_ID}-a1`;
  const symbolA2 = `${REPO_ID}-a2`;
  const symbolA3 = `${REPO_ID}-a3`;
  const symbolA4 = `${REPO_ID}-a4`;
  const symbolA5 = `${REPO_ID}-a5`;
  const symbolB1 = `${REPO_ID}-b1`;

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
      rootPath: "/tmp/test-cluster-slice-cohesion",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-cluster-slice-cohesion",
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
      [symbolA1, "a1"],
      [symbolA2, "a2"],
      [symbolA3, "a3"],
      [symbolA4, "a4"],
      [symbolA5, "a5"],
      [symbolB1, "b1"],
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

    // Entry symbol imports its same-cluster neighbors. These edges would normally
    // fall below SLICE_SCORE_THRESHOLD due to import weighting unless boosted.
    for (const toSymbolId of [symbolA2, symbolA3, symbolA4, symbolA5]) {
      await ladybugDb.insertEdge(conn, {
        repoId: REPO_ID,
        fromSymbolId: symbolA1,
        toSymbolId,
        edgeType: "import",
        weight: 1.0,
        confidence: 1.0,
        resolution: "exact",
        provenance: "static",
        createdAt: now,
      });
    }

    // Cross-cluster call edge to establish a related cluster.
    await ladybugDb.insertEdge(conn, {
      repoId: REPO_ID,
      fromSymbolId: symbolA1,
      toSymbolId: symbolB1,
      edgeType: "call",
      weight: 1.0,
      confidence: 1.0,
      resolution: "exact",
      provenance: "static",
      createdAt: now,
    });

    // Seed cluster membership explicitly (independent of the cluster detector).
    const clusterA = `${REPO_ID}-cluster-a`;
    const clusterB = `${REPO_ID}-cluster-b`;

    await ladybugDb.upsertCluster(conn, {
      clusterId: clusterA,
      repoId: REPO_ID,
      label: "cluster a",
      symbolCount: 5,
      cohesionScore: 0.0,
      versionId: null,
      createdAt: now,
    });
    await ladybugDb.upsertCluster(conn, {
      clusterId: clusterB,
      repoId: REPO_ID,
      label: "cluster b",
      symbolCount: 1,
      cohesionScore: 0.0,
      versionId: null,
      createdAt: now,
    });

    for (const symbolId of [symbolA1, symbolA2, symbolA3, symbolA4, symbolA5]) {
      await ladybugDb.upsertClusterMember(conn, {
        symbolId,
        clusterId: clusterA,
        membershipScore: 1.0,
      });
    }
    await ladybugDb.upsertClusterMember(conn, {
      symbolId: symbolB1,
      clusterId: clusterB,
      membershipScore: 1.0,
    });
  });

  after(async () => {
    await closeLadybugDb();
    if (existsSync(graphDbPath)) {
      rmSync(graphDbPath, { recursive: true, force: true });
    }
  });

  it("boosts same-cluster symbols into the slice frontier", async () => {
    const conn = await getLadybugConn();
    const slice = await buildSlice({
      repoId: REPO_ID,
      versionId: "v1",
      conn,
      entrySymbols: [symbolA1],
      taskText: "",
      budget: { maxCards: 10, maxEstimatedTokens: 10_000 },
      cardDetail: "deps",
      minConfidence: 0.5,
    });

    assert.ok(slice.cards.some((c) => c.symbolId === symbolA2));
    assert.ok(slice.cards.some((c) => c.symbolId === symbolA3));
    assert.ok(slice.cards.some((c) => c.symbolId === symbolA4));
    assert.ok(slice.cards.some((c) => c.symbolId === symbolA5));
    assert.ok(slice.cards.some((c) => c.symbolId === symbolB1));

    const entryCard = slice.cards.find((c) => c.symbolId === symbolA1);
    assert.ok(
      entryCard?.cluster,
      "Expected entry card to include cluster info",
    );
    const entryClusterId = entryCard.cluster.clusterId;

    const sameClusterCount = slice.cards.filter(
      (c) => c.cluster?.clusterId === entryClusterId,
    ).length;
    const ratio = sameClusterCount / Math.max(1, slice.cards.length);

    assert.ok(
      ratio > 0.8,
      `Expected >80% same-cluster symbols, got ${(ratio * 100).toFixed(1)}%`,
    );
  });
});
