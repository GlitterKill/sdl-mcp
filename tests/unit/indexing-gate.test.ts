import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
} from "../../dist/mcp/dispatch-limiter.js";
import {
  INDEXING_DISPATCH_CAP,
  isIndexingActive,
  resetIndexingGateForTests,
  withIndexingGate,
} from "../../dist/mcp/indexing-gate.js";

describe("indexing gate reshapes dispatch limiter", () => {
  beforeEach(() => {
    resetIndexingGateForTests();
    resetToolDispatchLimiter();
  });

  afterEach(() => {
    resetIndexingGateForTests();
    resetToolDispatchLimiter();
  });

  it("narrows dispatch concurrency while indexing is active", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 12, queueTimeoutMs: 1_000 });
    const limiter = getToolDispatchLimiter();

    assert.strictEqual(limiter.getMaxConcurrency(), 12);
    assert.strictEqual(isIndexingActive(), false);

    let insideGate = false;
    const gatePromise = withIndexingGate(async () => {
      insideGate = true;
      assert.strictEqual(isIndexingActive(), true);
      assert.strictEqual(
        limiter.getMaxConcurrency(),
        Math.min(INDEXING_DISPATCH_CAP, 12),
      );
    });

    await gatePromise;
    assert.strictEqual(insideGate, true);
    assert.strictEqual(isIndexingActive(), false);
    // Concurrency restored to configured value after gate exits.
    assert.strictEqual(limiter.getMaxConcurrency(), 12);
  });

  it("keeps dispatch narrowed until the last indexer finishes", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 10 });
    const limiter = getToolDispatchLimiter();

    let releaseOuter: (() => void) | undefined;
    const outerBarrier = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });

    const outer = withIndexingGate(async () => {
      await outerBarrier;
    });

    // Allow gate listener to fire synchronously during the first enter.
    await Promise.resolve();
    assert.strictEqual(
      limiter.getMaxConcurrency(),
      Math.min(INDEXING_DISPATCH_CAP, 10),
    );

    let releaseInner: (() => void) | undefined;
    const innerBarrier = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    const inner = withIndexingGate(async () => {
      await innerBarrier;
    });

    releaseInner?.();
    await inner;
    // Outer still active — dispatch must remain narrowed.
    assert.strictEqual(
      limiter.getMaxConcurrency(),
      Math.min(INDEXING_DISPATCH_CAP, 10),
    );

    releaseOuter?.();
    await outer;
    assert.strictEqual(limiter.getMaxConcurrency(), 10);
    assert.strictEqual(isIndexingActive(), false);
  });

  it("honors configured max smaller than INDEXING_DISPATCH_CAP", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 2 });
    const limiter = getToolDispatchLimiter();

    await withIndexingGate(async () => {
      // min(INDEXING_DISPATCH_CAP=4, 2) == 2 — no change.
      assert.strictEqual(limiter.getMaxConcurrency(), 2);
    });

    assert.strictEqual(limiter.getMaxConcurrency(), 2);
  });
});
