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

  it("idle process with high heapUsed/heapTotal ratio returns balanced when heapLimitMb is provided", () => {
    // Simulates an idle Node process between GCs: heapTotal is V8's currently
    // committed heap (small, mostly full), but the real ceiling is far higher.
    // Without heapLimitMb the legacy ratio (heapUsed/heapTotal = 0.95) would
    // trigger memory_pressure. With heapLimitMb provided, real ratio is tiny.
    const r = classifyBottleneck({
      ...baseInput,
      heapUsedMb: 190,
      heapTotalMb: 200, // committed heap, near-full pre-GC
      heapLimitMb: 4096, // --max-old-space-size = 4 GB
    });
    assert.equal(r.dominant, "balanced");
  });

  it("flags memory_pressure when heapUsed approaches heapLimitMb", () => {
    const r = classifyBottleneck({
      ...baseInput,
      heapUsedMb: 3800,
      heapTotalMb: 4000,
      heapLimitMb: 4096,
    });
    assert.equal(r.dominant, "memory_pressure");
  });

  it("falls back to heapTotalMb when heapLimitMb is unset (legacy callers)", () => {
    const r = classifyBottleneck({
      ...baseInput,
      heapUsedMb: 1900,
      heapTotalMb: 2000,
      // heapLimitMb intentionally omitted
    });
    assert.equal(r.dominant, "memory_pressure");
  });

  it("returns balanced when no rule clears MIN_DOMINANT_SCORE", () => {
    // poolWriteQueuedAvg = 7 -> poolScore = (7-5)/20 = 0.10, below 0.15 floor.
    const r = classifyBottleneck({ ...baseInput, poolWriteQueuedAvg: 7 });
    assert.equal(r.dominant, "balanced");
    // Floor-branch return shape: empty signals, confidence in [0, 1].
    assert.equal(r.topSignals.length, 0);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    // Sub-floor but non-trivial score → confidence below 0.5 (closer to flipping
    // into a real classification than to "definitely idle").
    assert.ok(r.confidence < 0.5);
  });

  it("floor-branch confidence approaches 1 when every rule scores near zero", () => {
    // baseInput already produces ~zero scores on every rule. Confidence on the
    // floor branch should be very high — we are confident nothing is wrong.
    const r = classifyBottleneck(baseInput);
    assert.equal(r.dominant, "balanced");
    assert.equal(r.topSignals.length, 0);
    assert.ok(
      r.confidence > 0.95,
      `expected confidence > 0.95, got ${r.confidence}`,
    );
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
