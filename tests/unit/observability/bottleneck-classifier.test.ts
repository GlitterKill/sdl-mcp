import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyBottleneck } from "../../../dist/observability/bottleneck-classifier.js";

const baseInput = {
  cpuPctAvg: 10,
  cpuPctMax: 20,
  rssMb: 200,
  heapUsedMb: 100,
  heapTotalMb: 200,
  eventLoopLagP95Ms: 5,
  dbLatencyP95Ms: 20,
  indexerParseP95Ms: 50,
  ioThroughputMbPerSec: 10,
  ioThroughputSaturationMbPerSec: 200,
  poolWriteQueuedAvg: 0,
  drainQueueDepthAvg: 0,
};

describe("classifyBottleneck", () => {
  it("returns balanced under nominal load", () => {
    const r = classifyBottleneck(baseInput);
    assert.equal(r.dominant, "balanced");
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(Array.isArray(r.topSignals));
  });

  it("flags cpu_bound when cpuPctAvg high and event-loop lag low", () => {
    const r = classifyBottleneck({
      ...baseInput,
      cpuPctAvg: 85,
      eventLoopLagP95Ms: 10,
    });
    assert.equal(r.dominant, "cpu_bound");
  });

  it("flags memory_pressure when RSS large", () => {
    const r = classifyBottleneck({ ...baseInput, rssMb: 2000 });
    assert.equal(r.dominant, "memory_pressure");
  });

  it("flags db_latency on p95 latency spike", () => {
    const r = classifyBottleneck({ ...baseInput, dbLatencyP95Ms: 700 });
    assert.equal(r.dominant, "db_latency");
  });

  it("flags db_latency on write-pool queue saturation", () => {
    const r = classifyBottleneck({ ...baseInput, poolWriteQueuedAvg: 8 });
    assert.equal(r.dominant, "db_latency");
  });

  it("flags indexer_parse on slow parse latency", () => {
    const r = classifyBottleneck({ ...baseInput, indexerParseP95Ms: 800 });
    assert.equal(r.dominant, "indexer_parse");
  });

  it("returns top signals as a non-empty array of named values", () => {
    const r = classifyBottleneck({
      ...baseInput,
      cpuPctAvg: 90,
      rssMb: 1800,
    });
    assert.ok(r.topSignals.length > 0);
    for (const s of r.topSignals) {
      assert.equal(typeof s.name, "string");
      assert.equal(typeof s.value, "number");
      assert.equal(typeof s.unit, "string");
      assert.equal(typeof s.weight, "number");
    }
  });
});
