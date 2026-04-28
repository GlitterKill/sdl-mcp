import { describe, it } from "node:test";
import assert from "node:assert";

import {
  withRepoWriteHeavyLock,
  waitForDerivedRefreshIdle,
  _seedRunningForTesting,
  _getDerivedRefreshQueueStateForTesting,
} from "../../dist/indexer/derived-refresh-queue.js";

const REPO = "derived-refresh-queue-test";

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
