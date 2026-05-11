import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  isInToolDispatch,
  resetToolDispatchLimiter,
  runToolDispatch,
  waitForToolDispatchIdle,
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

  it("configureToolDispatchLimiter reshapes the limiter in place", () => {
    // Reshape-in-place preserves the singleton reference so in-flight tool
    // calls don't need to be replayed through a brand-new limiter. The
    // indexing-gate listener is attached to the singleton, so replacing it
    // would silently break the gate. Narrowing/widening is applied via
    // setMaxConcurrency; only the queueTimeoutMs for *future* enqueues is
    // observable, and the public API exposes max through getStats/max only.
    const original = getToolDispatchLimiter();

    configureToolDispatchLimiter({
      maxConcurrency: 2,
      queueTimeoutMs: 1_000,
    });

    const reshaped = getToolDispatchLimiter();
    assert.strictEqual(reshaped, original);
    assert.strictEqual(reshaped.getMaxConcurrency(), 2);
    assert.strictEqual(reshaped.getStats().active, 0);
    assert.strictEqual(reshaped.getStats().queued, 0);
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

  it("marks async context while a tool dispatch slot is active", async () => {
    assert.strictEqual(isInToolDispatch(), false);

    await runToolDispatch(async () => {
      assert.strictEqual(isInToolDispatch(), true);
      await Promise.resolve();
      assert.strictEqual(isInToolDispatch(), true);
    });

    assert.strictEqual(isInToolDispatch(), false);
  });

  it("waits until active dispatch work drains to the allowance", async () => {
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

    const first = runToolDispatch(async () => firstBarrier);
    const second = runToolDispatch(async () => secondBarrier);
    await delay(20);
    assert.strictEqual(limiter.getStats().active, 2);

    let idle = false;
    const wait = waitForToolDispatchIdle({
      activeAllowance: 1,
      timeoutMs: 1_000,
      pollMs: 5,
      label: "test",
    }).then((result) => {
      idle = result;
    });

    await delay(20);
    assert.strictEqual(idle, false);

    releaseFirst?.();
    await wait;
    assert.strictEqual(idle, true);
    assert.strictEqual(limiter.getStats().active, 1);

    releaseSecond?.();
    await Promise.all([first, second]);
  });
});
