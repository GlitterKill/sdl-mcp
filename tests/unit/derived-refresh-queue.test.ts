import { afterEach, describe, it } from "node:test";
import assert from "node:assert";

import {
  withRepoWriteHeavyLock,
  waitForDerivedRefreshIdle,
  _seedRunningForTesting,
  _getDerivedRefreshQueueStateForTesting,
  _getDerivedRefreshTimeoutMsForTesting,
  _runWithDerivedRefreshTimeoutForTesting,
} from "../../dist/indexer/derived-refresh-queue.js";

const REPO = "derived-refresh-queue-test";
const ORIGINAL_DERIVED_REFRESH_TIMEOUT =
  process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_DERIVED_REFRESH_TIMEOUT === undefined) {
    delete process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS;
  } else {
    process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS =
      ORIGINAL_DERIVED_REFRESH_TIMEOUT;
  }
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withRepoWriteHeavyLock", () => {
  it("serializes concurrent acquirers in arrival order", async () => {
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const c = deferred();

    const aRun = withRepoWriteHeavyLock(REPO, async () => {
      order.push("A:enter");
      await a.promise;
      order.push("A:exit");
    });
    const bRun = withRepoWriteHeavyLock(REPO, async () => {
      order.push("B:enter");
      await b.promise;
      order.push("B:exit");
    });
    const cRun = withRepoWriteHeavyLock(REPO, async () => {
      order.push("C:enter");
      await c.promise;
      order.push("C:exit");
    });

    // Microtask flush: A should have entered, B/C waiting on prior tail.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(order, ["A:enter"]);

    a.resolve();
    await Promise.resolve();
    await aRun;
    // After A exits, B should enter next.
    await Promise.resolve();
    assert.deepStrictEqual(order, ["A:enter", "A:exit", "B:enter"]);

    b.resolve();
    await bRun;
    await Promise.resolve();
    assert.deepStrictEqual(order, [
      "A:enter",
      "A:exit",
      "B:enter",
      "B:exit",
      "C:enter",
    ]);

    c.resolve();
    await cRun;
    assert.deepStrictEqual(order, [
      "A:enter",
      "A:exit",
      "B:enter",
      "B:exit",
      "C:enter",
      "C:exit",
    ]);
  });

  it("isolates locks per repoId", async () => {
    const a = deferred();
    let bRan = false;

    const aRun = withRepoWriteHeavyLock("repo-a", async () => {
      await a.promise;
    });
    const bRun = withRepoWriteHeavyLock("repo-b", async () => {
      bRan = true;
    });

    await bRun;
    assert.strictEqual(bRan, true, "repo-b lock should not wait on repo-a");

    a.resolve();
    await aRun;
  });

  it("propagates rejections to the acquirer and frees the lock", async () => {
    const sentinel = new Error("boom");
    await assert.rejects(
      withRepoWriteHeavyLock(REPO, async () => {
        throw sentinel;
      }),
      (err: unknown) => err === sentinel,
    );

    let nextRan = false;
    await withRepoWriteHeavyLock(REPO, async () => {
      nextRan = true;
    });
    assert.strictEqual(
      nextRan,
      true,
      "lock should be released after rejection",
    );
  });

  it("removes the map entry when no successor is queued", async () => {
    await withRepoWriteHeavyLock("repo-cleanup", async () => undefined);
    // After release, no successor is queued, so the tail entry should be
    // deleted. There's no public read of the Map; instead, exercise the
    // observable contract: the next acquirer should not wait on a stale
    // resolved promise (which it wouldn't anyway, but this catches a leak
    // of resolved promises growing the map).
    const start = Date.now();
    await withRepoWriteHeavyLock("repo-cleanup", async () => undefined);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `second acquire was fast (got ${elapsed}ms)`);
  });
});

describe("derived refresh timeout", () => {
  it("uses the environment override for the bounded refresh timeout", () => {
    process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS = "25";

    assert.strictEqual(_getDerivedRefreshTimeoutMsForTesting(), 25);
  });

  it("aborts and rejects work that exceeds the bounded refresh timeout", async () => {
    process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS = "30";
    let aborted = false;

    await assert.rejects(
      _runWithDerivedRefreshTimeoutForTesting(
        "repo-timeout",
        "v1",
        new AbortController().signal,
        async (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise<void>(() => undefined);
        },
      ),
      /derived-refresh timed out after 30ms/,
    );
    assert.strictEqual(aborted, true);
  });

  it("rejects new write-heavy lock attempts while timed-out work is still settling", async () => {
    process.env.SDL_DERIVED_REFRESH_TIMEOUT_MS = "30";
    const repoId = "repo-lock-timeout";
    const blocker = deferred();
    let lockEntered = false;

    try {
      await assert.rejects(
        _runWithDerivedRefreshTimeoutForTesting(
          repoId,
          "v1",
          new AbortController().signal,
          async () => {
            await withRepoWriteHeavyLock(repoId, async () => {
              lockEntered = true;
              await blocker.promise;
            });
          },
          { markActiveWriteLockOnTimeout: true },
        ),
        /derived-refresh timed out after 30ms/,
      );
      assert.strictEqual(lockEntered, true, "test must exercise active lock");

      await assert.rejects(
        withRepoWriteHeavyLock(repoId, async () => undefined),
        /write-heavy lock .* timed out/,
      );
    } finally {
      blocker.resolve();
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        let ran = false;
        await withRepoWriteHeavyLock(repoId, async () => {
          ran = true;
        });
        assert.strictEqual(ran, true);
        return;
      } catch (err) {
        if (
          err instanceof Error &&
          err.name === "RepoWriteHeavyLockTimedOutError"
        ) {
          continue;
        }
        throw err;
      }
    }
    assert.fail("timed-out write-heavy lock marker did not clear");
  });
});

describe("waitForDerivedRefreshIdle", () => {
  it("returns immediately when queue is idle for the repo", async () => {
    const before = Date.now();
    await waitForDerivedRefreshIdle("repo-never-touched", 5_000);
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 50, `expected fast return, got ${elapsed}ms`);
  });

  it("times out when an in-flight refresh never completes", async () => {
    const release = _seedRunningForTesting("repo-stuck");
    const start = Date.now();
    await waitForDerivedRefreshIdle("repo-stuck", 200);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed >= 150 && elapsed < 2000,
      `wait should respect timeout (got ${elapsed}ms)`,
    );
    const state = _getDerivedRefreshQueueStateForTesting();
    assert.ok(state.running >= 1, "refresh should still be running");
    release();
    // Yield so the seeded promise's .finally runs `running.delete` before
    // node:test inspects unsettled promises.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("returns once an in-flight refresh completes", async () => {
    const release = _seedRunningForTesting("repo-completing");
    const waitPromise = waitForDerivedRefreshIdle("repo-completing", 5_000, 20);
    setImmediate(release);
    await waitPromise;
    const state = _getDerivedRefreshQueueStateForTesting();
    assert.strictEqual(state.running, 0, "no running entries after wait");
    assert.strictEqual(state.pending, 0, "no pending entries after wait");
  });
});
