import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import {
  aggregateCoveragePermille,
  checkRetrievalHealth,
  hasExactHealthyIndex,
  resolveRequiredRetrievalIndexes,
} from "../../dist/retrieval/health.js";

const retrievalHealthDbSource = readFileSync(
  join(process.cwd(), "src/db/ladybug-retrieval-health.ts"),
  "utf8",
);

const exactIndexes = [
  {
    name: "symbol_search_text_v1",
    tableName: "Symbol",
    type: "fts" as const,
    property: "searchText",
    extensionLoaded: true,
    status: "healthy" as const,
  },
];

describe("strict retrieval health", () => {
  it("uses the shared symbol-vector table constant in coverage queries", () => {
    assert.ok(
      retrievalHealthDbSource.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"),
    );
    assert.ok(!retrievalHealthDbSource.includes("SymbolVectorEmbedding"));
  });

  it("requires an exact table, name, type, and property match", () => {
    const required = {
      name: "symbol_search_text_v1",
      tableName: "Symbol",
      type: "fts" as const,
      property: "searchText",
    };

    assert.equal(hasExactHealthyIndex(exactIndexes, required), true);
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], property: "wrongProperty" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], tableName: "FileSummary" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], type: "vector" }],
        required,
      ),
      false,
    );
    assert.equal(
      hasExactHealthyIndex(
        [{ ...exactIndexes[0], extensionLoaded: false }],
        required,
      ),
      false,
    );
  });

  it("derives only active specialized-model indexes from shared mappings", () => {
    const required = resolveRequiredRetrievalIndexes(undefined);

    assert.deepEqual(required.symbolVectors, [
      {
        model: "jina-embeddings-v2-base-code",
        tableName: "SymbolVectorEmbedding",
        name: "symbol_vec_jina_code_v2",
        type: "vector",
        property: "embeddingJinaCodeVec",
      },
    ]);
    assert.deepEqual(required.fileSummaryVectors, [
      {
        model: "nomic-embed-text-v1.5",
        tableName: "FileSummary",
        name: "filesummary_vec_nomic_embed_v15",
        type: "vector",
        property: "embeddingNomicVec",
      },
    ]);
  });

  it("converts bigint coverage counts and rounds once after aggregation", () => {
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 1n, covered: 1n, indexHealthy: true },
        { eligible: 2n, covered: 1n, indexHealthy: true },
      ]),
      667,
    );
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 1n, covered: 1n, indexHealthy: true },
        { eligible: 4n, covered: 1n, indexHealthy: true },
      ]),
      400,
    );
  });

  it("handles zero, partial, and full eligible coverage", () => {
    assert.equal(aggregateCoveragePermille([]), 1000);
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 40n, indexHealthy: true },
      ]),
      400,
    );
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 100n, indexHealthy: true },
      ]),
      1000,
    );
  });

  it("counts a missing required index as zero covered rows", () => {
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 100n, covered: 100n, indexHealthy: false },
      ]),
      0,
    );
  });

  it("keeps health errors unavailable instead of promoting extensions", async () => {
    const conn = {
      query: async () => {
        throw new Error("SHOW_INDEXES failed");
      },
    } as unknown as Connection;

    const health = await checkRetrievalHealth(conn, "repo", undefined);

    assert.equal(health.fts, false);
    assert.equal(health.fileSummaryFts, false);
    assert.equal(health.vectorNomic, false);
    assert.equal(health.vectorJinaCode, false);
    assert.deepEqual(health.coveragePermille, {
      symbolVector: 0,
      fileSummaryVector: 0,
    });
    assert.equal(health.degradationReasons?.[0]?.code, "health-check-error");
  });

  it("requires extension_loaded to be explicitly true", () => {
    const required = {
      name: "symbol_search_text_v1",
      tableName: "Symbol",
      type: "fts" as const,
      property: "searchText",
    };
    const { extensionLoaded: _extensionLoaded, ...missingExtensionState } =
      exactIndexes[0];

    assert.equal(
      hasExactHealthyIndex([missingExtensionState], required),
      false,
    );
  });

  it("uses configured Symbol FTS and vector index names", () => {
    const required = resolveRequiredRetrievalIndexes({
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
    } as never);

    assert.equal(required.symbolFts.name, "custom_symbol_fts");
    assert.equal(required.symbolFts.tableName, "Symbol");
    assert.equal(required.symbolVectors[0]?.name, "custom_symbol_jina");
    assert.equal(
      required.symbolVectors[0]?.tableName,
      "SymbolVectorEmbedding",
    );
  });

  it("retains unsupported configured models as unavailable zero-coverage lanes", () => {
    const required = resolveRequiredRetrievalIndexes({
      symbolEmbeddingModels: ["unsupported-symbol-model"],
      fileSummaryEmbeddingModels: [],
    } as never);

    assert.equal(required.symbolVectors.length, 1);
    assert.equal(required.symbolVectors[0]?.model, "unsupported-symbol-model");
    assert.equal(required.symbolVectors[0]?.name, null);
    assert.equal(required.symbolVectors[0]?.property, null);
    assert.equal(
      aggregateCoveragePermille([
        { eligible: 0, covered: 0, indexHealthy: false },
      ]),
      0,
    );
  });
});
