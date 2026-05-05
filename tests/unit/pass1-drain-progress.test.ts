import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BatchPersistAccumulator } from "../../dist/indexer/parser/batch-persist.js";
import type { IndexProgress } from "../../dist/indexer/indexer-init.js";

/**
 * Tests for `attachPass1DrainProgress` in
 * `src/indexer/indexer-pass1.ts`.
 *
 * This helper drives the CLI's pass-1 drain bar by:
 *   1. Computing `totalBatches = queueDepth + (pending > 0 ? 1 : 0)` at
 *      handoff time.
 *   2. Emitting one initial progress event with `stageCurrent: 0`.
 *   3. Registering a callback on the accumulator that emits a per-batch
 *      tick with the new `stageCurrent`.
 *
 * Pure-logic checks here cover the no-op cases (no callback / no work)
 * and the initial-emit shape. Per-batch firing is exercised end-to-end
 * by the indexing integration tests because it requires an actual
 * BatchPersistAccumulator drain loop with a real DB.
 */

describe("attachPass1DrainProgress — no-op cases", () => {
  it("returns immediately when onProgress is undefined", async () => {
    const { attachPass1DrainProgress } =
      await import("../../dist/indexer/indexer-pass1.js");
    const acc = new BatchPersistAccumulator();
    // No callback set → no calls fire on the accumulator.
    assert.doesNotThrow(() => {
      attachPass1DrainProgress(acc, undefined);
    });
  });

  it("emits nothing when totalBatches is 0 (empty accumulator)", async () => {
    const { attachPass1DrainProgress } =
      await import("../../dist/indexer/indexer-pass1.js");
    const acc = new BatchPersistAccumulator();
    const events: IndexProgress[] = [];
    attachPass1DrainProgress(acc, (e) => events.push(e));
    assert.strictEqual(events.length, 0, "no work in queue → no initial event");
  });
});

describe("attachPass1DrainProgress — initial event", () => {
  it("emits a 0/total tick when the accumulator has pending rows", async () => {
    const { attachPass1DrainProgress } =
      await import("../../dist/indexer/indexer-pass1.js");
    // Use a low threshold so we can exercise the queue + pending state
    // without auto-enqueueing.
    const acc = new BatchPersistAccumulator(1000);
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

    const events: IndexProgress[] = [];
    attachPass1DrainProgress(acc, (e) => events.push(e));

    assert.strictEqual(events.length, 1, "initial tick should fire once");
    const initial = events[0];
    assert.strictEqual(initial.stage, "finalizing");
    assert.strictEqual(initial.substage, "pass1Drain");
    assert.strictEqual(
      initial.stageCurrent,
      0,
      "initial tick must report 0 batches flushed",
    );
    assert.strictEqual(
      initial.stageTotal,
      1,
      "1 pending row → totalBatches counts the residual snapshot",
    );
  });

  it("counts queueDepth + 1 when both queued snapshots and pending rows exist", async () => {
    const { attachPass1DrainProgress } =
      await import("../../dist/indexer/indexer-pass1.js");
    // threshold = 1 → first addFile auto-enqueues a snapshot, leaving
    // pending = 0. Then add another row → pending = 1.
    const acc = new BatchPersistAccumulator(1);
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
    // queueDepth is now 1 (snapshot enqueued); pending is 0. Add another
    // row to land in pending without re-enqueueing.
    acc.addSymbols([
      {
        symbolId: "s1",
        fileId: "f1",
        repoId: "r1",
        kind: "function",
        name: "foo",
        astFingerprint: "fp1",
        startLine: 1,
        startCol: 0,
        endLine: 5,
        endCol: 0,
        signature: null,
        signatureJson: null,
        summary: null,
        invariants: null,
        invariantsJson: null,
        sideEffects: null,
        sideEffectsJson: null,
        searchText: null,
        roleTagsJson: null,
        contentHash: null,
        relPath: "src/a.ts",
        language: "ts",
        exported: true,
        visibility: null,
      } as never,
    ]);
    // Drain may have already processed the queued snapshot; whatever
    // queueDepth + pending evaluate to at attach time is what totalBatches
    // should include.
    const expectedQueueDepth = acc.queueDepth;
    const expectedHasResidual = acc.pending > 0 ? 1 : 0;
    const expectedTotal = expectedQueueDepth + expectedHasResidual;

    const events: IndexProgress[] = [];
    attachPass1DrainProgress(acc, (e) => events.push(e));

    if (expectedTotal === 0) {
      // Edge case: the drain finished before we attached. No events.
      assert.strictEqual(events.length, 0);
    } else {
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].stageTotal, expectedTotal);
      assert.strictEqual(events[0].stageCurrent, 0);
    }
  });
});
