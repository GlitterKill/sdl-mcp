import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connection } from "kuzu";

import type { SemanticConfig } from "../../dist/config/types.js";
import type { SymbolVectorHealthSnapshot } from "../../dist/retrieval/health.js";

const MODEL = "jina-embeddings-v2-base-code";
const OTHER_MODEL = "nomic-embed-text-v1.5";
const REPO_ID = "repo";
const VERSION_ID = "v-repository-vector";
const EMBEDDING = [1, ...Array<number>(767).fill(0)];

describe("repository-safe Symbol vector retrieval", () => {
  it("ranks exact vectors from the repository table with validated identity", async (t) => {
    const core = await import("../../dist/db/ladybug-core.js");
    const { resolveSymbolVectorPhysicalIdentity } = await import(
      "../../dist/db/ladybug-symbol-embeddings.js"
    );
    let captured:
      | { statement: string; params: Record<string, unknown> }
      | undefined;
    const candidate = {
      repoId: REPO_ID,
      model: MODEL,
      embeddingId: `${MODEL}:repo-a`,
      symbolId: "repo-a",
      score: 1,
    };

    t.mock.module("../../dist/db/ladybug-core.js", {
      namedExports: {
        ...core,
        queryExactVectorAll: async (
          _conn: Connection,
          statement: string,
          params: Record<string, unknown>,
        ) => {
          captured = { statement, params };
          return [candidate];
        },
      },
    });

    const retrieval = await import(
      "../../dist/db/ladybug-retrieval.js?repository-exact-contract"
    );
    const rankExact = Reflect.get(retrieval, "rankRepoSymbolVectorsExact");
    assert.equal(typeof rankExact, "function");
    if (typeof rankExact !== "function") return;

    const conn = {} as Connection;
    assert.deepEqual(
      await rankExact(conn, REPO_ID, MODEL, EMBEDDING, 2),
      [candidate],
    );

    const identity = resolveSymbolVectorPhysicalIdentity(REPO_ID, MODEL);
    assert.ok(captured);
    assert.match(captured.statement, new RegExp(`MATCH \\(e:${identity.tableName}\\)`));
    assert.match(captured.statement, /e\.repoId = \$repoId/);
    assert.match(captured.statement, /e\.model = \$model/);
    assert.match(
      captured.statement,
      new RegExp(`e\\.${identity.propertyName} IS NOT NULL`),
    );
    assert.match(captured.statement, /array_cosine_similarity/);
    assert.match(captured.statement, /CAST\(\$embedding, 'DOUBLE\[768\]'\)/);
    assert.match(captured.statement, /RETURN repoId, model, embeddingId, symbolId, score/);
    assert.match(captured.statement, /ORDER BY score DESC, symbolId ASC/);
    assert.doesNotMatch(captured.statement, /MATCH \(e:SymbolVectorEmbedding\)/);
    assert.doesNotMatch(captured.statement, /'repo'/);
    assert.equal(captured.statement.includes(MODEL), false);
    assert.deepEqual(captured.params, {
      repoId: REPO_ID,
      model: MODEL,
      embedding: EMBEDDING,
      limit: 2,
    });

    await assert.rejects(
      rankExact(conn, REPO_ID, "unknown", EMBEDDING, 2),
      /Unknown embedding model/,
    );
    await assert.rejects(
      rankExact(conn, REPO_ID, MODEL, EMBEDDING.slice(1), 2),
      /768/,
    );
    await assert.rejects(
      rankExact(
        conn,
        REPO_ID,
        MODEL,
        [Number.NaN, ...EMBEDDING.slice(1)],
        2,
      ),
      /non-finite/,
    );
    await assert.rejects(
      rankExact(conn, REPO_ID, MODEL, EMBEDDING, 0),
      /limit/,
    );
    await assert.rejects(
      rankExact(conn, REPO_ID, MODEL, EMBEDDING, 10_001),
      /limit/,
    );
  });

  it("routes from one complete cached health batch and fences invalidation", async (t) => {
    const ladybug = await import("../../dist/db/ladybug.js");
    const core = await import("../../dist/db/ladybug-core.js");
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const loadConfigModule = await import("../../dist/config/loadConfig.js");
    const { SemanticConfigSchema } = await import(
      "../../dist/config/types.js"
    );
    const health = await import("../../dist/retrieval/health.js");
    const { resolveSymbolVectorPhysicalIdentity } = await import(
      "../../dist/db/ladybug-symbol-embeddings.js"
    );

    const originalConn = { name: "original" } as unknown as Connection;
    const freshConn = { name: "fresh" } as unknown as Connection;
    const semantic = SemanticConfigSchema.parse({
      enabled: true,
      provider: "local",
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [MODEL, OTHER_MODEL],
      fileSummaryEmbeddingModels: [],
      retrieval: {},
    }) as SemanticConfig;

    let stuck = false;
    let freshConnError: Error | undefined;
    let annResponses: Array<unknown[] | Error> = [];
    let exactRows: Array<Record<string, unknown>> = [];
    let exactError: Error | undefined;
    let onAnnQuery: (() => void) | undefined;
    const vectorQueries: string[] = [];
    const exactCalls: Array<{
      conn: Connection;
      repoId: string;
      modelName: string;
      embedding: number[];
      limit: number;
    }> = [];

    t.mock.module("../../dist/db/ladybug.js", {
      namedExports: {
        ...ladybug,
        getLadybugConn: async () => {
          if (freshConnError) throw freshConnError;
          return freshConn;
        },
      },
    });
    t.mock.module("../../dist/db/ladybug-core.js", {
      namedExports: {
        ...core,
        isConnStuck: (conn: Connection) => conn === originalConn && stuck,
        queryStoredProcAll: async (_conn: Connection, statement: string) => {
          if (/SHOW_INDEXES|count\s*\(/i.test(statement)) {
            throw new Error("retrieval must not inspect physical state");
          }
          vectorQueries.push(statement);
          onAnnQuery?.();
          const response = annResponses.shift();
          if (response instanceof Error) throw response;
          return response ?? [];
        },
      },
    });
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugDb,
        rankRepoSymbolVectorsExact: async (
          conn: Connection,
          repoId: string,
          modelName: string,
          embedding: number[],
          limit: number,
        ) => {
          exactCalls.push({ conn, repoId, modelName, embedding, limit });
          if (exactError) throw exactError;
          return exactRows;
        },
      },
    });
    t.mock.module("../../dist/config/loadConfig.js", {
      namedExports: {
        ...loadConfigModule,
        loadConfig: () => ({ semantic }),
      },
    });

    const orchestrator = await import(
      "../../dist/retrieval/orchestrator.js?repository-health-routing-contract"
    );
    const queryRepositoryVectors = Reflect.get(
      orchestrator,
      "queryRepoSymbolVectorIndex",
    );
    assert.equal(typeof queryRepositoryVectors, "function");
    if (typeof queryRepositoryVectors !== "function") return;

    function makeSnapshot(
      model: string,
      generation: number,
      versionId: string,
      mode: SymbolVectorHealthSnapshot["mode"],
      options: {
        exactFallbackAllowed?: boolean;
        observedProperty?: string;
      } = {},
    ): SymbolVectorHealthSnapshot {
      const identity = resolveSymbolVectorPhysicalIdentity(
        REPO_ID,
        model,
        semantic,
      );
      const expectedIndexIdentity = {
        model,
        tableName: identity.tableName,
        name: identity.indexName,
        type: "vector" as const,
        property: identity.propertyName,
      };
      return {
        repoId: REPO_ID,
        versionId,
        generation,
        model,
        eligibleSymbolCount: 2,
        completeVectorCount: 2,
        lifecycleState: "steady",
        expectedIndexIdentity,
        observedIndexIdentity:
          mode === "hnsw"
            ? {
                ...expectedIndexIdentity,
                property:
                  options.observedProperty ?? expectedIndexIdentity.property,
                status: "healthy",
                extensionLoaded: true,
              }
            : null,
        mode,
        exactFallbackAllowed:
          options.exactFallbackAllowed ?? mode !== "none",
      };
    }

    function publish(
      mode: SymbolVectorHealthSnapshot["mode"],
      options: {
        clear?: boolean;
        versionId?: string;
        exactFallbackAllowed?: boolean;
        observedProperty?: string;
      } = {},
    ): number {
      if (options.clear !== false) {
        health.clearRepositorySymbolVectorHealth(REPO_ID);
      }
      const versionId = options.versionId ?? VERSION_ID;
      const generation = health.invalidateRepositorySymbolVectorHealth(
        REPO_ID,
        versionId,
        semantic,
        "refreshing",
      );
      const enabledModels = [
        ...(health.getRepositorySymbolVectorHealthSnapshots(REPO_ID)?.keys() ??
          []),
      ];
      const snapshots = enabledModels.map((model) =>
        makeSnapshot(
          model,
          generation,
          versionId,
          model === MODEL ? mode : "none",
          model === MODEL
            ? {
                exactFallbackAllowed: options.exactFallbackAllowed,
                observedProperty: options.observedProperty,
              }
            : { exactFallbackAllowed: false },
        ),
      );
      assert.equal(
        health.publishRepositorySymbolVectorHealthBatch({
          repoId: REPO_ID,
          versionId,
          capturedGeneration: generation,
          enabledModels,
          snapshots,
        }),
        true,
      );
      return generation;
    }

    function validAnnRow(
      symbolId: string,
      distance: number,
      overrides: Partial<Record<"repoId" | "model" | "embeddingId", string>> = {},
    ): Record<string, unknown> {
      return {
        repoId: overrides.repoId ?? REPO_ID,
        model: overrides.model ?? MODEL,
        embeddingId: overrides.embeddingId ?? `${MODEL}:${symbolId}`,
        symbolId,
        distance,
      };
    }

    function validExactRow(
      symbolId: string,
      score: number,
      overrides: Partial<Record<"repoId" | "model" | "embeddingId", string>> = {},
    ): Record<string, unknown> {
      return {
        repoId: overrides.repoId ?? REPO_ID,
        model: overrides.model ?? MODEL,
        embeddingId: overrides.embeddingId ?? `${MODEL}:${symbolId}`,
        symbolId,
        score,
      };
    }

    function reset(): void {
      stuck = false;
      freshConnError = undefined;
      annResponses = [];
      exactRows = [];
      exactError = undefined;
      onAnnQuery = undefined;
      vectorQueries.length = 0;
      exactCalls.length = 0;
      health.clearRepositorySymbolVectorHealth(REPO_ID);
    }

    async function run(topK = 2) {
      return queryRepositoryVectors(
        originalConn,
        REPO_ID,
        MODEL,
        EMBEDDING,
        topK,
        3,
      );
    }

    function assertHardDegradedBatch(previousGeneration: number): void {
      const snapshots =
        health.getRepositorySymbolVectorHealthSnapshots(REPO_ID);
      assert.ok(snapshots);
      assert.deepEqual([...snapshots.keys()], [MODEL, OTHER_MODEL]);
      for (const snapshot of snapshots.values()) {
        assert.ok(snapshot.generation > previousGeneration);
        assert.equal(snapshot.lifecycleState, "refreshing");
        assert.equal(snapshot.mode, "degraded");
        assert.equal(snapshot.exactFallbackAllowed, false);
      }
    }

    await t.test("none and hard-degraded modes perform no vector query", async () => {
      reset();
      assert.deepEqual(await run(), []);

      publish("none", { exactFallbackAllowed: false });
      assert.deepEqual(await run(), []);

      publish("degraded", { exactFallbackAllowed: false });
      assert.deepEqual(await run(), []);

      assert.deepEqual(vectorQueries, []);
      assert.deepEqual(exactCalls, []);
    });

    await t.test("exact and exact-enabled degraded modes use only exact", async () => {
      for (const mode of ["exact", "degraded"] as const) {
        reset();
        publish(mode, { exactFallbackAllowed: true });
        exactRows = [validExactRow("repo-exact", 1)];

        assert.deepEqual(await run(), [
          { symbolId: "repo-exact", score: 1 },
        ]);
        assert.equal(exactCalls.length, 1);
        assert.deepEqual(vectorQueries, []);
      }
    });

    await t.test("direct exact execution failure returns empty without ANN", async () => {
      reset();
      publish("exact", { exactFallbackAllowed: true });
      exactError = new Error("exact unavailable");

      assert.deepEqual(await run(), []);
      assert.equal(exactCalls.length, 1);
      assert.deepEqual(vectorQueries, []);
    });

    await t.test("HNSW uses the repository identity once at caller K", async () => {
      reset();
      publish("hnsw", { exactFallbackAllowed: true });
      annResponses = [[validAnnRow("repo-short", 0.1)]];

      assert.deepEqual(await run(2), [
        { symbolId: "repo-short", score: 1 / 1.1 },
      ]);
      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 0);

      const identity = resolveSymbolVectorPhysicalIdentity(
        REPO_ID,
        MODEL,
        semantic,
      );
      assert.match(
        vectorQueries[0],
        new RegExp(
          `QUERY_VECTOR_INDEX\\('${identity.tableName}', '${identity.indexName}'`,
        ),
      );
      assert.match(vectorQueries[0], /, 2, efs := 3\)/);
      assert.doesNotMatch(vectorQueries[0], /SymbolVectorEmbedding'/);
      assert.strictEqual(
        health.getRepositorySymbolVectorHealthSnapshot(REPO_ID, MODEL)?.mode,
        "hnsw",
        "a naturally short valid ANN page is not a failure",
      );
    });

    await t.test("ANN errors invalidate the whole batch before exact fallback", async () => {
      reset();
      const generation = publish("hnsw", {
        exactFallbackAllowed: true,
      });
      annResponses = [new Error("ANN unavailable")];
      exactRows = [validExactRow("repo-exact", 1)];

      assert.deepEqual(await run(), [
        { symbolId: "repo-exact", score: 1 },
      ]);
      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 1);
      assertHardDegradedBatch(generation);
    });

    await t.test("failed guarded exact fallback stays empty after invalidation", async () => {
      reset();
      const generation = publish("hnsw", {
        exactFallbackAllowed: true,
      });
      annResponses = [new Error("ANN unavailable")];
      exactError = new Error("exact unavailable");

      assert.deepEqual(await run(), []);
      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 1);
      assertHardDegradedBatch(generation);
    });

    await t.test("invalid ANN identity or mapped property invalidates atomically", async () => {
      const invalidRows = [
        validAnnRow("foreign", 0.1, { repoId: "other-repo" }),
        validAnnRow("wrong-model", 0.1, { model: OTHER_MODEL }),
        validAnnRow("wrong-id", 0.1, { embeddingId: "wrong" }),
      ];

      for (const invalidRow of invalidRows) {
        reset();
        const generation = publish("hnsw", {
          exactFallbackAllowed: true,
        });
        annResponses = [[invalidRow]];
        exactRows = [validExactRow("repo-exact", 1)];

        assert.deepEqual(await run(), [
          { symbolId: "repo-exact", score: 1 },
        ]);
        assert.equal(vectorQueries.length, 1);
        assert.equal(exactCalls.length, 1);
        assertHardDegradedBatch(generation);
      }

      reset();
      const generation = publish("hnsw", {
        exactFallbackAllowed: true,
        observedProperty: "embeddingNomicVec",
      });
      exactRows = [validExactRow("repo-exact", 1)];

      assert.deepEqual(await run(), [
        { symbolId: "repo-exact", score: 1 },
      ]);
      assert.equal(vectorQueries.length, 0);
      assert.equal(exactCalls.length, 1);
      assertHardDegradedBatch(generation);
    });

    await t.test("invalid exact identity reaches neither ranking nor output", async () => {
      const invalidRows = [
        validExactRow("foreign", 1, { repoId: "other-repo" }),
        validExactRow("wrong-model", 1, { model: OTHER_MODEL }),
        validExactRow("wrong-id", 1, { embeddingId: "wrong" }),
      ];

      for (const invalidRow of invalidRows) {
        reset();
        const generation = publish("exact", {
          exactFallbackAllowed: true,
        });
        exactRows = [invalidRow];

        assert.deepEqual(await run(), []);
        assert.deepEqual(vectorQueries, []);
        assert.equal(exactCalls.length, 1);
        assertHardDegradedBatch(generation);
      }
    });

    await t.test("a stale failure cannot invalidate a newer generation", async () => {
      reset();
      publish("hnsw", { exactFallbackAllowed: true });
      annResponses = [new Error("old generation failed")];
      onAnnQuery = () => {
        onAnnQuery = undefined;
        publish("hnsw", {
          clear: false,
          versionId: "v-new",
          exactFallbackAllowed: true,
        });
      };

      assert.deepEqual(await run(), []);
      assert.equal(exactCalls.length, 0);
      const current =
        health.getRepositorySymbolVectorHealthSnapshot(REPO_ID, MODEL);
      assert.equal(current?.versionId, "v-new");
      assert.equal(current?.mode, "hnsw");
      assert.equal(current?.exactFallbackAllowed, true);
    });

    await t.test("ANN ordering and tie-breaks are byte-stable", async () => {
      const rows = [
        validAnnRow("repo-b", 0.2),
        validAnnRow("repo-c", 0.1),
        validAnnRow("repo-a", 0.2),
        validAnnRow("repo-a", 0.2),
      ];
      let expected: string | undefined;

      for (const permutation of [
        rows,
        [...rows].reverse(),
        [rows[2], rows[0], rows[3], rows[1]],
      ]) {
        reset();
        publish("hnsw", { exactFallbackAllowed: true });
        annResponses = [permutation];

        const stable = JSON.stringify(await run(3));
        expected ??= stable;
        assert.equal(stable, expected);
        assert.equal(exactCalls.length, 0);
      }
    });

    await t.test("stuck ANN connection checks out once for guarded exact", async () => {
      reset();
      publish("hnsw", { exactFallbackAllowed: true });
      stuck = true;
      annResponses = [new Error("ANN unavailable")];
      exactRows = [validExactRow("repo-exact", 1)];

      assert.deepEqual(await run(), [
        { symbolId: "repo-exact", score: 1 },
      ]);
      assert.strictEqual(exactCalls[0]?.conn, freshConn);

      reset();
      publish("hnsw", { exactFallbackAllowed: true });
      stuck = true;
      freshConnError = new Error("checkout unavailable");
      annResponses = [new Error("ANN unavailable")];
      assert.deepEqual(await run(), []);
      assert.equal(exactCalls.length, 0);
    });

    t.after(() => {
      health.clearRepositorySymbolVectorHealth(REPO_ID);
    });
  });
});
