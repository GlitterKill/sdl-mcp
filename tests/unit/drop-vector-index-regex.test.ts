import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for `isAbsentIndexError` in retrieval/index-lifecycle.ts.
 *
 * The regex distinguishes LadybugDB's "this index doesn't exist on this
 * table" binder errors (which `dropVectorIndex` should treat as success
 * semantics — there's nothing to drop) from real failures that must
 * propagate to a warn + false return.
 *
 * Earlier the regex only matched `does not exist`, which missed the
 * actual phrasing fresh databases produce ("Table X doesn't have an
 * index with name Y") and stranded fresh-DB embedding refreshes on the
 * slow per-row HNSW maintenance path.
 */

describe("isAbsentIndexError — recognises absent-index phrasings", () => {
  it("matches LadybugDB's binder phrasing (fresh DB)", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Binder exception: Table Symbol doesn't have an index with name symbol_vec_jina_code_v2.",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });

  it("rejects generic does-not-exist messages that do not name the vector index", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Index 'foo' does not exist.",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("matches named vector index does-not-exist phrasings", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Vector index 'symbol_vec_jina_code_v2' does not exist.",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });

  it("matches 'no such vector index' phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Runtime error: no such vector index 'symbol_vec_jina_code_v2'",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });

  it("rejects FTS index absence in the vector matcher", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "no such fts index symbol_search_text_v1",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("matches 'no such index' (no qualifier) phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "no such index symbol_vec_jina_code_v2",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });

  it("is case-insensitive", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "TABLE Symbol DOESN'T HAVE AN INDEX WITH NAME symbol_vec_jina_code_v2",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      true,
    );
  });
});

describe("isAbsentIndexError — does NOT match unrelated errors", () => {
  it("rejects the rollback-failure cascade message", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Connection is unusable after a rollback failure",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("rejects the LADYBUG#377 vec-column write rejection", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Cannot set property vec on Symbol; it is used in one or more indexes",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("rejects 'cannot write to indexed column' style errors", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Index is read-only during write transaction",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });

  it("rejects empty error messages", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("", "Symbol", "symbol_vec_jina_code_v2"),
      false,
    );
  });

  it("rejects messages containing 'exist' but not 'does not exist'", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    // A message that mentions "exist" without the absent-form phrasing
    // must not be misread as success — that was the original concern with
    // a broader regex like "not found".
    assert.strictEqual(
      isAbsentIndexError(
        "Table exists but the column is locked",
        "Symbol",
        "symbol_vec_jina_code_v2",
      ),
      false,
    );
  });
});

describe("dropVectorIndexWithDependencies", () => {
  it("treats absent DROP_VECTOR_INDEX procedure as absent only when strict catalog has no table index", async () => {
    const { dropVectorIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropVectorIndexWithDependencies(
      {} as never,
      "Symbol",
      "symbol_vec_jina_code_v2",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: Procedure DROP_VECTOR_INDEX does not exist.",
          );
        },
        showIndexes: async () => [],
      },
    );

    assert.deepEqual(result, { status: "absent" });
  });

  it("fails closed when DROP_VECTOR_INDEX is missing and SHOW_INDEXES cannot confirm absence", async () => {
    const { dropVectorIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropVectorIndexWithDependencies(
      {} as never,
      "Symbol",
      "symbol_vec_jina_code_v2",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: function DROP_VECTOR_INDEX is not defined.",
          );
        },
        showIndexes: async () => {
          throw new Error("Catalog exception: SHOW_INDEXES is not available.");
        },
      },
    );

    assert.equal(result.status, "failed");
  });

  it("does not hide missing DROP_VECTOR_INDEX when the table index is still present", async () => {
    const { dropVectorIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropVectorIndexWithDependencies(
      {} as never,
      "Symbol",
      "symbol_vec_jina_code_v2",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: function DROP_VECTOR_INDEX is not defined.",
          );
        },
        showIndexes: async () => [
          {
            name: "symbol_vec_jina_code_v2",
            type: "vector",
            property: "embeddingJinaCodeVec",
            tableName: "Symbol",
            status: "healthy",
          },
        ],
      },
    );

    assert.equal(result.status, "failed");
  });

  it("uses strict SHOW_INDEXES for production vector drop confirmation", async () => {
    const source = await import("../../dist/retrieval/index-lifecycle.js");
    assert.match(source.dropVectorIndex.toString(), /showIndexesStrict/);
  });
});

