import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
} from "../../dist/mcp/dispatch-limiter.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("tool dispatch limiter", () => {
  beforeEach(() => {
    resetToolDispatchLimiter();
  });

  afterEach(() => {
    resetToolDispatchLimiter();
  });

  it("getToolDispatchLimiter returns the same instance on repeated calls", () => {
    const first = getToolDispatchLimiter();
    const second = getToolDispatchLimiter();

    assert.strictEqual(first, second);
  });

  it("configureToolDispatchLimiter replaces the limiter instance", () => {
    const original = getToolDispatchLimiter();

    configureToolDispatchLimiter({
      maxConcurrency: 2,
      queueTimeoutMs: 1_000,
    });

    const replaced = getToolDispatchLimiter();
    assert.notStrictEqual(replaced, original);
    assert.strictEqual(replaced.getStats().active, 0);
    assert.strictEqual(replaced.getStats().queued, 0);
  });

  it("resetToolDispatchLimiter clears the singleton instance", () => {
    const original = getToolDispatchLimiter();

    resetToolDispatchLimiter();

    const recreated = getToolDispatchLimiter();
    assert.notStrictEqual(recreated, original);
  });

  it("respects maxConcurrency and queues N+1 tasks", async () => {
    configureToolDispatchLimiter({
      maxConcurrency: 2,
      queueTimeoutMs: 1_000,
    });
    const limiter = getToolDispatchLimiter();

    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;

    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    let thirdStarted = false;
    let resolveThirdStarted: (() => void) | undefined;
    const thirdStartedSignal = new Promise<void>((resolve) => {
      resolveThirdStarted = resolve;
    });

    const firstTask = limiter.run(async () => {
      await firstBarrier;
      return "first";
    });
    const secondTask = limiter.run(async () => {
      await secondBarrier;
      return "second";
    });
    const thirdTask = limiter.run(async () => {
      thirdStarted = true;
      resolveThirdStarted?.();
      return "third";
    });

    await delay(20);

    const inFlightStats = limiter.getStats();
    assert.strictEqual(inFlightStats.active, 2);
    assert.strictEqual(inFlightStats.queued, 1);
    assert.strictEqual(thirdStarted, false);

    releaseFirst?.();

    await Promise.race([
      thirdStartedSignal,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("queued task did not start")), 500);
      }),
    ]);

    assert.strictEqual(thirdStarted, true);

    releaseSecond?.();

    const results = await Promise.all([firstTask, secondTask, thirdTask]);
    assert.deepStrictEqual(results.sort(), ["first", "second", "third"]);

    const finalStats = limiter.getStats();
    assert.strictEqual(finalStats.active, 0);
    assert.strictEqual(finalStats.queued, 0);
  });

  it("creates a fresh limiter after reset", () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 123 });
    const configured = getToolDispatchLimiter();

    resetToolDispatchLimiter();

    const fresh = getToolDispatchLimiter();
    assert.notStrictEqual(fresh, configured);

    const stats = fresh.getStats();
    assert.strictEqual(stats.active, 0);
    assert.strictEqual(stats.queued, 0);
  });
});
