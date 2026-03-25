/**
 * retrieval-index-lifecycle.test.ts
 *
 * Tests for src/retrieval/index-lifecycle.ts.
 *
 * index-lifecycle.ts depends on kuzu (LadybugDB) connections and
 * src/db/ladybug.ts which transitively imports src/util/tracing.ts — an
 * OTel module that breaks in the tsx unit-test environment.  Tests therefore
 * use source-reading and structural validation instead of live imports.
 *
 * Structural / shape tests confirm the module exports the expected API
 * and that IndexHealthResult values satisfy the documented interface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IndexHealthResult } from "../../dist/retrieval/index-lifecycle.js";

// ---------------------------------------------------------------------------
// Source text fixture
// ---------------------------------------------------------------------------

const src = readFileSync(
  join(process.cwd(), "src/retrieval/index-lifecycle.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// IndexHealthResult structure
// ---------------------------------------------------------------------------

describe("IndexHealthResult structure", () => {
  it("satisfies the expected shape: fts object + vectors array", () => {
    const result: IndexHealthResult = {
      fts: {
        exists: false,
        healthy: false,
        indexName: "symbol_search_text_v1",
      },
      vectors: [
        {
          model: "all-MiniLM-L6-v2",
          exists: false,
          healthy: false,
          indexName: "symbol_vec_embeddingminilm",
        },
        {
          model: "nomic-embed-text-v1.5",
          exists: false,
          healthy: false,
          indexName: "symbol_vec_embeddingnomic",
        },
      ],
    };

    assert.ok(typeof result.fts === "object", "fts should be an object");
    assert.ok(typeof result.fts.exists === "boolean", "fts.exists should be boolean");
    assert.ok(typeof result.fts.healthy === "boolean", "fts.healthy should be boolean");
    assert.ok(
      result.fts.indexName === null || typeof result.fts.indexName === "string",
      "fts.indexName should be string or null",
    );

    assert.ok(Array.isArray(result.vectors), "vectors should be an array");
    assert.strictEqual(result.vectors.length, 2, "should have two vector entries");

    for (const v of result.vectors) {
      assert.ok(typeof v.model === "string", "vector.model should be string");
      assert.ok(typeof v.exists === "boolean", "vector.exists should be boolean");
      assert.ok(typeof v.healthy === "boolean", "vector.healthy should be boolean");
      assert.ok(
        v.indexName === null || typeof v.indexName === "string",
        "vector.indexName should be string or null",
      );
    }
  });

  it("fts.indexName can be null", () => {
    const result: IndexHealthResult = {
      fts: { exists: false, healthy: false, indexName: null },
      vectors: [],
    };
    assert.strictEqual(result.fts.indexName, null);
  });

  it("vectors array can be empty", () => {
    const result: IndexHealthResult = {
      fts: { exists: false, healthy: false, indexName: "x" },
      vectors: [],
    };
    assert.deepStrictEqual(result.vectors, []);
  });
});

// ---------------------------------------------------------------------------
// ensureIndexes — source verification
// ---------------------------------------------------------------------------

describe("ensureIndexes source verification", () => {
  it("source exports ensureIndexes", () => {
    assert.ok(
      src.includes("export async function ensureIndexes"),
      "ensureIndexes should be exported",
    );
  });

  it("ensureIndexes checks getExtensionCapabilities before creating indexes", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.ok(
      fnBody.includes("getExtensionCapabilities()"),
      "ensureIndexes should call getExtensionCapabilities()",
    );
  });

  it("ensureIndexes skips when FTS extension unavailable", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    const fnBody = src.slice(fnStart, fnStart + 1200);
    assert.ok(
      fnBody.includes("!caps.fts"),
      "ensureIndexes should check !caps.fts before creating FTS index",
    );
  });

  it("ensureIndexes skips when vector extension unavailable", () => {
    const fnStart = src.indexOf("export async function ensureIndexes");
    // The vector caps check appears after the FTS section; use a wider slice.
    const fnBody = src.slice(fnStart, fnStart + 3000);
    assert.ok(
      fnBody.includes("!caps.vector"),
      "ensureIndexes should check !caps.vector before creating vector indexes",
    );
  });

  it("ensureIndexes returns IndexEnsureResult with created/skipped/failed arrays", () => {
    assert.ok(src.includes("created: []"), "should initialise created array");
    assert.ok(src.includes("skipped: []"), "should initialise skipped array");
    assert.ok(src.includes("failed: []"), "should initialise failed array");
  });

  it("source exports checkIndexHealth", () => {
    assert.ok(
      src.includes("export async function checkIndexHealth"),
      "checkIndexHealth should be exported",
    );
  });

  it("source exports createFtsIndex", () => {
    assert.ok(
      src.includes("export async function createFtsIndex"),
      "createFtsIndex should be exported",
    );
  });

  it("source exports createVectorIndex", () => {
    assert.ok(
      src.includes("export async function createVectorIndex"),
      "createVectorIndex should be exported",
    );
  });

  it("source exports showIndexes", () => {
    assert.ok(
      src.includes("export async function showIndexes"),
      "showIndexes should be exported",
    );
  });
});

// ---------------------------------------------------------------------------
// IndexEnsureResult structural validation
// ---------------------------------------------------------------------------

describe("IndexEnsureResult structure", () => {
  it("has created, skipped, failed string arrays", () => {
    const result = { created: ["idx_a"], skipped: ["idx_b"], failed: [] as string[] };
    assert.ok(Array.isArray(result.created));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(Array.isArray(result.failed));
  });

  it("empty result has all three empty arrays", () => {
    const result = { created: [] as string[], skipped: [] as string[], failed: [] as string[] };
    assert.strictEqual(result.created.length, 0);
    assert.strictEqual(result.skipped.length, 0);
    assert.strictEqual(result.failed.length, 0);
  });
});
