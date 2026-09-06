import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";
import {
  beginRepoRemoval,
  captureActiveRepoEpoch,
  resetRepoLifecycleForTests,
} from "../../dist/services/repo-lifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReconcileWorker", () => {
  it("clears queued work and cancels the exact repository cluster job", () => {
    const queue = new ReconcileQueue();
    const cancelled: string[] = [];
    queue.enqueue(
      "repo:child",
      {
        touchedSymbolIds: ["symbol"],
        dependentSymbolIds: [],
        dependentFilePaths: [],
        importedFilePaths: [],
        invalidations: ["clusters"],
      },
      "2026-07-17T00:00:00.000Z",
    );
    const worker = new ReconcileWorker(queue, {
      clusterScheduler: {
        schedule: async () => undefined,
        cancel: (repoId) => cancelled.push(repoId),
        waitForIdle: async () => undefined,
      },
    });

    worker.clearRepo("repo:child");

    assert.deepEqual(cancelled, ["repo:child"]);
    assert.strictEqual(queue.getStatus("repo:child").queueDepth, 0);
  });

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

  it("drains an admitted patch before removal and rejects later reconcile work", async () => {
    resetRepoLifecycleForTests();
    const repoId = "reconcile-removal-race";
    const queue = new ReconcileQueue();
    const entered = deferred();
    const release = deferred();
    let patchCalls = 0;
    const worker = new ReconcileWorker(queue, {
      clusterScheduler: {
        schedule: async () => undefined,
        waitForIdle: async () => undefined,
      },
      patchSavedFile: async () => {
        patchCalls += 1;
        entered.resolve();
        await release.promise;
        return {
          frontier: {
            touchedSymbolIds: [],
            dependentSymbolIds: [],
            dependentFilePaths: [],
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
      repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/a.ts"],
        importedFilePaths: [],
        invalidations: [],
      },
      "2026-07-17T00:00:00.000Z",
    );
    await entered.promise;

    let removalSettled = false;
    const removalPromise = beginRepoRemoval(repoId).finally(() => {
      removalSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(captureActiveRepoEpoch(repoId), undefined);
    assert.strictEqual(removalSettled, false);

    release.resolve();
    const removal = await removalPromise;
    removal.commitTombstone();
    await worker.waitForIdle();

    worker.enqueue(
      repoId,
      {
        touchedSymbolIds: [],
        dependentSymbolIds: [],
        dependentFilePaths: ["src/late.ts"],
        importedFilePaths: [],
        invalidations: [],
      },
      "2026-07-17T00:00:01.000Z",
    );
    await worker.waitForIdle();
    assert.strictEqual(patchCalls, 1);
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

it("retains a failed patch while successful siblings finish without automatic retry", async () => {
  const queue = new ReconcileQueue();
  const calls: string[] = [];
  const worker = new ReconcileWorker(queue, {
    clusterScheduler: { schedule() {}, async waitForIdle() {} },
    planReconcileWork: () => ({
      filePaths: ["a.ts", "b.ts"],
      recomputeDerivedData: false,
    }),
    patchSavedFile: async ({ filePath }) => {
      calls.push(filePath);
      if (filePath === "a.ts") throw new Error("missing parser");
      return {
        frontier: {
          touchedSymbolIds: [],
          dependentSymbolIds: [],
          dependentFilePaths: [],
          importedFilePaths: [],
          invalidations: [],
        },
      };
    },
  });
  worker.enqueue("failure-siblings", {
    touchedSymbolIds: [],
    dependentSymbolIds: [],
    dependentFilePaths: ["a.ts", "b.ts"],
    importedFilePaths: [],
    invalidations: [],
  });
  await worker.waitForIdle();
  assert.deepEqual(calls, ["a.ts", "b.ts"]);
  assert.equal(queue.getStatus("failure-siblings").queueDepth, 1);
  assert.equal(queue.getStatus("failure-siblings").lastError, "missing parser");
  assert.equal(queue.peekNext(), false);
});

it("does not acknowledge inventory recovery through the legacy worker", async () => {
  const queue = new ReconcileQueue();
  const worker = new ReconcileWorker(queue, {
    clusterScheduler: { schedule() {}, async waitForIdle() {} },
    planReconcileWork: () => ({ filePaths: [], recomputeDerivedData: false }),
  });
  worker.enqueue("overflow", {
    touchedSymbolIds: [],
    dependentSymbolIds: [],
    dependentFilePaths: Array.from({ length: 10_001 }, (_, i) => `file${i}.ts`),
    importedFilePaths: [],
    invalidations: [],
  });
  await worker.waitForIdle();
  assert.ok(queue.getStatus("overflow").queueDepth > 0);
  assert.equal(queue.peekNext(), false);
});

for (const failB of [false, true]) {
  it(`settles A before its B frontier and ${failB ? "retains B failure" : "finishes the noncyclic batch"}`, async () => {
    const queue = new ReconcileQueue();
    const calls: string[] = [];
    const repoId = `dependency-batch-${failB}`;
    const worker = new ReconcileWorker(queue, {
      clusterScheduler: { schedule() {}, async waitForIdle() {} },
      planReconcileWork: ({ frontier }) => ({
        filePaths: frontier.dependentFilePaths,
        recomputeDerivedData: false,
      }),
      patchSavedFile: async ({ filePath }) => {
        calls.push(filePath);
        // Bound the regression without waiting for the production drain limit.
        if (calls.length > 6) {
          worker.clearRepo(repoId);
          throw new Error("noncyclic frontier repeated");
        }
        if (filePath === "b.ts" && failB)
          throw new Error("B parser unavailable");
        return {
          frontier: {
            touchedSymbolIds: [],
            dependentSymbolIds: [],
            dependentFilePaths: filePath === "a.ts" ? ["b.ts"] : [],
            importedFilePaths: [],
            invalidations: [],
          },
        };
      },
    });
    worker.enqueue(repoId, {
      touchedSymbolIds: [],
      dependentSymbolIds: [],
      dependentFilePaths: ["a.ts", "b.ts"],
      importedFilePaths: [],
      invalidations: [],
    });
    await worker.waitForIdle();
    assert.deepEqual(calls, ["a.ts", "b.ts"]);
    assert.equal(queue.getStatus(repoId).queueDepth, failB ? 1 : 0);
    assert.equal(
      queue.getStatus(repoId).lastError,
      failB ? "B parser unavailable" : null,
    );
    assert.equal(queue.peekNext(), false);
  });
}
