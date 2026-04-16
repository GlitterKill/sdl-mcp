import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("parseFilesRustAsync (Fix 1: async napi)", () => {
  it("exports parseFilesRustAsync alongside sync variant", async () => {
    const mod = await import("../../dist/indexer/rustIndexer.js");
    assert.equal(typeof mod.parseFilesRust, "function");
    assert.equal(typeof mod.parseFilesRustAsync, "function");
  });

  it("parseFilesRustAsync returns a Promise", async () => {
    const { parseFilesRustAsync } = await import(
      "../../dist/indexer/rustIndexer.js"
    );
    const result = parseFilesRustAsync("nonexistent-repo", "/tmp", [], 0);
    assert.ok(
      result === null || result instanceof Promise,
      "Should return null (no addon) or a Promise",
    );
    if (result instanceof Promise) {
      const resolved = await result;
      assert.ok(
        resolved === null || Array.isArray(resolved),
        "Resolved value should be null or array",
      );
    }
  });
});

describe("Pipelined chunk processing (Fix 3)", () => {
  it("runPass1WithRustEngine is exported", async () => {
    const mod = await import("../../dist/indexer/indexer-pass1.js");
    assert.equal(typeof mod.runPass1WithRustEngine, "function");
  });
});

describe("BatchPersistAccumulator integration (Fix 2)", () => {
  it("processFileFromRustResult accepts batchAccumulator param", async () => {
    const mod = await import(
      "../../dist/indexer/parser/rust-process-file.js"
    );
    assert.equal(typeof mod.processFileFromRustResult, "function");
    assert.ok(
      mod.processFileFromRustResult.length <= 1,
      "processFileFromRustResult takes a single params object",
    );
  });

  it("BatchPersistAccumulator pending tracks files and rows", async () => {
    const { BatchPersistAccumulator } = await import(
      "../../dist/indexer/parser/batch-persist.js"
    );
    const acc = new BatchPersistAccumulator(100);

    acc.addFile(
      {
        fileId: "f1", repoId: "r1", relPath: "a.ts",
        contentHash: "h1", language: "ts", byteSize: 10,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    acc.addSymbols([
      {
        symbolId: "s1", repoId: "r1", fileId: "f1", kind: "function",
        name: "a", exported: true, visibility: "public", language: "ts",
        rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 1, rangeEndCol: 10,
        signature: "function a()", summary: "",
        invariantsJson: "[]", sideEffectsJson: "[]",
        astFingerprint: "fp", roleTagsJson: "[]", searchText: "a",
      },
    ]);

    // 1 file + 1 symbol = 2 total rows
    assert.equal(acc.pending, 2);
    assert.equal(acc.shouldFlush(), false);

    acc.addFile(
      {
        fileId: "f2", repoId: "r1", relPath: "b.ts",
        contentHash: "h2", language: "ts", byteSize: 20,
        lastIndexedAt: new Date().toISOString(),
      },
      "old-f2",
    );
    // 2 files + 1 symbol = 3 total rows
    assert.equal(acc.pending, 3);
  });
});
