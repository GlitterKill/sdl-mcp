import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";

import { SemanticConfigSchema } from "../../dist/config/types.js";
import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { execCheckpoint } from "../../dist/db/ladybug-core.js";
import { withExclusiveLadybugOperation } from "../../dist/db/ladybug-operation-gate.js";
import {
  resolveSymbolVectorPhysicalIdentity,
  setRepoSymbolVectorEmbeddingBatch,
} from "../../dist/db/ladybug-symbol-embeddings.js";
import * as retrieval from "../../dist/db/ladybug-retrieval.js";
import { withWindowsFtsRuntime } from "../../dist/db/ladybug-windows-fts-runtime.js";
import {
  clearRepositorySymbolVectorHealth,
  invalidateRepositorySymbolVectorHealth,
  publishRepositorySymbolVectorHealthBatch,
  type SymbolVectorHealthSnapshot,
} from "../../dist/retrieval/health.js";
import { createVectorIndex } from "../../dist/retrieval/index-lifecycle.js";
import { queryRepoSymbolVectorIndex } from "../../dist/retrieval/orchestrator.js";

const MODEL = "jina-embeddings-v2-base-code";
const VERSION_ID = "v-repository-vector-integration";
const QUERY = [0.999999, 0.001, ...Array<number>(766).fill(0)];
const SECOND = [0.95, 0.312249, ...Array<number>(766).fill(0)];
const ORTHOGONAL = [0.001, 0.999999, ...Array<number>(766).fill(0)];
const semantic = SemanticConfigSchema.parse({
  enabled: true,
  provider: "local",
  embeddingProfile: "specialized",
  symbolEmbeddingModels: [MODEL],
  fileSummaryEmbeddingModels: [],
  retrieval: {},
});
const testDir = mkdtempSync(join(tmpdir(), "sdl-repo-vector-exact-"));

function items(
  rows: ReadonlyArray<readonly [string, readonly number[]]>,
): Array<{
  symbolId: string;
  vector: string;
  cardHash: string;
  vectorArray: number[];
}> {
  return rows.map(([symbolId, vector]) => ({
    symbolId,
    vector: JSON.stringify(vector),
    cardHash: `hash-${symbolId}`,
    vectorArray: [...vector],
  }));
}

function publishHnswSnapshot(repoId: string): void {
  const identity = resolveSymbolVectorPhysicalIdentity(
    repoId,
    MODEL,
    semantic,
  );
  const generation = invalidateRepositorySymbolVectorHealth(
    repoId,
    VERSION_ID,
    semantic,
    "refreshing",
  );
  const expectedIndexIdentity = {
    model: MODEL,
    tableName: identity.tableName,
    name: identity.indexName,
    type: "vector" as const,
    property: identity.propertyName,
  };
  const snapshot: SymbolVectorHealthSnapshot = {
    repoId,
    versionId: VERSION_ID,
    generation,
    model: MODEL,
    eligibleSymbolCount: repoId === "repo-a" ? 4 : 2,
    completeVectorCount: repoId === "repo-a" ? 4 : 2,
    lifecycleState: "steady",
    expectedIndexIdentity,
    observedIndexIdentity: {
      ...expectedIndexIdentity,
      status: "healthy",
      extensionLoaded: true,
    },
    mode: "hnsw",
    exactFallbackAllowed: true,
  };
  assert.equal(
    publishRepositorySymbolVectorHealthBatch({
      repoId,
      versionId: VERSION_ID,
      capturedGeneration: generation,
      enabledModels: [MODEL],
      snapshots: [snapshot],
    }),
    true,
  );
}

before(async () => {
  await closeLadybugDb();
  await initLadybugDb(join(testDir, "graph.lbug"));
  await withExclusiveLadybugOperation(async () => {
    const conn = await getLadybugConn();
    await setRepoSymbolVectorEmbeddingBatch(
      conn,
      "repo-a",
      MODEL,
      items([
        ["shared-symbol", QUERY],
        ["repo-a-second", SECOND],
        ["repo-a-tie-a", ORTHOGONAL],
        ["repo-a-tie-b", ORTHOGONAL],
      ]),
    );
    await setRepoSymbolVectorEmbeddingBatch(
      conn,
      "repo-b",
      MODEL,
      items([
        ["shared-symbol", QUERY],
        ["repo-b-second", SECOND],
      ]),
    );
  });
});

