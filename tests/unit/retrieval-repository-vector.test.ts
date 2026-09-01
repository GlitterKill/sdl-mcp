import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Connection } from "kuzu";

const MODEL = "jina-embeddings-v2-base-code";
const EMBEDDING = [1, ...Array<number>(767).fill(0)];

describe("repository-safe Symbol vector retrieval", () => {
  it("validates and parameterizes exact repository ranking", async (t) => {
    const core = await import("../../dist/db/ladybug-core.js");
    let captured:
      | { statement: string; params: Record<string, unknown> }
      | undefined;

    t.mock.module("../../dist/db/ladybug-core.js", {
      namedExports: {
        ...core,
        queryExactVectorAll: async (
          _conn: Connection,
          statement: string,
          params: Record<string, unknown>,
        ) => {
          captured = { statement, params };
          return [{ symbolId: "repo-a", score: 1 }];
        },
      },
    });

    const retrieval = await import(
      "../../dist/db/ladybug-retrieval.js?exact-ranking-contract"
    );
    const rankExact = Reflect.get(retrieval, "rankRepoSymbolVectorsExact");
    assert.equal(typeof rankExact, "function");
    if (typeof rankExact !== "function") return;

    const conn = {} as Connection;
    assert.deepEqual(
      await rankExact(conn, "repo", MODEL, EMBEDDING, 2),
      [{ symbolId: "repo-a", score: 1 }],
    );
    assert.ok(captured);
    assert.match(captured.statement, /embeddingJinaCodeVec/);
    assert.match(captured.statement, /e\.repoId = \$repoId/);
    assert.doesNotMatch(captured.statement, /s\.repoId/);
    assert.match(captured.statement, /array_cosine_similarity/);
    assert.match(captured.statement, /CAST\(\$embedding, 'DOUBLE\[768\]'\)/);
    assert.match(captured.statement, /ORDER BY score DESC, symbolId ASC/);
    assert.doesNotMatch(captured.statement, /repo-a|repo'/);
    assert.deepEqual(captured.params, {
      repoId: "repo",
      embedding: EMBEDDING,
      limit: 2,
    });
    await assert.rejects(
      rankExact(conn, "repo", "unknown", EMBEDDING, 2),
      /Unknown embedding model/,
    );
    await assert.rejects(
      rankExact(conn, "repo", MODEL, EMBEDDING.slice(1), 2),
      /768/,
    );
    await assert.rejects(
      rankExact(conn, "repo", MODEL, [Number.NaN, ...EMBEDDING.slice(1)], 2),
      /non-finite/,
    );
    await assert.rejects(rankExact(conn, "repo", MODEL, EMBEDDING, 0), /limit/);
    await assert.rejects(
      rankExact(conn, "repo", MODEL, EMBEDDING, 10_001),
      /limit/,
    );
  });

  it("adapts physical ANN once and falls back to exact safely", async (t) => {
    const ladybug = await import("../../dist/db/ladybug.js");
    const core = await import("../../dist/db/ladybug-core.js");
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const loadConfigModule = await import("../../dist/config/loadConfig.js");
    const configTypes = await import("../../dist/config/types.js");
    const embeddings = await import("../../dist/indexer/embeddings.js");
    const graphAdmission = await import(
      "../../dist/services/graph-retrieval-availability.js"
    );
    const health = await import("../../dist/retrieval/health.js");
    const { logger } = await import("../../dist/util/logger.js");

    const originalConn = { name: "original" } as unknown as Connection;
    const freshConn = { name: "fresh" } as unknown as Connection;
    const semantic = configTypes.SemanticConfigSchema.parse({
      enabled: true,
      provider: "local",
      embeddingProfile: "specialized",
      symbolEmbeddingModels: [MODEL],
      fileSummaryEmbeddingModels: [],
      retrieval: {},
    });
    let topK = 2;
    let efs = 3;
    let stuck = false;
    let annResponses: Array<unknown[] | Error> = [];
    let exactRows: Array<{ symbolId: string; score: number }> = [];
    let exactError: Error | undefined;
    let freshConnError: Error | undefined;
    const vectorQueries: string[] = [];
    const exactCalls: Array<{
      conn: Connection;
      repoId: string;
      modelName: string;
      embedding: number[];
      limit: number;
    }> = [];
    const warnings: Array<{
      message: string;
      meta?: Record<string, unknown>;
    }> = [];
    const originalWarn = logger.warn;
    logger.warn = (message, meta) => warnings.push({ message, meta });
    t.after(() => {
      logger.warn = originalWarn;
    });

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
        queryStoredProcAll: async (_conn: Connection, query: string) => {
          vectorQueries.push(query);
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
        loadConfig: () => ({
          semantic: {
            ...semantic,
            retrieval: {
              ...semantic.retrieval,
              fts: { ...semantic.retrieval.fts, enabled: false },
              vector: {
                ...semantic.retrieval.vector,
                enabled: true,
                topK,
                efs,
              },
            },
          },
        }),
      },
    });
    t.mock.module("../../dist/indexer/embeddings.js", {
      namedExports: {
        ...embeddings,
        getEmbeddingProvider: () => ({
          initialize: async () => undefined,
          isMockFallback: () => false,
          embed: async () => [EMBEDDING],
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
          fts: false,
          fileSummaryFts: false,
          vectorNomic: false,
          vectorJinaCode: true,
          vectorByEntityModel: {
            symbol: { [MODEL]: true },
            fileSummary: {},
          },
          coveragePermille: { symbolVector: 1000, fileSummaryVector: 0 },
        }),
      },
    });

    const orchestrator = await import(
      "../../dist/retrieval/orchestrator.js?repository-vector-contract"
    );

    function reset(): void {
      topK = 2;
      efs = 3;
      stuck = false;
      annResponses = [];
      exactRows = [];
      exactError = undefined;
      freshConnError = undefined;
      vectorQueries.length = 0;
      exactCalls.length = 0;
      warnings.length = 0;
    }

    async function run() {
      const context = orchestrator.createRetrievalQueryContext({
        connection: originalConn,
      });
      const result = await orchestrator.hybridSearch(
        {
          repoId: "repo",
          query: "find symbols",
          limit: topK,
          ftsEnabled: false,
          vectorEnabled: true,
          includeEvidence: true,
        },
        context,
      );
      return { context, result };
    }

    await t.test("retries K=2 to K=4 and filters before fusion", async () => {
      reset();
      annResponses = [
        [
          { symbolId: "repo-b", distance: 0.3, owned: true },
          { symbolId: "foreign", distance: 0.1, owned: false },
        ],
        [
          { symbolId: "repo-b", distance: 0.2, owned: true },
          { symbolId: "foreign", distance: 0.1, owned: false },
          { symbolId: "repo-a", distance: 0.2, owned: true },
          { symbolId: "repo-a", distance: 0.2, owned: true },
        ],
      ];

      const { result } = await run();

      assert.equal(vectorQueries.length, 2);
      assert.ok(
        vectorQueries.every((query) =>
          query.includes("QUERY_VECTOR_INDEX('SymbolVectorEmbedding'"),
        ),
      );
      assert.ok(vectorQueries.every((query) => !query.includes("PROJECT_GRAPH")));
      assert.ok(vectorQueries.every((query) => query.includes("node.repoId")));
      assert.match(vectorQueries[0], /, 2, efs := 3\)/);
      assert.match(vectorQueries[1], /, 4, efs := 4\)/);
      assert.deepEqual(
        result.results.map((row) => row.symbolId),
        ["repo-a", "repo-b"],
      );
      assert.equal(JSON.stringify(result).includes("foreign"), false);
      assert.equal(exactCalls.length, 0);
    });

    await t.test("keeps results and evidence stable across ANN row order", async () => {
      const rows = [
        { symbolId: "repo-b", distance: 0.2, owned: true },
        { symbolId: "foreign", distance: 0.1, owned: false },
        { symbolId: "repo-a", distance: 0.2, owned: true },
        { symbolId: "repo-a", distance: 0.2, owned: true },
      ];
      const permutations = [
        rows,
        [...rows].reverse(),
        [rows[2], rows[0], rows[3], rows[1]],
      ];
      let expected: string | undefined;

      for (const permutation of permutations) {
        reset();
        annResponses = [
          [
            { symbolId: "repo-b", distance: 0.3, owned: true },
            { symbolId: "foreign", distance: 0.1, owned: false },
          ],
          permutation,
        ];

        const { result } = await run();
        assert.ok(result.evidence);
        const stable = JSON.stringify({
          results: result.results,
          evidence: {
            sources: result.evidence.sources,
            topRanksPerSource: result.evidence.topRanksPerSource,
            candidateCountPerSource:
              result.evidence.candidateCountPerSource,
            fallbackReason: result.evidence.fallbackReason,
          },
        });
        expected ??= stable;
        assert.equal(stable, expected);
        assert.deepEqual(
          result.results.map((row) => row.symbolId),
          ["repo-a", "repo-b"],
        );
        assert.equal(stable.includes("foreign"), false);
        assert.equal(exactCalls.length, 0);
      }
    });

    await t.test("does not repeat ANN at the K ceiling", async () => {
      reset();
      topK = 10_000;
      annResponses = [
        Array.from({ length: 10_000 }, (_, index) => ({
          symbolId: index === 0 ? "repo-a" : `foreign-${index}`,
          distance: index / 10_000,
          owned: index === 0,
        })),
      ];
      exactRows = [{ symbolId: "repo-exact", score: 1 }];

      const { result } = await run();

      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 1);
      assert.deepEqual(result.results.map((row) => row.symbolId), ["repo-exact"]);
    });

    await t.test("uses exact once after ANN rejection and marks success", async () => {
      reset();
      annResponses = [new Error("ANN deadline")];
      exactRows = [{ symbolId: "repo-exact", score: 1 }];

      const { context, result } = await run();

      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 1);
      assert.deepEqual(result.results.map((row) => row.symbolId), ["repo-exact"]);
      assert.deepEqual(context.laneOutcomes.get("symbol:vector:jinacode"), {
        available: true,
        attempted: true,
        succeeded: true,
        failed: false,
      });
      assert.equal(exactCalls[0].repoId, "repo");
      assert.equal(exactCalls[0].modelName, MODEL);
      assert.deepEqual(exactCalls[0].embedding, EMBEDDING);
      assert.equal(exactCalls[0].limit, 2);
      assert.ok(
        warnings.some(
          ({ message, meta }) =>
            message.includes("Symbol ANN failed; using exact fallback") &&
            meta?.error instanceof Error &&
            meta.error.message === "ANN deadline",
        ),
      );
    });

    await t.test("short raw window falls back without retry", async () => {
      reset();
      annResponses = [[{ symbolId: "repo-a", distance: 0.1, owned: true }]];
      exactRows = [{ symbolId: "repo-exact", score: 1 }];

      await run();

      assert.equal(vectorQueries.length, 1);
      assert.equal(exactCalls.length, 1);
    });

    await t.test("unresolved retry shortage falls back", async () => {
      reset();
      annResponses = [
        [
          { symbolId: "repo-a", distance: 0.1, owned: true },
          { symbolId: "foreign", distance: 0.2, owned: false },
        ],
        [
          { symbolId: "repo-a", distance: 0.1, owned: true },
          { symbolId: "repo-a", distance: 0.2, owned: true },
          { symbolId: "foreign-a", distance: 0.3, owned: false },
          { symbolId: "foreign-b", distance: 0.4, owned: false },
        ],
      ];
      exactRows = [{ symbolId: "repo-exact", score: 1 }];

      await run();

      assert.equal(vectorQueries.length, 2);
      assert.equal(exactCalls.length, 1);
    });

    await t.test("checks out a healthy connection after ANN quarantine", async () => {
      reset();
      stuck = true;
      annResponses = [new Error("ANN deadline")];
      exactRows = [{ symbolId: "repo-exact", score: 1 }];

      await run();

      assert.equal(exactCalls.length, 1);
      assert.strictEqual(exactCalls[0].conn, freshConn);
    });

    await t.test("preserves ANN failure when healthy checkout also fails", async () => {
      reset();
      stuck = true;
      annResponses = [new Error("ANN deadline")];
      freshConnError = new Error("checkout unavailable");

      const { context, result } = await run();

      assert.deepEqual(result.results, []);
      assert.equal(exactCalls.length, 0);
      assert.deepEqual(context.laneOutcomes.get("symbol:vector:jinacode"), {
        available: true,
        attempted: true,
        succeeded: false,
        failed: true,
      });
      assert.ok(
        warnings.some(
          ({ message }) =>
            message.includes("ANN deadline") &&
            message.includes("checkout unavailable"),
        ),
      );
    });

    await t.test("preserves degradation when ANN and exact both fail", async () => {
      reset();
      annResponses = [new Error("ANN unavailable")];
      exactError = new Error("exact unavailable");

      const { context, result } = await run();

      assert.deepEqual(result.results, []);
      assert.equal(exactCalls.length, 1);
      assert.deepEqual(context.laneOutcomes.get("symbol:vector:jinacode"), {
        available: true,
        attempted: true,
        succeeded: false,
        failed: true,
      });
      assert.ok(
        warnings.some(
          ({ message }) =>
            message.includes("ANN unavailable") &&
            message.includes("exact unavailable"),
        ),
      );
    });
  });
});
