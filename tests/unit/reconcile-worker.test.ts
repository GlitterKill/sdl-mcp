import { hash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoConfigSchema } from "../../dist/config/types.js";
import { captureReconcileDependencyInputs } from "../../dist/live-index/reconcile-planner.js";
import { it } from "node:test";
import assert from "node:assert/strict";
import { ReconcileQueue } from "../../dist/live-index/reconcile-queue.js";
import { ReconcileWorker } from "../../dist/live-index/reconcile-worker.js";
import { beginRepoRemoval } from "../../dist/services/repo-lifecycle.js";

const frontier = {
  touchedSymbolIds: [],
  dependentSymbolIds: [],
  dependentFilePaths: [],
  importedFilePaths: [],
  invalidations: [],
};

it("clears only the exact repository queue", () => {
  const queue = new ReconcileQueue();
  queue.enqueue("repo", { ...frontier, dependentFilePaths: ["a.ts"] }, "now");
  queue.enqueue(
    "repo:child",
    { ...frontier, dependentFilePaths: ["b.ts"] },
    "now",
  );
  new ReconcileWorker(queue).clearRepo("repo");
  assert.equal(queue.getStatus("repo").queueDepth, 0);
  assert.equal(queue.getStatus("repo:child").queueDepth, 1);
});

it("does not start broad derived jobs for metadata-only frontiers", async () => {
  const queue = new ReconcileQueue();
  let preparations = 0;
  const worker = new ReconcileWorker(queue, {
    prepareReconcileFiles: async () => {
      preparations++;
      throw new Error("unexpected provider execution");
    },
  });
  worker.enqueue("metadata", {
    ...frontier,
    invalidations: ["clusters", "processes"],
  });
  await worker.waitForIdle();
  assert.equal(preparations, 0);
  assert.equal(queue.getStatus("metadata").queueDepth, 0);
});

it("retains inventory and source work until explicit write-readiness wake", async () => {
  const queue = new ReconcileQueue();
  const worker = new ReconcileWorker(queue);
  worker.setReadiness("inventory", () => false);
  worker.requestInventory("inventory");
  worker.enqueue("inventory", { ...frontier, dependentFilePaths: ["a.ts"] });
  await worker.waitForIdle();
  assert.equal(queue.getStatus("inventory").queueDepth, 2);
  assert.equal(queue.getStatus("inventory").lastError, null);
  assert.equal(queue.getStatus("inventory").inflight, false);
});

it("rejects later work after repository removal", async () => {
  const repoId = "removed-worker";
  const removal = await beginRepoRemoval(repoId);
  removal.commitTombstone();
  const queue = new ReconcileQueue();
  const worker = new ReconcileWorker(queue);
  assert.equal(
    worker.enqueue(repoId, { ...frontier, dependentFilePaths: ["late.ts"] }),
    false,
  );
  await worker.waitForIdle();
  assert.equal(queue.getStatus(repoId).queueDepth, 0);
});

it("captures a binary project input with the same raw SHA256 used by preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdl-reconcile-inputs-"));
  try {
    const bytes = Buffer.from([0, 255, 254, 128, 65]);
    await writeFile(join(root, "bun.lockb"), bytes);
    const config = RepoConfigSchema.parse({ repoId: "binary", rootPath: root });
    assert.deepEqual(
      await captureReconcileDependencyInputs(root, config, ["a.ts"]),
      [{ path: "bun.lockb", contentHash: hash("sha256", bytes, "hex") }],
    );
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "sdl-reconcile-inputs-")));
    await rm(root, { recursive: true, force: true });
  }
});
