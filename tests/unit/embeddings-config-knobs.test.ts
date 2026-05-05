import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the new embedding-related config knobs:
 *
 *   - `semantic.embeddingBatchSize` (1-128, default 32)
 *   - `semantic.embeddingsSequential` (boolean, default false)
 *   - `semantic.modelVariant` (free-form string, optional)
 *   - `semantic.executionProviders` (string[], default ["cpu"])
 *
 * Plus the related constants exposed from `config/constants.ts`:
 *
 *   - `DEFAULT_EMBEDDING_BATCH_SIZE = 32`
 *   - `MAX_EMBEDDING_BATCH_SIZE = 128`
 *   - `MAX_EMBEDDING_CONCURRENCY = 8` (already covered by the
 *     `embedding-concurrency.test.ts` suite)
 */

describe("embeddingBatchSize schema", () => {
  it("defaults to DEFAULT_EMBEDDING_BATCH_SIZE (32)", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({});
    assert.strictEqual(parsed.embeddingBatchSize, 32);
  });

  it("accepts the lower bound (1)", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({ embeddingBatchSize: 1 });
    assert.strictEqual(parsed.embeddingBatchSize, 1);
  });

  it("accepts the upper bound (128)", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({ embeddingBatchSize: 128 });
    assert.strictEqual(parsed.embeddingBatchSize, 128);
  });

  it("rejects values below 1", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    assert.throws(() => SemanticConfigSchema.parse({ embeddingBatchSize: 0 }));
  });

  it("rejects values above 128", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    assert.throws(() =>
      SemanticConfigSchema.parse({ embeddingBatchSize: 129 }),
    );
  });

  it("rejects non-integer values", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    assert.throws(() =>
      SemanticConfigSchema.parse({ embeddingBatchSize: 32.5 }),
    );
  });
});

describe("embeddingsSequential schema", () => {
  it("defaults to false", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({});
    assert.strictEqual(parsed.embeddingsSequential, false);
  });

  it("accepts true", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({ embeddingsSequential: true });
    assert.strictEqual(parsed.embeddingsSequential, true);
  });

  it("rejects non-boolean values", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    assert.throws(() =>
      SemanticConfigSchema.parse({ embeddingsSequential: "true" }),
    );
  });
});

describe("modelVariant schema", () => {
  it("defaults to undefined when not set", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({});
    assert.strictEqual(parsed.modelVariant, undefined);
  });

  it("accepts arbitrary variant names", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    for (const variant of ["default", "fp16", "fp32", "int8", "q4"]) {
      const parsed = SemanticConfigSchema.parse({ modelVariant: variant });
      assert.strictEqual(parsed.modelVariant, variant);
    }
  });
});

describe("executionProviders schema", () => {
  it("defaults to ['cpu']", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({});
    assert.deepStrictEqual(parsed.executionProviders, ["cpu"]);
  });

  it("accepts an arbitrary list of provider names", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    const parsed = SemanticConfigSchema.parse({
      executionProviders: ["dml", "cpu"],
    });
    assert.deepStrictEqual(parsed.executionProviders, ["dml", "cpu"]);
  });

  it("rejects non-string entries", async () => {
    const { SemanticConfigSchema } = await import("../../dist/config/types.js");
    assert.throws(() =>
      SemanticConfigSchema.parse({ executionProviders: [42] }),
    );
  });
});

describe("constants module exports", () => {
  it("exports DEFAULT_EMBEDDING_BATCH_SIZE = 32", async () => {
    const { DEFAULT_EMBEDDING_BATCH_SIZE } =
      await import("../../dist/config/constants.js");
    assert.strictEqual(DEFAULT_EMBEDDING_BATCH_SIZE, 32);
  });

  it("exports MAX_EMBEDDING_BATCH_SIZE = 128", async () => {
    const { MAX_EMBEDDING_BATCH_SIZE } =
      await import("../../dist/config/constants.js");
    assert.strictEqual(MAX_EMBEDDING_BATCH_SIZE, 128);
  });
});
