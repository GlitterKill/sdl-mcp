import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface MetricThreshold {
  minValue?: number;
  maxMs?: number;
  maxTokens?: number;
  minPercent?: number;
  trend: "higher-is-better" | "lower-is-better";
  allowableIncreasePercent?: number;
  allowableDecreasePercent?: number;
}

export interface ThresholdCategory {
  [metricName: string]: MetricThreshold;
}

export interface BenchmarkThresholds {
  version: string;
  description: string;
  thresholds: {
    indexing: ThresholdCategory;
    quality: ThresholdCategory;
    performance: ThresholdCategory;
    tokenEfficiency: ThresholdCategory;
    coverage: ThresholdCategory;
  };
  smoothing: {
    warmupRuns: number;
    sampleRuns: number;
    outlierMethod: "iqr" | "stddev" | "none";
    iqrMultiplier: number;
  };
  baseline: {
    filePath: string;
    autoUpdateOnPass: boolean;
  };
}

export interface ThresholdEvaluation {
  metricName: string;
  category: string;
  currentValue: number;
  baselineValue?: number;
  threshold: MetricThreshold;
  passed: boolean;
  delta?: number;
  deltaPercent?: number;
  message: string;
}

export interface ThresholdEvaluationResult {
  passed: boolean;
  evaluations: ThresholdEvaluation[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export class ThresholdEvaluator {
  private thresholds: BenchmarkThresholds;

  constructor(thresholds: BenchmarkThresholds) {
    this.thresholds = thresholds;
  }

  evaluate(
    currentMetrics: Record<string, number>,
    baselineMetrics?: Record<string, number>,
  ): ThresholdEvaluationResult {
    const evaluations: ThresholdEvaluation[] = [];

    for (const [categoryName, category] of Object.entries(
      this.thresholds.thresholds,
    )) {
      for (const [metricName, threshold] of Object.entries(category)) {
        const currentValue = currentMetrics[metricName];
        const baselineValue = baselineMetrics?.[metricName];

        if (currentValue === undefined) {
          continue;
        }

        const evaluation = this.evaluateMetric(
          metricName,
          categoryName,
          currentValue,
          baselineValue,
          threshold,
        );
        evaluations.push(evaluation);
      }
    }

    const summary = {
      total: evaluations.length,
      passed: evaluations.filter((e) => e.passed).length,
      failed: evaluations.filter((e) => !e.passed).length,
      warnings: 0,
    };

    return {
      passed: summary.failed === 0,
      evaluations,
      summary,
    };
  }

  private evaluateMetric(
    metricName: string,
    category: string,
    currentValue: number,
    baselineValue: number | undefined,
    threshold: MetricThreshold,
  ): ThresholdEvaluation {
    let passed = true;
    let message = "";
    let delta: number | undefined;
    let deltaPercent: number | undefined;

    if (baselineValue !== undefined) {
      delta = currentValue - baselineValue;
      deltaPercent = (delta / baselineValue) * 100;

      if (threshold.trend === "lower-is-better") {
        if (threshold.allowableIncreasePercent) {
          const allowableIncrease =
            (baselineValue * threshold.allowableIncreasePercent) / 100;
          if (delta > allowableIncrease) {
            passed = false;
            message = `Increased by ${deltaPercent.toFixed(1)}% (threshold: ${threshold.allowableIncreasePercent}%)`;
          } else {
            message = `Within tolerance (${deltaPercent.toFixed(1)}% increase)`;
          }
        }
      } else {
        if (threshold.allowableDecreasePercent) {
          const allowableDecrease =
            (baselineValue * threshold.allowableDecreasePercent) / 100;
          if (delta < -allowableDecrease) {
            passed = false;
            message = `Decreased by ${Math.abs(deltaPercent).toFixed(1)}% (threshold: ${threshold.allowableDecreasePercent}%)`;
          } else {
            message = `Within tolerance (${deltaPercent.toFixed(1)}% change)`;
          }
        }
      }
    }

    if (threshold.maxMs !== undefined) {
      if (currentValue > threshold.maxMs) {
        passed = false;
        message = message
          ? `${message} and exceeds max ${threshold.maxMs}ms`
          : `Exceeds max ${threshold.maxMs}ms`;
      }
    }

    if (threshold.maxTokens !== undefined) {
      if (currentValue > threshold.maxTokens) {
        passed = false;
        message = message
          ? `${message} and exceeds max ${threshold.maxTokens} tokens`
          : `Exceeds max ${threshold.maxTokens} tokens`;
      }
    }

    if (threshold.minValue !== undefined) {
      if (currentValue < threshold.minValue) {
        passed = false;
        message = message
          ? `${message} and below min ${threshold.minValue}`
          : `Below minimum ${threshold.minValue}`;
      }
    }

    if (threshold.minPercent !== undefined) {
      if (currentValue < threshold.minPercent) {
        passed = false;
        message = message
          ? `${message} and below min ${(threshold.minPercent * 100).toFixed(0)}%`
          : `Below minimum ${(threshold.minPercent * 100).toFixed(0)}%`;
      }
    }

    if (message === "") {
      message = "No baseline or absolute threshold defined";
    }

    return {
      metricName,
      category,
      currentValue,
      baselineValue,
      threshold,
      passed,
      delta,
      deltaPercent,
      message,
    };
  }
}

export function loadThresholdConfig(configPath: string): BenchmarkThresholds {
  const content = readFileSync(configPath, "utf-8");
  return JSON.parse(content) as BenchmarkThresholds;
}

export function loadBaselineMetrics(
  baselinePath: string,
): Record<string, number> | undefined {
  if (!existsSync(baselinePath)) {
    return undefined;
  }

  const content = readFileSync(baselinePath, "utf-8");
  const baseline = JSON.parse(content);

  if (baseline.results && baseline.results[0]) {
    const result = baseline.results[0];
    const metrics: Record<string, number> = {};

    if (result.performance) {
      metrics.indexTimePerFile = result.performance.indexTimePerFile;
      metrics.indexTimePerSymbol = result.performance.indexTimePerSymbol;
      metrics.sliceBuildTimeMs = result.performance.sliceBuildTimeMs;
      metrics.avgSkeletonTimeMs = result.performance.avgSkeletonTimeMs;
    }

    if (result.quality) {
      metrics.symbolsPerFile = result.quality.symbolsPerFile;
      metrics.edgesPerSymbol = result.quality.edgesPerSymbol;
      metrics.graphConnectivity = result.quality.graphConnectivity;
      metrics.exportedSymbolRatio = result.quality.exportedSymbolRatio;
    }

    if (result.sdlMcp) {
      metrics.avgCardTokens = result.sdlMcp.avgCardTokens;
      metrics.avgSkeletonTokens = result.sdlMcp.avgSkeletonTokens;
    }

    return metrics;
  }

  return undefined;
}

export function saveBaselineMetrics(
  baselinePath: string,
  results: unknown,
): void {
  const dir = dirname(baselinePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(baselinePath, JSON.stringify(results, null, 2), "utf-8");
}
