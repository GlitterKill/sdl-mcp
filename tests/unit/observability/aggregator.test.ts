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

  it("computeAndRecordHealth returns 1.0 placeholders on a fresh aggregator (no NaN)", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.computeAndRecordHealth();
    const { health } = agg.getSnapshot(REPO);
    assert.equal(health.components.freshness, 1);
    assert.equal(health.components.errorRate, 1);
    assert.equal(health.components.coverage, 1);
    assert.equal(health.components.edgeQuality, 1);
    assert.equal(health.components.callResolution, 1);
    assert.equal(Number.isFinite(health.score), true);
    assert.equal(health.score, 100);
  });

  it("computeAndRecordHealth derives edgeQuality from latest IndexEvent stats", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordIndexEvent({
      repoId: REPO,
      versionId: "v1",
      stats: {
        filesScanned: 100,
        symbolsExtracted: 500,
        edgesExtracted: 1000,
        durationMs: 200,
        errors: 100,
      },
    });
    agg.computeAndRecordHealth();
    const { health } = agg.getSnapshot(REPO);
    assert.equal(health.components.edgeQuality, 0.9);
  });

  it("computeAndRecordHealth clamps edgeQuality at 0 when errors exceed edges", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordIndexEvent({
      repoId: REPO,
      versionId: "v1",
      stats: {
        filesScanned: 1,
        symbolsExtracted: 1,
        edgesExtracted: 10,
        durationMs: 1,
        errors: 50,
      },
    });
    agg.computeAndRecordHealth();
    const { health } = agg.getSnapshot(REPO);
    assert.equal(health.components.edgeQuality, 0);
  });

  it("recordCacheOutcome batch (count + hits) increments totals correctly", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordCacheOutcome({
      source: "etag",
      hit: true,
      latencyMs: 2,
      count: 10,
      hits: 7,
    });
    const { cache } = agg.getSnapshot(REPO);
    assert.equal(cache.totalHits, 7);
    assert.equal(cache.totalMisses, 3);
  });

  it("records audit buffer samples and exposes gauge in snapshot", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordAuditBufferSample({
      depth: 12,
      droppedTotal: 0,
      sessionActive: true,
    });
    agg.recordAuditBufferSample({
      depth: 5,
      droppedTotal: 2,
      sessionActive: false,
    });
    const { auditBuffer } = agg.getSnapshot(REPO);
    assert.equal(auditBuffer.depth, 5);
    assert.equal(auditBuffer.maxDepth, 12);
    assert.equal(auditBuffer.droppedTotal, 2);
    assert.equal(auditBuffer.sessionActive, false);
  });

  it("computes post-index session histogram + timeout count", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordPostIndexSession({ durationMs: 100, timedOut: false });
    agg.recordPostIndexSession({ durationMs: 250, timedOut: false });
    agg.recordPostIndexSession({ durationMs: 9000, timedOut: true });
    const { postIndexSession } = agg.getSnapshot(REPO);
    assert.equal(postIndexSession.totalSessions, 3);
    assert.equal(postIndexSession.timeoutCount, 1);
    assert.equal(postIndexSession.maxDurationMs, 9000);
    assert.equal(postIndexSession.lastDurationMs, 9000);
    assert.equal(postIndexSession.lastTimedOut, true);
    assert.ok(postIndexSession.lastEndedAt);
    assert.ok(postIndexSession.p95DurationMs >= 250);
    assert.ok(postIndexSession.avgDurationMs > 100);
  });

  it("ignores invalid post-index durations", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordPostIndexSession({ durationMs: Number.NaN, timedOut: false });
    agg.recordPostIndexSession({ durationMs: -5, timedOut: false });
    const { postIndexSession } = agg.getSnapshot(REPO);
    assert.equal(postIndexSession.totalSessions, 0);
    assert.equal(postIndexSession.maxDurationMs, 0);
  });
});
