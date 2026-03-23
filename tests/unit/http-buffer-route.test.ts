import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  routeLiveIndexApiRequest,
  type LiveIndexApiRequest,
} from "../../dist/cli/transport/http.js";

describe("live index HTTP routing", () => {
  it("routes buffer updates to the live index coordinator", async () => {
    const calls: Array<{ kind: string; payload: unknown }> = [];
    const response = await routeLiveIndexApiRequest(
      {
        method: "POST",
        pathname: "/api/repo/demo-repo/buffer",
        body: {
          eventType: "change",
          filePath: "src/example.ts",
          content: "export const value = 1;",
          language: "typescript",
          version: 2,
          dirty: true,
          timestamp: "2026-03-07T12:00:00.000Z",
        },
      } satisfies LiveIndexApiRequest,
      {
        liveIndex: {
          async pushBufferUpdate(payload) {
            calls.push({ kind: "push", payload });
            return {
              accepted: true,
              repoId: "demo-repo",
              overlayVersion: 2,
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
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 202);
    assert.deepStrictEqual(calls, [
      {
        kind: "push",
        payload: {
          repoId: "demo-repo",
          eventType: "change",
          filePath: "src/example.ts",
          content: "export const value = 1;",
          language: "typescript",
          version: 2,
          dirty: true,
          timestamp: "2026-03-07T12:00:00.000Z",
        },
      },
    ]);
  });

  it("rejects invalid buffer event payloads", async () => {
    const response = await routeLiveIndexApiRequest(
      {
        method: "POST",
        pathname: "/api/repo/demo-repo/buffer",
        body: {
          eventType: "bogus",
          filePath: "src/example.ts",
          content: "x",
          version: 1,
          dirty: true,
          timestamp: "2026-03-07T12:00:00.000Z",
        },
      } satisfies LiveIndexApiRequest,
      {
        liveIndex: {
          async pushBufferUpdate() {
            throw new Error("should not be called");
          },
          async checkpointRepo() {
            throw new Error("should not be called");
          },
          async getLiveStatus() {
            throw new Error("should not be called");
          },
        },
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 400);
    assert.deepStrictEqual(response?.payload, {
      error: "Unable to process buffer update request.",
    });
  });

  it("returns a generic checkpoint error message", async () => {
    const response = await routeLiveIndexApiRequest(
      {
        method: "POST",
        pathname: "/api/repo/demo-repo/checkpoint",
        body: { reason: "manual" },
      } satisfies LiveIndexApiRequest,
      {
        liveIndex: {
          async pushBufferUpdate() {
            throw new Error("not used");
          },
          async checkpointRepo() {
            throw new Error("checkpoint exploded");
          },
          async getLiveStatus() {
            throw new Error("not used");
          },
        },
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 400);
    assert.deepStrictEqual(response?.payload, {
      error: "Unable to process checkpoint request.",
    });
  });

  it("returns live status for a repository", async () => {
    const response = await routeLiveIndexApiRequest(
      {
        method: "GET",
        pathname: "/api/repo/demo-repo/live-status",
      } satisfies LiveIndexApiRequest,
      {
        liveIndex: {
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
              pendingBuffers: 1,
              dirtyBuffers: 1,
              parseQueueDepth: 1,
              checkpointPending: false,
              lastBufferEventAt: "2026-03-07T12:00:00.000Z",
              lastCheckpointAt: null,
              lastCheckpointAttemptAt: "2026-03-07T12:01:00.000Z",
              lastCheckpointResult: "success" as const,
              lastCheckpointError: null,
              lastCheckpointReason: "save",
            };
          },
        },
      },
    );

    assert.ok(response);
    assert.strictEqual(response?.status, 200);
    assert.deepStrictEqual(response?.payload, {
      repoId: "demo-repo",
      enabled: true,
      pendingBuffers: 1,
      dirtyBuffers: 1,
      parseQueueDepth: 1,
      checkpointPending: false,
      lastBufferEventAt: "2026-03-07T12:00:00.000Z",
      lastCheckpointAt: null,
      lastCheckpointAttemptAt: "2026-03-07T12:01:00.000Z",
      lastCheckpointResult: "success",
      lastCheckpointError: null,
      lastCheckpointReason: "save",
    });
  });
});
