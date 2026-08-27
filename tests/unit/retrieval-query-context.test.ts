import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const orchestratorSrc = readFileSync(
  join(process.cwd(), "src/retrieval/orchestrator.ts"),
  "utf8",
);
const retrievalDbSrc = readFileSync(
  join(process.cwd(), "src/db/ladybug-retrieval.ts"),
  "utf8",
);

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

  it("queries symbol ANN on SymbolVectorEmbedding and returns symbol IDs", () => {
    assert.ok(retrievalDbSrc.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"));
    assert.ok(
      orchestratorSrc.includes(
        "`CALL QUERY_VECTOR_INDEX('${projectionName}'",
      ),
    );
    assert.ok(orchestratorSrc.includes("symbolId: vectorRowId(row)"));
  });

  it("runs both Symbol ANN paths through a repository-filtered projection", () => {
    assert.ok(retrievalDbSrc.includes("CALL PROJECT_GRAPH_CYPHER"));
    assert.strictEqual(
      orchestratorSrc.match(
        /queryRepoSymbolVectorIndex\(/g,
      )?.length,
      3,
    );
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
