import assert from "node:assert/strict";
import { it } from "node:test";
import type { Connection } from "kuzu";

it("derives specialized health from repository coverage and configured physical indexes", async (t) => {
  const lifecycle = await import("../../dist/retrieval/index-lifecycle.js");
  const extensionCaps = await import("../../dist/db/extension-caps.js");
  const retrievalHealthDb = await import("../../dist/db/ladybug-retrieval-health.js");
  const ladybugDb = await import("../../dist/db/ladybug-queries.js");
  const derivedState = await import("../../dist/db/ladybug-derived-state.js");
  const { resolveSymbolVectorPhysicalIdentity } = await import("../../dist/db/ladybug-symbol-embeddings.js");
  const model = "jina-embeddings-v2-base-code";
  const config = {
    enabled: true, embeddingProfile: "specialized",
    symbolEmbeddingModels: [model], fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
    retrieval: {
      fts: { indexName: "custom_symbol_fts" },
      vector: { indexes: { [model]: { indexName: "custom_symbol_jina" } } },
    },
  } as never;
  const identity = resolveSymbolVectorPhysicalIdentity("repo", model, config);
  const indexes = [
    { name: "custom_symbol_fts", tableName: "Symbol", type: "fts", property: "searchText", extensionLoaded: true, status: "healthy" },
    { name: lifecycle.ENTITY_FTS_INDEX_NAMES.fileSummary, tableName: "FileSummary", type: "fts", property: "searchText", extensionLoaded: true, status: "healthy" },
    { name: identity.indexName, tableName: identity.tableName, type: "vector", property: identity.propertyName, extensionLoaded: true, status: "healthy" },
    { name: lifecycle.FILESUMMARY_VECTOR_INDEX_NAMES.nomic, tableName: "FileSummary", type: "vector", property: lifecycle.FILESUMMARY_EMBEDDING_PROPERTIES.nomic.property, extensionLoaded: true, status: "healthy" },
  ];
  const symbolIds = Array.from({ length: 2000 }, (_, i) => `symbol-${i}`);
  let completeCount = symbolIds.length;
  t.mock.module("../../dist/retrieval/index-lifecycle.js", {
    namedExports: { ...lifecycle, showIndexesStrict: async () => indexes },
  });
  t.mock.module("../../dist/db/extension-caps.js", {
    namedExports: { ...extensionCaps, getExtensionCapabilities: () => ({ fts: true, vector: true }) },
  });
  t.mock.module("../../dist/db/ladybug-queries.js", {
    namedExports: { ...ladybugDb, getLatestVersion: async () => ({ repoId: "repo", versionId: "v1" }) },
  });
  t.mock.module("../../dist/db/ladybug-derived-state.js", {
    namedExports: { ...derivedState, getDerivedStateFromConnection: async () => ({ embeddingLifecycleState: "steady" }) },
  });
  t.mock.module("../../dist/db/ladybug-retrieval-health.js", {
    namedExports: {
      ...retrievalHealthDb,
      validateRepoSymbolVectorOwnership: async () => {},
      countCompleteRepoSymbolVectors: async () => completeCount,
      getEligibleRepoSymbolIds: async () => symbolIds,
      getRepoSymbolVectorHealthRows: async () => ({
        tableState: "present",
        rows: symbolIds.slice(0, completeCount).map((symbolId) => ({
          repoId: "repo", model, symbolId, embeddingId: `${model}:${symbolId}`,
          embeddingVectorPresent: true, cardHashPresent: true,
          embeddingJinaCodeVecPresent: true, embeddingNomicVecPresent: false,
        })),
      }),
      getFileSummaryRetrievalCoverage: async () => ({ eligible: 4n, covered: 2n }),
    },
  });
  const { checkRetrievalHealth, invalidateSymbolRetrievalCoverageCache, getRepositorySymbolVectorHealthSnapshot } =
    await import("../../dist/retrieval/health.js?specialized-health");
  const check = () => checkRetrievalHealth({} as Connection, "repo", config);
  const health = await check();
  assert.equal(health.fts, true);
  assert.equal(health.fileSummaryFts, true);
  assert.equal(health.vectorJinaCode, true);
  assert.equal(health.vectorNomic, false);
  assert.deepEqual(health.vectorByEntityModel, {
    symbol: { [model]: true }, fileSummary: { "nomic-embed-text-v1.5": true },
  });
  assert.deepEqual(health.coveragePermille, { symbolVector: 1000, fileSummaryVector: 500 });
  assert.deepEqual(health.modelCoveragePermille, {
    symbol: { [model]: 1000 }, fileSummary: { "nomic-embed-text-v1.5": 500 },
  });

  // A healthy catalog index cannot make incomplete repository vectors queryable.
  completeCount = 1600;
  invalidateSymbolRetrievalCoverageCache("repo");
  const partial = await check();
  assert.equal(partial.vectorJinaCode, false);
  assert.equal(partial.coveragePermille.symbolVector, 0);
  assert.equal(partial.modelCoveragePermille.symbol[model], 0);
  assert.equal(getRepositorySymbolVectorHealthSnapshot("repo", model)?.completeVectorCount, 1600);
});
