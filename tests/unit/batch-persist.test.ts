import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";

describe("BatchPersistAccumulator", () => {
  it("starts with zero pending count", () => {
    const acc = new BatchPersistAccumulator();
    assert.equal(acc.pending, 0);
    assert.equal(acc.shouldFlush(), false);
  });

  it("increments pending count on addFile", () => {
    const acc = new BatchPersistAccumulator(3);
    acc.addFile(
      {
        fileId: "f1",
        repoId: "r1",
        relPath: "src/a.ts",
        contentHash: "abc",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.pending, 1);
    assert.equal(acc.shouldFlush(), false);
  });

  it("shouldFlush returns true at threshold", () => {
    const acc = new BatchPersistAccumulator(2);
    acc.addFile(
      {
        fileId: "f1",
        repoId: "r1",
        relPath: "src/a.ts",
        contentHash: "abc",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.shouldFlush(), false);

    acc.addFile(
      {
        fileId: "f2",
        repoId: "r1",
        relPath: "src/b.ts",
        contentHash: "def",
        language: "ts",
        byteSize: 200,
        lastIndexedAt: new Date().toISOString(),
      },
      "existing-f2",
    );
    assert.equal(acc.pending, 2);
    assert.equal(acc.shouldFlush(), true);
  });

  it("tracks total rows in pending count", () => {
    const acc = new BatchPersistAccumulator(100);

    acc.addSymbols([
      {
        symbolId: "s1", repoId: "r1", fileId: "f1", kind: "function",
        name: "foo", exported: true, visibility: "public", language: "ts",
        rangeStartLine: 1, rangeStartCol: 0, rangeEndLine: 5, rangeEndCol: 1,
        signature: "function foo(): void", summary: "Does foo",
        invariantsJson: "[]", sideEffectsJson: "[]",
        astFingerprint: "fp1", roleTagsJson: "[]", searchText: "foo",
      },
    ]);

    acc.addEdges([
      {
        repoId: "r1", fromSymbolId: "s1", toSymbolId: "s2",
        edgeType: "calls", weight: 1.0, confidence: 0.9, resolution: "heuristic",
      },
    ]);

    acc.addSymbolReferences([
      {
        symbolId: "s1", repoId: "r1", fileId: "f1",
        referenceType: "definition", line: 1, column: 0,
      },
    ]);

    // 1 symbol + 1 edge + 1 ref = 3 total rows
    assert.equal(acc.pending, 3);
    assert.equal(acc.shouldFlush(), false);
  });

  it("flush with zero pending is a no-op", async () => {
    const acc = new BatchPersistAccumulator();
    await acc.flush();
    assert.equal(acc.pending, 0);
  });

  it("default threshold is 50", () => {
    const acc = new BatchPersistAccumulator();
    for (let i = 0; i < 49; i++) {
      acc.addFile(
        {
          fileId: `f${i}`,
          repoId: "r1",
          relPath: `src/${i}.ts`,
          contentHash: `hash${i}`,
          language: "ts",
          byteSize: 100,
          lastIndexedAt: new Date().toISOString(),
        },
        null,
      );
    }
    assert.equal(acc.shouldFlush(), false);

    acc.addFile(
      {
        fileId: "f49",
        repoId: "r1",
        relPath: "src/49.ts",
        contentHash: "hash49",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.shouldFlush(), true);
    assert.equal(acc.pending, 50);
  });
});
