import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  truncateStepResult,
  getContinuation,
  clearContinuationStore,
} from "../../dist/code-mode/workflow-truncation.js";

describe("workflow-truncation", () => {
  beforeEach(() => {
    clearContinuationStore();
  });

  it("returns result unchanged when under budget", () => {
    const data = { key: "small value" };
    const result = truncateStepResult(data, 1000);
    assert.deepEqual(result.truncated, data);
    assert.equal(result.handle, "");
    assert.equal(result.originalTokens, result.keptTokens);
  });

  it("truncates large array", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: "A relatively long description to take up some tokens",
    }));
    const result = truncateStepResult(data, 200);
    assert.ok(result.handle.startsWith("cont-"));
    assert.ok(result.originalTokens > 200);
    assert.ok(result.keptTokens <= 200);
    assert.ok(Array.isArray(result.truncated));
    assert.ok((result.truncated as unknown[]).length < 100);
  });

  it("truncates large object", () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      data[`key${i}`] = `value-${i}-${"x".repeat(100)}`;
    }
    const result = truncateStepResult(data, 200);
    assert.ok(result.handle);
    assert.ok(result.keptTokens <= result.originalTokens);
    const truncObj = result.truncated as Record<string, unknown>;
    assert.ok(Object.keys(truncObj).length < 50);
  });

  it("does not crash when object entries serialize to undefined", () => {
    const data = {
      omitted: undefined,
      callback: () => "not-json",
      symbol: Symbol("not-json"),
      content: "x".repeat(5_000),
    };

    const result = truncateStepResult(data, 25);

    assert.ok(result.handle);
    assert.ok(result.originalTokens > result.keptTokens);
  });

  it("truncates large string values", () => {
    const data = { content: "x".repeat(5000) };
    const result = truncateStepResult(data, 100);
    assert.ok(result.handle);
    const truncObj = result.truncated as Record<string, string>;
    if (truncObj.content) {
      assert.ok(
        truncObj.content.length < 5000,
        "string should be shorter than original",
      );
    }
  });

  it("returns continuation handle when truncation occurs", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const result = truncateStepResult(data, 50);
    assert.ok(result.handle.startsWith("cont-"));
    assert.ok(result.originalTokens > 50);
  });

  it("continuation can be retrieved", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const result = truncateStepResult(data, 50);
    const continuation = getContinuation(result.handle);
    assert.ok(continuation);
    assert.deepEqual(continuation.data, data);
    assert.equal(continuation.hasMore, false);
  });

  it("continuation supports offset/limit for arrays", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const result = truncateStepResult(data, 50);

    const page1 = getContinuation(result.handle, 0, 10);
    assert.ok(page1);
    assert.equal((page1.data as unknown[]).length, 10);
    assert.equal(page1.hasMore, true);

    const page2 = getContinuation(result.handle, 90, 20);
    assert.ok(page2);
    assert.equal((page2.data as unknown[]).length, 10); // only 10 left
    assert.equal(page2.hasMore, false);
  });

  it("continuation pages large non-array payloads", () => {
    const data = { content: "x".repeat(20_000), meta: { source: "test" } };
    const result = truncateStepResult(data, 50);
    const continuation = getContinuation(result.handle, 0, 100);

    assert.ok(continuation);
    const page = continuation.data as Record<string, unknown>;
    assert.equal(typeof page.content, "string");
    assert.equal((page.content as string).length, 100);
    assert.equal(page.encoding, "json");
    assert.equal(page.offset, 0);
    assert.equal(page.nextOffset, 100);
    assert.equal(continuation.hasMore, true);
    assert.ok(continuation.totalTokens < result.originalTokens);
  });

  it("continuation pages arrays selected by path", () => {
    const data = {
      results: Array.from({ length: 8 }, (_, id) => ({ id })),
      meta: { source: "test" },
    };
    const result = truncateStepResult(data, 20);
    const continuation = getContinuation(result.handle, 2, 3, "results");

    assert.ok(continuation);
    assert.deepEqual(continuation.data, [{ id: 2 }, { id: 3 }, { id: 4 }]);
    assert.equal(continuation.hasMore, true);
  });

  it("nonexistent handle returns null", () => {
    const result = getContinuation("nonexistent-handle");
    assert.equal(result, null);
  });

  it("clearContinuationStore works", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const result = truncateStepResult(data, 50);
    assert.ok(getContinuation(result.handle));
    clearContinuationStore();
    assert.equal(getContinuation(result.handle), null);
  });
});
