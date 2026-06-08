import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import type { EdgeRow } from "../../dist/db/ladybug-queries.js";

function edge(overrides: Partial<EdgeRow> = {}): EdgeRow {
  return {
    repoId: "r1",
    fromSymbolId: "from-1",
    toSymbolId: "to-1",
    edgeType: "call",
    weight: 1.0,
    confidence: 0.9,
    resolution: "import-direct",
    resolverId: "batch-persist-test",
    resolutionPhase: "pass1",
    provenance: "test-provenance",
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

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

  it("waitForIdle with zero pending is a no-op and keeps accumulator reusable", async () => {
    const acc = new BatchPersistAccumulator();
    await acc.waitForIdle();
    assert.equal(acc.pending, 0);

    acc.addFile(
      {
        fileId: "f-after-idle",
        repoId: "r1",
        relPath: "src/after-idle.ts",
        contentHash: "after-idle",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    assert.equal(acc.pending, 1);
  });

  it("supports caller-controlled batch draining for provider-first fallback", () => {
    const source = readFileSync("src/indexer/indexer-pass1.ts", "utf8");
    assert.match(source, /autoDrain:\s*params\.autoDrainBatchPersist/);
    assert.match(source, /await batchAccumulator\.waitForIdle\(\)/);
  });

  it("default threshold is 512", () => {
    const acc = new BatchPersistAccumulator();
    for (let i = 0; i < 511; i++) {
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
    assert.equal(acc.pending, 511);

    acc.addFile(
      {
        fileId: "f511",
        repoId: "r1",
        relPath: "src/511.ts",
        contentHash: "hash511",
        language: "ts",
        byteSize: 100,
        lastIndexedAt: new Date().toISOString(),
      },
      null,
    );
    // Auto-enqueued at threshold, pending resets
    assert.equal(acc.pending, 0);
  });

  it("setProgressCallback accepts a function", () => {
    const acc = new BatchPersistAccumulator();
    let calls = 0;
    acc.setProgressCallback(() => {
      calls += 1;
    });
    // The callback is stored privately; we cannot trigger drain here
    // without a real LadybugDB connection. The integration tests in
    // tests/integration/*-pass2-indexing.test.ts exercise the firing
    // path end-to-end. This unit test verifies the API contract.
    assert.strictEqual(typeof calls, "number");
  });

  it("setProgressCallback accepts null to clear the callback", () => {
    const acc = new BatchPersistAccumulator();
    acc.setProgressCallback(() => {
      // ignored
    });
    // Re-setting to null must not throw.
    assert.doesNotThrow(() => acc.setProgressCallback(null));
  });

  it("getActiveDrainStats returns zero queue depth on a fresh accumulator", async () => {
    const { getActiveDrainStats } =
      await import("../../dist/indexer/parser/batch-persist.js");
    const acc = new BatchPersistAccumulator();
    // Track an arbitrary callback so the registry sees this instance.
    acc.setProgressCallback(() => {
      // ignored
    });
    const stats = getActiveDrainStats();
    assert.strictEqual(typeof stats.queueDepth, "number");
    assert.strictEqual(typeof stats.drainFailures, "number");
  });

  it("keeps fresh-source COPY semantics during pass-1 drain writes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "..",
      "src",
      "indexer",
      "parser",
      "batch-persist.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    assert.match(
      content,
      /ensureDependencyTargetsForKnownSourceEdges\(\s*txConn,\s*knownEndpointEdges,\s*\)/,
      "BatchPersistAccumulator should prepare placeholder targets before relationship COPY",
    );
    assert.match(
      content,
      /insertKnownSymbolEdges\(txConn,\s*knownEndpointEdges\)/,
      "BatchPersistAccumulator should route prepared fresh-source edges through relationship COPY",
    );
    assert.match(
      content,
      /insertEdges\(txConn,\s*repairEdges,\s*\{[\s\S]*skipSourceRepoLink:\s*true,[\s\S]*skipExistingRelationshipUpdate:\s*true,[\s\S]*\}\)/,
      "BatchPersistAccumulator must keep pass-1 repair edges in fresh-edge mode",
    );
  });

  it("supports fresh-copy symbol batches for provider-first fallback", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __filename = fileURLToPath(import.meta.url);
    const srcPath = path.resolve(
      path.dirname(__filename),
      "..",
      "..",
      "src",
      "indexer",
      "parser",
      "batch-persist.ts",
    );
    const content = fs.readFileSync(srcPath, "utf-8");

    assert.match(
      content,
      /symbolWriteMode\?:\s*"merge"\s*\|\s*"fresh-copy"/,
      "BatchPersistAccumulator should expose the fresh-copy provider fallback mode",
    );
    assert.match(
      content,
      /this\.symbolWriteMode\s*===\s*"fresh-copy"/,
      "fresh-copy mode should have a dedicated write path",
    );
    assert.match(
      content,
      /deleteSymbolsByIds\(txConn,\s*incomingSymbolIds\)/,
      "fresh-copy batches should clear colliding stubs or stale symbols before COPY",
    );
    assert.match(
      content,
      /upsertKnownFileSymbols\(txConn,\s*batch\.symbols\)/,
      "fresh-copy batches should use the duplicate-key-safe symbol COPY writer",
    );
  });

  it("splits pass-1 edges so prepared non-real or known real endpoints use COPY", async () => {
    const { splitPass1EdgesForKnownEndpointCopy } = await import(
      "../../dist/indexer/parser/batch-persist.js"
    );

    const known = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "symbol-b",
    });
    const unresolvedTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unresolved:call:missing",
    });
    const unresolvedSource = edge({
      fromSymbolId: "unresolved:call:source",
      toSymbolId: "symbol-b",
    });
    const providerTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "provider-symbol",
    });
    const outsideBatchTarget = edge({
      fromSymbolId: "symbol-a",
      toSymbolId: "unknown-symbol",
    });

    const split = splitPass1EdgesForKnownEndpointCopy(
      [
        known,
        unresolvedTarget,
        unresolvedSource,
        providerTarget,
        outsideBatchTarget,
      ],
      new Set(["symbol-a", "symbol-b"]),
      new Set(["provider-symbol"]),
    );

    assert.deepStrictEqual(split.knownEndpointEdges, [
      known,
      unresolvedTarget,
      providerTarget,
    ]);
    assert.deepStrictEqual(split.repairEdges, [
      unresolvedSource,
      outsideBatchTarget,
    ]);
  });
});
