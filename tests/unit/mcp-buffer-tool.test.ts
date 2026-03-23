import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleBufferCheckpoint,
  handleBufferPush,
  handleBufferStatus,
} from "../../dist/mcp/tools/buffer.js";

describe("buffer MCP tools", () => {
  it("pushes buffer updates through the live index coordinator", async () => {
    const calls: unknown[] = [];
    const result = await handleBufferPush(
      {
        repoId: "demo-repo",
        eventType: "change",
        filePath: "src/example.ts",
        content: "export const value = 1;",
        language: "typescript",
        version: 7,
        dirty: true,
        timestamp: "2026-03-07T12:00:00.000Z",
      },
      undefined,
      {
        async pushBufferUpdate(payload) {
          calls.push(payload);
          return {
            accepted: true,
            repoId: "demo-repo",
            overlayVersion: 7,
            parseScheduled: true,
            checkpointScheduled: false,
            warnings: [],
          };
        },
        async checkpointRepo() {
          throw new Error("not used");
        },
        async getLiveStatus() {
          throw new Error("not used");
        },
      },
    );

    assert.deepStrictEqual(calls, [
      {
        repoId: "demo-repo",
        eventType: "change",
        filePath: "src/example.ts",
        content: "export const value = 1;",
        language: "typescript",
        version: 7,
        dirty: true,
        timestamp: "2026-03-07T12:00:00.000Z",
      },
    ]);
    assert.strictEqual(result.overlayVersion, 7);
  });

  it("reports live buffer status", async () => {
    const result = await handleBufferStatus(
      { repoId: "demo-repo" },
      undefined,
      {
        async pushBufferUpdate() {
          throw new Error("not used");
        },
        async checkpointRepo() {
          throw new Error("not used");
        },
        async getLiveStatus(repoId) {
          return {
            repoId,
            enabled: true,
            pendingBuffers: 2,
            dirtyBuffers: 1,
            parseQueueDepth: 1,
            checkpointPending: true,
            lastBufferEventAt: "2026-03-07T12:00:00.000Z",
            lastCheckpointAt: null,
            lastCheckpointAttemptAt: "2026-03-07T12:01:00.000Z",
            lastCheckpointResult: "partial" as const,
            lastCheckpointError: "disk full",
            lastCheckpointReason: "idle",
          };
        },
      },
    );

    assert.strictEqual(result.pendingBuffers, 2);
    assert.strictEqual(result.checkpointPending, true);
    assert.strictEqual(result.lastCheckpointResult, "partial");
  });

  it("requests an explicit checkpoint", async () => {
    const calls: unknown[] = [];
    const result = await handleBufferCheckpoint(
      {
        repoId: "demo-repo",
        reason: "manual",
      },
      undefined,
      {
        async pushBufferUpdate() {
          throw new Error("not used");
        },
        async checkpointRepo(payload) {
          calls.push(payload);
          return {
            repoId: payload.repoId,
            requested: true,
            checkpointId: "ckpt-1",
            pendingBuffers: 1,
            checkpointedFiles: 2,
            failedFiles: 0,
            lastCheckpointAt: "2026-03-07T12:02:00.000Z",
          };
        },
        async getLiveStatus() {
          throw new Error("not used");
        },
      },
    );

    assert.deepStrictEqual(calls, [{ repoId: "demo-repo", reason: "manual" }]);
    assert.strictEqual(result.checkpointId, "ckpt-1");
    assert.strictEqual(result.checkpointedFiles, 2);
  });
});
