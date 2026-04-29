import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RingBuffer } from "../../../dist/observability/ring-buffer.js";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const ring = new RingBuffer<number>(5);
    assert.deepEqual(ring.snapshot(), []);
  });

  it("retains last N entries when capacity exceeded", () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1, 1);
    ring.push(2, 2);
    ring.push(3, 3);
    ring.push(4, 4);
    const values = ring.snapshot().map((e) => e.v);
    assert.deepEqual(values, [2, 3, 4]);
  });

  it("filters by since(t) timestamp", () => {
    const ring = new RingBuffer<string>(10);
    ring.push("a", 100);
    ring.push("b", 200);
    ring.push("c", 300);
    const since200 = ring.since(200).map((e) => e.v);
    assert.deepEqual(since200, ["b", "c"]);
  });

  it("clear() empties the buffer", () => {
    const ring = new RingBuffer<number>(5);
    ring.push(1, 1);
    ring.push(2, 2);
    ring.clear();
    assert.deepEqual(ring.snapshot(), []);
  });

  it("uses Date.now() when no timestamp provided", () => {
    const before = Date.now();
    const ring = new RingBuffer<number>(2);
    ring.push(42);
    const after = Date.now();
    const entries = ring.snapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].v, 42);
    assert.ok(entries[0].t >= before && entries[0].t <= after);
  });
});
