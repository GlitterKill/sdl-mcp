import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReconcileQueue } from "../../src/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../src/live-index/reconcile-worker.js";

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
});
