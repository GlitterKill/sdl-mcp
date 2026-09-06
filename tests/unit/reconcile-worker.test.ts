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

it("stops claiming queued work while retaining later accepted work", async () => {
  const queue = new ReconcileQueue();
  const worker = new ReconcileWorker(queue);
  worker.setReadiness("shutdown", () => false);
  worker.enqueue("shutdown", { ...frontier, dependentFilePaths: ["first.ts"] });
  worker.beginShutdown();
  worker.setReadiness("shutdown", () => true);
  worker.wake("shutdown");
  worker.enqueue("shutdown", { ...frontier, dependentFilePaths: ["second.ts"] });
  worker.requestInventory("shutdown", true);
  await worker.waitForIdle();
  assert.equal(queue.getStatus("shutdown").queueDepth, 3);
  assert.equal(queue.getStatus("shutdown").inflight, false);
  assert.equal(queue.getStatus("shutdown").lastError, null);
});

it("checkpoints exact pending paths and forced inventory across repeated recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdl-reconcile-recovery-"));
  try {
    const path = join(root, "graph.lbug");
    const firstQueue = new ReconcileQueue();
    const first = new ReconcileWorker(firstQueue);
    await first.recoverPending(path);
    first.beginShutdown();
    first.enqueue("restart", { ...frontier, dependentFilePaths: ["saved.ts", "removed.ts"] });
    first.requestInventory("restart", true);
    await first.persistPending();

    for (let restart = 0; restart < 2; restart++) {
      const queue = new ReconcileQueue();
      const worker = new ReconcileWorker(queue);
      worker.setReadiness("restart", () => false);
      await worker.recoverPending(path);
      assert.deepEqual(queue.snapshotPending(), firstQueue.snapshotPending());
      worker.beginShutdown();
      await worker.waitForIdle();
      await worker.persistPending();
    }
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "sdl-reconcile-recovery-")));
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects corrupt recovery paths without overwriting the retained checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdl-reconcile-invalid-"));
  try {
    const path = join(root, "graph.lbug");
    const marker = join(root, ".sdl-reconcile-graph.lbug.json");
    for (const filePath of ["../outside.ts", "..\\outside.ts", "C:\\outside.ts", "/outside.ts"]) {
      const content = JSON.stringify({
        version: 1,
        repos: [{
          repoId: "invalid", filePaths: [filePath], touchedSymbolIds: [],
          invalidations: [], inventoryNeeded: false, inventoryForce: false,
        }],
      });
      await writeFile(marker, content);
      const worker = new ReconcileWorker(new ReconcileQueue());
      await assert.rejects(worker.recoverPending(path), /relative to the repository/);
      worker.beginShutdown();
      await worker.persistPending();
      const { readFile } = await import("node:fs/promises");
      assert.equal(await readFile(marker, "utf8"), content);
    }
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), "sdl-reconcile-invalid-")));
    await rm(root, { recursive: true, force: true });
  }
});
