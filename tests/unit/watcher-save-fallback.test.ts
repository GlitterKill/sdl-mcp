import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processWatchedFileChange } from "../../dist/indexer/watcher.js";

describe("processWatchedFileChange", () => {
  it("prefers file patching over repo-wide incremental reindex", async () => {
    const calls: string[] = [];

    await processWatchedFileChange({
      repoId: "demo-repo",
      filePath: "src/example.ts",
      async indexRepo() {
        calls.push("index");
      },
      async patchSavedFileFn() {
        calls.push("patch");
      },
    });

    assert.deepStrictEqual(calls, ["patch"]);
  });

  it("falls back to incremental reindex when file patching fails", async () => {
    const calls: string[] = [];

    await processWatchedFileChange({
      repoId: "demo-repo",
      filePath: "src/example.ts",
      async indexRepo() {
        calls.push("index");
      },
      async patchSavedFileFn() {
        calls.push("patch");
        throw new Error("boom");
      },
    });

    assert.deepStrictEqual(calls, ["patch", "index"]);
  });
});
