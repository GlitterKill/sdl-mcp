import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";
import {
  ThresholdEvaluator,
  loadBaselineMetrics,
  saveBaselineMetrics,
  type BenchmarkThresholds,
} from "../../dist/benchmark/threshold.js";
import { RegressionReportGenerator } from "../../dist/benchmark/regression.js";
import { MetricSmoothing, runBenchmarkWithSmoothing } from "../../dist/benchmark/smoothing.js";

describe("Benchmark Threshold Evaluator", () => {
  let thresholds: BenchmarkThresholds;
  let evaluator: ThresholdEvaluator;

  beforeEach(() => {
    thresholds = {
      version: "1.0",
      description: "Test thresholds",
      thresholds: {
        indexing: {
          indexTimePerFile: {
            maxMs: 200,
            trend: "lower-is-better",
            allowableIncreasePercent: 10,
          },
        },
        quality: {
          symbolsPerFile: {
            minValue: 5,
            trend: "higher-is-better",
            allowableDecreasePercent: 5,
          },
        },
        performance: {},
        tokenEfficiency: {},
        coverage: {},
      },
      smoothing: {
        warmupRuns: 2,
        sampleRuns: 3,
        outlierMethod: "iqr",
        iqrMultiplier: 1.5,
      },
      baseline: {
        filePath: ".benchmark/baseline.json",
        autoUpdateOnPass: false,
      },
    };
    evaluator = new ThresholdEvaluator(thresholds);
  });

  it("should pass when current value is better than baseline", () => {
    const currentMetrics = { indexTimePerFile: 100 };
    const baselineMetrics = { indexTimePerFile: 150 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluations.length, 1);
    assert.strictEqual(result.evaluations[0].passed, true);
    assert.strictEqual(result.evaluations[0].delta, -50);
    assert.ok(
      Math.abs((result.evaluations[0].deltaPercent ?? 0) - -33.33) < 0.1,
    );
  });

  it("should fail when current value exceeds allowable increase", () => {
    const currentMetrics = { indexTimePerFile: 180 };
    const baselineMetrics = { indexTimePerFile: 150 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.evaluations[0].passed, false);
    assert.strictEqual(result.evaluations[0].delta, 30);
    assert.strictEqual(result.evaluations[0].deltaPercent, 20);
  });

  it("should pass when within allowable increase", () => {
    const currentMetrics = { indexTimePerFile: 160 };
    const baselineMetrics = { indexTimePerFile: 150 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluations[0].passed, true);
  });

  it("should not hard-fail on absolute max when baseline already exceeds max and current is within tolerance", () => {
    const currentMetrics = { indexTimePerFile: 260 };
    const baselineMetrics = { indexTimePerFile: 250 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluations[0].passed, true);
  });

  it("should fail when below minimum value", () => {
    const currentMetrics = { symbolsPerFile: 3 };

    const result = evaluator.evaluate(currentMetrics);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.evaluations[0].passed, false);
  });

  it("should pass when above minimum value", () => {
    const currentMetrics = { symbolsPerFile: 10 };

    const result = evaluator.evaluate(currentMetrics);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.evaluations[0].passed, true);
  });

  it("should evaluate multiple metrics", () => {
    const currentMetrics = {
      indexTimePerFile: 100,
      symbolsPerFile: 10,
    };
    const baselineMetrics = {
      indexTimePerFile: 150,
      symbolsPerFile: 8,
    };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    assert.strictEqual(result.evaluations.length, 2);
    assert.strictEqual(result.summary.total, 2);
    assert.strictEqual(result.summary.passed, 2);
  });
});

