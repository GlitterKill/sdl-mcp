import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  _getIndexRefreshAdmissionStatsForTesting,
  configureToolDispatchLimiter,
  getToolDispatchLimiter,
  getToolDispatchStats,
  isInToolDispatch,
  resetToolDispatchLimiter,
  retainIndexRefreshAdmissionUntil,
  runIndexRefreshAdmission,
  runOutsideToolDispatchContext,
  runToolDispatch,
  ToolDispatchQueueCapacityError,
  ToolDispatchQueueTimeoutError,
  waitForToolDispatchIdle,
} from "../../dist/mcp/dispatch-limiter.js";
import { _seedRunningForTesting } from "../../dist/indexer/derived-refresh-queue.js";

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
    assert.strictEqual(reshaped.getStats().maxConcurrency, 2);
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

  it("exposes dispatch stats without creating stale queue state", () => {
    configureToolDispatchLimiter({ maxConcurrency: 3, queueTimeoutMs: 1_000 });

    const stats = getToolDispatchStats();

    assert.strictEqual(stats.active, 0);
    assert.strictEqual(stats.queued, 0);
    assert.strictEqual(stats.maxConcurrency, 3);
    assert.strictEqual(stats.configuredMax, 3);
    assert.strictEqual(typeof stats.indexingActive, "boolean");
  });

  it("returns retryable typed errors when queued dispatch work times out", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 30 });

    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runToolDispatch(async () => blocker, undefined, "first");

    await assert.rejects(
      runToolDispatch(async () => "second", undefined, "sdl.context"),
      (err: unknown) => {
        assert.ok(err instanceof ToolDispatchQueueTimeoutError);
        assert.strictEqual((err as { code?: string }).code, "RUNTIME_ERROR");
        assert.strictEqual(
          (err as { classification?: string }).classification,
          "unavailable",
        );
        assert.strictEqual((err as { retryable?: boolean }).retryable, true);
        assert.match(err.message, /Tool dispatch queue timed out/);
        assert.match(err.message, /activeLabels=first/);
        assert.ok(
          (err as { details?: string[] }).details?.includes(
            "activeLabels=first",
          ),
        );
        return true;
      },
    );

    release?.();
    await first;
  });

  it("lets derived-refresh deferred work finish before timing foreground dispatch out", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 30 });

    let releaseSlot: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    const releaseStatus = _seedRunningForTesting("repo-deferred", "v1", {
      current: 2,
      total: 4,
      phase: "processRefresh",
      message: "processes",
    });

    const first = runToolDispatch(
      async () => blocker,
      undefined,
      "derived-refresh:repo-deferred",
    );
    let outcome = "pending";
    const second = runToolDispatch(
      async () => "second",
      undefined,
      "sdl.context",
    ).then(
      (value) => {
        outcome = `resolved:${value}`;
        return value;
      },
      (err: unknown) => {
        outcome = `rejected:${err instanceof Error ? err.message : String(err)}`;
        return "rejected";
      },
    );

    try {
      await delay(80);
      assert.strictEqual(outcome, "pending");
      releaseSlot?.();
      releaseStatus();
      const result = await Promise.race([
        second,
        delay(500).then(() => "timed out"),
      ]);
      assert.strictEqual(result, "second");
      await first;
    } finally {
      releaseSlot?.();
      releaseStatus();
      await first.catch(() => undefined);
      await second.catch(() => undefined);
    }
  });

  it("clears active dispatch labels on reset", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 123 });

    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const first = runToolDispatch(
      async () => {
        markStarted?.();
        return blocker;
      },
      undefined,
      "first",
    );

    try {
      await started;
      assert.deepStrictEqual(getToolDispatchStats().activeLabels, ["first"]);
      resetToolDispatchLimiter();
      assert.deepStrictEqual(getToolDispatchStats().activeLabels, []);
    } finally {
      release?.();
      await first.catch(() => undefined);
    }
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

  it("clears only dispatch context for retained detached work and restores it after failure", async () => {
    let rejectBackground!: (reason?: unknown) => void;
    let releaseRetained!: () => void;
    const backgroundFailure = new Promise<void>((_resolve, reject) => {
      rejectBackground = reject;
    });
    const retainedAfterFailure = new Promise<void>((resolve) => {
      releaseRetained = resolve;
    });

    const response = await runIndexRefreshAdmission(() =>
      runToolDispatch(async () => {
        assert.strictEqual(isInToolDispatch(), true);
        const background = runOutsideToolDispatchContext(async () => {
          assert.strictEqual(isInToolDispatch(), false);
          // Refresh-admission ALS must survive while only dispatch ALS clears.
          retainIndexRefreshAdmissionUntil(retainedAfterFailure);
          await backgroundFailure;
        });
        retainIndexRefreshAdmissionUntil(background);
        assert.strictEqual(isInToolDispatch(), true);
        return "accepted";
      }),
    );
    assert.strictEqual(response, "accepted");
    await delay(0);
    assert.strictEqual(getToolDispatchStats().active, 0);

    const queued = runIndexRefreshAdmission(async () => "released");
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);
    rejectBackground(new Error("injected detached failure"));
    await delay(10);
    assert.strictEqual(
      _getIndexRefreshAdmissionStatsForTesting().queued,
      1,
      "the second retained promise still owns refresh admission",
    );
    releaseRetained();

    assert.strictEqual(await queued, "released");
    await delay(0);
    assert.strictEqual(isInToolDispatch(), false);
    assert.strictEqual(getToolDispatchStats().active, 0);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().active, 0);
  });

  it("releases refresh admission when synchronous dispatch rejects", async () => {
    await assert.rejects(
      runIndexRefreshAdmission(async () => {
        throw new Error("injected refresh failure");
      }),
      /injected refresh failure/,
    );

    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().active, 0);
    assert.strictEqual(await runIndexRefreshAdmission(async () => "next"), "next");
  });

  it("holds admission through retained rejection and releases afterward", async () => {
    let rejectBackground!: (reason?: unknown) => void;
    const background = new Promise<void>((_resolve, reject) => {
      rejectBackground = reject;
    });
    const firstResponse = await runIndexRefreshAdmission(async () => {
      retainIndexRefreshAdmissionUntil(background);
      return "accepted";
    });
    assert.strictEqual(firstResponse, "accepted");

    const second = runIndexRefreshAdmission(async () => "next");
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);
    rejectBackground(new Error("background failed"));

    assert.strictEqual(await second, "next");
    // The response resolves inside the admitted task; the limiter's finally
    // releases its slot on the following microtask.
    await delay(0);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().active, 0);
  });

  it("retains every transferred promise and ignores transfer outside admission", async () => {
    // Internal watcher/CLI refresh paths do not own public admission.
    retainIndexRefreshAdmissionUntil(Promise.resolve());
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().active, 0);

    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    assert.strictEqual(
      await runIndexRefreshAdmission(async () => {
        retainIndexRefreshAdmissionUntil(first);
        retainIndexRefreshAdmissionUntil(second);
        return "accepted";
      }),
      "accepted",
    );

    const queued = runIndexRefreshAdmission(async () => "released");
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);
    releaseFirst();
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);
    releaseSecond();
    assert.strictEqual(await queued, "released");
  });

  it("reset rejects queued refresh admission and clears its test ledger", async () => {
    let release!: () => void;
    const background = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.strictEqual(
      await runIndexRefreshAdmission(async () => {
        retainIndexRefreshAdmissionUntil(background);
        return "accepted";
      }),
      "accepted",
    );
    const queued = runIndexRefreshAdmission(async () => "never");
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);

    resetToolDispatchLimiter();
    await assert.rejects(queued, /queue cleared/);
    assert.deepStrictEqual(_getIndexRefreshAdmissionStatsForTesting(), {
      active: 0,
      queued: 0,
      maxConcurrency: 1,
      totalActiveMs: 0,
      totalQueueMs: 0,
      totalRuns: 0,
      peakQueued: 0,
      peakActive: 0,
    });
    release();
    await delay(10);
  });

  it("uses the injected short queue timeout for refresh admission", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 8, queueTimeoutMs: 20 });
    let release!: () => void;
    const background = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.strictEqual(
      await runIndexRefreshAdmission(async () => {
        retainIndexRefreshAdmissionUntil(background);
        return "accepted";
      }),
      "accepted",
    );

    try {
      await assert.rejects(
        runIndexRefreshAdmission(async () => "late"),
        (error: unknown) => {
          assert.ok(error instanceof ToolDispatchQueueTimeoutError);
          assert.match(error.message, /timed out after 20ms/);
          assert.match(error.message, /index-refresh-admission/);
          assert.strictEqual(error.classification, "unavailable");
          assert.strictEqual(error.retryable, true);
          return true;
        },
      );
    } finally {
      release();
      await delay(0);
    }
  });

  it("bounds the public refresh admission queue", async () => {
    let release!: () => void;
    const background = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.strictEqual(
      await runIndexRefreshAdmission(async () => {
        retainIndexRefreshAdmissionUntil(background);
        return "accepted";
      }),
      "accepted",
    );

    const queued = Array.from({ length: 8 }, (_, index) =>
      runIndexRefreshAdmission(async () => `queued-${index}`),
    );
    const queuedSettled = Promise.allSettled(queued);
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 8);

    try {
      await assert.rejects(
        runIndexRefreshAdmission(async () => "overflow"),
        (error: unknown) => {
          assert.ok(error instanceof ToolDispatchQueueCapacityError);
          assert.match(error.message, /queue capacity of 8/);
          assert.strictEqual(error.classification, "unavailable");
          assert.strictEqual(error.retryable, true);
          return true;
        },
      );
    } finally {
      resetToolDispatchLimiter();
      release();
      await queuedSettled;
    }
  });

  it("removes disconnected refresh requests from the admission queue", async () => {
    let release!: () => void;
    const background = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.strictEqual(
      await runIndexRefreshAdmission(async () => {
        retainIndexRefreshAdmissionUntil(background);
        return "accepted";
      }),
      "accepted",
    );

    const controller = new AbortController();
    const queued = runIndexRefreshAdmission(
      async () => "must-not-run",
      controller.signal,
    );
    await delay(10);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 1);

    controller.abort(new Error("client disconnected"));
    await assert.rejects(queued, /client disconnected/);
    assert.strictEqual(_getIndexRefreshAdmissionStatsForTesting().queued, 0);
    release();
    await delay(0);
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

  it("does not report idle while dispatch work remains queued", async () => {
    configureToolDispatchLimiter({ maxConcurrency: 1, queueTimeoutMs: 1_000 });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondEntered = false;
    let idleSettled = false;
    const first = runToolDispatch(async () => firstBarrier);
    const second = runToolDispatch(async () => {
      secondEntered = true;
      await secondBarrier;
    });
    await delay(20);
    const wait = waitForToolDispatchIdle({
      activeAllowance: 1,
      timeoutMs: 1_000,
      pollMs: 2,
      label: "queued-drain-test",
    }).then((result) => {
      idleSettled = result;
    });

    try {
      await delay(20);
      assert.strictEqual(
        idleSettled,
        false,
        "queued work must drain before idle is reported",
      );
    } finally {
      releaseFirst();
    }
    await wait;
    assert.strictEqual(secondEntered, true);
    releaseSecond();
    await Promise.all([first, second]);
  });
});
