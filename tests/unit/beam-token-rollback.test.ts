import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rollbackAcceptedNodeFromSlice } from "../../dist/graph/slice/beam-search-engine.js";

describe("beam search token rollback", () => {
  it("reverts acceptance bookkeeping when a node is rolled back", () => {
    const state = {
      sliceCards: new Set(["entry-symbol", "other-symbol"]),
      entrySymbols: new Set(["entry-symbol"]),
      coveredEntrySymbols: 1,
      highConfidenceCards: 1,
      recentAcceptedScores: [0.9],
    } as Parameters<typeof rollbackAcceptedNodeFromSlice>[0];

    rollbackAcceptedNodeFromSlice(state, "entry-symbol", 0.9);

    assert.deepEqual(Array.from(state.sliceCards), ["other-symbol"]);
    assert.equal(state.coveredEntrySymbols, 0);
    assert.equal(state.highConfidenceCards, 0);
    assert.deepEqual(state.recentAcceptedScores, []);
  });
});
