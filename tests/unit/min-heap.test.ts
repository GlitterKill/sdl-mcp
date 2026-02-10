import { describe, it } from "node:test";
import assert from "node:assert";
import { MinHeap } from "../../src/graph/minHeap.js";

describe("MinHeap", () => {
  it("orders by score ascending", () => {
    const heap = new MinHeap<{ score: number }>();
    heap.insert({ score: 3 });
    heap.insert({ score: 1 });
    heap.insert({ score: 2 });

    assert.strictEqual(heap.extractMin()?.score, 1);
    assert.strictEqual(heap.extractMin()?.score, 2);
    assert.strictEqual(heap.extractMin()?.score, 3);
  });

  it("breaks score ties by priority", () => {
    const heap = new MinHeap<{ score: number; priority?: number }>();
    heap.insert({ score: -1, priority: 5 });
    heap.insert({ score: -1, priority: 1 });
    heap.insert({ score: -1, priority: 3 });

    assert.strictEqual(heap.extractMin()?.priority, 1);
    assert.strictEqual(heap.extractMin()?.priority, 3);
    assert.strictEqual(heap.extractMin()?.priority, 5);
  });

  it("breaks full ties by insertion sequence", () => {
    const heap = new MinHeap<{
      score: number;
      priority?: number;
      sequence?: number;
      id: string;
    }>();
    heap.insert({ score: -1, priority: 2, sequence: 10, id: "late" });
    heap.insert({ score: -1, priority: 2, sequence: 1, id: "early" });

    assert.strictEqual(heap.extractMin()?.id, "early");
    assert.strictEqual(heap.extractMin()?.id, "late");
  });
});
