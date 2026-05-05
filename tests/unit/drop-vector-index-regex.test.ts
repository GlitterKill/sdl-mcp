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
      ),
      true,
    );
  });

  it("matches the generic 'does not exist' phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(isAbsentIndexError("Index 'foo' does not exist."), true);
  });

  it("matches 'no such vector index' phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("Runtime error: no such vector index 'foo'"),
      true,
    );
  });

  it("matches 'no such fts index' phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("no such fts index symbol_search_text_v1"),
      true,
    );
  });

  it("matches 'no such index' (no qualifier) phrasing", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(isAbsentIndexError("no such index foo"), true);
  });

  it("is case-insensitive", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("TABLE Symbol DOESN'T HAVE AN INDEX WITH NAME foo"),
      true,
    );
  });
});

describe("isAbsentIndexError — does NOT match unrelated errors", () => {
  it("rejects the rollback-failure cascade message", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("Connection is unusable after a rollback failure"),
      false,
    );
  });

  it("rejects the LADYBUG#377 vec-column write rejection", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError(
        "Cannot set property vec on Symbol; it is used in one or more indexes",
      ),
      false,
    );
  });

  it("rejects 'cannot write to indexed column' style errors", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(
      isAbsentIndexError("Index is read-only during write transaction"),
      false,
    );
  });

  it("rejects empty error messages", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    assert.strictEqual(isAbsentIndexError(""), false);
  });

  it("rejects messages containing 'exist' but not 'does not exist'", async () => {
    const { isAbsentIndexError } =
      await import("../../dist/retrieval/index-lifecycle.js");
    // A message that mentions "exist" without the absent-form phrasing
    // must not be misread as success — that was the original concern with
    // a broader regex like "not found".
    assert.strictEqual(
      isAbsentIndexError("Table exists but the column is locked"),
      false,
    );
  });
});
