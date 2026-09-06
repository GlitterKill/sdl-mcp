import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processWatchedFileChange } from "../../dist/indexer/watcher.js";

describe("watcher shared admission", () => {
  it("accepts overlapping saves synchronously before readiness without patching or indexing", () => {
    const admitted: unknown[] = [];
    const coordinator = {
      recordDiskChange(input: unknown) {
        admitted.push(input);
        return true;
      },
    };
    for (const filePath of ["src/a.ts", "src/b.ts", "src/a.ts"]) {
      assert.equal(
        processWatchedFileChange({
          repoId: "repo",
          filePath,
          coordinator,
          isWriteReady: () => false,
          indexRepo: async () => assert.fail("automatic index"),
          patchSavedFileFn: async () => assert.fail("direct patch"),
        }),
        true,
      );
    }
    assert.deepEqual(
      admitted,
      ["src/a.ts", "src/b.ts", "src/a.ts"].map((filePath) => ({
        repoId: "repo",
        filePath,
      })),
    );
  });
  it("retains removals and reports refused admission honestly", () => {
    const admitted: unknown[] = [];
    assert.equal(
      processWatchedFileChange({
        repoId: "repo",
        filePath: "gone.ts",
        removed: true,
        coordinator: {
          recordDiskChange(input: unknown) {
            admitted.push(input);
            return false;
          },
        },
        indexRepo: async () => assert.fail("automatic index"),
      }),
      false,
    );
    assert.deepEqual(admitted, [
      { repoId: "repo", filePath: "gone.ts", removed: true },
    ]);
  });
});
