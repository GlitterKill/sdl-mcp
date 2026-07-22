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

  it("routes delete and rename patch failures through one incremental reindex", async () => {
    const calls: string[] = [];

    await processWatchedFileChange({
      repoId: "demo-repo",
      filePath: "src/deleted.ts",
      async indexRepo(repoId, mode) {
        calls.push(`index:${repoId}:${mode}`);
      },
      async patchSavedFileFn({ filePath }) {
        calls.push(`patch:${filePath}`);
        throw new Error("file was deleted or renamed");
      },
    });

    assert.deepStrictEqual(calls, [
      "patch:src/deleted.ts",
      "index:demo-repo:incremental",
    ]);
  });
});
