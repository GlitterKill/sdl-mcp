import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { StorageIntegrityError } from "../../dist/domain/errors.js";
import {
  classifyWatcherReindexFailure,
  processWatchedFileChange,
} from "../../dist/indexer/watcher.js";

function missingPathError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
    code: "ENOENT",
    path,
  });
}

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
        throw missingPathError("C:/repo/src/deleted.ts");
      },
    });

    assert.deepStrictEqual(calls, [
      "patch:src/deleted.ts",
      "index:demo-repo:incremental",
    ]);
  });

  it("routes root-level deletes through one incremental reindex", async () => {
    const calls: string[] = [];
    const repoRoot = resolve("watcher-root");

    await processWatchedFileChange({
      repoId: "demo-repo",
      repoRoot,
      filePath: "deleted.ts",
      async indexRepo(repoId, mode) {
        calls.push(`index:${repoId}:${mode}`);
      },
      async patchSavedFileFn({ filePath }) {
        calls.push(`patch:${filePath}`);
        throw missingPathError(resolve(repoRoot, "deleted.ts"));
      },
    });

    assert.deepStrictEqual(calls, [
      "patch:deleted.ts",
      "index:demo-repo:incremental",
    ]);
  });

  it("does not mistake a nested missing file with the same basename for a root-level delete", async () => {
    const calls: string[] = [];
    const repoRoot = resolve("watcher-root");
    const nested = missingPathError(
      resolve(repoRoot, "nested", "deleted.ts"),
    );

    await assert.rejects(
      processWatchedFileChange({
        repoId: "demo-repo",
        repoRoot,
        filePath: "deleted.ts",
        async indexRepo() {
          calls.push("index");
        },
        async patchSavedFileFn() {
          calls.push("patch");
          throw nested;
        },
      }),
      (error: unknown) => error === nested,
    );
    assert.deepStrictEqual(calls, ["patch"]);
  });

  it("does not fallback for a permanent graph storage failure", async () => {
    const calls: string[] = [];
    const failure = new StorageIntegrityError("duplicate physical symbols");

    await assert.rejects(
      processWatchedFileChange({
        repoId: "demo-repo",
        filePath: "src/example.ts",
        async indexRepo() {
          calls.push("index");
        },
        async patchSavedFileFn() {
          calls.push("patch");
          throw failure;
        },
      }),
      (error: unknown) => error === failure,
    );
    assert.deepStrictEqual(calls, ["patch"]);
    assert.equal(classifyWatcherReindexFailure(failure), "permanent");
  });

  it("does not treat an unrelated nested missing path as the watched file", async () => {
    const calls: string[] = [];
    const nested = missingPathError("C:/repo/config/generated.json");
    const failure = new Error("parser setup failed", { cause: nested });

    await assert.rejects(
      processWatchedFileChange({
        repoId: "demo-repo",
        filePath: "src/example.ts",
        async indexRepo() {
          calls.push("index");
        },
        async patchSavedFileFn() {
          calls.push("patch");
          throw failure;
        },
      }),
      (error: unknown) => error === failure,
    );
    assert.deepStrictEqual(calls, ["patch"]);
    assert.equal(classifyWatcherReindexFailure(failure), "unknown");
  });
});
