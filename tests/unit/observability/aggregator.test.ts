import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Aggregator,
  DEFAULT_AGGREGATOR_OPTIONS,
} from "../../../dist/observability/aggregator.js";

const REPO = "sdl-mcp";

describe("Aggregator", () => {
  it("starts with a fresh schema-versioned snapshot", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    const snap = agg.getSnapshot(REPO);
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.repoId, REPO);
    assert.ok(typeof snap.generatedAt === "string");
  });

  it("records cache hits and misses with correct hit rate", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordCacheOutcome({ source: "fts", hit: true, latencyMs: 5 });
    agg.recordCacheOutcome({ source: "fts", hit: true, latencyMs: 10 });
    agg.recordCacheOutcome({ source: "fts", hit: false, latencyMs: 15 });
    agg.recordCacheOutcome({ source: "vector", hit: false, latencyMs: 20 });
    const { cache } = agg.getSnapshot(REPO);
    assert.equal(cache.totalHits, 2);
    assert.equal(cache.totalMisses, 2);
    assert.equal(cache.overallHitRatePct, 50);
  });

  it("aggregates packed-wire byte savings", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordPackedWire({
      encoderId: "v2",
      jsonBytes: 1000,
      packedBytes: 400,
      decision: "packed",
      axisHit: "bytes",
    });
    agg.recordPackedWire({
      encoderId: "v2",
      jsonBytes: 500,
      packedBytes: 200,
      decision: "packed",
      axisHit: "tokens",
    });
    const { packed } = agg.getSnapshot(REPO);
    assert.equal(packed.bytesSaved, 900);
    assert.equal(packed.packedCount, 2);
    assert.equal(packed.fallbackCount, 0);
  });

  it("counts SCIP failures separately from successes", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordScipIngest({
      edgesCreated: 100,
      edgesUpgraded: 20,
      durationMs: 50,
      failed: false,
    });
    agg.recordScipIngest({
      edgesCreated: 0,
      edgesUpgraded: 0,
      durationMs: 5,
      failed: true,
    });
    const { scip } = agg.getSnapshot(REPO);
    assert.equal(scip.successCount, 1);
    assert.equal(scip.failureCount, 1);
    assert.equal(scip.totalEdgesCreated, 100);
    assert.equal(scip.totalEdgesUpgraded, 20);
  });

  it("classifies PPR backend dispatch", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordPprResult({
      repoId: REPO,
      backend: "native",
      computeMs: 5,
      touched: 100,
      seedCount: 3,
    });
    agg.recordPprResult({
      repoId: REPO,
      backend: "js",
      computeMs: 12,
      touched: 80,
      seedCount: 2,
    });
    agg.recordPprResult({
      repoId: REPO,
      backend: "fallback-bfs",
      computeMs: 1,
      touched: 30,
      seedCount: 1,
    });
    const { ppr } = agg.getSnapshot(REPO);
    assert.equal(ppr.totalRuns, 3);
    assert.equal(ppr.nativeCount, 1);
    assert.equal(ppr.jsCount, 1);
    assert.equal(ppr.fallbackCount, 1);
  });

  it("emits timeseries with the requested window", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordResourceSample({
      cpuPct: 25,
      rssMb: 512,
      heapUsedMb: 256,
      heapTotalMb: 512,
      eventLoopLagMs: 5,
    });
    const ts = agg.getTimeseries(REPO, "15m");
    assert.equal(ts.schemaVersion, 1);
    assert.equal(ts.window, "15m");
    assert.ok(ts.resolutionMs > 0);
    assert.equal(typeof ts.series, "object");
  });
});
