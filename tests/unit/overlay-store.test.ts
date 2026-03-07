import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OverlayStore } from "../../src/live-index/overlay-store.js";

describe("OverlayStore", () => {
  it("keeps the newest buffer version per file", () => {
    const store = new OverlayStore();

    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 3,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/example.ts",
      content: "export const value = 0;",
      language: "typescript",
      version: 2,
      dirty: true,
      timestamp: "2026-03-07T11:59:59.000Z",
    });

    const draft = store.getDraft("demo-repo", "src/example.ts");
    assert.ok(draft);
    assert.strictEqual(draft?.version, 3);
    assert.strictEqual(draft?.content, "export const value = 1;");
  });

  it("tracks dirty files and checkpoint metadata", () => {
    const store = new OverlayStore();

    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "change",
      filePath: "src/a.ts",
      content: "export const a = 1;",
      language: "typescript",
      version: 1,
      dirty: true,
      timestamp: "2026-03-07T12:00:00.000Z",
    });
    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "save",
      filePath: "src/b.ts",
      content: "export const b = 1;",
      language: "typescript",
      version: 1,
      dirty: false,
      timestamp: "2026-03-07T12:01:00.000Z",
    });

    store.markCheckpointed("demo-repo", "src/b.ts", "2026-03-07T12:02:00.000Z");

    assert.deepStrictEqual(store.listDirtyFiles("demo-repo"), ["src/a.ts"]);
    const cleanDraft = store.getDraft("demo-repo", "src/b.ts");
    assert.strictEqual(cleanDraft?.lastCheckpointAt, "2026-03-07T12:02:00.000Z");
  });

  it("evicts a clean buffer when closed", () => {
    const store = new OverlayStore();

    store.upsertDraft({
      repoId: "demo-repo",
      eventType: "save",
      filePath: "src/example.ts",
      content: "export const value = 1;",
      language: "typescript",
      version: 4,
      dirty: false,
      timestamp: "2026-03-07T12:00:00.000Z",
    });

    store.removeDraft("demo-repo", "src/example.ts");

    assert.strictEqual(store.getDraft("demo-repo", "src/example.ts"), null);
  });
});