describe("Regression Report Generator", () => {
  let generator: RegressionReportGenerator;

  beforeEach(() => {
    generator = new RegressionReportGenerator();
  });

  it("should generate regression report with improved metrics", () => {
    const data = {
      timestamp: new Date().toISOString(),
      repoId: "test-repo",
      currentMetrics: { indexTimePerFile: 100 },
      baselineMetrics: { indexTimePerFile: 150 },
      thresholds: {},
      evaluations: [
        {
          metricName: "indexTimePerFile",
          category: "indexing",
          currentValue: 100,
          baselineValue: 150,
          threshold: {
            trend: "lower-is-better" as const,
            allowableIncreasePercent: 10,
          },
          passed: true,
          delta: -50,
          deltaPercent: -33.33,
          message: "Within tolerance (-33.3% decrease)",
        },
      ],
    };

    const report = generator.generate(data);

    assert.strictEqual(report.summary.passed, true);
    assert.strictEqual(report.summary.totalMetrics, 1);
    assert.strictEqual(report.summary.improved, 1);
    assert.strictEqual(report.summary.degraded, 0);
    assert.strictEqual(report.deltas[0].trend, "improved");
  });

  it("should generate regression report with degraded metrics", () => {
    const data = {
      timestamp: new Date().toISOString(),
      repoId: "test-repo",
      currentMetrics: { indexTimePerFile: 180 },
      baselineMetrics: { indexTimePerFile: 150 },
      thresholds: {},
      evaluations: [
        {
          metricName: "indexTimePerFile",
          category: "indexing",
          currentValue: 180,
          baselineValue: 150,
          threshold: {
            trend: "lower-is-better" as const,
            allowableIncreasePercent: 10,
          },
          passed: false,
          delta: 30,
          deltaPercent: 20,
          message: "Increased by 20.0% (threshold: 10%)",
        },
      ],
    };

    const report = generator.generate(data);

    assert.strictEqual(report.summary.passed, false);
    assert.strictEqual(report.summary.degraded, 1);
    assert.strictEqual(report.deltas[0].trend, "degraded");
    assert.strictEqual(report.deltas[0].impact, "medium");
    assert.ok(report.failingThresholds.includes("indexing.indexTimePerFile"));
  });

  it("should generate markdown report", () => {
    const data = {
      timestamp: new Date().toISOString(),
      repoId: "test-repo",
      currentMetrics: { indexTimePerFile: 100 },
      baselineMetrics: { indexTimePerFile: 150 },
      thresholds: {},
      evaluations: [
        {
          metricName: "indexTimePerFile",
          category: "indexing",
          currentValue: 100,
          baselineValue: 150,
          threshold: {
            trend: "lower-is-better" as const,
            allowableIncreasePercent: 10,
          },
          passed: true,
          delta: -50,
          deltaPercent: -33.33,
          message: "Within tolerance (-33.3% decrease)",
        },
      ],
    };

    const report = generator.generate(data);
    const markdown = generator.generateMarkdownReport(report);

    assert.ok(markdown.includes("Benchmark Regression Report"));
    assert.ok(markdown.includes("Summary"));
    assert.ok(markdown.includes("indexTimePerFile"));
    assert.ok(markdown.includes("improved"));
  });
});

