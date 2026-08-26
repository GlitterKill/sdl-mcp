import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("derives specialized entity/model health from configured exact indexes", async (t) => {
  const lifecycle = await import("../../dist/retrieval/index-lifecycle.js");
  const extensionCaps = await import("../../dist/db/extension-caps.js");
  const retrievalHealthDb = await import(
    "../../dist/db/ladybug-retrieval-health.js"
  );

  const indexes = [
    {
      name: "custom_symbol_fts",
      tableName: "Symbol",
      type: "fts" as const,
      property: "searchText",
      extensionLoaded: true,
      status: "healthy" as const,
    },
    {
      name: lifecycle.ENTITY_FTS_INDEX_NAMES.fileSummary,
      tableName: "FileSummary",
      type: "fts" as const,
      property: "searchText",
      extensionLoaded: true,
      status: "healthy" as const,
    },
    {
      name: "custom_symbol_jina",
      tableName: "SymbolVectorEmbedding",
      type: "vector" as const,
      property: "embeddingJinaCodeVec",
      extensionLoaded: true,
      status: "healthy" as const,
    },
    {
      name: lifecycle.FILESUMMARY_VECTOR_INDEX_NAMES.nomic,
      tableName: "FileSummary",
      type: "vector" as const,
      property: lifecycle.FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property,
      extensionLoaded: true,
      status: "healthy" as const,
    },
  ];

  t.mock.module("../../dist/retrieval/index-lifecycle.js", {
    namedExports: {
      ...lifecycle,
      showIndexesStrict: async () => indexes,
    },
  });
  t.mock.module("../../dist/db/extension-caps.js", {
    namedExports: {
      ...extensionCaps,
      getExtensionCapabilities: () => ({ fts: true, vector: true }),
    },
  });
  t.mock.module("../../dist/db/ladybug-retrieval-health.js", {
    namedExports: {
      ...retrievalHealthDb,
      getSymbolRetrievalCoverage: async () => ({
        eligible: 10n,
        covered: 8n,
      }),
      getFileSummaryRetrievalCoverage: async () => ({
        eligible: 4n,
        covered: 2n,
      }),
    },
  });

  const { checkRetrievalHealth } = await import(
    "../../dist/retrieval/health.js?specialized-health"
  );
  const health = await checkRetrievalHealth(
    {} as Connection,
    "repo",
    {
      enabled: true,
      embeddingProfile: "specialized",
      symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
      retrieval: {
        fts: { indexName: "custom_symbol_fts" },
        vector: {
          indexes: {
            "jina-embeddings-v2-base-code": {
              indexName: "custom_symbol_jina",
            },
          },
        },
      },
    } as never,
  );

  assert.equal(health.fts, true);
  assert.equal(health.fileSummaryFts, true);
  assert.equal(health.vectorJinaCode, true);
  assert.equal(health.vectorNomic, false);
  assert.deepEqual(health.vectorByEntityModel, {
    symbol: {
      "jina-embeddings-v2-base-code": true,
    },
    fileSummary: {
      "nomic-embed-text-v1.5": true,
    },
  });
  assert.deepEqual(health.coveragePermille, {
    symbolVector: 800,
    fileSummaryVector: 500,
  });
  assert.deepEqual(health.modelCoveragePermille, {
    symbol: {
      "jina-embeddings-v2-base-code": 800,
    },
    fileSummary: {
      "nomic-embed-text-v1.5": 500,
    },
  });
});
