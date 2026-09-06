import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";
import {
  beginRepoRemoval,
  captureActiveRepoEpoch,
  resetRepoLifecycleForTests,
} from "../../dist/services/repo-lifecycle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("InMemoryLiveIndexCoordinator", () => {
  it("does not replace a newer unsaved parse when saved admission settles late", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      debounceMs: 60_000,
      sweepIntervalMs: 0,
    });
    const entered = deferred();
    const release = deferred();
    coordinator.acceptSavedFile = async () => {
      entered.resolve();
      await release.promise;
      return true;
    };
    const scheduled: number[] = [];
    const internals = coordinator as unknown as {
      parseScheduler: {
        schedule: (
          key: string,
          value: { input: { version: number } },
        ) => Promise<void>;
      };
    };
    internals.parseScheduler.schedule = async (_key, value) => {
      scheduled.push(value.input.version);
    };
    const input = {
      repoId: "save-parse-race",
      filePath: "a.ts",
      content: "export const value = 12;",
      language: "typescript",
      version: 12,
      dirty: false,
      timestamp: "2026-09-06T00:00:00Z",
      eventType: "save" as const,
    };
    const saving = coordinator.pushBufferUpdate(input);
    await entered.promise;
    await coordinator.pushBufferUpdate({
      ...input,
      version: 13,
      content: "export const draft = 13;",
      dirty: true,
      eventType: "change",
    });
    release.resolve();
    const saved = await saving;
    assert.equal(saved.accepted, true);
    assert.equal(saved.parseScheduled, false);
    assert.deepEqual(scheduled, [13]);
    assert.equal(
      coordinator.getOverlayStore().getDraft(input.repoId, input.filePath)
        ?.version,
      13,
    );
    await coordinator.close();
  });
  it("closes admission and drains an accepted debounced parse", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      debounceMs: 0,
      sweepIntervalMs: 0,
    });
    const parseEntered = deferred();
    const releaseParse = deferred();
    const internals = coordinator as unknown as {
      loadRepoRoot: (repoId: string) => Promise<string>;
    };
    internals.loadRepoRoot = async () => {
      parseEntered.resolve();
      await releaseParse.promise;
      return process.cwd();
    };

    const accepted = await coordinator.pushBufferUpdate({
      repoId: "closing-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    assert.equal(accepted.accepted, true);
    await parseEntered.promise;

    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    const late = await coordinator.pushBufferUpdate({
      repoId: "closing-repo",
      eventType: "change",
      filePath: "src/late.ts",
      content: "export const late = true;",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-07T12:00:01.000Z",
    });
    assert.deepEqual(late, {
      accepted: false,
      repoId: "closing-repo",
      overlayVersion: 1,
      parseScheduled: false,
      checkpointScheduled: false,
      warnings: ["Live indexing stopped."],
    });

    releaseParse.resolve();
    await closing;
    await coordinator.close();
  });

  it("waits for an accepted sweep before closing", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      sweepIntervalMs: 1,
    });
    coordinator.getOverlayStore().upsertDraft({
      repoId: "sweep-close-repo",
      eventType: "save",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    const sweepEntered = deferred();
    const releaseSweep = deferred();
    const internals = coordinator as unknown as {
      checkpointService: {
        checkpointRepo: (input: { repoId: string }) => Promise<unknown>;
      };
    };
    internals.checkpointService.checkpointRepo = async () => {
      sweepEntered.resolve();
      await releaseSweep.promise;
      return {};
    };
    await sweepEntered.promise;

    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);

    releaseSweep.resolve();
    await closing;
  });

  it("waits for an accepted checkpoint before closing", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      sweepIntervalMs: 0,
    });
    const checkpointEntered = deferred();
    const releaseCheckpoint = deferred();
    const internals = coordinator as unknown as {
      checkpointService: {
        checkpointRepo: (input: { repoId: string }) => Promise<unknown>;
      };
    };
    internals.checkpointService.checkpointRepo = async () => {
      checkpointEntered.resolve();
      await releaseCheckpoint.promise;
      return {
        repoId: "checkpoint-close-repo",
        requested: true,
        pending: false,
      };
    };
    const checkpoint = coordinator.checkpointRepo({
      repoId: "checkpoint-close-repo",
    });
    await checkpointEntered.promise;

    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);

    releaseCheckpoint.resolve();
    await Promise.all([checkpoint, closing]);
  });

  it("returns the static no-work checkpoint response when disabled", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({ enabled: false });

    const first = await coordinator.checkpointRepo({
      repoId: "disabled-repo",
      reason: "explicit",
    });
    const second = await coordinator.checkpointRepo({
      repoId: "disabled-repo",
      reason: "explicit",
    });

    const expected = {
      repoId: "disabled-repo",
      requested: false,
      pending: false,
      message: "No checkpoint-eligible buffers were pending.",
    };
    assert.deepStrictEqual(first, expected);
    assert.deepStrictEqual(second, expected);
    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    coordinator.reset();
  });

  it("drains an admitted sweep and skips a late sweep after removal", async () => {
    resetRepoLifecycleForTests();
    const repoId = "sweep-removal-race";
    const coordinator = new InMemoryLiveIndexCoordinator({
      sweepIntervalMs: 0,
    });
    coordinator.getOverlayStore().upsertDraft({
      repoId,
      eventType: "save",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-07-17T12:00:00.000Z",
    });
    const entered = deferred();
    const release = deferred();
    let checkpointCalls = 0;
    const internals = coordinator as unknown as {
      checkpointService: {
        checkpointRepo: (input: { repoId: string }) => Promise<unknown>;
      };
      sweepOverlay: () => Promise<void>;
    };
    internals.checkpointService.checkpointRepo = async () => {
      checkpointCalls += 1;
      entered.resolve();
      await release.promise;
      return {};
    };

    const sweep = internals.sweepOverlay();
    await entered.promise;
    let removalSettled = false;
    const removalPromise = beginRepoRemoval(repoId).finally(() => {
      removalSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(captureActiveRepoEpoch(repoId), undefined);
    assert.strictEqual(removalSettled, false);

    release.resolve();
    await sweep;
    const removal = await removalPromise;
    removal.commitTombstone();

    await internals.sweepOverlay();
    assert.strictEqual(checkpointCalls, 1);
    coordinator.reset();
  });

  it("rejects equal-version retries as stale updates", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator();
    coordinator.getOverlayStore().upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 3,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    const result = await coordinator.pushBufferUpdate({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 2;",
      language: "typescript",
      version: 3,
      dirty: true,
      timestamp: "2026-03-07T12:00:01.000Z",
    });

    assert.deepStrictEqual(result, {
      accepted: false,
      repoId: "demo-repo",
      overlayVersion: 3,
      parseScheduled: false,
      checkpointScheduled: false,
      warnings: ["Ignored stale buffer update."],
    });
    assert.strictEqual(
      coordinator.getOverlayStore().getDraft("demo-repo", "src/example.ts")
        ?.content,
      "export const value = 1;",
    );
  });

  it("accepts newer close events without stale-version warnings", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator();
    coordinator.getOverlayStore().upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    const result = await coordinator.pushBufferUpdate({
      repoId: "demo-repo",
      eventType: "close",
      filePath: "src/example.ts",
      content: "",
      language: "typescript",
      version: 2,
      dirty: false,
      timestamp: "2026-03-07T12:00:01.000Z",
    });

    assert.strictEqual(result.accepted, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(
      coordinator.getOverlayStore().getDraft("demo-repo", "src/example.ts"),
      null,
    );
  });

  it("warns when close events are older than the draft", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator();
    coordinator.getOverlayStore().upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    const result = await coordinator.pushBufferUpdate({
      repoId: "demo-repo",
      eventType: "close",
      filePath: "src/example.ts",
      content: "",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:00:01.000Z",
    });

    assert.deepStrictEqual(result.warnings, [
      "Close event version 1 does not match draft version 2.",
    ]);
  });
});

it("does not wake retained failed reconciliation after coordinator close", async () => {
  const coordinator = new InMemoryLiveIndexCoordinator({
    enabled: false,
    sweepIntervalMs: 0,
  });
  const internals = coordinator as unknown as {
    reconcileQueue: import("../../dist/live-index/reconcile-queue.js").ReconcileQueue;
    reconcileWorker: { invalidateSourceContext(repoId: string): void };
  };
  const queue = internals.reconcileQueue;
  queue.enqueue(
    "closed",
    {
      touchedSymbolIds: [],
      dependentSymbolIds: [],
      dependentFilePaths: ["a.ts"],
      importedFilePaths: [],
      invalidations: [],
    },
    "now",
  );
  queue.fail(queue.claimNext()!, "now", "provider unavailable");
  let wakes = 0;
  internals.reconcileWorker.invalidateSourceContext = () => {
    wakes++;
  };
  await coordinator.close();
  coordinator.invalidateSourceContext("closed");
  assert.equal(wakes, 0);
  assert.equal(queue.getStatus("closed").queueDepth, 1);
  assert.equal(queue.peekNext(), false);
});
