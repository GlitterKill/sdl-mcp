import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("resolveSemanticEmbeddingModelPlan", () => {
  it("defaults to specialized symbol and FileSummary lanes", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({}),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, [
      "nomic-embed-text-v1.5",
    ]);
  });

  it("uses both supported models for max-recall", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({ embeddingProfile: "max-recall" }),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "jina-embeddings-v2-base-code",
      "nomic-embed-text-v1.5",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, [
      "jina-embeddings-v2-base-code",
      "nomic-embed-text-v1.5",
    ]);
  });

  it("lets explicit lane arrays override the profile independently", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({
        embeddingProfile: "max-recall",
        symbolEmbeddingModels: ["jina-embeddings-v2-base-code"],
      }),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, [
      "jina-embeddings-v2-base-code",
      "nomic-embed-text-v1.5",
    ]);
  });

  it("dedupes model arrays while preserving order", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({
        symbolEmbeddingModels: [
          "nomic-embed-text-v1.5",
          "jina-embeddings-v2-base-code",
          "nomic-embed-text-v1.5",
        ],
        fileSummaryEmbeddingModels: [
          "jina-embeddings-v2-base-code",
          "jina-embeddings-v2-base-code",
        ],
      }),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "nomic-embed-text-v1.5",
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, [
      "jina-embeddings-v2-base-code",
    ]);
  });

  it("filters unsupported explicit lane models without restoring profile defaults", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({
        embeddingProfile: "max-recall",
        symbolEmbeddingModels: [
          "unsupported-model",
          "jina-embeddings-v2-base-code",
        ],
        fileSummaryEmbeddingModels: ["unsupported-model"],
      }),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, []);
    assert.deepStrictEqual(plan.unsupportedModels, ["unsupported-model"]);
  });

  it("preserves legacy shared model behavior when only legacy fields are set", async () => {
    const { resolveSemanticEmbeddingModelPlan } = await import(
      "../../dist/config/semantic-embedding-model-plan.js"
    );
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");

    const plan = resolveSemanticEmbeddingModelPlan(
      SemanticConfigSchema.parse({
        model: "nomic-embed-text-v1.5",
        additionalModels: ["jina-embeddings-v2-base-code"],
      }),
    );

    assert.deepStrictEqual(plan.symbolEmbeddingModels, [
      "nomic-embed-text-v1.5",
      "jina-embeddings-v2-base-code",
    ]);
    assert.deepStrictEqual(plan.fileSummaryEmbeddingModels, [
      "nomic-embed-text-v1.5",
      "jina-embeddings-v2-base-code",
    ]);
  });
});
