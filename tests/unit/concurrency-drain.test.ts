import { describe, it } from "node:test";
import assert from "node:assert";
import { ConcurrencyLimiter } from "../../dist/util/concurrency.js";

describe("ConcurrencyLimiter drain()", () => {
  it("should resolve immediately when no tasks are active", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2 });
    await limiter.drain();
    // Should complete without hanging
    assert.ok(true);
  });

  it("should wait for active tasks to complete", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2 });
    let completed = false;

    limiter.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      completed = true;
    });

    await limiter.drain();
    assert.strictEqual(completed, true);
  });

  it("should wait for queued tasks to complete", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 1 });
    const results: number[] = [];

    limiter.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      results.push(1);
    });
    limiter.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      results.push(2);
    });
    limiter.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      results.push(3);
    });

    await limiter.drain();
    assert.deepStrictEqual(results, [1, 2, 3]);
  });

  it("should respect concurrency limit", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrency: 2 });
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 6 }, () =>
      limiter.run(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((resolve) => setTimeout(resolve, 20));
        current--;
      }),
    );

    await Promise.all(tasks);
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
  });
});
