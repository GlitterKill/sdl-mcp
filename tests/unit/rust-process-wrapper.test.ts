import { describe, it } from "node:test";
import assert from "node:assert";

import {
  isRustEngineAvailable,
  traceProcessesRust,
} from "../../src/indexer/rustIndexer.js";

describe("traceProcessesRust wrapper", () => {
  it("returns null when native addon is unavailable", () => {
    if (isRustEngineAvailable()) return;

    const result = traceProcessesRust([], [], 20, ["entry"]);
    assert.strictEqual(result, null);
  });

  it("traces a simple call chain deterministically when native addon is available", () => {
    if (!isRustEngineAvailable()) return;

    const symbols = [
      { symbolId: "A", name: "entry" },
      { symbolId: "B", name: "mid" },
      { symbolId: "C", name: "exit" },
    ];

    const callEdges = [
      { callerId: "A", calleeId: "B" },
      { callerId: "B", calleeId: "C" },
    ];

    const r1 = traceProcessesRust(symbols, callEdges, 20, ["entry"]);
    const r2 = traceProcessesRust(symbols, callEdges, 20, ["entry"]);

    assert.ok(r1 && r2, "Expected native results");
    assert.strictEqual(r1.length, 1);
    assert.deepStrictEqual(r1, r2, "Expected deterministic output");

    const proc = r1[0];
    assert.strictEqual(proc.entrySymbolId, "A");
    assert.ok(typeof proc.processId === "string" && proc.processId.length > 0);
    assert.strictEqual(proc.depth, 2);
    assert.deepStrictEqual(
      proc.steps.map((s) => s.symbolId),
      ["A", "B", "C"],
    );
    assert.deepStrictEqual(
      proc.steps.map((s) => s.stepOrder),
      [0, 1, 2],
    );
  });
});

