import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { Connection } from "kuzu";

import {
  SYMBOL_HNSW_MIN_ROWS,
  aggregateCoveragePermille,
  checkRetrievalHealth,
  evaluateRepositorySymbolVectorHealth,
  hasExactHealthyIndex,
  resolveRequiredRetrievalIndexes,
} from "../../dist/retrieval/health.js";
import { resolveSymbolVectorPhysicalIdentity } from "../../dist/db/ladybug-symbol-embeddings.js";

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
  it("uses the repository vector table in coverage queries", () => {
    assert.ok(
      retrievalHealthDbSource.includes("inspectRepoSymbolVectorTable"),
    );
    assert.ok(retrievalHealthDbSource.includes("inspection.tableName"));
    assert.ok(retrievalHealthDbSource.includes("e.repoId = $repoId"));
    assert.ok(
      !retrievalHealthDbSource.includes("SYMBOL_VECTOR_EMBEDDING_TABLE"),
    );
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

  it("derives repository-scoped specialized-model indexes from shared mappings", () => {
    const identity = resolveSymbolVectorPhysicalIdentity(
      "repo",
      "jina-embeddings-v2-base-code",
    );
    const required = resolveRequiredRetrievalIndexes(undefined, "repo");

    assert.deepEqual(required.symbolVectors, [
      {
        model: "jina-embeddings-v2-base-code",
        tableName: identity.tableName,
        name: identity.indexName,
        type: "vector",
        property: identity.propertyName,
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

  it("uses configured Symbol FTS and repository vector index names", () => {
    const semanticConfig = {
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
    } as never;
    const identity = resolveSymbolVectorPhysicalIdentity(
      "repo",
      "jina-embeddings-v2-base-code",
      semanticConfig,
    );
    const required = resolveRequiredRetrievalIndexes(semanticConfig, "repo");

    assert.equal(required.symbolFts.name, "custom_symbol_fts");
    assert.equal(required.symbolFts.tableName, "Symbol");
    assert.equal(required.symbolVectors[0]?.name, identity.indexName);
    assert.equal(required.symbolVectors[0]?.tableName, identity.tableName);
  });

  it("retains unsupported configured models as unavailable zero-coverage lanes", () => {
    const required = resolveRequiredRetrievalIndexes(
      {
        symbolEmbeddingModels: ["unsupported-symbol-model"],
        fileSummaryEmbeddingModels: [],
      } as never,
      "repo",
    );

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


const JINA_MODEL = "jina-embeddings-v2-base-code";
const NOMIC_MODEL = "nomic-embed-text-v1.5";
const ONE_MODEL_CONFIG = {
  enabled: true,
  symbolEmbeddingModels: [JINA_MODEL],
  fileSummaryEmbeddingModels: [],
} as never;

type HealthInput = Parameters<typeof evaluateRepositorySymbolVectorHealth>[0];

function eligibleIds(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `s${index}`);
}

function completeRow(
  symbolId: string,
  model = JINA_MODEL,
): HealthInput["vectorRows"][number] {
  return {
    embeddingId: `${model}:${symbolId}`,
    repoId: "repo",
    symbolId,
    model,
    embeddingVectorPresent: true,
    cardHashPresent: true,
    embeddingJinaCodeVecPresent: model === JINA_MODEL,
    embeddingNomicVecPresent: model === NOMIC_MODEL,
  };
}

function expectedVectorIndex(model = JINA_MODEL) {
  const identity = resolveSymbolVectorPhysicalIdentity("repo", model);
  return {
    name: identity.indexName,
    tableName: identity.tableName,
    type: "vector" as const,
    property: identity.propertyName,
    extensionLoaded: true,
    status: "healthy" as const,
  };
}

function healthInput(
  count: number,
  overrides: Partial<HealthInput> = {},
): HealthInput {
  const ids = eligibleIds(count);
  return {
    repoId: "repo",
    versionId: "v1",
    generation: 1,
    lifecycleState: "steady",
    semanticConfig: ONE_MODEL_CONFIG,
    tableState: count === 0 ? "absent" : "present",
    eligibleSymbolIds: ids,
    vectorRows: ids.map((id) => completeRow(id)),
    indexes:
      count >= SYMBOL_HNSW_MIN_ROWS ? [expectedVectorIndex()] : [],
    ...overrides,
  };
}

describe("repository Symbol vector health snapshots", () => {
  it("uses the single 2,000-row threshold at 0, 1, 1,999, 2,000, and 2,001", () => {
    assert.equal(SYMBOL_HNSW_MIN_ROWS, 2_000);
    for (const [count, mode] of [
      [0, "none"],
      [1, "exact"],
      [1_999, "exact"],
      [2_000, "hnsw"],
      [2_001, "hnsw"],
    ] as const) {
      const [snapshot] = evaluateRepositorySymbolVectorHealth(
        healthInput(count),
      );
      assert.equal(snapshot?.eligibleSymbolCount, count);
      assert.equal(snapshot?.completeVectorCount, count);
      assert.equal(snapshot?.mode, mode, `count ${count}`);
    }
  });

  it("publishes no model snapshots when semantics are disabled", () => {
    assert.deepEqual(
      evaluateRepositorySymbolVectorHealth(
        healthInput(1, {
          semanticConfig: { ...ONE_MODEL_CONFIG, enabled: false } as never,
        }),
      ),
      [],
    );
  });

  it("fails closed when eligible symbols have no repository table", () => {
    const [snapshot] = evaluateRepositorySymbolVectorHealth(
      healthInput(1, { tableState: "absent", vectorRows: [] }),
    );
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, false);
  });

  it("rejects incomplete, foreign, wrong-model, mismatched, duplicate, and orphan rows", () => {
    const base = completeRow("s0");
    const corruptions: Array<[string, HealthInput["vectorRows"], string[]]> = [
      [
        "incomplete",
        [{ ...base, embeddingVectorPresent: false }],
        ["s0"],
      ],
      ["foreign", [{ ...base, repoId: "other" }], ["s0"]],
      [
        "wrong model carrying mapped property",
        [{ ...base, model: NOMIC_MODEL }],
        ["s0"],
      ],
      [
        "embedding identity mismatch",
        [{ ...base, embeddingId: `${JINA_MODEL}:other` }],
        ["s0"],
      ],
      ["duplicate", [base, { ...base }], ["s0"]],
      ["orphan", [base, completeRow("orphan")], ["s0"]],
      [
        "balanced missing and orphan",
        [base, completeRow("orphan")],
        ["s0", "missing"],
      ],
    ];

    for (const [label, vectorRows, eligibleSymbolIds] of corruptions) {
      const [snapshot] = evaluateRepositorySymbolVectorHealth(
        healthInput(eligibleSymbolIds.length, {
          eligibleSymbolIds,
          vectorRows,
        }),
      );
      assert.equal(snapshot?.mode, "degraded", label);
      assert.equal(snapshot?.exactFallbackAllowed, false, label);
    }
  });

  it("requires exactly one healthy full catalog tuple for HNSW", () => {
    const expected = expectedVectorIndex();
    const cases: Array<[string, HealthInput["indexes"]]> = [
      ["missing", []],
      ["wrong table", [{ ...expected, tableName: "Symbol" }]],
      ["wrong type", [{ ...expected, type: "fts" }]],
      ["wrong property", [{ ...expected, property: "wrong" }]],
      ["unhealthy", [{ ...expected, status: "unknown" }]],
      [
        "extension not positively loaded",
        [{ ...expected, extensionLoaded: undefined }],
      ],
      [
        "different name on same table and property",
        [{ ...expected, name: "other_index" }],
      ],
      ["duplicate exact name", [expected, { ...expected }]],
    ];

    const [healthy] = evaluateRepositorySymbolVectorHealth(
      healthInput(2_000),
    );
    assert.equal(healthy?.mode, "hnsw");
    assert.deepEqual(healthy?.observedIndexIdentity, expected);

    for (const [label, indexes] of cases) {
      const [snapshot] = evaluateRepositorySymbolVectorHealth(
        healthInput(2_000, { indexes }),
      );
      assert.equal(snapshot?.mode, "degraded", label);
      assert.equal(snapshot?.exactFallbackAllowed, true, label);
    }
  });

  it("treats a same-name foreign tuple as relevant even below the threshold", () => {
    const [snapshot] = evaluateRepositorySymbolVectorHealth(
      healthInput(1, {
        indexes: [{ ...expectedVectorIndex(), tableName: "Symbol" }],
      }),
    );
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, true);
  });

  it("allows guarded exact only after durable refreshing-state assessment", () => {
    const [snapshot] = evaluateRepositorySymbolVectorHealth(
      healthInput(1, { lifecycleState: "refreshing" }),
    );
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, true);

    const [deleting] = evaluateRepositorySymbolVectorHealth(
      healthInput(1, { lifecycleState: "deleting" }),
    );
    assert.equal(deleting?.mode, "degraded");
    assert.equal(deleting?.exactFallbackAllowed, false);
  });

  it("fails closed for a configured never-indexed version with eligible symbols", () => {
    const [snapshot] = evaluateRepositorySymbolVectorHealth(
      healthInput(1, { versionId: null }),
    );
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, false);
  });

  it("derives repository-scoped Symbol vector identities without widening fixed FTS identities", () => {
    const required = resolveRequiredRetrievalIndexes(
      ONE_MODEL_CONFIG,
      "repo",
    );
    const identity = resolveSymbolVectorPhysicalIdentity("repo", JINA_MODEL);
    assert.equal(required.symbolFts.tableName, "Symbol");
    assert.equal(required.fileSummaryFts.tableName, "FileSummary");
    assert.equal(required.symbolVectors[0]?.tableName, identity.tableName);
    assert.equal(required.symbolVectors[0]?.name, identity.indexName);
  });

  it("rejects an empty repository identity", () => {
    assert.throws(
      () => resolveRequiredRetrievalIndexes(ONE_MODEL_CONFIG, ""),
      /repository ID must not be empty/,
    );
  });

  it("fails closed for zero eligible symbols with a foreign metadata-only row", () => {
    const [snapshot] = evaluateRepositorySymbolVectorHealth(
      healthInput(0, {
        tableState: "present",
        vectorRows: [
          {
            ...completeRow("orphan"),
            repoId: "foreign",
            embeddingVectorPresent: false,
            cardHashPresent: false,
            embeddingJinaCodeVecPresent: false,
          },
        ],
      }),
    );
    assert.equal(snapshot?.mode, "degraded");
    assert.equal(snapshot?.exactFallbackAllowed, false);
  });
});
