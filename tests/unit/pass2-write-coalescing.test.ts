import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the pass-2 dispatcher write helpers in
 * `src/indexer/indexer-pass2.ts`.
 *
 *   - `makeImmediateSubmit(mode)` → SubmitEdgeWrite that flushes via
 *     `withWriteConn` on each call. Sequential dispatch path.
 *   - `makeBatchAccumulator()` → returns `{ acc, submit }`; submit pushes
 *     into the in-memory accumulator without touching the DB.
 *   - `flushBatchAccumulator(acc, mode)` → issues the combined write.
 *
 * The in-memory accumulator paths (no DB) are testable directly. The
 * actual flush + immediate-submit paths require a DB connection and are
 * exercised end-to-end by the per-language pass-2 indexing integration
 * tests; here we cover the no-op early-return guards plus the
 * accumulator's collection invariants.
 */

const FAKE_EDGE = {
  repoId: "r1",
  fromSymbolId: "from-1",
  toSymbolId: "to-1",
  edgeType: "call",
  weight: 1.0,
  confidence: 0.9,
  resolution: "import-direct",
  resolverId: "pass2-test",
  resolutionPhase: "pass2",
  provenance: "test-provenance",
  createdAt: new Date().toISOString(),
};

describe("makeBatchAccumulator", () => {
  it("starts with empty arrays", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc } = makeBatchAccumulator();
    assert.deepStrictEqual(acc.symbolIdsToRefresh, []);
    assert.deepStrictEqual(acc.edges, []);
  });

  it("submit pushes symbolIds into the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: ["a", "b"], edges: [] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a", "b"]);
    assert.deepStrictEqual(acc.edges, []);
  });

  it("submit pushes edges into the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: [], edges: [FAKE_EDGE] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, []);
    assert.strictEqual(acc.edges.length, 1);
    assert.strictEqual(acc.edges[0].fromSymbolId, "from-1");
  });

  it("multiple submits accumulate across both arrays", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: ["a"], edges: [FAKE_EDGE] });
    await submit({ symbolIdsToRefresh: ["b", "c"], edges: [FAKE_EDGE] });
    assert.deepStrictEqual(acc.symbolIdsToRefresh, ["a", "b", "c"]);
    assert.strictEqual(acc.edges.length, 2);
  });

  it("submit with empty inputs is a no-op on the accumulator", async () => {
    const { makeBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    const { acc, submit } = makeBatchAccumulator();
    await submit({ symbolIdsToRefresh: [], edges: [] });
    assert.strictEqual(acc.symbolIdsToRefresh.length, 0);
    assert.strictEqual(acc.edges.length, 0);
  });
});

describe("flushBatchAccumulator — no-op guards", () => {
  it("returns immediately when both arrays are empty (no DB call)", async () => {
    const { flushBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    // A real withWriteConn would throw without an initialised LadybugDB
    // connection, so the fact that this resolves cleanly proves the
    // empty-acc early return fires before any DB work happens.
    const acc = { symbolIdsToRefresh: [], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "incremental"),
    );
  });

  it("returns immediately for full-mode + empty edges (no DB call)", async () => {
    const { flushBatchAccumulator } =
      await import("../../dist/indexer/indexer-pass2.js");
    // When both arrays are empty the early return fires regardless of
    // mode — the full-mode DELETE-skip optimisation kicks in only when
    // we have symbolIdsToRefresh, but no edges either means no work.
    const acc = { symbolIdsToRefresh: [], edges: [] };
    await assert.doesNotReject(
      async () => await flushBatchAccumulator(acc, "full"),
    );
  });
});

describe("makeImmediateSubmit — early-return guard", () => {
  it("returns immediately when both arrays are empty (no DB call)", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    const submit = makeImmediateSubmit("incremental");
    // The early return inside makeImmediateSubmit must fire before any
    // withWriteConn call that would otherwise need a real DB.
    await assert.doesNotReject(
      async () => await submit({ symbolIdsToRefresh: [], edges: [] }),
    );
  });

  it("returns a function for both 'full' and 'incremental' modes", async () => {
    const { makeImmediateSubmit } =
      await import("../../dist/indexer/indexer-pass2.js");
    assert.strictEqual(typeof makeImmediateSubmit("full"), "function");
    assert.strictEqual(typeof makeImmediateSubmit("incremental"), "function");
  });
});