describe("Metric Smoothing", () => {
  it("should filter warmup runs", () => {
    const config = {
      warmupRuns: 2,
      sampleRuns: 3,
      outlierMethod: "none" as const,
      iqrMultiplier: 1.5,
    };
    const smoother = new MetricSmoothing(config);

    const measurements = {
      metricA: [100, 95, 90, 88, 87],
    };

    const filtered = smoother.filterWarmup(measurements);

    assert.deepStrictEqual(filtered.metricA, [90, 88, 87]);
  });

  it("should detect IQR outliers", () => {
    const config = {
      warmupRuns: 0,
      sampleRuns: 5,
      outlierMethod: "iqr" as const,
      iqrMultiplier: 1.5,
    };
    const smoother = new MetricSmoothing(config);

    const values = [10, 12, 11, 100, 13, 12, 11];
    const outliers = smoother.detectOutliers(values);

    assert.ok(outliers.includes(100));
    assert.strictEqual(outliers.length, 1);
  });

  it("should detect standard deviation outliers", () => {
    const config = {
      warmupRuns: 0,
      sampleRuns: 5,
      outlierMethod: "stddev" as const,
      iqrMultiplier: 1.5,
    };
    const smoother = new MetricSmoothing(config);

    const values = [10, 12, 11, 10, 12, 11, 100];
    const outliers = smoother.detectOutliers(values);

    assert.ok(outliers.includes(100));
  });

  it("should smooth metrics with median", () => {
    const config = {
      warmupRuns: 0,
      sampleRuns: 3,
      outlierMethod: "iqr" as const,
      iqrMultiplier: 1.5,
    };
    const smoother = new MetricSmoothing(config);

    const measurements = {
      metricA: [100, 95, 90, 88, 87],
    };

    const smoothed = smoother.smooth(measurements);

    assert.strictEqual(smoothed.metricA, 90);
  });

  it("should run benchmark with smoothing", async () => {
    const config = {
      warmupRuns: 1,
      sampleRuns: 2,
      outlierMethod: "none" as const,
      iqrMultiplier: 1.5,
    };

    let callCount = 0;
    const benchmarkFn = async () => {
      callCount++;
      return { metricA: callCount * 100 };
    };

    const { smoothed, raw } = await runBenchmarkWithSmoothing(config, benchmarkFn);

    assert.strictEqual(callCount, 3);
    assert.deepStrictEqual(raw.metricA, [100, 200, 300]);
    assert.strictEqual(smoothed.metricA, 250);
  });
});

describe("Baseline Management", () => {
  const baselinePath = resolve(process.cwd(), ".test-baseline.json");

  afterEach(() => {
    if (existsSync(baselinePath)) {
      unlinkSync(baselinePath);
    }
  });

  it("should save and load baseline metrics", () => {
    const results = {
      results: [
        {
          performance: {
            indexTimePerFile: 150,
            indexTimePerSymbol: 5,
            sliceBuildTimeMs: 100,
            avgSkeletonTimeMs: 2,
          },
          quality: {
            symbolsPerFile: 25,
            edgesPerSymbol: 12,
            graphConnectivity: 0.8,
            exportedSymbolRatio: 0.3,
          },
          sdlMcp: {
            avgCardTokens: 180,
            avgSkeletonTokens: 150,
          },
        },
      ],
    };

    saveBaselineMetrics(baselinePath, results);

    const loaded = loadBaselineMetrics(baselinePath);

    assert.ok(loaded !== undefined);
    assert.strictEqual(loaded?.indexTimePerFile, 150);
    assert.strictEqual(loaded?.symbolsPerFile, 25);
  });

  it("should load baseline metrics from benchmark-ci result format", () => {
    const results = {
      timestamp: "2026-02-09T00:00:00.000Z",
      repoId: "test-repo",
      repoPath: "/tmp/test-repo",
      metrics: {
        indexTimePerFile: 150,
        indexTimePerSymbol: 5,
        symbolsPerFile: 25,
        edgesPerSymbol: 12,
        graphConnectivity: 0.8,
        exportedSymbolRatio: 0.3,
        sliceBuildTimeMs: 100,
        avgSkeletonTimeMs: 2,
        avgCardTokens: 180,
        avgSkeletonTokens: 150,
      },
    };

    saveBaselineMetrics(baselinePath, results);

    const loaded = loadBaselineMetrics(baselinePath);

    assert.ok(loaded !== undefined);
    assert.strictEqual(loaded?.indexTimePerFile, 150);
    assert.strictEqual(loaded?.symbolsPerFile, 25);
    assert.strictEqual(loaded?.avgCardTokens, 180);
  });

  it("should return undefined for missing baseline", () => {
    const loaded = loadBaselineMetrics(baselinePath);

    assert.strictEqual(loaded, undefined);
  });

  it("should handle malformed baseline gracefully", () => {
    writeFileSync(baselinePath, "invalid json", "utf-8");

    assert.throws(() => loadBaselineMetrics(baselinePath));
  });
});
