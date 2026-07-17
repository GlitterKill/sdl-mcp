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
  it("drains an admitted sweep and skips a late sweep after removal", async () => {
    resetRepoLifecycleForTests();
    const repoId = "sweep-removal-race";
    const coordinator = new InMemoryLiveIndexCoordinator({ sweepIntervalMs: 0 });
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
      coordinator.getOverlayStore().getDraft("demo-repo", "src/example.ts")?.content,
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
