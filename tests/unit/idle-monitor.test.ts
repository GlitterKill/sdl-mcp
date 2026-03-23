import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OverlayStore } from "../../dist/live-index/overlay-store.js";
import { IdleMonitor } from "../../dist/live-index/idle-monitor.js";

describe("IdleMonitor", () => {
  it("checkpoints repos that are quiet and have clean overlay entries", async () => {
    const store = new OverlayStore();
    store.upsertDraft({
      repoId: "quiet-repo",
      eventType: "save",
      filePath: "src/quiet.ts",
      content: "export const quiet = true;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    store.upsertDraft({
      repoId: "active-repo",
      eventType: "save",
      filePath: "src/active.ts",
      content: "export const active = true;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:05:00.000Z",
    });

    const calls: Array<{ repoId: string; reason?: string }> = [];
    const monitor = new IdleMonitor({
      overlayStore: store,
      quietPeriodMs: 60_000,
      intervalMs: 60_000,
      now: () => Date.parse("2026-03-07T12:05:30.000Z"),
      checkpointRepo: async (request) => {
        calls.push(request);
        return {
          repoId: request.repoId,
          requested: true,
          checkpointId: "ckpt-1",
          pendingBuffers: 0,
          checkpointedFiles: 1,
          failedFiles: 0,
          lastCheckpointAt: "2026-03-07T12:05:30.000Z",
        };
      },
    });

    const repos = await monitor.scanOnce();

    assert.deepStrictEqual(repos, ["quiet-repo"]);
    assert.deepStrictEqual(calls, [{ repoId: "quiet-repo", reason: "idle" }]);
  });
});
