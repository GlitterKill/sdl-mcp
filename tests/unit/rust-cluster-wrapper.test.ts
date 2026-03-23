import { describe, it } from "node:test";
import assert from "node:assert";

import {
  computeClustersRust,
  isRustEngineAvailable,
} from "../../dist/indexer/rustIndexer.js";

describe("computeClustersRust wrapper", () => {
  it("returns null when native addon is unavailable", () => {
    if (isRustEngineAvailable()) return;

    const result = computeClustersRust([], [], 3);
    assert.strictEqual(result, null);
  });

  it("computes deterministic cluster assignments when native addon is available", () => {
    if (!isRustEngineAvailable()) return;

    const symbols = [
      { symbolId: "A" },
      { symbolId: "B" },
      { symbolId: "C" },
      { symbolId: "X" },
      { symbolId: "Y" },
      { symbolId: "Z" },
    ];

    const edges = [
      { fromSymbolId: "A", toSymbolId: "B" },
      { fromSymbolId: "B", toSymbolId: "C" },
      { fromSymbolId: "X", toSymbolId: "Y" },
      { fromSymbolId: "Y", toSymbolId: "Z" },
    ];

    const r1 = computeClustersRust(symbols, edges, 3);
    const r2 = computeClustersRust(symbols, edges, 3);

    // The native addon may be present but built without the cluster exports.
    if (!r1 || !r2) return;
    assert.strictEqual(r1.length, 6);
    assert.deepStrictEqual(r1, r2, "Expected deterministic output");

    const clusterIds = new Set(r1.map((a) => a.clusterId));
    assert.strictEqual(clusterIds.size, 2);
    r1.forEach((a) => {
      assert.ok(typeof a.symbolId === "string");
      assert.ok(typeof a.clusterId === "string");
      assert.strictEqual(a.membershipScore, 1.0);
    });
  });
});
