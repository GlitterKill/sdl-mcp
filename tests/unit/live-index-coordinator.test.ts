import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryLiveIndexCoordinator } from "../../src/live-index/coordinator.js";

describe("InMemoryLiveIndexCoordinator", () => {
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
});
