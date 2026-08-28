import assert from "node:assert/strict";
import { test } from "node:test";

import { hashEmbeddingPayload } from "../../dist/indexer/embeddings.js";
import { resolveEmbeddingModelCandidates } from "../../dist/indexer/model-registry.js";
import { hashContent } from "../../dist/util/hashing.js";

const JINA_MODEL = "jina-embeddings-v2-base-code";

test("undefined embedding compatibility preserves the legacy digest", () => {
  const parts = ["symbol-1", "payload"];

  assert.equal(hashEmbeddingPayload(parts), hashContent(parts.join("|")));
});

test("Jina quantized aliases share cache identity while fp16 differs", () => {
  const options = {
    name: JINA_MODEL,
    deterministic: false,
    requestedProviders: ["cpu"],
  } as const;
  const quantizedDefault = resolveEmbeddingModelCandidates(options)[0];
  const quantizedInt8 = resolveEmbeddingModelCandidates({
    ...options,
    requestedVariant: "int8",
  })[0];
  const fp16 = resolveEmbeddingModelCandidates({
    ...options,
    requestedVariant: "fp16",
  })[0];
  const parts = ["symbol-1", "payload"];

  assert.equal(
    hashEmbeddingPayload(parts, quantizedDefault.cacheCompatibilityKey),
    hashEmbeddingPayload(parts, quantizedInt8.cacheCompatibilityKey),
  );
  assert.notEqual(
    hashEmbeddingPayload(parts, fp16.cacheCompatibilityKey),
    hashEmbeddingPayload(parts, quantizedDefault.cacheCompatibilityKey),
  );
});
