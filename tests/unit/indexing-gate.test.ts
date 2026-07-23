import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  resetToolDispatchLimiter,
  runToolDispatch,
  waitForToolDispatchIdle,
} from "../../dist/mcp/dispatch-limiter.js";
import {
  INDEXING_DISPATCH_CAP,
  isIndexingActive,
  resetIndexingGateForTests,
  withIndexingGate,
} from "../../dist/mcp/indexing-gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("keeps background dispatch and destructive indexing mutually exclusive", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 2, queueTimeoutMs: 1_000 });
    const releaseBackground = deferred();
    const backgroundEntered = deferred();
    const releaseIndex = deferred();
    let indexPassedDrain = false;
    let laterBackgroundEntered = false;

    const background = runToolDispatch(
      async () => {
        backgroundEntered.resolve();
        await releaseBackground.promise;
      },
      undefined,
      "derived-refresh:repo-a",
    );
    await backgroundEntered.promise;
    const index = runToolDispatch(
      () =>
        withIndexingGate(async () => {
          const idle = await waitForToolDispatchIdle({
            activeAllowance: 1,
            timeoutMs: 1_000,
            pollMs: 2,
            label: "indexing gate exclusion test",
          });
          assert.strictEqual(idle, true);
          indexPassedDrain = true;
          await releaseIndex.promise;
        }),
      undefined,
      "sdl.index.refresh",
    );

    let laterBackground: Promise<void> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.strictEqual(
        indexPassedDrain,
        false,
        "indexing must wait for an active background dispatch",
      );

      releaseBackground.resolve();
      await background;
      while (!indexPassedDrain) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      laterBackground = runToolDispatch(
        async () => {
          laterBackgroundEntered = true;
        },
        undefined,
        "derived-refresh:repo-b",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.strictEqual(
        laterBackgroundEntered,
        false,
        "new background dispatch must queue behind destructive indexing",
      );
    } finally {
      releaseBackground.resolve();
      releaseIndex.resolve();
      await Promise.allSettled(
        laterBackground ? [background, index, laterBackground] : [background, index],
      );
    }
    assert.strictEqual(laterBackgroundEntered, true);
  });

  it("uses the lower of configured max and INDEXING_DISPATCH_CAP", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 2 });
    const limiter = getToolDispatchLimiter();

    await withIndexingGate(async () => {
      assert.strictEqual(
        limiter.getMaxConcurrency(),
        Math.min(INDEXING_DISPATCH_CAP, 2),
      );
    });

    assert.strictEqual(limiter.getMaxConcurrency(), 2);
  });
});
