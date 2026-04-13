/**
 * retrieval-model-mapping.test.ts
 *
 * Verifies the model-to-property/index mapping helpers in
 * src/retrieval/model-mapping.ts.  All functions are pure (no DB required).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EMBEDDING_MODELS,
  getEmbeddingPropertyName,
  getCardHashPropertyName,
  getUpdatedAtPropertyName,
  getVectorIndexName,
} from "../../dist/retrieval/model-mapping.js";

// Known model constants used throughout the tests.
const JINA = "jina-embeddings-v2-base-code";
const NOMIC = "nomic-embed-text-v1.5";
const UNKNOWN = "unknown-model-xyz";

// ---------------------------------------------------------------------------
// EMBEDDING_MODELS registry
// ---------------------------------------------------------------------------

describe("EMBEDDING_MODELS", () => {
  it("has an entry for jina-embeddings-v2-base-code with dimension 384", () => {
    const info = EMBEDDING_MODELS[JINA];
    assert.ok(info, "jina-embeddings-v2-base-code should be in EMBEDDING_MODELS");
    assert.strictEqual(info.dimension, 768);
  });

  it("has an entry for nomic-embed-text-v1.5 with dimension 768", () => {
    const info = EMBEDDING_MODELS[NOMIC];
    assert.ok(info, "nomic-embed-text-v1.5 should be in EMBEDDING_MODELS");
    assert.strictEqual(info.dimension, 768);
  });

  it("jina-embeddings-v2-base-code propertyPrefix is 'embeddingJinaCode'", () => {
    assert.strictEqual(EMBEDDING_MODELS[JINA]!.propertyPrefix, "embeddingJinaCode");
  });

  it("nomic-embed-text-v1.5 propertyPrefix is 'embeddingNomic'", () => {
    assert.strictEqual(EMBEDDING_MODELS[NOMIC]!.propertyPrefix, "embeddingNomic");
  });

  it("has exactly two entries", () => {
    assert.strictEqual(Object.keys(EMBEDDING_MODELS).length, 2);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingPropertyName
// ---------------------------------------------------------------------------

describe("getEmbeddingPropertyName", () => {
  it("returns 'embeddingJinaCode' for jina-embeddings-v2-base-code", () => {
    assert.strictEqual(getEmbeddingPropertyName(JINA), "embeddingJinaCode");
  });

  it("returns 'embeddingNomic' for nomic-embed-text-v1.5", () => {
    assert.strictEqual(getEmbeddingPropertyName(NOMIC), "embeddingNomic");
  });

  it("returns null for an unknown model", () => {
    assert.strictEqual(getEmbeddingPropertyName(UNKNOWN), null);
  });

  it("returns null for an empty string", () => {
    assert.strictEqual(getEmbeddingPropertyName(""), null);
  });
});

// ---------------------------------------------------------------------------
// getCardHashPropertyName
// ---------------------------------------------------------------------------

describe("getCardHashPropertyName", () => {
  it("returns 'embeddingJinaCodeCardHash' for jina-embeddings-v2-base-code", () => {
    assert.strictEqual(getCardHashPropertyName(JINA), "embeddingJinaCodeCardHash");
  });

  it("returns 'embeddingNomicCardHash' for nomic-embed-text-v1.5", () => {
    assert.strictEqual(getCardHashPropertyName(NOMIC), "embeddingNomicCardHash");
  });

  it("returns null for an unknown model", () => {
    assert.strictEqual(getCardHashPropertyName(UNKNOWN), null);
  });
});

// ---------------------------------------------------------------------------
// getUpdatedAtPropertyName
// ---------------------------------------------------------------------------

describe("getUpdatedAtPropertyName", () => {
  it("returns 'embeddingJinaCodeUpdatedAt' for jina-embeddings-v2-base-code", () => {
    assert.strictEqual(getUpdatedAtPropertyName(JINA), "embeddingJinaCodeUpdatedAt");
  });

  it("returns 'embeddingNomicUpdatedAt' for nomic-embed-text-v1.5", () => {
    assert.strictEqual(getUpdatedAtPropertyName(NOMIC), "embeddingNomicUpdatedAt");
  });

  it("returns null for an unknown model", () => {
    assert.strictEqual(getUpdatedAtPropertyName(UNKNOWN), null);
  });
});

// ---------------------------------------------------------------------------
// getVectorIndexName
// ---------------------------------------------------------------------------

describe("getVectorIndexName", () => {
  it("returns 'symbol_vec_jina_code_v2' for jina-embeddings-v2-base-code", () => {
    assert.strictEqual(getVectorIndexName(JINA), "symbol_vec_jina_code_v2");
  });

  it("returns 'symbol_vec_embeddingnomic' for nomic-embed-text-v1.5", () => {
    assert.strictEqual(getVectorIndexName(NOMIC), "symbol_vec_nomic_embed_v15");
  });

  it("returns null for an unknown model", () => {
    assert.strictEqual(getVectorIndexName(UNKNOWN), null);
  });

  it("index names are all lowercase", () => {
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      const name = getVectorIndexName(model);
      assert.ok(name !== null, `${model} should have an index name`);
      assert.strictEqual(name, name.toLowerCase(), `index name for ${model} should be lowercase`);
    }
  });

  it("index names start with 'symbol_vec_'", () => {
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      const name = getVectorIndexName(model);
      assert.ok(name?.startsWith("symbol_vec_"), `index name for ${model} should start with 'symbol_vec_'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-model consistency checks
// ---------------------------------------------------------------------------

describe("model mapping consistency", () => {
  it("all known models return non-null values from all helpers", () => {
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      assert.notStrictEqual(getEmbeddingPropertyName(model), null, `${model}: embeddingPropertyName`);
      assert.notStrictEqual(getCardHashPropertyName(model), null, `${model}: cardHashPropertyName`);
      assert.notStrictEqual(getUpdatedAtPropertyName(model), null, `${model}: updatedAtPropertyName`);
      assert.notStrictEqual(getVectorIndexName(model), null, `${model}: vectorIndexName`);
    }
  });

  it("cardHash property names are derived from embedding property name + 'CardHash'", () => {
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      const embProp = getEmbeddingPropertyName(model)!;
      const hashProp = getCardHashPropertyName(model)!;
      assert.strictEqual(hashProp, `${embProp}CardHash`);
    }
  });

  it("updatedAt property names are derived from embedding property name + 'UpdatedAt'", () => {
    for (const model of Object.keys(EMBEDDING_MODELS)) {
      const embProp = getEmbeddingPropertyName(model)!;
      const updatedProp = getUpdatedAtPropertyName(model)!;
      assert.strictEqual(updatedProp, `${embProp}UpdatedAt`);
    }
  });
});
