import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OverlayStore } from "../../dist/live-index/overlay-store.js";
import { CheckpointService } from "../../dist/live-index/checkpoint-service.js";

describe("CheckpointService", () => {
  it("evicts clean drafts after a successful checkpoint and records status", async () => {
    const store = new OverlayStore();
    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "save",
      filePath: "src/clean.ts",
      content: "export const clean = 1;",
      language: "typescript",
      version: 2,
      dirty: false,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/dirty.ts",
      content: "export const dirty = 2;",
      language: "typescript",
      version: 3,
      dirty: true,
      timestamp: "2026-03-07T12:01:00.000Z",
    });

    const patched: string[] = [];
    const checkpointService = new CheckpointService(store, {
      now: () => "2026-03-07T12:05:00.000Z",
      patchSavedFile: async ({ filePath }) => {
        patched.push(filePath);
        return undefined as never;
      },
    });

    const result = await checkpointService.checkpointRepo({
      repoId: "demo-repo",
      reason: "manual",
    });

    assert.deepStrictEqual(patched, ["src/clean.ts"]);
    assert.strictEqual(store.getDraft("demo-repo", "src/clean.ts"), null);
    assert.ok(store.getDraft("demo-repo", "src/dirty.ts"));
    assert.strictEqual(result.checkpointedFiles, 1);
    assert.strictEqual(result.failedFiles, 0);
    assert.strictEqual(result.pendingBuffers, 1);
    assert.strictEqual(result.lastCheckpointAt, "2026-03-07T12:05:00.000Z");

    const status = checkpointService.getStatus("demo-repo");
    assert.strictEqual(status.lastCheckpointResult, "success");
    assert.strictEqual(status.lastCheckpointError, null);
    assert.strictEqual(status.lastCheckpointReason, "manual");
  });

  it("keeps drafts recoverable when checkpointing fails", async () => {
    const store = new OverlayStore();
    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "save",
      filePath: "src/failing.ts",
      content: "export const broken = 1;",
      language: "typescript",
      version: 5,
      dirty: false,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    const checkpointService = new CheckpointService(store, {
      now: () => "2026-03-07T12:10:00.000Z",
      patchSavedFile: async () => {
        throw new Error("disk write failed");
      },
    });

    const result = await checkpointService.checkpointRepo({
      repoId: "demo-repo",
      reason: "idle",
    });

    assert.ok(store.getDraft("demo-repo", "src/failing.ts"));
    assert.strictEqual(result.checkpointedFiles, 0);
    assert.strictEqual(result.failedFiles, 1);
    assert.strictEqual(result.pendingBuffers, 1);

    const status = checkpointService.getStatus("demo-repo");
    assert.strictEqual(status.lastCheckpointResult, "failed");
    assert.match(status.lastCheckpointError ?? "", /disk write failed/i);
    assert.strictEqual(status.lastCheckpointReason, "idle");
  });
});
