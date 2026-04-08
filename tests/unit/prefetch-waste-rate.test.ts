import { describe, it } from "node:test";
import assert from "node:assert";
import {
  configurePrefetch,
  getPrefetchStats,
  consumePrefetchedKey,
  shutdownPrefetch,
} from "../../dist/graph/prefetch.js";

// Regression test for the wasteRate formula fix (2026-04-08).
// Before the fix: wasteRate = wastedPrefetch / completed (items / batches)
// could be unbounded (e.g. 50.0 when one batch wasted 50 items).
// After the fix: wasteRate = wastedPrefetch / (cacheHits + wastedPrefetch)
// is always a ratio in [0, 1].

describe("prefetch wasteRate bounds", () => {
  it("wasteRate is 0 before any prefetch activity", () => {
    const repoId = "wasterate-test-fresh-" + Date.now();
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    const stats = getPrefetchStats(repoId);
    assert.strictEqual(stats.wasteRate, 0, "fresh repo should have wasteRate=0");
    assert.strictEqual(stats.hitRate, 0, "fresh repo should have hitRate=0");
  });

  it("wasteRate stays in [0, 1] after cache miss activity", () => {
    const repoId = "wasterate-test-miss-" + Date.now();
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    // Produce a few cache misses. With no wastedPrefetch items recorded,
    // wasteRate must stay at 0 (not become negative or > 1).
    for (let i = 0; i < 5; i++) {
      consumePrefetchedKey(repoId, `card:missing-${i}`);
    }
    const stats = getPrefetchStats(repoId);
    assert.ok(
      stats.wasteRate >= 0 && stats.wasteRate <= 1,
      `wasteRate (${stats.wasteRate}) must be in [0, 1]`,
    );
    assert.ok(
      stats.hitRate >= 0 && stats.hitRate <= 1,
      `hitRate (${stats.hitRate}) must be in [0, 1]`,
    );
  });

  it("shutdown leaves stats in a consistent state", () => {
    const repoId = "wasterate-test-shutdown-" + Date.now();
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    consumePrefetchedKey(repoId, "card:x");
    shutdownPrefetch();
    const stats = getPrefetchStats(repoId);
    assert.ok(stats.wasteRate >= 0 && stats.wasteRate <= 1);
  });
});
