import { describe, it } from "node:test";
import assert from "node:assert";
import {
  configurePrefetch,
  consumePrefetchedKey,
  getPrefetchStats,
  prefetchSliceFrontier,
} from "../../src/graph/prefetch.js";
import { trainPrefetchModel, predictNextTool } from "../../src/graph/prefetch-model.js";

describe("prefetch pipeline", () => {
  it("records cache misses/hits and exposes rates", () => {
    const repoId = "prefetch-test";
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });

    consumePrefetchedKey(repoId, "card:missing");
    const missStats = getPrefetchStats(repoId);
    assert.ok(missStats.cacheMisses >= 1);

    prefetchSliceFrontier(repoId, []);
    const hit = consumePrefetchedKey(repoId, "card:missing");
    assert.strictEqual(typeof hit, "boolean");
  });

  it("trains lightweight model from tool traces", () => {
    const model = trainPrefetchModel([
      { repoId: "r", taskType: "implement", tool: "search" },
      { repoId: "r", taskType: "implement", tool: "card" },
      { repoId: "r", taskType: "implement", tool: "slice" },
      { repoId: "r", taskType: "implement", tool: "search" },
      { repoId: "r", taskType: "implement", tool: "card" },
      { repoId: "r", taskType: "implement", tool: "slice" },
    ]);

    assert.strictEqual(predictNextTool(model, "search", "card"), "slice");
  });
});
