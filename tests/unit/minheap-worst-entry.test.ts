import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MinHeap } from "../../dist/graph/minHeap.js";

describe("MinHeap worst-entry lookup", () => {
  it("returns the worst leaf without copying the heap array", () => {
    const heap = new MinHeap<{ score: number; label: string }>();
    for (const [score, label] of [
      [0.1, "best"],
      [0.8, "candidate"],
      [0.4, "middle"],
      [0.95, "worst"],
    ] as const) {
      heap.insert({ score, label });
    }

    const entry = heap.findWorstEntry((a, b) => a.score - b.score);

    assert.ok(entry, "expected a worst entry for a non-empty heap");
    assert.equal(entry.item.label, "worst");
    heap.replaceAt(entry.index, { score: 0.2, label: "replacement" });
    assert.equal(heap.size(), 4);
    assert.equal(
      heap.findWorstEntry((a, b) => a.score - b.score)?.item.label,
      "candidate",
    );
  });
});
