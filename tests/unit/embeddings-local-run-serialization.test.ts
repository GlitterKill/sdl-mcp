import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBatchInference } from "../../dist/indexer/embeddings-local.js";
import { ConcurrencyLimiter } from "../../dist/util/concurrency.js";

function createInferenceHarness() {
  let activeTokenizations = 0;
  let maxTokenizations = 0;
  let activeRuns = 0;
  let maxRuns = 0;

  const tokenizer = {
    async encodeBatch() {
      activeTokenizations++;
      maxTokenizations = Math.max(maxTokenizations, activeTokenizations);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeTokenizations--;
      return [
        {
          getIds: () => [1, 2],
          getAttentionMask: () => [1, 1],
          getTypeIds: () => [0, 0],
        },
      ];
    },
  };
  const session = {
    inputNames: ["input_ids", "attention_mask"],
    async run() {
      activeRuns++;
      maxRuns = Math.max(maxRuns, activeRuns);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeRuns--;
      return {
        last_hidden_state: {
          data: new Float32Array([1, 2, 3, 4]),
          dims: [1, 2, 2],
        },
      };
    },
  };
  const ort = {
    Tensor: class {
      constructor(
        _type: string,
        _data: BigInt64Array,
        _dims: readonly number[],
      ) {}
    },
  };

  return {
    tokenizer,
    session,
    ort,
    maxTokenizations: () => maxTokenizations,
    maxRuns: () => maxRuns,
  };
}

function assertNormalizedVectors(results: number[][][]): void {
  for (const result of results) {
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].length, 2);
    assert.ok(result[0].every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...result[0]) - 1) < 1e-12);
  }
}

describe("runBatchInference session serialization", () => {
  it("serializes DirectML runs without serializing tokenization", async () => {
    const harness = createInferenceHarness();
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });

    const results = await Promise.all([
      runBatchInference(
        harness.session,
        harness.tokenizer,
        ["first"],
        2,
        harness.ort,
        limiter,
      ),
      runBatchInference(
        harness.session,
        harness.tokenizer,
        ["second"],
        2,
        harness.ort,
        limiter,
      ),
    ]);

    assert.strictEqual(harness.maxTokenizations(), 2);
    assert.strictEqual(harness.maxRuns(), 1);
    assertNormalizedVectors(results);
  });

  it("allows CPU runs to overlap without a limiter", async () => {
    const harness = createInferenceHarness();

    const results = await Promise.all([
      runBatchInference(
        harness.session,
        harness.tokenizer,
        ["first"],
        2,
        harness.ort,
      ),
      runBatchInference(
        harness.session,
        harness.tokenizer,
        ["second"],
        2,
        harness.ort,
      ),
    ]);

    assert.strictEqual(harness.maxRuns(), 2);
    assertNormalizedVectors(results);
  });
});