describe("isAbsentFtsIndexError — recognises only named FTS index absence", () => {
  it("matches the named Cluster FTS catalog-miss phrasing", async () => {
    const { isAbsentFtsIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentFtsIndexError(
        "Binder exception: Table Cluster doesn't have an index with name cluster_search_text_v1.",
        "Cluster",
        "cluster_search_text_v1",
      ),
      true,
    );
  });

  it("matches a named FTS index does-not-exist phrasing", async () => {
    const { isAbsentFtsIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentFtsIndexError(
        "FTS index 'cluster_search_text_v1' does not exist.",
        "Cluster",
        "cluster_search_text_v1",
      ),
      true,
    );
  });

  it("rejects missing DROP_FTS_INDEX procedure messages", async () => {
    const { isAbsentFtsIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentFtsIndexError(
        "Catalog exception: Procedure DROP_FTS_INDEX does not exist.",
        "Cluster",
        "cluster_search_text_v1",
      ),
      false,
    );
  });

  it("rejects absence for a different FTS index name", async () => {
    const { isAbsentFtsIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentFtsIndexError(
        "no such fts index process_search_text_v1",
        "Cluster",
        "cluster_search_text_v1",
      ),
      false,
    );
  });

  it("treats absent DROP_FTS_INDEX procedure as absent only when catalog has no table index", async () => {
    const { dropFtsIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropFtsIndexWithDependencies(
      {} as never,
      "Cluster",
      "cluster_search_text_v1",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: Procedure DROP_FTS_INDEX does not exist.",
          );
        },
        showIndexes: async () => [],
      },
    );

    assert.deepEqual(result, { status: "absent" });
  });

  it("does not hide missing DROP_FTS_INDEX when the table index is still present", async () => {
    const { dropFtsIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropFtsIndexWithDependencies(
      {} as never,
      "Cluster",
      "cluster_search_text_v1",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: Procedure DROP_FTS_INDEX does not exist.",
          );
        },
        showIndexes: async () => [
          {
            name: "cluster_search_text_v1",
            type: "fts",
            property: "searchText",
            tableName: "Cluster",
            status: "healthy",
          },
        ],
      },
    );

    assert.equal(result.status, "failed");
  });

  it("treats missing DROP_FTS_INDEX function as absent only after catalog confirmation", async () => {
    const { dropFtsIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropFtsIndexWithDependencies(
      {} as never,
      "Cluster",
      "cluster_search_text_v1",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: function DROP_FTS_INDEX is not defined.",
          );
        },
        showIndexes: async () => [],
      },
    );

    assert.deepEqual(result, { status: "absent" });
  });

  it("does not hide missing DROP_FTS_INDEX function when the table index is still present", async () => {
    const { dropFtsIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropFtsIndexWithDependencies(
      {} as never,
      "Cluster",
      "cluster_search_text_v1",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: function DROP_FTS_INDEX is not defined.",
          );
        },
        showIndexes: async () => [
          {
            name: "cluster_search_text_v1",
            type: "fts",
            property: "searchText",
            tableName: "Cluster",
            status: "healthy",
          },
        ],
      },
    );

    assert.equal(result.status, "failed");
  });

  it("fails closed when DROP_FTS_INDEX is missing and SHOW_INDEXES cannot confirm absence", async () => {
    const { dropFtsIndexWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    const result = await dropFtsIndexWithDependencies(
      {} as never,
      "Cluster",
      "cluster_search_text_v1",
      {
        execStoredProc: async () => {
          throw new Error(
            "Catalog exception: function DROP_FTS_INDEX is not defined.",
          );
        },
        showIndexes: async () => {
          throw new Error("Catalog exception: SHOW_INDEXES is not available.");
        },
      },
    );

    assert.equal(result.status, "failed");
  });

  it("uses strict SHOW_INDEXES for production FTS drop confirmation", async () => {
    const source = await import("../../dist/retrieval/index-lifecycle.js");
    assert.match(source.dropFtsIndex.toString(), /showIndexesStrict/);
  });

  it("distinguishes same-name FTS indexes by table", async () => {
    const { indexExistsForTable } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    assert.equal(
      indexExistsForTable(
        [
          {
            name: "shared_search_text_v1",
            type: "fts",
            property: "searchText",
            tableName: "Memory",
            status: "healthy",
          },
        ],
        "Cluster",
        "shared_search_text_v1",
        "fts",
      ),
      false,
    );
  });

  it("does not treat missing SHOW_INDEXES table metadata as table confirmation", async () => {
    const { indexExistsForTable } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    assert.equal(
      indexExistsForTable(
        [
          {
            name: "shared_search_text_v1",
            type: "fts",
            property: "searchText",
            status: "unknown",
          },
        ],
        "Cluster",
        "shared_search_text_v1",
        "fts",
      ),
      false,
    );
  });
});

describe("ensureFtsIndexForNonEmptyTableWithDependencies", () => {
  it("skips creation when the table is empty", async () => {
    const { ensureFtsIndexForNonEmptyTableWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    let createCalls = 0;
    const result = await ensureFtsIndexForNonEmptyTableWithDependencies(
      {} as never,
      "Symbol",
      "symbol_search_text_v1",
      {
        showIndexes: async () => [],
        countRowsInTable: async () => 0,
        createFtsIndex: async () => {
          createCalls += 1;
          return true;
        },
      },
    );

    assert.deepEqual(result, { status: "empty" });
    assert.equal(createCalls, 0);
  });

  it("creates FTS only for non-empty tables without an existing table index", async () => {
    const { ensureFtsIndexForNonEmptyTableWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    let createCalls = 0;
    const result = await ensureFtsIndexForNonEmptyTableWithDependencies(
      {} as never,
      "Symbol",
      "symbol_search_text_v1",
      {
        showIndexes: async () => [],
        countRowsInTable: async () => 3,
        createFtsIndex: async () => {
          createCalls += 1;
          return true;
        },
      },
    );

    assert.deepEqual(result, { status: "created" });
    assert.equal(createCalls, 1);
  });

  it("does not create FTS when the table-aware index already exists", async () => {
    const { ensureFtsIndexForNonEmptyTableWithDependencies } = await import(
      "../../dist/retrieval/index-lifecycle.js"
    );
    let countCalls = 0;
    let createCalls = 0;
    const result = await ensureFtsIndexForNonEmptyTableWithDependencies(
      {} as never,
      "Symbol",
      "symbol_search_text_v1",
      {
        showIndexes: async () => [
          {
            name: "symbol_search_text_v1",
            type: "fts",
            property: "searchText",
            tableName: "Symbol",
            status: "healthy",
          },
        ],
        countRowsInTable: async () => {
          countCalls += 1;
          return 3;
        },
        createFtsIndex: async () => {
          createCalls += 1;
          return true;
        },
      },
    );

    assert.deepEqual(result, { status: "exists" });
    assert.equal(countCalls, 0);
    assert.equal(createCalls, 0);
  });
});
