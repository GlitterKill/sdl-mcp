import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDebouncedJobScheduler } from "../../src/live-index/debounce.js";

describe("createDebouncedJobScheduler", () => {
  it("coalesces rapid updates for the same file into one parse job", async () => {
    const runs: Array<{ key: string; payload: number }> = [];
    const scheduler = createDebouncedJobScheduler<number>({
      delayMs: 20,
      async run(key, payload) {
        runs.push({ key, payload });
      },
    });

    scheduler.schedule("demo-repo:src/example.ts", 1);
    scheduler.schedule("demo-repo:src/example.ts", 2);

    await scheduler.waitForIdle();

    assert.deepStrictEqual(runs, [
      { key: "demo-repo:src/example.ts", payload: 2 },
    ]);
    assert.strictEqual(scheduler.size(), 0);
  });
});
