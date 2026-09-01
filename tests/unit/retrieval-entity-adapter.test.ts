import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("executes exact entity lanes for specialized health", async (t) => {
  const ladybug = await import("../../dist/db/ladybug.js");
  const ladybugCore = await import("../../dist/db/ladybug-core.js");
  const loadConfigModule = await import("../../dist/config/loadConfig.js");
  const configTypes = await import("../../dist/config/types.js");
  const embeddings = await import("../../dist/indexer/embeddings.js");
  const graphAdmission = await import(
    "../../dist/services/graph-retrieval-availability.js"
  );
  const healthModule = await import("../../dist/retrieval/health.js");

  const semantic = configTypes.SemanticConfigSchema.parse({
    enabled: true,
    embeddingProfile: "specialized",
    symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
    fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
  });
  const queries: string[] = [];
  const providerModels: string[] = [];
  let rejectVector = false;
  const caps = {
    fts: true,
    fileSummaryFts: false,
    vectorNomic: false,
    vectorJinaCode: true,
    vectorByEntityModel: {
      symbol: { "jina-embeddings-v2-base-code": true },
      fileSummary: { "nomic-embed-text-v1.5": true },
    },
    coveragePermille: {
      symbolVector: 1000,
      fileSummaryVector: 1000,
    },
  };

  t.mock.module("../../dist/db/ladybug.js", {
    namedExports: {
      ...ladybug,
      getLadybugConn: async () => ({} as Connection),
    },
  });
  t.mock.module("../../dist/db/ladybug-core.js", {
    namedExports: {
      ...ladybugCore,
      queryStoredProcAll: async (_conn: Connection, query: string) => {
        queries.push(query);
        if (query.includes("QUERY_VECTOR_INDEX")) {
          if (rejectVector) throw new Error("vector deadline exceeded");
          return [{ node: { fileId: "file-summary-1" }, distance: 0.1 }];
        }
        return [{ node: { fileId: "file-summary-1" }, score: 1 }];
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
      getEmbeddingProvider: (_provider: string, model: string) => {
        providerModels.push(model);
        return {
          isMockFallback: () => false,
          embed: async () => [[0.1, 0.2]],
        };
      },
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
      ...healthModule,
      checkRetrievalHealth: async () => caps,
    },
  });

  const { entitySearch } = await import(
    "../../dist/retrieval/orchestrator.js?entity-lane-adapter"
  );

  await t.test("uses FileSummary Nomic and skips inactive FileSummary Jina", async () => {
    queries.length = 0;
    providerModels.length = 0;

    const result = await entitySearch({
      repoId: "repo",
      query: "find summary",
      limit: 10,
      entityTypes: ["fileSummary"],
      ftsEnabled: false,
      vectorEnabled: true,
    });

    assert.deepEqual(providerModels, ["nomic-embed-text-v1.5"]);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /FileSummary/);
    assert.match(queries[0], /filesummary_vec_nomic_embed_v15/);
    assert.deepEqual(
      result.results.map((item) => [item.entityType, item.entityId]),
      [["fileSummary", "file-summary-1"]],
    );
  });

  await t.test("does not exception-probe missing FileSummary FTS", async () => {
    queries.length = 0;

    const result = await entitySearch({
      repoId: "repo",
      query: "find summary",
      limit: 10,
      entityTypes: ["fileSummary"],
      ftsEnabled: true,
      vectorEnabled: false,
    });

    assert.deepEqual(queries, []);
    assert.deepEqual(result.results, []);
  });

  await t.test("returns FileSummary FTS results when its vector lane fails", async () => {
    queries.length = 0;
    providerModels.length = 0;
    caps.fileSummaryFts = true;
    rejectVector = true;

    try {
      const result = await entitySearch({
        repoId: "repo",
        query: "find summary",
        limit: 10,
        entityTypes: ["fileSummary"],
        ftsEnabled: true,
        vectorEnabled: true,
      });

      assert.equal(
        queries.filter((query) => query.includes("QUERY_FTS_INDEX")).length,
        1,
      );
      assert.equal(
        queries.filter((query) => query.includes("QUERY_VECTOR_INDEX")).length,
        1,
      );
      assert.deepEqual(
        result.results.map((item) => [item.entityType, item.entityId]),
        [["fileSummary", "file-summary-1"]],
      );
    } finally {
      caps.fileSummaryFts = false;
      rejectVector = false;
    }
  });
});
