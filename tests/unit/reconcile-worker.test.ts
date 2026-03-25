import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

describe("ReconcileWorker", () => {
  it("processes a re-enqueued file again within the same drain", async () => {
    const queue = new ReconcileQueue();
    const patchCalls: string[] = [];

    const worker = new ReconcileWorker(queue, {
      clusterScheduler: {
        schedule: async () => undefined,
        waitForIdle: async () => undefined,
      },
      patchSavedFile: async (...args: any[]) => {
        const [{ filePath }] = args as [{ filePath: string }];
        patchCalls.push(filePath);
        return {
          frontier: {
            touchedSymbolIds: [],
            dependentSymbolIds: [],
            dependentFilePaths: patchCalls.length === 1 ? ["src/a.ts"] : [],
            importedFilePaths: [],
            invalidations: [],
          },
        };
      },
      planReconcileWork: () => ({
        filePaths: ["src/a.ts"],
        recomputeDerivedData: false,
      }),
    });

    worker.enqueue(
      "demo-repo",
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/a.ts"],
        importedFilePaths: [],
        invalidations: [],
      },
      "2026-03-18T18:00:00.000Z",
    );

    await worker.waitForIdle();

    assert.deepEqual(patchCalls, ["src/a.ts", "src/a.ts"]);
    assert.strictEqual(queue.getStatus("demo-repo").queueDepth, 0);
  });

  it("waitForIdle timeout resolves even when no other handles keep the process alive", () => {
    const script = `
      import { ReconcileQueue } from "./dist/live-index/reconcile-queue.js";
      import { ReconcileWorker } from "./dist/live-index/reconcile-worker.js";

      const worker = new ReconcileWorker(new ReconcileQueue(), {
        clusterScheduler: {
          schedule() {},
          async waitForIdle() {},
        },
        patchSavedFile: async () => ({
          frontier: {
            touchedSymbolIds: [],
            dependentSymbolIds: [],
            dependentFilePaths: [],
            importedFilePaths: [],
            invalidations: [],
          },
        }),
        planReconcileWork: () => ({
          filePaths: [],
          recomputeDerivedData: false,
        }),
      });

      worker.draining = true;
      worker.pendingDrain = null;
      await worker.waitForIdle(40);
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
    assert.match(result.stdout, /done/);
  });
});