after(async () => {
  clearRepositorySymbolVectorHealth("repo-a");
  clearRepositorySymbolVectorHealth("repo-b");
  await closeLadybugDb();
  rmSync(testDir, { recursive: true, force: true });
});

it("keeps exact ranking isolated and byte-stable across repository tables", async () => {
  const rankExact = Reflect.get(retrieval, "rankRepoSymbolVectorsExact");
  assert.equal(typeof rankExact, "function");
  if (typeof rankExact !== "function") return;

  const conn = await getLadybugConn();
  const repoA = await rankExact(conn, "repo-a", MODEL, QUERY, 10);
  const repoARepeat = await rankExact(conn, "repo-a", MODEL, QUERY, 10);
  const repoB = await rankExact(conn, "repo-b", MODEL, QUERY, 10);
  const repoBRepeat = await rankExact(conn, "repo-b", MODEL, QUERY, 10);

  assert.equal(JSON.stringify(repoARepeat), JSON.stringify(repoA));
  assert.equal(JSON.stringify(repoBRepeat), JSON.stringify(repoB));
  assert.deepEqual(
    repoA.map((row: { symbolId: string }) => row.symbolId),
    ["shared-symbol", "repo-a-second", "repo-a-tie-a", "repo-a-tie-b"],
  );
  assert.deepEqual(
    repoB.map((row: { symbolId: string }) => row.symbolId),
    ["shared-symbol", "repo-b-second"],
  );
  assert.ok(
    repoA.every(
      (row: { repoId: string; model: string; embeddingId: string; symbolId: string }) =>
        row.repoId === "repo-a" &&
        row.model === MODEL &&
        row.embeddingId === `${MODEL}:${row.symbolId}`,
    ),
  );
  assert.ok(
    repoB.every(
      (row: { repoId: string; model: string; embeddingId: string; symbolId: string }) =>
        row.repoId === "repo-b" &&
        row.model === MODEL &&
        row.embeddingId === `${MODEL}:${row.symbolId}`,
    ),
  );
});

it("queries each repository HNSW exactly once through its published identity", async () => {
  const identities = ["repo-a", "repo-b"].map((repoId) =>
    resolveSymbolVectorPhysicalIdentity(repoId, MODEL, semantic),
  );

  const created = await withWindowsFtsRuntime(async () =>
    withExclusiveLadybugOperation(async () => {
      const conn = await getLadybugConn();
      await execCheckpoint(conn);
      const results: boolean[] = [];
      for (const identity of identities) {
        results.push(
          await createVectorIndex(
            conn,
            identity.tableName,
            identity.propertyName,
            identity.indexName,
            768,
          ),
        );
      }
      return results;
    }),
  );
  assert.deepEqual(created, [true, true]);

  publishHnswSnapshot("repo-a");
  publishHnswSnapshot("repo-b");

  const conn = await getLadybugConn();
  const repoA = await queryRepoSymbolVectorIndex(
    conn,
    "repo-a",
    MODEL,
    QUERY,
    2,
    200,
  );
  const repoARepeat = await queryRepoSymbolVectorIndex(
    conn,
    "repo-a",
    MODEL,
    QUERY,
    2,
    200,
  );
  const repoB = await queryRepoSymbolVectorIndex(
    conn,
    "repo-b",
    MODEL,
    QUERY,
    2,
    200,
  );
  const repoBRepeat = await queryRepoSymbolVectorIndex(
    conn,
    "repo-b",
    MODEL,
    QUERY,
    2,
    200,
  );

  assert.equal(JSON.stringify(repoARepeat), JSON.stringify(repoA));
  assert.equal(JSON.stringify(repoBRepeat), JSON.stringify(repoB));
  assert.deepEqual(
    repoA.map((row) => row.symbolId),
    ["shared-symbol", "repo-a-second"],
  );
  assert.deepEqual(
    repoB.map((row) => row.symbolId),
    ["shared-symbol", "repo-b-second"],
  );
  assert.equal(
    repoA.some((row) => row.symbolId === "repo-b-second"),
    false,
  );
  assert.equal(
    repoB.some((row) => row.symbolId === "repo-a-second"),
    false,
  );
});
