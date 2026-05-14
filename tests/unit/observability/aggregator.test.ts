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
    assert.equal(snap.pool.dispatchActive, 0);
    assert.equal(snap.pool.dispatchQueued, 0);
    assert.equal(snap.pool.dispatchMax, 0);
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
      jsonTokens: 300,
      packedTokens: 120,
      decision: "packed",
      axisHit: "bytes",
    });
    agg.recordPackedWire({
      encoderId: "v2",
      jsonBytes: 500,
      packedBytes: 200,
      jsonTokens: 150,
      packedTokens: 60,
      decision: "fallback",
      axisHit: "tokens",
    });
    const { packed } = agg.getSnapshot(REPO);
    assert.equal(packed.jsonBaselineBytesTotal, 1000);
    assert.equal(packed.packedBytesTotal, 400);
    assert.equal(packed.jsonBaselineTokensTotal, 300);
    assert.equal(packed.packedTokensTotal, 120);
    assert.equal(packed.bytesSaved, 600);
    assert.equal(packed.tokensSaved, 180);
    assert.equal(packed.byEncoder.v2.tokensSaved, 180);
    assert.equal(packed.packedCount, 1);
    assert.equal(packed.fallbackCount, 1);
    assert.equal(packed.byEncoder.v2.totalDecisions, 2);
    assert.equal(packed.byEncoder.v2.fallbackCount, 1);
    const packedLayer =
      agg.getSnapshot(REPO).tokenEfficiency.compressionLayers.bySource
        .packedWire;
    assert.equal(packedLayer.events, 2);
    assert.equal(packedLayer.realizedEvents, 1);
    assert.equal(packedLayer.estimatedTokensAvoided, 180);
    assert.equal(packedLayer.storedBytes, 600);
    assert.equal(packedLayer.opportunities, 2);
    assert.equal(packedLayer.hits, 1);
    assert.equal(packedLayer.hitRatePct, 50);
  });

  it("starts token savings layers with zero denominators", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    const layers = agg.getSnapshot(REPO).tokenEfficiency.compressionLayers;
    assert.equal(layers.totalEvents, 0);
    assert.equal(layers.totalEstimatedTokensAvoided, 0);
    assert.equal(layers.bySource.etag.events, 0);
    assert.equal(layers.bySource.etag.opportunities, 0);
    assert.equal(layers.bySource.etag.hitRatePct, 0);
  });

  it("aggregates token savings by source and by tool", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordTokenSavingsEvent({
      source: "responseArtifact",
      tool: "sdl.context",
      estimatedTokensAvoided: 120,
      storedBytes: 2048,
      opportunity: true,
      hit: true,
    });
    agg.recordTokenSavingsEvent({
      source: "responseArtifact",
      tool: "sdl.context",
      estimatedTokensAvoided: 30,
      storedBytes: 512,
      opportunity: true,
      hit: false,
      realized: false,
    });
    agg.recordTokenSavingsEvent({
      source: "rawWindowAvoidance",
      tool: "code.getHotPath",
      estimatedTokensAvoided: 80,
    });

    const layers = agg.getSnapshot(REPO).tokenEfficiency.compressionLayers;
    assert.equal(layers.totalEvents, 3);
    assert.equal(layers.totalRealizedEvents, 2);
    assert.equal(layers.totalEstimatedTokensAvoided, 200);
    assert.equal(layers.totalStoredBytes, 2048);
    assert.equal(layers.bySource.responseArtifact.events, 2);
    assert.equal(layers.bySource.responseArtifact.realizedEvents, 1);
    assert.equal(layers.bySource.responseArtifact.estimatedTokensAvoided, 120);
    assert.equal(layers.bySource.responseArtifact.hitRatePct, 50);
    assert.equal(layers.bySource.rawWindowAvoidance.estimatedTokensAvoided, 80);
    assert.equal(layers.byTool["sdl.context"].events, 2);
    assert.equal(layers.byTool["sdl.context"].estimatedTokensAvoided, 120);
    assert.equal(layers.byTool["sdl.context"].storedBytes, 2048);
    assert.equal(layers.byTool["code.getHotPath"].estimatedTokensAvoided, 80);
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

  it("records dispatch limiter state in pool metrics", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);

    agg.recordDispatchSample({ active: 1, queued: 3, maxConcurrency: 1 });
    agg.recordDispatchSample({ active: 0, queued: 1, maxConcurrency: 8 });

    const { pool } = agg.getSnapshot(REPO);
    assert.equal(pool.dispatchActive, 0);
    assert.equal(pool.dispatchQueued, 1);
    assert.equal(pool.dispatchMax, 8);
    assert.equal(pool.maxDispatchActive, 1);
    assert.equal(pool.maxDispatchQueued, 3);
  });

  it("aggregates per-tool timing phase diagnostics", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordToolCall({
      tool: "sdl.context",
      request: {},
      response: {},
      durationMs: 100,
      diagnostics: {
        timings: {
          totalMs: 100,
          phases: {
            "context.retrieve": 70,
            "context.response": 15,
          },
        },
      },
    });
    agg.recordToolCall({
      tool: "sdl.context",
      request: {},
      response: {},
      durationMs: 300,
      diagnostics: {
        timings: {
          totalMs: 300,
          phases: {
            "context.retrieve": 210,
            "context.response": 30,
          },
        },
      },
    });

    const tool = agg.getSnapshot(REPO).latency.perTool["sdl.context"];
    assert.ok(tool);
    assert.equal(tool.phases?.["context.retrieve"]?.count, 2);
    assert.equal(tool.phases?.["context.retrieve"]?.p95Ms, 210);
    assert.equal(tool.phases?.["context.response"]?.maxMs, 30);
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
