import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEmbeddingWidth,
  resolvePerformancePresets,
} from "../../dist/util/cpu-presets.js";

describe("CPU-tier embedding presets", () => {
  it("bounds embedding width from physical-core capacity", () => {
    for (const [logicalCores, physicalCores, expected] of [
      [1, undefined, 1],
      [2, undefined, 1],
      [7, undefined, 4],
      [8, 4, 4],
      [12, 6, 6],
      [20, 10, 8],
      [32, 16, 8],
    ] as const) {
      assert.strictEqual(
        resolveEmbeddingWidth({ logicalCores, physicalCores }),
        expected,
      );
    }
  });

  it("merges embedding defaults into every tier", () => {
    const cases = [
      ["mid", { logicalCores: 8, physicalCores: 4 }, 4, 4],
      ["high", { logicalCores: 12, physicalCores: 6 }, 6, 8],
      ["extreme", { logicalCores: 32, physicalCores: 16 }, 8, 12],
    ] as const;

    for (const [tier, cpuProfile, embeddingConcurrency, indexingConcurrency] of cases) {
      const presets = resolvePerformancePresets(tier, {}, cpuProfile);
      assert.strictEqual(presets.embeddingConcurrency, embeddingConcurrency);
      assert.strictEqual(presets.embeddingBatchSize, 16);
      assert.strictEqual(presets.indexingConcurrency, indexingConcurrency);
    }
  });

  it("preserves explicit semantic embedding settings", () => {
    const presets = resolvePerformancePresets(
      "extreme",
      { semantic: { embeddingConcurrency: 3, embeddingBatchSize: 24 } },
      { logicalCores: 32, physicalCores: 16 },
    );

    assert.strictEqual(presets.embeddingConcurrency, 3);
    assert.strictEqual(presets.embeddingBatchSize, 24);
  });
});
