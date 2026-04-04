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
const MINILM = "all-MiniLM-L6-v2";
const NOMIC = "nomic-embed-text-v1.5";
const UNKNOWN = "unknown-model-xyz";

// ---------------------------------------------------------------------------
// EMBEDDING_MODELS registry
// ---------------------------------------------------------------------------

describe("EMBEDDING_MODELS", () => {
  it("has an entry for all-MiniLM-L6-v2 with dimension 384", () => {
    const info = EMBEDDING_MODELS[MINILM];
    assert.ok(info, "all-MiniLM-L6-v2 should be in EMBEDDING_MODELS");
    assert.strictEqual(info.dimension, 384);
  });

  it("has an entry for nomic-embed-text-v1.5 with dimension 768", () => {
    const info = EMBEDDING_MODELS[NOMIC];
    assert.ok(info, "nomic-embed-text-v1.5 should be in EMBEDDING_MODELS");
    assert.strictEqual(info.dimension, 768);
  });

  it("all-MiniLM-L6-v2 propertyPrefix is 'embeddingMiniLM'", () => {
    assert.strictEqual(EMBEDDING_MODELS[MINILM]!.propertyPrefix, "embeddingMiniLM");
  });

  it("nomic-embed-text-v1.5 propertyPrefix is 'embeddingNomic'", () => {
    assert.strictEqual(EMBEDDING_MODELS[NOMIC]!.propertyPrefix, "embeddingNomic");
  });

  it("has exactly three entries", () => {
    assert.strictEqual(Object.keys(EMBEDDING_MODELS).length, 3);
  });
});

// ---------------------------------------------------------------------------
// getEmbeddingPropertyName
// ---------------------------------------------------------------------------

describe("getEmbeddingPropertyName", () => {
  it("returns 'embeddingMiniLM' for all-MiniLM-L6-v2", () => {
    assert.strictEqual(getEmbeddingPropertyName(MINILM), "embeddingMiniLM");
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
  it("returns 'embeddingMiniLMCardHash' for all-MiniLM-L6-v2", () => {
    assert.strictEqual(getCardHashPropertyName(MINILM), "embeddingMiniLMCardHash");
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
  it("returns 'embeddingMiniLMUpdatedAt' for all-MiniLM-L6-v2", () => {
    assert.strictEqual(getUpdatedAtPropertyName(MINILM), "embeddingMiniLMUpdatedAt");
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
  it("returns 'symbol_vec_embeddingminilm' for all-MiniLM-L6-v2", () => {
    assert.strictEqual(getVectorIndexName(MINILM), "symbol_vec_minilm_l6_v2");
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
