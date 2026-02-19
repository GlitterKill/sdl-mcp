import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  recordToolTrace,
  retrainModel,
  getCurrentModel,
  getGatingConfig,
  configureGating,
  predictNextTool,
  predictNextToolFromRecent,
  computePriorityBoost,
  recordStrategyMetrics,
  recordWastedPrefetch,
  getStrategyMetrics,
  getAllStrategyMetrics,
  resetModel,
  clearTraceBuffer,
  trainPrefetchModel,
  type PrefetchModel,
  type ToolTraceEvent,
} from "../../src/graph/prefetch-model.js";
import {
  configurePrefetch,
  getPrefetchStats,
  prefetchSliceFrontier,
  consumePrefetchedKey,
} from "../../src/graph/prefetch.js";

describe("prefetch model integration", () => {
  beforeEach(() => {
    resetModel();
    clearTraceBuffer();
    configurePrefetch({ enabled: true, maxBudgetPercent: 20 });
    configureGating({
      enabled: true,
      minSamplesForPrediction: 2,
      confidenceThreshold: 0.3,
      fallbackToDeterministic: true,
      retrainIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    resetModel();
    clearTraceBuffer();
  });

  describe("model predictions influence queue ordering", () => {
    it("boosts priority based on predicted next tool", () => {
      const events: ToolTraceEvent[] = [
        { repoId: "r1", taskType: "implement", tool: "search" },
        { repoId: "r1", taskType: "implement", tool: "card" },
        { repoId: "r1", taskType: "implement", tool: "slice" },
        { repoId: "r1", taskType: "implement", tool: "search" },
        { repoId: "r1", taskType: "implement", tool: "card" },
        { repoId: "r1", taskType: "implement", tool: "slice" },
        { repoId: "r1", taskType: "implement", tool: "search" },
        { repoId: "r1", taskType: "implement", tool: "card" },
      ];

      for (const event of events) {
        recordToolTrace(event);
      }

      const model = retrainModel();
      assert.ok(model, "Model should be trained");

      const prediction = predictNextTool(model!, "search", "card");
      assert.strictEqual(
        prediction,
        "slice",
        "Should predict 'slice' after 'search=>card'",
      );

      const boost = computePriorityBoost("slice-frontier", "slice");
      assert.ok(
        boost > 0,
        `Should have positive boost for slice-frontier when slice predicted, got ${boost}`,
      );
    });

    it("records tool traces and builds transition model", () => {
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "search",
      });
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "card",
      });
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "slice",
      });
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "search",
      });
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "card",
      });
      recordToolTrace({
        repoId: "test-repo",
        taskType: "implement",
        tool: "slice",
      });

      const model = retrainModel();
      assert.ok(model, "Model should train with enough samples");
      assert.ok(
        model!.nextToolByPair["search=>card"],
        "Should have prediction for search=>card",
      );
    });

    it("predicts next tool from recent calls", () => {
      for (let i = 0; i < 3; i++) {
        recordToolTrace({ repoId: "r", taskType: "implement", tool: "search" });
        recordToolTrace({ repoId: "r", taskType: "implement", tool: "card" });
        recordToolTrace({ repoId: "r", taskType: "implement", tool: "slice" });
      }

      retrainModel();
      recordToolTrace({ repoId: "r", taskType: "implement", tool: "search" });
      recordToolTrace({ repoId: "r", taskType: "implement", tool: "card" });

      const prediction = predictNextToolFromRecent();
      assert.strictEqual(prediction, "slice");
    });
  });

  describe("deterministic fallback when model unavailable", () => {
    it("returns zero boost when model disabled", () => {
      configureGating({ enabled: false });

      const boost = computePriorityBoost("slice-frontier", "slice");
      assert.strictEqual(
        boost,
        0,
        "Should return zero boost when model disabled",
      );
    });

    it("returns zero boost when prediction is null", () => {
      const boost = computePriorityBoost("slice-frontier", null);
      assert.strictEqual(
        boost,
        0,
        "Should return zero boost when prediction is null",
      );
    });

    it("model returns null when insufficient samples", () => {
      configureGating({ minSamplesForPrediction: 100 });

      const events: ToolTraceEvent[] = [
        { repoId: "r", taskType: "implement", tool: "a" },
        { repoId: "r", taskType: "implement", tool: "b" },
        { repoId: "r", taskType: "implement", tool: "c" },
      ];

      const model = trainPrefetchModel(events);
      const prediction = predictNextTool(model, "a", "b");
      assert.strictEqual(
        prediction,
        null,
        "Should return null with insufficient samples",
      );
    });

    it("works without model training", () => {
      const model = getCurrentModel();
      assert.strictEqual(model, null, "Should be null before training");

      const prediction = predictNextToolFromRecent();
      assert.strictEqual(prediction, null, "Should return null without model");
    });
  });

  describe("metrics status output fields", () => {
    it("tracks hit rate per strategy", () => {
      recordStrategyMetrics("slice-frontier", true, 35);
      recordStrategyMetrics("slice-frontier", true, 35);
      recordStrategyMetrics("slice-frontier", false, 0);

      const metrics = getStrategyMetrics("slice-frontier");
      assert.ok(metrics, "Should have metrics for strategy");
      assert.strictEqual(metrics!.cacheHits, 2);
      assert.strictEqual(metrics!.cacheMisses, 1);
      assert.ok(metrics!.hitRate > 0.5, "Hit rate should be > 0.5");
    });

    it("tracks waste rate per strategy", () => {
      recordStrategyMetrics("file-open", true, 35);
      recordWastedPrefetch("file-open");
      recordWastedPrefetch("file-open");

      const metrics = getStrategyMetrics("file-open");
      assert.ok(metrics, "Should have metrics");
      assert.strictEqual(metrics!.wastedPrefetch, 2);
      assert.ok(metrics!.wasteRate > 0, "Waste rate should be positive");
    });

    it("aggregates all strategy metrics", () => {
      recordStrategyMetrics("slice-frontier", true, 35);
      recordStrategyMetrics("file-open", true, 35);
      recordStrategyMetrics("delta-blast", false, 0);

      const allMetrics = getAllStrategyMetrics();
      assert.strictEqual(allMetrics.length, 3, "Should have 3 strategies");
      assert.ok(allMetrics.some((m) => m.strategy === "slice-frontier"));
      assert.ok(allMetrics.some((m) => m.strategy === "file-open"));
      assert.ok(allMetrics.some((m) => m.strategy === "delta-blast"));
    });

    it("reports latency reduction correctly", () => {
      recordStrategyMetrics("slice-frontier", true, 50);
      recordStrategyMetrics("slice-frontier", true, 30);

      const metrics = getStrategyMetrics("slice-frontier");
      assert.ok(metrics, "Should have metrics");
      assert.ok(
        metrics!.avgLatencyReductionMs > 0,
        "Should track latency reduction",
      );
    });
  });

  describe("gating config", () => {
    it("returns default gating config", () => {
      const config = getGatingConfig();
      assert.ok(typeof config.enabled === "boolean");
      assert.ok(typeof config.minSamplesForPrediction === "number");
      assert.ok(typeof config.confidenceThreshold === "number");
      assert.ok(typeof config.fallbackToDeterministic === "boolean");
      assert.ok(typeof config.retrainIntervalMs === "number");
    });

    it("allows overriding gating config", () => {
      configureGating({
        enabled: false,
        minSamplesForPrediction: 10,
        confidenceThreshold: 0.8,
      });

      const config = getGatingConfig();
      assert.strictEqual(config.enabled, false);
      assert.strictEqual(config.minSamplesForPrediction, 10);
      assert.strictEqual(config.confidenceThreshold, 0.8);
    });
  });

  describe("prefetch stats integration", () => {
    it("includes model status in prefetch stats", () => {
      const repoId = "stats-test-repo";

      prefetchSliceFrontier(repoId, []);

      const stats = getPrefetchStats(repoId);
      assert.ok(
        typeof stats.modelEnabled === "boolean",
        "Should include modelEnabled",
      );
      assert.ok(
        Array.isArray(stats.strategyMetrics),
        "Should include strategyMetrics array",
      );
      assert.ok(
        typeof stats.deterministicFallback === "boolean",
        "Should include deterministicFallback",
      );
    });

    it("tracks strategy metrics through consume", () => {
      const repoId = "consume-test";
      const key = "card:test-symbol";

      prefetchSliceFrontier(repoId, []);
      const hit = consumePrefetchedKey(repoId, key, "slice-frontier");

      assert.strictEqual(typeof hit, "boolean");
      const stats = getPrefetchStats(repoId);
      assert.ok(Array.isArray(stats.strategyMetrics));
    });
  });

  describe("regression: deterministic fallback works", () => {
    it("prefetch still works when model is null", () => {
      configureGating({ enabled: false });
      const repoId = "fallback-test";

      prefetchSliceFrontier(repoId, ["symbol1", "symbol2"]);

      const stats = getPrefetchStats(repoId);
      assert.ok(stats.enabled, "Prefetch should be enabled");
      assert.strictEqual(stats.modelEnabled, false, "Model should be disabled");
      assert.strictEqual(
        stats.deterministicFallback,
        true,
        "Should be using deterministic fallback",
      );
    });

    it("priority boost is zero when model disabled", () => {
      configureGating({ enabled: false });

      const boost1 = computePriorityBoost("slice-frontier", "slice");
      const boost2 = computePriorityBoost("file-open", "card");

      assert.strictEqual(boost1, 0);
      assert.strictEqual(boost2, 0);
    });
  });
});
