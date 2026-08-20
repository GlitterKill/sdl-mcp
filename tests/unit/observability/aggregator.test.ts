import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Aggregator,
  DEFAULT_AGGREGATOR_OPTIONS,
  percentile,
} from "../../../dist/observability/aggregator.js";

const REPO = "sdl-mcp";


type ToolProjection = NonNullable<
  Parameters<Aggregator["recordToolCall"]>[0]["projection"]
>;

function toolProjection(
  overrides: Partial<ToolProjection>,
  observabilityProfile: "standard" | "usage" = "standard",
): ToolProjection {
  return {
    profile: {
      projector: "test",
      observabilityProfile,
      defaultDetail: "compact",
      budgetClass: "small",
      largeResponseStrategy: "truncate",
      recoveryPolicy: "none",
    },
    effectiveDetail: "compact",
    diagnosticsIncluded: false,
    rawBytes: 0,
    rawTokens: 0,
    projectedBytes: 0,
    projectedTokens: 0,
    removedFieldCount: 0,
    truncated: false,
    responseHandled: false,
    recoveryEmitted: false,
    invalidRecoveryCount: 0,
    ...overrides,
  };
}

describe("Aggregator", () => {
  it("preserves the legacy snapshot deep-key serialization order", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    const snapshot = agg.getSnapshot(REPO);
    const normalized = { ...snapshot, generatedAt: "<timestamp>", uptimeMs: 0 };
    assert.equal(
      createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      "e7a24d6147256d4621894b0eed4a3ce6a6e05ecbeeba45ef5bd0c640a1f343df",
    );
  });

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

  it("includes tool-call token usage in token-efficiency totals", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordToolCall({
      tool: "sdl.context",
      request: {},
      response: {},
      durationMs: 25,
      tokensUsed: 100,
      tokensSaved: 40,
    });

    const { tokenEfficiency } = agg.getSnapshot(REPO);
    assert.equal(tokenEfficiency.totalUsed, 100);
    assert.equal(tokenEfficiency.totalSaved, 40);
    assert.equal(tokenEfficiency.savingsRatio, 40 / 140);
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
    assert.equal(layers.totalOriginalTokens, 0);
    assert.equal(layers.totalReturnedTokens, 0);
    assert.equal(layers.totalSavedTokens, 0);
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
      originalTokens: 150,
      returnedTokens: 30,
      savedTokens: 120,
      storedBytes: 2048,
      opportunity: true,
      hit: true,
    });
    agg.recordTokenSavingsEvent({
      source: "responseArtifact",
      tool: "sdl.context",
      estimatedTokensAvoided: 30,
      originalTokens: 60,
      returnedTokens: 30,
      savedTokens: 30,
      storedBytes: 512,
      opportunity: true,
      hit: false,
      realized: false,
    });
    agg.recordTokenSavingsEvent({
      source: "rawWindowAvoidance",
      tool: "code.getHotPath",
      estimatedTokensAvoided: 80,
      originalTokens: 100,
      returnedTokens: 20,
      savedTokens: 80,
    });

    const layers = agg.getSnapshot(REPO).tokenEfficiency.compressionLayers;
    assert.equal(layers.totalEvents, 3);
    assert.equal(layers.totalRealizedEvents, 2);
    assert.equal(layers.totalEstimatedTokensAvoided, 200);
    assert.equal(layers.totalOriginalTokens, 250);
    assert.equal(layers.totalReturnedTokens, 50);
    assert.equal(layers.totalSavedTokens, 200);
    assert.equal(layers.totalStoredBytes, 2048);
    assert.equal(layers.bySource.responseArtifact.events, 2);
    assert.equal(layers.bySource.responseArtifact.realizedEvents, 1);
    assert.equal(layers.bySource.responseArtifact.estimatedTokensAvoided, 120);
    assert.equal(layers.bySource.responseArtifact.originalTokens, 150);
    assert.equal(layers.bySource.responseArtifact.returnedTokens, 30);
    assert.equal(layers.bySource.responseArtifact.savedTokens, 120);
    assert.equal(layers.bySource.responseArtifact.hitRatePct, 50);
    assert.equal(layers.bySource.rawWindowAvoidance.estimatedTokensAvoided, 80);
    assert.equal(layers.bySource.rawWindowAvoidance.originalTokens, 100);
    assert.equal(layers.bySource.rawWindowAvoidance.returnedTokens, 20);
    assert.equal(layers.bySource.rawWindowAvoidance.savedTokens, 80);
    assert.equal(layers.byTool["sdl.context"].events, 2);
    assert.equal(layers.byTool["sdl.context"].estimatedTokensAvoided, 120);
    assert.equal(layers.byTool["sdl.context"].originalTokens, 150);
    assert.equal(layers.byTool["sdl.context"].returnedTokens, 30);
    assert.equal(layers.byTool["sdl.context"].savedTokens, 120);
    assert.equal(layers.byTool["sdl.context"].storedBytes, 2048);
    assert.equal(layers.byTool["code.getHotPath"].estimatedTokensAvoided, 80);
    assert.equal(layers.byTool["code.getHotPath"].originalTokens, 100);
    assert.equal(layers.byTool["code.getHotPath"].returnedTokens, 20);
    assert.equal(layers.byTool["code.getHotPath"].savedTokens, 80);
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

  it("aggregates retrieval phase timings and beam frontier peaks", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordSemanticSearch({
      repoId: REPO,
      semanticEnabled: true,
      latencyMs: 40,
      candidateCount: 3,
      alpha: 0.6,
      retrievalMode: "hybrid",
      retrievalType: "hybrid",
      phaseLatencyMs: { fts: 6, vector: 14, fusion: 2 },
    });
    agg.recordSemanticSearch({
      repoId: REPO,
      semanticEnabled: true,
      latencyMs: 80,
      candidateCount: 5,
      alpha: 0.6,
      retrievalMode: "hybrid",
      retrievalType: "hybrid",
      phaseLatencyMs: { fts: 10, vector: 20, ppr: 12 },
    });
    agg.recordBeamBuild({
      durationMs: 10,
      accepted: 2,
      evicted: 1,
      rejected: 0,
      maxFrontierSize: 3,
    });
    agg.recordBeamBuild({
      durationMs: 20,
      accepted: 4,
      evicted: 0,
      rejected: 2,
      maxFrontierSize: 7,
    });

    const snap = agg.getSnapshot(REPO);
    assert.equal(snap.retrieval.avgLatencyMs, 60);
    assert.equal(snap.retrieval.phaseLatencyMs.fts.count, 2);
    assert.equal(snap.retrieval.phaseLatencyMs.fts.avgMs, 8);
    assert.equal(snap.retrieval.phaseLatencyMs.vector.p95Ms, 20);
    assert.equal(snap.retrieval.phaseLatencyMs.ppr.count, 1);
    assert.equal(snap.beam.avgFrontierMaxSize, 5);
    assert.equal(snap.beam.p95FrontierMaxSize, 7);
  });

  it("aggregates delta blast-radius metrics", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordDeltaBlastRadius({
      changedSymbolCount: 2,
      blastRadiusCount: 5,
      durationMs: 30,
      dbRoundTrips: 8,
      fallbackPathQueryCount: 2,
      pathExplanationLatencyMs: 12,
    });
    agg.recordDeltaBlastRadius({
      changedSymbolCount: 4,
      blastRadiusCount: 8,
      durationMs: 90,
      dbRoundTrips: 12,
      fallbackPathQueryCount: 0,
      pathExplanationLatencyMs: 0,
    });

    const delta = agg.getSnapshot(REPO).delta;
    assert.equal(delta.totalBlastRadiusComputations, 2);
    assert.equal(delta.avgBlastRadiusLatencyMs, 60);
    assert.equal(delta.p95BlastRadiusLatencyMs, 90);
    assert.equal(delta.avgDbRoundTripsPerChangedSymbol, 3.5);
    assert.equal(delta.fallbackPathQueryCount, 2);
    assert.equal(delta.avgPathExplanationLatencyMs, 12);
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

  it("surfaces predictive context aggregates from prefetch telemetry", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordPrefetch({
      repoId: REPO,
      hitRate: 0.4,
      wasteRate: 0.25,
      avgLatencyReductionMs: 35,
      queueDepth: 2,
      policyMode: "safe",
      outcomeSamples: 24,
      suppressedPrefetch: 3,
      acceptedPrefetch: 7,
      topStrategies: [
        {
          strategy: "search-cards",
          resourceKind: "card",
          samples: 24,
          hitRate: 0.4,
          acceptedRate: 0.3,
          wasteRate: 0.25,
          score: 0.42,
          suppressed: 3,
        },
      ],
    });

    const { predictiveContext } = agg.getSnapshot(REPO);
    assert.equal(predictiveContext.policyMode, "safe");
    assert.equal(predictiveContext.outcomeSamples, 24);
    assert.equal(predictiveContext.hitRatePct, 40);
    assert.equal(predictiveContext.wasteRatePct, 25);
    assert.equal(predictiveContext.topStrategies[0]?.strategy, "search-cards");
  });

  it("aggregates bounded, versioned tool-output metrics without retaining payloads", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    const fixtures = [
      ["sdl.context", false, toolProjection({
        rawBytes: 1000, rawTokens: 400, projectedBytes: 400,
        projectedTokens: 160, removedFieldCount: 3,
      })],
      ["sdl.context", false, toolProjection({
        rawBytes: 2000, rawTokens: 800, projectedBytes: 1000,
        projectedTokens: 400, removedFieldCount: 2, effectiveDetail: "full",
        truncated: true, responseHandled: true, recoveryEmitted: true,
      })],
      ["sdl.context", true, toolProjection({
        projectedBytes: 50, projectedTokens: 20, removedFieldCount: 1,
        responseHandled: true, invalidRecoveryCount: 2,
      })],
      ["sdl.manual", false, toolProjection({
        rawBytes: 500, rawTokens: 200, projectedBytes: 100,
        projectedTokens: 40,
      }, "usage")],
      ["sdl.manual", false, toolProjection({
        rawBytes: 600, rawTokens: 240, projectedBytes: 300,
        projectedTokens: 120, removedFieldCount: 4, effectiveDetail: "full",
        truncated: true,
      }, "usage")],
    ] as const;

    for (const [tool, errored, projection] of fixtures) {
      agg.recordToolCall({
        tool,
        request: { args: "request-secret", path: "C:\\secret\\source.ts" },
        response: {
          canonicalResult: "canonical-secret",
          stdout: "stdout-secret",
          stderr: "stderr-secret",
          source: "source-secret",
          handle: "handle-secret",
          diagnostics: { arbitrary: "diagnostic-secret" },
        },
        durationMs: 10,
        errored,
        projection,
      });
    }

    const snapshot = agg.getSnapshot(REPO);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.toolOutput.schemaVersion, 1);
    assert.deepEqual(snapshot.toolOutput.overall, {
      calls: 5,
      errors: 1,
      rawBytesTotal: 4100,
      projectedBytesTotal: 1850,
      rawTokensTotal: 1640,
      projectedTokensTotal: 740,
      reductionRatio: 2250 / 4100,
      removedFieldTotal: 10,
      handledCount: 2,
      handledRate: 2 / 5,
      truncatedCount: 2,
      truncatedRate: 2 / 5,
      detailCounts: { compact: 3, standard: 0, full: 2 },
      profileCounts: { standard: 3, usage: 2 },
      recoveryEmittedCount: 1,
      invalidRecoveryCount: 2,
      p50ProjectedBytes: 300,
      p95ProjectedBytes: 1000,
      maxProjectedBytes: 1000,
      p50ProjectedTokens: 120,
      p95ProjectedTokens: 400,
      maxProjectedTokens: 400,
    });
    assert.deepEqual(snapshot.toolOutput.perTool.map(({ tool }) => tool), [
      "sdl.context",
      "sdl.manual",
    ]);
    const context = snapshot.toolOutput.perTool[0];
    assert.ok(context);
    assert.equal(context.calls, 3);
    assert.equal(context.errors, 1);
    assert.equal(context.rawBytesTotal, 3000);
    assert.equal(context.projectedBytesTotal, 1450);
    assert.equal(context.reductionRatio, 1550 / 3000);
    assert.equal(context.p50ProjectedBytes, 400);
    assert.equal(context.p95ProjectedBytes, 1000);
    assert.equal(context.maxProjectedBytes, 1000);
    assert.equal(context.rawTokensTotal, 1200);
    assert.equal(context.projectedTokensTotal, 580);
    assert.equal(context.removedFieldTotal, 6);
    assert.equal(context.handledCount, 2);
    assert.equal(context.handledRate, 2 / 3);
    assert.equal(context.truncatedCount, 1);
    assert.equal(context.truncatedRate, 1 / 3);
    assert.deepEqual(context.detailCounts, {
      compact: 2,
      standard: 0,
      full: 1,
    });
    assert.deepEqual(context.profileCounts, { standard: 3 });
    assert.equal(context.recoveryEmittedCount, 1);
    assert.equal(context.invalidRecoveryCount, 2);
    assert.equal(context.p50ProjectedTokens, 160);
    assert.equal(context.p95ProjectedTokens, 400);
    assert.equal(context.maxProjectedTokens, 400);
    const manual = snapshot.toolOutput.perTool[1];
    assert.deepEqual(manual, {
      tool: "sdl.manual",
      calls: 2,
      errors: 0,
      rawBytesTotal: 1100,
      projectedBytesTotal: 400,
      rawTokensTotal: 440,
      projectedTokensTotal: 160,
      reductionRatio: 700 / 1100,
      removedFieldTotal: 4,
      handledCount: 0,
      handledRate: 0,
      truncatedCount: 1,
      truncatedRate: 0.5,
      detailCounts: { compact: 1, standard: 0, full: 1 },
      profileCounts: { usage: 2 },
      recoveryEmittedCount: 0,
      invalidRecoveryCount: 0,
      p50ProjectedBytes: 300,
      p95ProjectedBytes: 300,
      maxProjectedBytes: 300,
      p50ProjectedTokens: 120,
      p95ProjectedTokens: 120,
      maxProjectedTokens: 120,
    });
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  });

  it("uses deterministic odd/even percentiles and a zero-raw reduction branch", () => {
    assert.equal(percentile([9, 1, 5], 0.5), 5);
    assert.equal(percentile([4, 1, 3, 2], 0.5), 3);

    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordToolCall({
      tool: "sdl.zero",
      request: {},
      response: {},
      durationMs: 1,
      projection: toolProjection({
        effectiveDetail: "standard",
        projectedBytes: 7,
        projectedTokens: 3,
      }),
    });
    assert.equal(agg.getSnapshot(REPO).toolOutput.overall.reductionRatio, 0);
  });

  it("includes tool-output byte and token samples in timeseries", () => {
    const agg = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
    agg.recordToolCall({
      tool: "sdl.context",
      request: {},
      response: {},
      durationMs: 1,
      projection: toolProjection({
        rawBytes: 90,
        rawTokens: 30,
        projectedBytes: 30,
        projectedTokens: 10,
        removedFieldCount: 1,
      }),
    });

    const { series } = agg.getTimeseries(REPO, "15m");
    assert.equal(series.toolOutputRawBytes?.[0]?.rawBytes, 90);
    assert.equal(series.toolOutputProjectedBytes?.[0]?.projectedBytes, 30);
    assert.equal(series.toolOutputRawTokens?.[0]?.rawTokens, 30);
    assert.equal(series.toolOutputProjectedTokens?.[0]?.projectedTokens, 10);
  });
});
