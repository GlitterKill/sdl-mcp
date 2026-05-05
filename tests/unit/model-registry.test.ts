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
  resolveVariant,
} from "../../dist/indexer/model-registry.js";

test("getModelInfo returns Jina metadata", () => {
  const info = getModelInfo("jina-embeddings-v2-base-code");
  assert.strictEqual(info.name, "jina-embeddings-v2-base-code");
  assert.strictEqual(info.dimension, 768);
  assert.strictEqual(info.maxSequenceLength, 8192);
  assert.strictEqual(info.bundled, false);
  assert.strictEqual(info.defaultVariant, "default");
  assert.ok(info.variants.default, "default variant must be present");
  assert.strictEqual(
    info.variants.default.modelFile,
    "model_quantized.onnx",
    "default variant should map to the int8-quantized file",
  );
  assert.strictEqual(info.tokenizerFile, "tokenizer.json");
});

test("getModelInfo returns nomic metadata", () => {
  const info = getModelInfo("nomic-embed-text-v1.5");
  assert.strictEqual(info.name, "nomic-embed-text-v1.5");
  assert.strictEqual(info.dimension, 768);
  assert.strictEqual(info.maxSequenceLength, 8192);
  assert.strictEqual(info.bundled, false);
  assert.ok(info.downloadUrls, "nomic should have shared downloadUrls");
  assert.ok(
    info.downloadUrls.tokenizer.includes("huggingface.co"),
    "tokenizer URL should point to HuggingFace",
  );
  assert.ok(
    info.variants.default.downloadUrl.includes("huggingface.co"),
    "default variant URL should point to HuggingFace",
  );
});

test("Jina exposes default, int8, fp16, fp32 variants", () => {
  const info = getModelInfo("jina-embeddings-v2-base-code");
  for (const name of ["default", "int8", "fp16", "fp32"]) {
    assert.ok(info.variants[name], `Jina should expose ${name} variant`);
    assert.ok(
      info.variants[name].modelFile.endsWith(".onnx"),
      `${name} variant must have an .onnx modelFile`,
    );
  }
});

test("nomic exposes the full variant set", () => {
  const info = getModelInfo("nomic-embed-text-v1.5");
  for (const name of [
    "default",
    "int8",
    "uint8",
    "q4",
    "q4f16",
    "bnb4",
    "fp16",
    "fp32",
  ]) {
    assert.ok(info.variants[name], `nomic should expose ${name} variant`);
  }
});

test("resolveVariant returns requested variant when supported", () => {
  const { variantName, variant } = resolveVariant(
    "nomic-embed-text-v1.5",
    "fp16",
  );
  assert.strictEqual(variantName, "fp16");
  assert.strictEqual(variant.modelFile, "model_fp16.onnx");
});

test("resolveVariant falls back to default for unsupported variant", () => {
  const { variantName } = resolveVariant(
    "jina-embeddings-v2-base-code",
    "q4f16",
  );
  // jina does not publish q4f16 — fallback to default.
  assert.strictEqual(
    variantName,
    "jina-embeddings-v2-base-code".length === 0 ? "default" : "default",
  );
});

test("resolveVariant returns default when requested is undefined", () => {
  const { variantName } = resolveVariant("jina-embeddings-v2-base-code");
  assert.strictEqual(variantName, "default");
});

test("resolveModelPath returns variant-specific file", () => {
  const fp16Path = resolveModelPath("nomic-embed-text-v1.5", "fp16");
  assert.ok(
    fp16Path.endsWith("model_fp16.onnx"),
    `fp16 path should end with model_fp16.onnx: ${fp16Path}`,
  );
  const defaultPath = resolveModelPath("nomic-embed-text-v1.5");
  assert.ok(
    defaultPath.endsWith("model_quantized.onnx"),
    `default path should end with model_quantized.onnx: ${defaultPath}`,
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
  assert.ok(models.includes("jina-embeddings-v2-base-code"));
  assert.ok(models.includes("nomic-embed-text-v1.5"));
  assert.ok(models.includes("jina-embeddings-v2-base-code"));
  assert.strictEqual(models.length, 2);
});

test("isKnownModel returns true for registered models", () => {
  assert.strictEqual(isKnownModel("jina-embeddings-v2-base-code"), true);
  assert.strictEqual(isKnownModel("nomic-embed-text-v1.5"), true);
});

test("isKnownModel returns false for unknown models", () => {
  assert.strictEqual(isKnownModel("gpt-4"), false);
  assert.strictEqual(isKnownModel(""), false);
});

test("resolveModelPath returns path ending with model file", () => {
  const path = resolveModelPath("jina-embeddings-v2-base-code");
  assert.ok(
    path.endsWith("model_quantized.onnx"),
    `Path should end with ONNX file: ${path}`,
  );
  assert.ok(
    path.includes("jina-embeddings-v2-base-code"),
    `Path should contain model name: ${path}`,
  );
});

test("resolveTokenizerPath returns path ending with tokenizer file", () => {
  const path = resolveTokenizerPath("jina-embeddings-v2-base-code");
  assert.ok(
    path.endsWith("tokenizer.json"),
    `Path should end with tokenizer.json: ${path}`,
  );
  assert.ok(
    path.includes("jina-embeddings-v2-base-code"),
    `Path should contain model name: ${path}`,
  );
});

test("resolveModelDir for jina model uses runtime cache directory", () => {
  const dir = resolveModelDir("jina-embeddings-v2-base-code");
  assert.ok(
    dir.endsWith("jina-embeddings-v2-base-code"),
    `Dir should end with model name: ${dir}`,
  );
  assert.ok(
    dir.includes("sdl-mcp") || dir.includes(".cache"),
    `Jina dir should resolve to runtime cache: ${dir}`,
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
  const result = isModelAvailable("jina-embeddings-v2-base-code");
  assert.strictEqual(typeof result, "boolean");
});

test("isModelAvailable returns boolean for nomic model", () => {
  const result = isModelAvailable("nomic-embed-text-v1.5");
  assert.strictEqual(typeof result, "boolean");
});

test("Jina and nomic have same 768 dimensions", () => {
  const jina = getModelInfo("jina-embeddings-v2-base-code");
  const nomic = getModelInfo("nomic-embed-text-v1.5");
  assert.strictEqual(jina.dimension, nomic.dimension);
  assert.strictEqual(jina.dimension, 768);
  assert.strictEqual(nomic.dimension, 768);
});
