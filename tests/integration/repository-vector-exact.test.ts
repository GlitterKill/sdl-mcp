import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  closeLadybugDb,
  getLadybugConn,
  initLadybugDb,
} from "../../dist/db/ladybug.js";
import { exec } from "../../dist/db/ladybug-core.js";
import { setSymbolVectorEmbedding } from "../../dist/db/ladybug-queries.js";
import * as retrieval from "../../dist/db/ladybug-retrieval.js";
import { createVectorIndex } from "../../dist/retrieval/index-lifecycle.js";
import { queryRepoSymbolVectorIndex } from "../../dist/retrieval/orchestrator.js";
import { logger } from "../../dist/util/logger.js";

const MODEL = "jina-embeddings-v2-base-code";
const QUERY = [1, ...Array<number>(767).fill(0)];
const ORTHOGONAL = [0, 1, ...Array<number>(766).fill(0)];
const NATIVE_QUERY = [0, 0, 0.999999, 0.001, ...Array<number>(764).fill(0)];
const NATIVE_FOREIGN = [0, 0, 0.999, 0.0447, ...Array<number>(764).fill(0)];
const NATIVE_SECOND = [0, 0, 0.95, 0.312, ...Array<number>(764).fill(0)];
const testDir = mkdtempSync(join(tmpdir(), "sdl-repo-vector-exact-"));

before(async () => {
  await closeLadybugDb();
  await initLadybugDb(join(testDir, "graph.lbug"));
});

after(async () => {
  await closeLadybugDb();
  rmSync(testDir, { recursive: true, force: true });
});

it("ranks exact vectors inside one repository with deterministic ties", async () => {
  const rankExact = Reflect.get(retrieval, "rankRepoSymbolVectorsExact");
  assert.equal(typeof rankExact, "function");
  if (typeof rankExact !== "function") return;

  const conn = await getLadybugConn();
  await exec(
    conn,
    `UNWIND $rows AS row
     MERGE (r:Repo {repoId: row.repoId})
     SET r.rootPath = row.rootPath, r.createdAt = row.createdAt`,
    {
      rows: [
        { repoId: "repo-a", rootPath: "/repo-a", createdAt: "2026-01-01" },
        { repoId: "repo-b", rootPath: "/repo-b", createdAt: "2026-01-01" },
      ],
    },
  );
  await exec(
    conn,
    `UNWIND $rows AS row
     MERGE (s:Symbol {symbolId: row.symbolId})
     SET s.repoId = row.repoId, s.name = row.symbolId`,
    {
      rows: [
        { repoId: "repo-a", symbolId: "repo-a-exact" },
        { repoId: "repo-a", symbolId: "repo-a-tie-a" },
        { repoId: "repo-a", symbolId: "repo-a-tie-b" },
        { repoId: "repo-b", symbolId: "repo-b-exact" },
      ],
    },
  );
  for (const [repoId, symbolId, vector] of [
    ["repo-a", "repo-a-exact", QUERY],
    ["repo-a", "repo-a-tie-a", ORTHOGONAL],
    ["repo-a", "repo-a-tie-b", ORTHOGONAL],
    ["repo-b", "repo-b-exact", QUERY],
  ] as const) {
    await setSymbolVectorEmbedding(
      conn,
      repoId,
      symbolId,
      MODEL,
      JSON.stringify(vector),
      `hash-${symbolId}`,
      [...vector],
    );
  }

  const rows = await rankExact(conn, "repo-a", MODEL, QUERY, 10);

  assert.deepEqual(
    rows.map((row: { symbolId: string }) => row.symbolId),
    ["repo-a-exact", "repo-a-tie-a", "repo-a-tie-b"],
  );
  assert.ok(rows[0].score > rows[1].score);
  assert.equal(rows.some((row: { symbolId: string }) => row.symbolId === "repo-b-exact"), false);
});

it("runs the physical HNSW ownership path without exact fallback", async () => {
  const conn = await getLadybugConn();
  await exec(
    conn,
    `UNWIND $rows AS row
     MERGE (e:SymbolVectorEmbedding {embeddingId: row.embeddingId})
     SET e.repoId = row.repoId,
         e.symbolId = row.symbolId,
         e.model = $model,
         e.embeddingVector = row.vectorJson,
         e.cardHash = row.embeddingId,
         e.updatedAt = $updatedAt,
         e.embeddingJinaCodeVec = row.vector`,
    {
      model: MODEL,
      updatedAt: "2026-01-01T00:00:00.000Z",
      rows: [
        {
          embeddingId: "native-owned-shared",
          repoId: "repo-a",
          symbolId: "shared-native",
          vectorJson: JSON.stringify(NATIVE_QUERY),
          vector: NATIVE_QUERY,
        },
        {
          embeddingId: "native-foreign-shared",
          repoId: "repo-b",
          symbolId: "shared-native",
          vectorJson: JSON.stringify(NATIVE_FOREIGN),
          vector: NATIVE_FOREIGN,
        },
        {
          embeddingId: "native-owned-second",
          repoId: "repo-a",
          symbolId: "owned-second",
          vectorJson: JSON.stringify(NATIVE_SECOND),
          vector: NATIVE_SECOND,
        },
      ],
    },
  );

  const indexName = "repository_safe_native_jina";
  assert.equal(
    await createVectorIndex(
      conn,
      "SymbolVectorEmbedding",
      "embeddingJinaCodeVec",
      indexName,
      768,
    ),
    true,
  );

  const fallbackLogs: string[] = [];
  const originalDebug = logger.debug;
  const originalWarn = logger.warn;
  logger.debug = (message) => {
    if (message.includes("Symbol ANN")) fallbackLogs.push(message);
  };
  logger.warn = (message) => {
    if (message.includes("Symbol ANN")) fallbackLogs.push(message);
  };
  try {
    const rows = await queryRepoSymbolVectorIndex(
      conn,
      "repo-a",
      MODEL,
      indexName,
      NATIVE_QUERY,
      2,
      200,
    );
    assert.deepEqual(
      rows.map((row) => row.symbolId),
      ["shared-native", "owned-second"],
    );
  } finally {
    logger.debug = originalDebug;
    logger.warn = originalWarn;
  }
  assert.deepEqual(fallbackLogs, []);
});
