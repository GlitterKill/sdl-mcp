import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { computeClustersTS } from "../../dist/graph/cluster.js";

const REPO_ID = "test-ts-cluster-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("computeClustersTS", () => {
  const graphDbPath = join(__dirname, ".lbug-ts-cluster-test-db");

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
      rootPath: "/tmp/test-ts-cluster",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-ts-cluster",
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
      relPath: "src/test.ts",
      contentHash: "hash-test",
      language: "ts",
      byteSize: 100,
      lastIndexedAt: now,
    });

    const symbolIds = ["A", "B", "C", "X", "Y", "Z"].map((id) => `${id}-${REPO_ID}`);
    for (const symbolId of symbolIds) {
      await ladybugDb.upsertSymbol(conn, {
        symbolId,
        repoId: REPO_ID,
        fileId: "file-1",
        kind: "function",
        name: symbolId,
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

    const [A, B, C, X, Y, Z] = symbolIds;
    const edgeRows = [
      { fromSymbolId: A, toSymbolId: B },
      { fromSymbolId: B, toSymbolId: C },
      { fromSymbolId: X, toSymbolId: Y },
      { fromSymbolId: Y, toSymbolId: Z },
    ];

    for (const e of edgeRows) {
      await ladybugDb.insertEdge(conn, {
        repoId: REPO_ID,
        fromSymbolId: e.fromSymbolId,
        toSymbolId: e.toSymbolId,
        edgeType: "call",
        weight: 1.0,
        confidence: 1.0,
        resolution: "exact",
        provenance: null,
        createdAt: now,
      });
    }
  });

  after(async () => {
    await closeLadybugDb();
    try {
      rmSync(graphDbPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns deterministic cluster assignments", async () => {
    const r1 = await computeClustersTS(REPO_ID, { minClusterSize: 3 });
    const r2 = await computeClustersTS(REPO_ID, { minClusterSize: 3 });

    assert.strictEqual(r1.length, 6);
    assert.deepStrictEqual(r1, r2);

    const clusterIds = new Set(r1.map((a) => a.clusterId));
    assert.strictEqual(clusterIds.size, 2);

    r1.forEach((a) => {
      assert.ok(typeof a.symbolId === "string");
      assert.ok(typeof a.clusterId === "string");
      assert.strictEqual(a.membershipScore, 1.0);
    });
  });
});

