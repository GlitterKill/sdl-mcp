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

  it("auto-enqueues at threshold and resets pending", () => {
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
    assert.equal(acc.pending, 1);

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
      null,
    );
    // After hitting threshold, data is enqueued and pending resets
    assert.equal(acc.pending, 0);
  });

  it("tracks total rows in pending count", () => {
    const acc = new BatchPersistAccumulator(1000);
    acc.addSymbols([
      {
        symbolId: "s1",
        fileId: "f1",
        repoId: "r1",
        name: "foo",
        kind: "function",
        signature: "function foo()",
        startLine: 1,
        endLine: 5,
        exported: true,
        relPath: "src/a.ts",
        summary: null,
        invariants: null,
        sideEffects: null,
        astFingerprint: "fp1",
      },
    ]);
    acc.addEdges([
      {
        sourceSymbolId: "s1",
        targetSymbolId: "s2",
        edgeType: "call",
        confidence: 0.9,
      },
    ]);
    acc.addSymbolReferences([
      {
        fileId: "f1",
        symbolId: "s1",
        repoId: "r1",
        line: 10,
        col: 5,
        kind: "reference",
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

  it("default threshold is 200", () => {
    const acc = new BatchPersistAccumulator();
    for (let i = 0; i < 199; i++) {
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
    assert.equal(acc.pending, 199);

    acc.addFile(
      {
        fileId: "f199",
        repoId: "r1",
        relPath: "src/199.ts",
        contentHash: "hash199",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    // Auto-enqueued at threshold, pending resets
    assert.equal(acc.pending, 0);
  });
});
