import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OverlayStore } from "../../dist/live-index/overlay-store.js";
import { CheckpointService } from "../../dist/live-index/checkpoint-service.js";
import { InMemoryLiveIndexCoordinator } from "../../dist/live-index/coordinator.js";

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
      publishSavedFile: async ({ filePath }) => {
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
      publishSavedFile: async () => {
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

  it("explains successful checkpoints that find no clean eligible drafts", async () => {
    const store = new OverlayStore();
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

    const checkpointService = new CheckpointService(store, {
      now: () => "2026-03-07T12:15:00.000Z",
      publishSavedFile: async () => undefined as never,
    });

    const result = await checkpointService.checkpointRepo({
      repoId: "demo-repo",
      reason: "manual",
    });

    assert.deepStrictEqual(result, {
      repoId: "demo-repo",
      requested: false,
      pending: true,
      pendingBuffers: 1,
      message:
        "No checkpoint-eligible clean buffers were available; dirty buffers remain pending.",
    });
    assert.deepStrictEqual(checkpointService.getStatus("demo-repo"), {
      repoId: "demo-repo",
      lastCheckpointAt: null,
      lastCheckpointAttemptAt: null,
      lastCheckpointResult: null,
      lastCheckpointError: null,
      lastCheckpointReason: null,
    });
  });

  it("explains checkpoints when no buffers are pending", async () => {
    const store = new OverlayStore();
    const checkpointService = new CheckpointService(store, {
      now: () => "2026-03-07T12:20:00.000Z",
      publishSavedFile: async () => undefined as never,
    });

    const request = {
      repoId: "demo-repo",
      reason: "manual",
    };
    const initialStatus = checkpointService.getStatus("demo-repo");
    const expected = {
      repoId: "demo-repo",
      requested: false,
      pending: false,
      message: "No checkpoint-eligible buffers were pending.",
    };

    const first = await checkpointService.checkpointRepo(request);
    const second = await checkpointService.checkpointRepo(request);

    assert.deepStrictEqual(first, expected);
    assert.deepStrictEqual(second, expected);
    assert.deepStrictEqual(
      checkpointService.getStatus("demo-repo"),
      initialStatus,
    );

    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "save",
      filePath: "src/clean.ts",
      content: "export const clean = 1;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:20:00.000Z",
    });
    const work = await checkpointService.checkpointRepo(request);
    assert.match(work.checkpointId ?? "", /-0$/);
  });

  it("resolves an explicit no-work checkpoint without waiting for parse jobs", async () => {
    const coordinator = new InMemoryLiveIndexCoordinator({
      sweepIntervalMs: 0,
    });
    const internals = coordinator as unknown as {
      parseScheduler: { waitForIdle: () => Promise<void> };
    };
    internals.parseScheduler.waitForIdle = () => new Promise<void>(() => {});

    const result = await Promise.race([
      coordinator.checkpointRepo({ repoId: "demo-repo", reason: "manual" }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("checkpoint waited for parse jobs")),
          100,
        ),
      ),
    ]);

    assert.strictEqual(result.pending, false);
    assert.match(result.message ?? "", /no checkpoint-eligible buffers/i);
    coordinator.reset();
  });

  it("does not acknowledge or remove a newer clean draft during publication", async () => {
    const store = new OverlayStore();
    const input = {
      repoId: "race",
      filePath: "a.ts",
      content: "save12",
      version: 12,
      eventType: "save" as const,
      dirty: false,
      timestamp: "fixture",
    };
    store.upsertDraft(input);
    const service = new CheckpointService(store, {
      publishSavedFile: async () => {
        store.upsertDraft({ ...input, version: 13, content: "save13" });
        return undefined as never;
      },
    });
    const result = await service.checkpointRepo({ repoId: "race" });
    assert.equal(result.checkpointedFiles, 0);
    assert.equal(store.getDraft("race", "a.ts")?.version, 13);
  });
});
