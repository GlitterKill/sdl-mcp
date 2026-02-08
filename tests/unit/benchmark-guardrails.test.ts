# Benchmark Guardrails Test

Test suite for the benchmark guardrails system.

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  ThresholdEvaluator,
  loadThresholdConfig,
  loadBaselineMetrics,
  saveBaselineMetrics,
  type BenchmarkThresholds,
} from "../../src/benchmark/threshold.js";
import { RegressionReportGenerator } from "../../src/benchmark/regression.js";
import { MetricSmoothing, runBenchmarkWithSmoothing } from "../../src/benchmark/smoothing.js";

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

    expect(result.passed).toBe(true);
    expect(result.evaluations.length).toBe(1);
    expect(result.evaluations[0].passed).toBe(true);
    expect(result.evaluations[0].delta).toBe(-50);
    expect(result.evaluations[0].deltaPercent).toBeCloseTo(-33.33, 1);
  });

  it("should fail when current value exceeds allowable increase", () => {
    const currentMetrics = { indexTimePerFile: 180 };
    const baselineMetrics = { indexTimePerFile: 150 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    expect(result.passed).toBe(false);
    expect(result.evaluations[0].passed).toBe(false);
    expect(result.evaluations[0].delta).toBe(30);
    expect(result.evaluations[0].deltaPercent).toBe(20);
  });

  it("should pass when within allowable increase", () => {
    const currentMetrics = { indexTimePerFile: 160 };
    const baselineMetrics = { indexTimePerFile: 150 };

    const result = evaluator.evaluate(currentMetrics, baselineMetrics);

    expect(result.passed).toBe(true);
    expect(result.evaluations[0].passed).toBe(true);
  });

  it("should fail when below minimum value", () => {
    const currentMetrics = { symbolsPerFile: 3 };

    const result = evaluator.evaluate(currentMetrics);

    expect(result.passed).toBe(false);
    expect(result.evaluations[0].passed).toBe(false);
  });

  it("should pass when above minimum value", () => {
    const currentMetrics = { symbolsPerFile: 10 };

    const result = evaluator.evaluate(currentMetrics);

    expect(result.passed).toBe(true);
    expect(result.evaluations[0].passed).toBe(true);
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

    expect(result.evaluations.length).toBe(2);
    expect(result.summary.total).toBe(2);
    expect(result.summary.passed).toBe(2);
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

    expect(report.summary.passed).toBe(true);
    expect(report.summary.totalMetrics).toBe(1);
    expect(report.summary.improved).toBe(1);
    expect(report.summary.degraded).toBe(0);
    expect(report.deltas[0].trend).toBe("improved");
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

    expect(report.summary.passed).toBe(false);
    expect(report.summary.degraded).toBe(1);
    expect(report.deltas[0].trend).toBe("degraded");
    expect(report.deltas[0].impact).toBe("high");
    expect(report.failingThresholds).toContain("indexing.indexTimePerFile");
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

    expect(markdown).toContain("# Benchmark Regression Report");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("indexTimePerFile");
    expect(markdown).toContain("improved");
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

    expect(filtered.metricA).toEqual([90, 88, 87]);
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

    expect(outliers).toContain(100);
    expect(outliers.length).toBe(1);
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

    expect(outliers).toContain(100);
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

    expect(smoothed.metricA).toBe(90);
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

    expect(callCount).toBe(3); // 1 warmup + 2 samples
    expect(raw.metricA).toEqual([100, 200, 300]);
    expect(smoothed.metricA).toBe(250); // Median of [200, 300]
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

    expect(loaded).toBeDefined();
    expect(loaded?.indexTimePerFile).toBe(150);
    expect(loaded?.symbolsPerFile).toBe(25);
  });

  it("should return undefined for missing baseline", () => {
    const loaded = loadBaselineMetrics(baselinePath);

    expect(loaded).toBeUndefined();
  });

  it("should handle malformed baseline gracefully", () => {
    writeFileSync(baselinePath, "invalid json", "utf-8");

    expect(() => loadBaselineMetrics(baselinePath)).toThrow();
  });
});
