import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * T3: Validates that the agent executor's cardCache and cacheHits metric
 * work correctly, including proper reset() behavior.
 *
 * Since the Executor class is tightly coupled to LadybugDB, we test the
 * cache mechanics by instantiating the class and exercising cardCache
 * directly via its reset() contract.
 */
describe("Agent executor cardCache and cacheHits", () => {
  it("reset() clears cardCache so subsequent runs do not carry stale hits", async () => {
    const { Executor } = await import("../../dist/agent/executor.js");
    const executor = new Executor();

    // Access internal state to verify reset behavior.
    // The cardCache is a private Set<string>, but reset() should clear it.
    // After reset(), the metrics object should have cacheHits: 0.
    executor.reset();

    // Verify metrics are zeroed
    const metrics = (executor as any).metrics;
    assert.strictEqual(metrics.cacheHits, 0, "cacheHits should be 0 after reset");
    assert.strictEqual(metrics.totalDurationMs, 0, "totalDurationMs should be 0 after reset");
    assert.strictEqual(metrics.totalActions, 0, "totalActions should be 0 after reset");

    // Verify cardCache is a fresh empty Set
    const cache = (executor as any).cardCache;
    assert.ok(cache instanceof Set, "cardCache should be a Set");
    assert.strictEqual(cache.size, 0, "cardCache should be empty after reset");
  });

  it("cardCache is a Set<string> initialized empty", async () => {
    const { Executor } = await import("../../dist/agent/executor.js");
    const executor = new Executor();

    const cache = (executor as any).cardCache;
    assert.ok(cache instanceof Set, "cardCache should be a Set");
    assert.strictEqual(cache.size, 0, "cardCache should start empty");
  });

  it("reset() creates a new Set instance (does not just clear)", async () => {
    const { Executor } = await import("../../dist/agent/executor.js");
    const executor = new Executor();

    const cacheBefore = (executor as any).cardCache;
    // Simulate some cache entries
    cacheBefore.add("sym-1");
    cacheBefore.add("sym-2");
    assert.strictEqual(cacheBefore.size, 2);

    executor.reset();

    const cacheAfter = (executor as any).cardCache;
    assert.strictEqual(cacheAfter.size, 0, "cardCache should be empty after reset");
    // The old Set reference should not affect the new one
    assert.notStrictEqual(cacheBefore, cacheAfter, "reset should create a new Set");
  });
});
