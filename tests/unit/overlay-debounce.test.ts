import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDebouncedJobScheduler } from "../../dist/live-index/debounce.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

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

  it("waitForIdle keeps the process alive until a scheduled job completes", () => {
    const script = `
      import { createDebouncedJobScheduler } from "./dist/live-index/debounce.js";

      const scheduler = createDebouncedJobScheduler({
        delayMs: 40,
        async run() {
          console.log("ran");
        },
      });

      scheduler.schedule("demo-repo:src/example.ts", 1);
      await scheduler.waitForIdle();
      console.log("done");
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
      },
    );

    assert.strictEqual(
      result.status,
      0,
      `Expected child to exit successfully.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
    assert.match(result.stdout, /ran/);
    assert.match(result.stdout, /done/);
  });
});
