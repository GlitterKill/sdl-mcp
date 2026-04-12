import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureLocalEmbeddingRuntime,
  resetLocalEmbeddingRuntime,
} from "../../dist/indexer/embeddings-local.js";
import { getEmbeddingProvider } from "../../dist/indexer/embeddings.js";

test("ensureLocalEmbeddingRuntime returns availability status", async () => {
  resetLocalEmbeddingRuntime();
  const runtime = await ensureLocalEmbeddingRuntime();
  assert.strictEqual(typeof runtime.available, "boolean");
  if (!runtime.available) {
    assert.ok(runtime.reason, "unavailable runtime should include reason");
    assert.strictEqual(typeof runtime.reason, "string");
  }
});

test("ensureLocalEmbeddingRuntime caches result on second call", async () => {
  resetLocalEmbeddingRuntime();
  const first = await ensureLocalEmbeddingRuntime();
  const second = await ensureLocalEmbeddingRuntime();
  // Should be the exact same object (cached)
  assert.strictEqual(first, second);
});

test("resetLocalEmbeddingRuntime clears cached state", async () => {
  const first = await ensureLocalEmbeddingRuntime();
  resetLocalEmbeddingRuntime();
  const second = await ensureLocalEmbeddingRuntime();
  // After reset, should re-detect (may be a different object)
  assert.strictEqual(first.available, second.available);
});

test("getEmbeddingProvider returns mock provider", async () => {
  const provider = getEmbeddingProvider("mock");
  assert.strictEqual(typeof provider.embed, "function");
  assert.strictEqual(typeof provider.getDimension, "function");
  assert.strictEqual(provider.getDimension(), 64);
});

test("mock provider produces deterministic embeddings", async () => {
  const provider = getEmbeddingProvider("mock");
  const result1 = await provider.embed(["hello world"]);
  const result2 = await provider.embed(["hello world"]);
  assert.deepStrictEqual(result1, result2);
});

test("mock provider returns correct dimension vectors", async () => {
  const provider = getEmbeddingProvider("mock");
  const result = await provider.embed(["test function"]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].length, 64);
});

test("mock provider handles empty text", async () => {
  const provider = getEmbeddingProvider("mock");
  const result = await provider.embed([""]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].length, 64);
});

test("mock provider handles multiple texts", async () => {
  const provider = getEmbeddingProvider("mock");
  const result = await provider.embed(["hello", "world", "test"]);
  assert.strictEqual(result.length, 3);
  for (const vec of result) {
    assert.strictEqual(vec.length, 64);
  }
});

test("mock provider vectors are normalized (unit length)", async () => {
  const provider = getEmbeddingProvider("mock");
  const result = await provider.embed(["test function"]);
  const vec = result[0];
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
  assert.ok(
    Math.abs(norm - 1.0) < 0.01,
    `Expected unit vector (norm=1), got norm=${norm}`,
  );
});

test("different texts produce different embeddings", async () => {
  const provider = getEmbeddingProvider("mock");
  const [vec1] = await provider.embed(["alpha"]);
  const [vec2] = await provider.embed(["beta"]);
  // At least one dimension should differ
  const allSame = vec1.every((val, i) => Math.abs(val - vec2[i]) < 1e-9);
  assert.strictEqual(
    allSame,
    false,
    "Different texts should produce different vectors",
  );
});

test("getEmbeddingProvider local provider returns correct model dimension", () => {
  const provider = getEmbeddingProvider("local", "jina-embeddings-v2-base-code");
  // getDimension should return model dimension from registry (768) or fallback mock (64)
  const dim = provider.getDimension();
  assert.ok(
    dim === 768 || dim === 64,
    `Expected 768 or 64 (fallback), got ${dim}`,
  );
});

test("getEmbeddingProvider api provider works", async () => {
  const provider = getEmbeddingProvider("api");
  assert.strictEqual(provider.getDimension(), 64);
  const result = await provider.embed(["test"]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].length, 64);
});

test("local provider embeds or falls back gracefully", async () => {
  const provider = getEmbeddingProvider("local", "jina-embeddings-v2-base-code");
  // If ONNX runtime is available, returns 384-dim vectors
  // If not, falls back to 64-dim mock vectors — either way, should not throw
  const result = await provider.embed(["test embedding"]);
  assert.strictEqual(result.length, 1);
  assert.ok(
    result[0].length === 384 || result[0].length === 64,
    `Expected 384 (real) or 64 (mock fallback), got ${result[0].length}`,
  );
});
