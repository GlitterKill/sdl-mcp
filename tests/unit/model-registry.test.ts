import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getModelInfo,
  listModels,
  isKnownModel,
  resolveModelPath,
  resolveTokenizerPath,
  resolveModelDir,
  isModelAvailable,
} from "../../dist/indexer/model-registry.js";

test("getModelInfo returns MiniLM metadata", () => {
  const info = getModelInfo("all-MiniLM-L6-v2");
  assert.strictEqual(info.name, "all-MiniLM-L6-v2");
  assert.strictEqual(info.dimension, 384);
  assert.strictEqual(info.maxSequenceLength, 256);
  assert.strictEqual(info.bundled, true);
  assert.strictEqual(info.modelFile, "model_quantized.onnx");
  assert.strictEqual(info.tokenizerFile, "tokenizer.json");
});

test("getModelInfo returns nomic metadata", () => {
  const info = getModelInfo("nomic-embed-text-v1.5");
  assert.strictEqual(info.name, "nomic-embed-text-v1.5");
  assert.strictEqual(info.dimension, 768);
  assert.strictEqual(info.maxSequenceLength, 8192);
  assert.strictEqual(info.bundled, false);
  assert.ok(info.downloadUrls, "nomic should have downloadUrls");
  assert.ok(
    info.downloadUrls.model.includes("huggingface.co"),
    "download URL should point to HuggingFace",
  );
});

test("getModelInfo throws for unknown model", () => {
  assert.throws(
    () => getModelInfo("nonexistent-model"),
    (err: Error) => {
      assert.ok(err.message.includes("Unknown embedding model"));
      assert.ok(err.message.includes("nonexistent-model"));
      return true;
    },
  );
});

test("listModels returns all registered models", () => {
  const models = listModels();
  assert.ok(models.includes("all-MiniLM-L6-v2"));
  assert.ok(models.includes("nomic-embed-text-v1.5"));
  assert.ok(models.includes("jina-embeddings-v2-base-code"));
  assert.strictEqual(models.length, 3);
});

test("isKnownModel returns true for registered models", () => {
  assert.strictEqual(isKnownModel("all-MiniLM-L6-v2"), true);
  assert.strictEqual(isKnownModel("nomic-embed-text-v1.5"), true);
});

test("isKnownModel returns false for unknown models", () => {
  assert.strictEqual(isKnownModel("gpt-4"), false);
  assert.strictEqual(isKnownModel(""), false);
});

test("resolveModelPath returns path ending with model file", () => {
  const path = resolveModelPath("all-MiniLM-L6-v2");
  assert.ok(
    path.endsWith("model_quantized.onnx"),
    `Path should end with ONNX file: ${path}`,
  );
  assert.ok(
    path.includes("all-MiniLM-L6-v2"),
    `Path should contain model name: ${path}`,
  );
});

test("resolveTokenizerPath returns path ending with tokenizer file", () => {
  const path = resolveTokenizerPath("all-MiniLM-L6-v2");
  assert.ok(
    path.endsWith("tokenizer.json"),
    `Path should end with tokenizer.json: ${path}`,
  );
  assert.ok(
    path.includes("all-MiniLM-L6-v2"),
    `Path should contain model name: ${path}`,
  );
});

test("resolveModelDir for bundled model points to models/ directory", () => {
  const dir = resolveModelDir("all-MiniLM-L6-v2");
  assert.ok(dir.includes("models"), `Dir should contain 'models': ${dir}`);
  assert.ok(
    dir.endsWith("all-MiniLM-L6-v2"),
    `Dir should end with model name: ${dir}`,
  );
});

test("resolveModelDir for non-bundled model uses cache directory", () => {
  const dir = resolveModelDir("nomic-embed-text-v1.5");
  // Non-bundled models resolve to cache dir, not models/ in package
  assert.ok(
    dir.endsWith("nomic-embed-text-v1.5"),
    `Dir should end with model name: ${dir}`,
  );
  // Should NOT be in the bundled models/ directory
  assert.ok(
    dir.includes("sdl-mcp") || dir.includes(".cache"),
    `Non-bundled dir should be in cache: ${dir}`,
  );
});

test("isModelAvailable returns boolean without throwing", () => {
  // This test verifies the function runs without error regardless of whether
  // model files are actually present (CI may not have them downloaded)
  const result = isModelAvailable("all-MiniLM-L6-v2");
  assert.strictEqual(typeof result, "boolean");
});

test("isModelAvailable returns boolean for nomic model", () => {
  const result = isModelAvailable("nomic-embed-text-v1.5");
  assert.strictEqual(typeof result, "boolean");
});

test("MiniLM and nomic have different dimensions", () => {
  const miniLM = getModelInfo("all-MiniLM-L6-v2");
  const nomic = getModelInfo("nomic-embed-text-v1.5");
  assert.notStrictEqual(miniLM.dimension, nomic.dimension);
  assert.strictEqual(miniLM.dimension, 384);
  assert.strictEqual(nomic.dimension, 768);
});
