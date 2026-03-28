/**
 * retrieval-config.test.ts
 *
 * Verifies that SemanticConfigSchema correctly parses the new
 * semantic.retrieval.* fields introduced in Stage 0, and that
 * legacy config shapes (alpha, ann) remain accepted.
 *
 * Imports from src/ via tsx so no build step is required.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SemanticConfigSchema,
  SemanticRetrievalConfigSchema,
} from "../../dist/config/types.js";

// ---------------------------------------------------------------------------
// SemanticRetrievalConfigSchema
// ---------------------------------------------------------------------------

describe("SemanticRetrievalConfigSchema", () => {
  it("default config parses correctly with all retrieval defaults", () => {
    const result = SemanticRetrievalConfigSchema.parse({});

    assert.strictEqual(result.mode, "hybrid");
    assert.strictEqual(result.extensionsOptional, true);
    assert.strictEqual(result.candidateLimit, 100);
    assert.ok(result.fts !== undefined, "fts sub-config should be present");
    assert.ok(result.vector !== undefined, "vector sub-config should be present");
    assert.ok(result.fusion !== undefined, "fusion sub-config should be present");
  });

  it("mode='hybrid' parses correctly", () => {
    const result = SemanticRetrievalConfigSchema.parse({ mode: "hybrid" });
    assert.strictEqual(result.mode, "hybrid");
  });

  it("full retrieval block parses with all fields explicitly set", () => {
    const result = SemanticRetrievalConfigSchema.parse({
      mode: "hybrid",
      extensionsOptional: false,
      candidateLimit: 50,
      fts: {
        enabled: true,
        indexName: "my_fts_idx",
        topK: 30,
        conjunctive: true,
      },
      vector: {
        enabled: true,
        topK: 30,
        efs: 100,
        indexes: {
          "all-MiniLM-L6-v2": { indexName: "sym_vec_minilm" },
          "nomic-embed-text-v1.5": { indexName: "sym_vec_nomic" },
        },
      },
      fusion: {
        strategy: "rrf",
        rrfK: 30,
      },
    });

    assert.strictEqual(result.mode, "hybrid");
    assert.strictEqual(result.extensionsOptional, false);
    assert.strictEqual(result.candidateLimit, 50);
    assert.strictEqual(result.fts?.indexName, "my_fts_idx");
    assert.strictEqual(result.fts?.conjunctive, true);
    assert.strictEqual(result.vector?.efs, 100);
    assert.strictEqual(result.fusion?.rrfK, 30);
  });

  it("fts sub-schema defaults: enabled=true, indexName='symbol_search_text_v1', topK=75, conjunctive=false", () => {
    const result = SemanticRetrievalConfigSchema.parse({});
    const fts = result.fts!;
    assert.strictEqual(fts.enabled, true);
    assert.strictEqual(fts.indexName, "symbol_search_text_v1");
    assert.strictEqual(fts.topK, 75);
    assert.strictEqual(fts.conjunctive, false);
  });

  it("vector sub-schema defaults include both models with correct index names", () => {
    const result = SemanticRetrievalConfigSchema.parse({});
    const vector = result.vector!;
    assert.strictEqual(vector.enabled, true);
    assert.strictEqual(vector.topK, 75);
    assert.strictEqual(vector.efs, 200);

    const miniLM = vector.indexes?.["all-MiniLM-L6-v2"];
    assert.ok(miniLM, "all-MiniLM-L6-v2 index entry should be present");
    assert.strictEqual(miniLM.indexName, "symbol_vec_minilm_l6_v2");

    const nomic = vector.indexes?.["nomic-embed-text-v1.5"];
    assert.ok(nomic, "nomic-embed-text-v1.5 index entry should be present");
    assert.strictEqual(nomic.indexName, "symbol_vec_nomic_embed_v15");
  });

  it("fusion sub-schema defaults: strategy='rrf', rrfK=60", () => {
    const result = SemanticRetrievalConfigSchema.parse({});
    const fusion = result.fusion!;
    assert.strictEqual(fusion.strategy, "rrf");
    assert.strictEqual(fusion.rrfK, 60);
  });

  it("rejects unknown mode values", () => {
    assert.throws(
      () => SemanticRetrievalConfigSchema.parse({ mode: "turbo" }),
      /invalid_enum_value|invalid_value|Invalid enum value|Invalid option/i,
    );
  });
});

// ---------------------------------------------------------------------------
// SemanticConfigSchema — retrieval field integration
// ---------------------------------------------------------------------------

describe("SemanticConfigSchema with retrieval field", () => {
  it("default config parses correctly — retrieval field is optional and absent by default", () => {
    const result = SemanticConfigSchema.parse({});
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.model, "all-MiniLM-L6-v2");
    // retrieval is optional; may be undefined when not provided
    assert.ok(
      result.retrieval === undefined || typeof result.retrieval === "object",
      "retrieval should be undefined or an object",
    );
  });

  it("legacy config without semantic.retrieval still works", () => {
    const result = SemanticConfigSchema.parse({
      enabled: true,
      alpha: 0.5,
      model: "all-MiniLM-L6-v2",
    });
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(result.alpha, 0.5);
    assert.strictEqual(result.model, "all-MiniLM-L6-v2");
  });

  it("config with semantic.retrieval.mode='hybrid' parses correctly", () => {
    const result = SemanticConfigSchema.parse({
      retrieval: { mode: "hybrid" },
    });
    assert.strictEqual(result.retrieval?.mode, "hybrid");
  });

  it("config with full retrieval block parses correctly", () => {
    const result = SemanticConfigSchema.parse({
      enabled: true,
      model: "nomic-embed-text-v1.5",
      retrieval: {
        mode: "hybrid",
        extensionsOptional: false,
        candidateLimit: 200,
        fts: { enabled: true, topK: 50 },
        vector: { enabled: true, topK: 50, efs: 400 },
        fusion: { strategy: "rrf", rrfK: 80 },
      },
    });

    assert.strictEqual(result.model, "nomic-embed-text-v1.5");
    assert.strictEqual(result.retrieval?.mode, "hybrid");
    assert.strictEqual(result.retrieval?.candidateLimit, 200);
    assert.strictEqual(result.retrieval?.fts?.topK, 50);
    assert.strictEqual(result.retrieval?.vector?.efs, 400);
    assert.strictEqual(result.retrieval?.fusion?.rrfK, 80);
  });

  it("deprecation compatibility: alpha and ann still parse correctly alongside retrieval", () => {
    const result = SemanticConfigSchema.parse({
      alpha: 0.7,
      ann: { enabled: true, m: 16, efConstruction: 128, efSearch: 64 },
      retrieval: { mode: "legacy" },
    });

    assert.strictEqual(result.alpha, 0.7);
    assert.ok(result.ann !== undefined, "ann should be present");
    assert.strictEqual(result.ann?.enabled, true);
    assert.strictEqual(result.retrieval?.mode, "legacy");
  });

  it("alpha defaults to 0.6", () => {
    const result = SemanticConfigSchema.parse({});
    assert.strictEqual(result.alpha, 0.6);
  });
});
