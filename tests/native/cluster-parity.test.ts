import { describe, before, after, it } from "node:test";
import assert from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { closeLadybugDb, getLadybugConn, initLadybugDb } from "../../dist/db/ladybug.js";
import * as ladybugDb from "../../dist/db/ladybug-queries.js";
import { computeClustersTS } from "../../dist/graph/cluster.js";
import {
  computeClustersRust,
  isRustEngineAvailable,
} from "../../src/indexer/rustIndexer.js";

const REPO_ID = "test-native-cluster-parity-repo";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("native cluster parity", () => {
  const graphDbPath = join(tmpdir(), ".lbug-native-cluster-parity-test-db");

  let symbolIds: string[];
  let edges: Array<{ fromSymbolId: string; toSymbolId: string }>;

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
      rootPath: "/tmp/test-native-cluster-parity",
      configJson: JSON.stringify({
        repoId: REPO_ID,
        rootPath: "/tmp/test-native-cluster-parity",
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

    symbolIds = ["A", "B", "C", "X", "Y", "Z"].map((id) => `${id}-${REPO_ID}`);
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
    edges = [
      { fromSymbolId: A, toSymbolId: B },
      { fromSymbolId: B, toSymbolId: C },
      { fromSymbolId: X, toSymbolId: Y },
      { fromSymbolId: Y, toSymbolId: Z },
    ];

    for (const e of edges) {
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

  it("matches TypeScript fallback output when native addon is available", async () => {
    if (!isRustEngineAvailable()) return;

    const ts = await computeClustersTS(REPO_ID, { minClusterSize: 3 });
    const rust = computeClustersRust(
      symbolIds.map((symbolId) => ({ symbolId })),
      edges,
      3,
    );

    // The native addon may be present but built without the cluster exports.
    if (!rust) return;
    assert.deepStrictEqual(rust, ts);
  });
});
