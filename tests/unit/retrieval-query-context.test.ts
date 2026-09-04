import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connection } from "kuzu";

import {
  createRetrievalQueryContext,
  getOrCreateEmbeddingPromise,
  getOrCreateHealthPromise,
  runAfterGraphRetrievalAdmission,
  sortVectorRowsByDistance,
} from "../../dist/retrieval/orchestrator.js";
import * as retrievalOrchestrator from "../../dist/retrieval/orchestrator.js";
import { buildRetrievalState } from "../../dist/context/engine.js";
import type { RetrievalCapabilities } from "../../dist/retrieval/types.js";

const healthy: RetrievalCapabilities = {
  fts: true,
  fileSummaryFts: true,
  vectorNomic: true,
  vectorJinaCode: true,
  coveragePermille: {
    symbolVector: 1000,
    fileSummaryVector: 1000,
  },
};

describe("request-scoped retrieval work", () => {
  it("preserves the checked-out connection and initializes backend outcomes", () => {
    const connection = {} as unknown as Connection;

    const context = createRetrievalQueryContext({ connection });

    assert.strictEqual(context.connection, connection);
    assert.equal(context.laneOutcomes.size, 0);
  });

  it("shares one pending health promise per repository", async () => {
    const context = createRetrievalQueryContext();
    let calls = 0;
    let release: ((value: RetrievalCapabilities) => void) | undefined;
    const factory = () => {
      calls += 1;
      return new Promise<RetrievalCapabilities>((resolve) => {
        release = resolve;
      });
    };

    const first = getOrCreateHealthPromise(context, "repo", factory);
    const second = getOrCreateHealthPromise(context, "repo", factory);

    assert.strictEqual(first, second);
    assert.equal(calls, 0, "promise is cached before deferred work starts");
    assert.equal(context.healthPromises.size, 1);
    await Promise.resolve();
    assert.equal(calls, 1);
    release?.(healthy);
    assert.deepEqual(await first, healthy);
  });

  it("keys embeddings by both model and prefixed query", async () => {
    const context = createRetrievalQueryContext();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return [calls];
    };

    const first = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: shared",
      factory,
    );
    const duplicate = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: shared",
      factory,
    );
    const otherModel = getOrCreateEmbeddingPromise(
      context,
      "model-b",
      "query: shared",
      factory,
    );
    const otherQuery = getOrCreateEmbeddingPromise(
      context,
      "model-a",
      "query: other",
      factory,
    );

    assert.strictEqual(first, duplicate);
    assert.equal(context.embeddingPromises.size, 3);
    assert.deepEqual(await Promise.all([first, duplicate, otherModel, otherQuery]), [
      [1],
      [1],
      [2],
      [3],
    ]);
    assert.equal(calls, 3);
  });

  it("prewarms only the configured model and fully-prefixed query promises", async () => {
    const prewarm = Reflect.get(
      retrievalOrchestrator,
      "prewarmRetrievalEmbeddingPromises",
    );
    assert.equal(typeof prewarm, "function");
    if (typeof prewarm !== "function") return;

    const embedded = new Map<string, string>();
    const promises = await prewarm(
      "review ContextEngineV2",
      { includeFileSummary: true },
      {
        loadSemanticConfig: () => ({
          enabled: true,
          provider: "local",
          symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
          fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
        }),
        getEmbeddingProvider: (_provider: string, model: string) => ({
          embed: async ([text]: string[]) => {
            embedded.set(model, text ?? "");
            return [[model.length]];
          },
          getDimension: () => 1,
          isMockFallback: () => false,
        }),
      },
    );

    assert.equal(promises.size, 2);
    assert.deepEqual([...embedded.keys()].sort(), [
      "jina-embeddings-v2-base-code",
      "nomic-embed-text-v1.5",
    ]);
    for (const [model, prefixedQuery] of embedded) {
      assert.ok(
        promises.has(`${model}\u0000${prefixedQuery}`),
        `${model} must be cached under its exact prefixed query`,
      );
    }
  });

  it("initializes before fallback checks and rejects providers that degrade during embed", async () => {
    const prewarm = Reflect.get(
      retrievalOrchestrator,
      "prewarmRetrievalEmbeddingPromises",
    );
    assert.equal(typeof prewarm, "function");
    if (typeof prewarm !== "function") return;

    let initialized = false;
    let degraded = false;
    let embedCalls = 0;
    const promises = await prewarm(
      "review ContextEngineV2",
      { includeFileSummary: false },
      {
        loadSemanticConfig: () => ({
          enabled: true,
          provider: "local",
          symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
          fileSummaryEmbeddingModels: [],
        }),
        getEmbeddingProvider: () => ({
          initialize: async () => {
            initialized = true;
          },
          embed: async () => {
            assert.strictEqual(initialized, true);
            embedCalls += 1;
            degraded = true;
            return [[42]];
          },
          getDimension: () => 1,
          isMockFallback: () => {
            assert.strictEqual(
              initialized,
              true,
              "fallback state must not be read before initialization",
            );
            return degraded;
          },
        }),
      },
    );

    const [embeddingPromise] = promises.values();
    assert.ok(embeddingPromise);
    await assert.rejects(embeddingPromise, /mock fallback/);
    assert.strictEqual(embedCalls, 1);
  });

  it("does not prewarm models when the vector lane is configured off", async () => {
    const prewarm = Reflect.get(
      retrievalOrchestrator,
      "prewarmRetrievalEmbeddingPromises",
    );
    assert.equal(typeof prewarm, "function");
    if (typeof prewarm !== "function") return;

    let providerCalls = 0;
    const promises = await prewarm(
      "review ContextEngineV2",
      { includeFileSummary: true },
      {
        loadSemanticConfig: () => ({
          enabled: true,
          provider: "local",
          retrieval: { vector: { enabled: false } },
        }),
        getEmbeddingProvider: () => {
          providerCalls += 1;
          return {
            embed: async () => [[1]],
            getDimension: () => 1,
            isMockFallback: () => false,
          };
        },
      },
    );

    assert.equal(promises.size, 0);
    assert.equal(providerCalls, 0);
  });

  it("records rejected and empty embeddings as failed vector attempts", async () => {
    const awaitEmbedding = Reflect.get(
      retrievalOrchestrator,
      "awaitVectorEmbeddingForLanes",
    );
    assert.equal(typeof awaitEmbedding, "function");
    if (typeof awaitEmbedding !== "function") return;

    for (const [name, embeddingPromise] of [
      ["rejected", Promise.reject(new Error("embedding failed"))],
      ["empty", Promise.resolve([])],
    ] as const) {
      const context = createRetrievalQueryContext();
      const lanes = ["symbol:vector:jinacode"];
      if (name === "rejected") {
        await assert.rejects(
          awaitEmbedding(context, lanes, embeddingPromise),
          /embedding failed/,
        );
      } else {
        assert.deepEqual(
          await awaitEmbedding(context, lanes, embeddingPromise),
          [],
        );
      }

      assert.deepEqual(context.laneOutcomes.get(lanes[0]), {
        attempted: true,
        succeeded: false,
        failed: true,
      });
      assert.equal(
        buildRetrievalState(healthy, [], context.laneOutcomes).level,
        "insufficient",
        `${name} embedding cannot report hybrid or successful empty retrieval`,
      );
    }
  });

  it("sorts raw HNSW rows by numeric distance then stable ID", () => {
    const sorted = sortVectorRowsByDistance([
      { node: { symbolId: "b" }, distance: 0.2 },
      { node: { symbolId: "c" }, distance: 0.1 },
      { node: { symbolId: "a" }, distance: 0.2 },
    ]);

    assert.deepEqual(
      sorted.map((row) => row.node?.symbolId),
      ["c", "a", "b"],
    );
  });

  it("continues FTS while cached Symbol vectors are non-queryable", async (t) => {
    const ladybug = await import("../../dist/db/ladybug.js");
    const core = await import("../../dist/db/ladybug-core.js");
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const loadConfigModule = await import("../../dist/config/loadConfig.js");
    const embeddings = await import("../../dist/indexer/embeddings.js");
    const graphAdmission = await import(
      "../../dist/services/graph-retrieval-availability.js"
    );
    const health = await import("../../dist/retrieval/health.js");
    const { SemanticConfigSchema } = await import(
      "../../dist/config/types.js"
    );
    const { resolveSymbolVectorPhysicalIdentity } = await import(
      "../../dist/db/ladybug-symbol-embeddings.js"
    );

    const model = "jina-embeddings-v2-base-code";
    const repoId = "repo-fts-continuation";
    const versionId = "v-fts-continuation";
    const embedding = [1, ...Array<number>(767).fill(0)];
    const conn = {} as unknown as Connection;
    const semantic = SemanticConfigSchema.parse({
      enabled: true,
      provider: "local",
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [model],
      fileSummaryEmbeddingModels: [],
      retrieval: {
        fts: { enabled: true },
        vector: { enabled: true, topK: 2, efs: 3 },
      },
    });
    let ftsQueries = 0;
    let vectorQueries = 0;
    let exactCalls = 0;
    let exactRows: Array<Record<string, unknown>> = [];

    t.mock.module("../../dist/db/ladybug.js", {
      namedExports: {
        ...ladybug,
        getLadybugConn: async () => conn,
      },
    });
    t.mock.module("../../dist/db/ladybug-core.js", {
      namedExports: {
        ...core,
        isConnStuck: () => false,
        queryStoredProcAll: async (
          _conn: Connection,
          statement: string,
        ) => {
          if (statement.includes("QUERY_FTS_INDEX")) {
            ftsQueries += 1;
            return [{ node: { symbolId: "fts-only" }, score: 2 }];
          }
          if (statement.includes("QUERY_VECTOR_INDEX")) {
            vectorQueries += 1;
            return [];
          }
          if (/SHOW_INDEXES|count\s*\(/i.test(statement)) {
            throw new Error("request-time physical inspection is forbidden");
          }
          return [];
        },
      },
    });
    t.mock.module("../../dist/db/ladybug-queries.js", {
      namedExports: {
        ...ladybugDb,
        rankRepoSymbolVectorsExact: async () => {
          exactCalls += 1;
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
    t.mock.module("../../dist/indexer/embeddings.js", {
      namedExports: {
        ...embeddings,
        getEmbeddingProvider: () => ({
          initialize: async () => undefined,
          embed: async () => [embedding],
          getDimension: () => embedding.length,
          isMockFallback: () => false,
        }),
      },
    });
    t.mock.module("../../dist/services/graph-retrieval-availability.js", {
      namedExports: {
        ...graphAdmission,
        assertGraphRetrievalAvailable: async () => undefined,
      },
    });
    t.mock.module("../../dist/retrieval/health.js", {
      namedExports: {
        ...health,
        checkRetrievalHealth: async () => ({
          fts: true,
          fileSummaryFts: false,
          vectorNomic: false,
          vectorJinaCode: true,
          vectorByEntityModel: {
            symbol: { [model]: true },
            fileSummary: {},
          },
          modelCoveragePermille: {
            symbol: { [model]: 1000 },
            fileSummary: {},
          },
          coveragePermille: {
            symbolVector: 1000,
            fileSummaryVector: 0,
          },
        }),
      },
    });

    const orchestrator = await import(
      "../../dist/retrieval/orchestrator.js?fts-after-vector-invalidation"
    );

    function publish(
      mode: "none" | "exact" | "hnsw",
      exactFallbackAllowed: boolean,
    ): void {
      const identity = resolveSymbolVectorPhysicalIdentity(
        repoId,
        model,
        semantic,
      );
      const generation = health.invalidateRepositorySymbolVectorHealth(
        repoId,
        versionId,
        semantic,
        "refreshing",
      );
      const expectedIndexIdentity = {
        model,
        tableName: identity.tableName,
        name: identity.indexName,
        type: "vector" as const,
        property: identity.propertyName,
      };
      const snapshot = {
        repoId,
        versionId,
        generation,
        model,
        eligibleSymbolCount: 1,
        completeVectorCount: 1,
        lifecycleState: "steady" as const,
        expectedIndexIdentity,
        observedIndexIdentity:
          mode === "hnsw"
            ? {
                ...expectedIndexIdentity,
                status: "healthy" as const,
                extensionLoaded: true,
              }
            : null,
        mode,
        exactFallbackAllowed,
      };
      assert.equal(
        health.publishRepositorySymbolVectorHealthBatch({
          repoId,
          versionId,
          capturedGeneration: generation,
          enabledModels: [model],
          snapshots: [snapshot],
        }),
        true,
      );
    }

    function reset(): void {
      health.clearRepositorySymbolVectorHealth(repoId);
      ftsQueries = 0;
      vectorQueries = 0;
      exactCalls = 0;
      exactRows = [];
    }

    async function run() {
      return orchestrator.hybridSearch(
        {
          repoId,
          query: "find FTS",
          limit: 5,
          ftsEnabled: true,
          vectorEnabled: true,
          includeEvidence: true,
        },
        orchestrator.createRetrievalQueryContext({ connection: conn }),
      );
    }

    const cases: Array<{
      name: string;
      arrange: () => void;
    }> = [
      {
        name: "absent snapshot",
        arrange: () => undefined,
      },
      {
        name: "none snapshot",
        arrange: () => publish("none", false),
      },
      {
        name: "post-admission invalidation",
        arrange: () => {
          publish("hnsw", true);
          health.invalidateRepositorySymbolVectorHealth(
            repoId,
            versionId,
            semantic,
            "refreshing",
          );
        },
      },
    ];

    for (const scenario of cases) {
      reset();
      scenario.arrange();

      const result = await run();

      assert.deepEqual(
        result.results.map((row) => row.symbolId),
        ["fts-only"],
        scenario.name,
      );
      assert.equal(ftsQueries, 1, scenario.name);
      assert.equal(vectorQueries, 0, scenario.name);
      assert.equal(exactCalls, 0, scenario.name);
      assert.deepEqual(result.evidence?.sources, ["fts"], scenario.name);
    }

    reset();
    publish("exact", true);
    exactRows = [
      {
        repoId: "foreign-repo",
        model,
        embeddingId: model + ":foreign",
        symbolId: "foreign",
        score: 1,
      },
    ];

    const invalidExactResult = await run();

    assert.deepEqual(
      invalidExactResult.results.map((row) => row.symbolId),
      ["fts-only"],
    );
    assert.equal(JSON.stringify(invalidExactResult).includes("foreign"), false);
    assert.equal(ftsQueries, 1);
    assert.equal(vectorQueries, 0);
    assert.equal(exactCalls, 1);
    assert.equal(
      health.getRepositorySymbolVectorHealthSnapshot(repoId, model)?.mode,
      "degraded",
    );
    assert.equal(
      health.getRepositorySymbolVectorHealthSnapshot(repoId, model)
        ?.exactFallbackAllowed,
      false,
    );

    t.after(() => {
      health.clearRepositorySymbolVectorHealth(repoId);
    });
  });

  it("uses the stable ID tie-break for non-finite vector distances", () => {
    const rows = [
      { node: { symbolId: "b" }, distance: Number.POSITIVE_INFINITY },
      { node: { symbolId: "a" }, distance: Number.POSITIVE_INFINITY },
    ];

    for (const permutation of [rows, [...rows].reverse()]) {
      assert.deepEqual(
        sortVectorRowsByDistance(permutation).map((row) => row.node?.symbolId),
        ["a", "b"],
      );
    }
  });

  it("runs zero downstream work when graph integrity rejects admission", async () => {
    const conn = {} as unknown as Connection;
    let healthCalls = 0;
    let storedProcedureCalls = 0;
    let embeddingCalls = 0;

    const run = async () => {
      await runAfterGraphRetrievalAdmission(
        conn,
        "repo",
        async () => {
          healthCalls += 1;
          storedProcedureCalls += 1;
          embeddingCalls += 1;
          return healthy;
        },
        async () => {
          throw new Error("graph integrity rejected");
        },
      );
    };

    await assert.rejects(run, /graph integrity rejected/);
    assert.deepEqual(
      { healthCalls, storedProcedureCalls, embeddingCalls },
      { healthCalls: 0, storedProcedureCalls: 0, embeddingCalls: 0 },
    );
  });
});
