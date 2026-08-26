import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LADYBUG_SCHEMA_VERSION } from "../../dist/db/ladybug-schema.js";

const modulePath = "../../dist/benchmark/context-quality-cache.js";
const source = readFileSync(
  join(process.cwd(), "src/benchmark/context-quality-cache.ts"),
  "utf8",
);

function exactSnapshot() {
  return {
    repos: [{ repoId: "fixture", rootPath: "C:/fixtures/repo" }],
    ladybugSchemaVersion: LADYBUG_SCHEMA_VERSION,
    activeEmbeddingModels: {
      symbol: ["jina-embeddings-v2-base-code"],
      fileSummary: ["nomic-embed-text-v1.5"],
    },
    graphVersionId: "v1",
    derivedState: {
      clustersDirty: false,
      processesDirty: false,
      algorithmsDirty: false,
      summariesDirty: false,
      embeddingsDirty: false,
      targetVersionId: "v1",
      computedVersionId: "v1",
      graphIntegrityState: "verified",
      graphIntegrityVersionId: "v1",
      graphIntegrityDigest: "a".repeat(64),
      graphIntegrityRevision: 4,
      graphIntegrityVerifiedRevision: 4,
    },
    indexes: {
      symbolFts: {
        tableName: "Symbol",
        name: "symbol_search_text_v1",
        type: "fts",
        property: "searchText",
        healthy: true,
      },
      fileSummaryFts: {
        tableName: "FileSummary",
        name: "file_summary_search_text_v1",
        type: "fts",
        property: "searchText",
        healthy: true,
      },
      symbolVectors: [
        {
          model: "jina-embeddings-v2-base-code",
          tableName: "SymbolVectorEmbedding",
          name: "symbol_embedding_jina_code_vec_v1",
          type: "vector",
          property: "embeddingJinaCodeVec",
          healthy: true,
          eligible: 12,
          covered: 12,
        },
      ],
      fileSummaryVectors: [
        {
          model: "nomic-embed-text-v1.5",
          tableName: "FileSummary",
          name: "filesummary_embedding_nomic_vec_v1",
          type: "vector",
          property: "embeddingNomicVec",
          healthy: true,
          eligible: 4,
          covered: 4,
        },
      ],
    },
  };
}

const expectation = {
  repoId: "fixture",
  repoRoot: "C:/fixtures/repo",
  repoSha: "b".repeat(40),
  configDigest: "c".repeat(64),
  ladybugSchemaVersion: LADYBUG_SCHEMA_VERSION,
  symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
  fileSummaryEmbeddingModels: ["nomic-embed-text-v1.5"],
};

describe("context-quality database cache identity", () => {
  it("routes SymbolVectorEmbedding coverage through symbol coverage", () => {
    assert.ok(source.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"));
    assert.ok(!source.includes('"SymbolVectorEmbedding"'));
  });

  it("accepts only the exact closed-graph provenance snapshot", async () => {
    const cacheModule = await import(modulePath).catch(() => ({}));
    const validate = Reflect.get(
      cacheModule,
      "validateContextQualityCacheSnapshot",
    );
    assert.equal(typeof validate, "function");
    if (typeof validate !== "function") return;

    const result = validate(exactSnapshot(), expectation);

    assert.equal(result.repoId, "fixture");
    assert.equal(result.repoSha, "b".repeat(40));
    assert.equal(result.configDigest, "c".repeat(64));
    assert.equal(result.graphIntegrityState, "verified");
    assert.deepEqual(result.activeEmbeddingModels, {
      symbol: ["jina-embeddings-v2-base-code"],
      fileSummary: ["nomic-embed-text-v1.5"],
    });
  });

  it("rejects stale ownership, integrity, index, and coverage identity", async () => {
    const cacheModule = await import(modulePath).catch(() => ({}));
    const validate = Reflect.get(
      cacheModule,
      "validateContextQualityCacheSnapshot",
    );
    assert.equal(typeof validate, "function");
    if (typeof validate !== "function") return;

    const corruptions: Array<[string, (snapshot: ReturnType<typeof exactSnapshot>) => void]> =
      [
        [
          "sole repo ownership",
          (snapshot) => {
            snapshot.repos.push({
              repoId: "other",
              rootPath: "C:/fixtures/other",
            });
          },
        ],
        [
          "exact repo root",
          (snapshot) => {
            snapshot.repos[0]!.rootPath = "C:/fixtures/moved";
          },
        ],
        [
          "schema version",
          (snapshot) => {
            snapshot.ladybugSchemaVersion = 2;
          },
        ],
        [
          "verified graph",
          (snapshot) => {
            snapshot.derivedState.graphIntegrityState = "failed";
          },
        ],
        [
          "graph version",
          (snapshot) => {
            snapshot.derivedState.graphIntegrityVersionId = "v0";
          },
        ],
        [
          "graph digest",
          (snapshot) => {
            snapshot.derivedState.graphIntegrityDigest = "not-a-digest";
          },
        ],
        [
          "clean derived state",
          (snapshot) => {
            snapshot.derivedState.embeddingsDirty = true;
          },
        ],
        [
          "active model plan",
          (snapshot) => {
            snapshot.activeEmbeddingModels.symbol = [];
          },
        ],
        [
          "healthy exact index",
          (snapshot) => {
            snapshot.indexes.symbolVectors[0]!.healthy = false;
          },
        ],
        [
          "nonempty eligible corpus",
          (snapshot) => {
            snapshot.indexes.fileSummaryVectors[0]!.eligible = 0;
            snapshot.indexes.fileSummaryVectors[0]!.covered = 0;
          },
        ],
        [
          "complete model coverage",
          (snapshot) => {
            snapshot.indexes.symbolVectors[0]!.covered = 11;
          },
        ],
      ];

    for (const [label, corrupt] of corruptions) {
      const snapshot = exactSnapshot();
      corrupt(snapshot);
      assert.throws(
        () => validate(snapshot, expectation),
        undefined,
        label,
      );
    }
  });
});
