export interface SmoothingConfig {
  warmupRuns: number;
  sampleRuns: number;
  outlierMethod: "iqr" | "stddev" | "none";
  iqrMultiplier: number;
}

export interface MetricMeasurement {
  metricName: string;
  values: number[];
}

export interface SmoothingResult {
  metricName: string;
  originalValues: number[];
  smoothedValue: number;
  outliersRemoved: number[];
  stats: {
    mean: number;
    median: number;
    stddev: number;
    min: number;
    max: number;
  };
}

export class MetricSmoothing {
  private config: SmoothingConfig;

  constructor(config: SmoothingConfig) {
    this.config = config;
  }

  filterWarmup(
    measurements: Record<string, number[]>,
  ): Record<string, number[]> {
    const filtered: Record<string, number[]> = {};

    for (const [metricName, values] of Object.entries(measurements)) {
      if (values.length > this.config.warmupRuns) {
        filtered[metricName] = values.slice(this.config.warmupRuns);
      } else {
        filtered[metricName] = values;
      }
    }

    return filtered;
  }

  detectOutliers(values: number[]): number[] {
    if (this.config.outlierMethod === "none") {
      return [];
    }

    if (values.length < 3) {
      return [];
    }

    if (this.config.outlierMethod === "iqr") {
      return this.detectIQROutliers(values);
    } else if (this.config.outlierMethod === "stddev") {
      return this.detectStdDevOutliers(values);
    }

    return [];
  }

  private detectIQROutliers(values: number[]): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = this.percentile(sorted, 25);
    const q3 = this.percentile(sorted, 75);
    const iqr = q3 - q1;

    const lowerBound = q1 - this.config.iqrMultiplier * iqr;
    const upperBound = q3 + this.config.iqrMultiplier * iqr;

    return values.filter((v) => v < lowerBound || v > upperBound);
  }

  private detectStdDevOutliers(values: number[]): number[] {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stddev = Math.sqrt(variance);

    const threshold = 2 * stddev;
    return values.filter((v) => Math.abs(v - mean) > threshold);
  }

  private percentile(sorted: number[], p: number): number {
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    if (upper >= sorted.length) {
      return sorted[sorted.length - 1];
    }

    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  smooth(measurements: Record<string, number[]>): Record<string, number> {
    const results: Record<string, number> = {};

    for (const [metricName, values] of Object.entries(measurements)) {
      const result = this.smoothMetric(metricName, values);
      results[metricName] = result.smoothedValue;
    }

    return results;
  }

  smoothMetric(metricName: string, values: number[]): SmoothingResult {
    const outliers = this.detectOutliers(values);
    const filteredValues = values.filter((v) => !outliers.includes(v));

    const stats = this.calculateStats(filteredValues);

    return {
      metricName,
      originalValues: values,
      smoothedValue: stats.median,
      outliersRemoved: outliers,
      stats,
    };
  }

  private calculateStats(values: number[]): SmoothingResult["stats"] {
    if (values.length === 0) {
      return {
        mean: 0,
        median: 0,
        stddev: 0,
        min: 0,
        max: 0,
      };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    const mean = sum / values.length;
    const variance =
      values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / values.length;

    return {
      mean,
      median: this.percentile(sorted, 50),
      stddev: Math.sqrt(variance),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }
}

export async function runBenchmarkWithSmoothing(
  config: SmoothingConfig,
  benchmarkFn: () => Promise<Record<string, number>>,
): Promise<{
  smoothed: Record<string, number>;
  raw: Record<string, number[]>;
}> {
  const measurements: Record<string, number[]> = {};

  for (let i = 0; i < config.warmupRuns + config.sampleRuns; i++) {
    const result = await benchmarkFn();

    for (const [metricName, value] of Object.entries(result)) {
      if (!measurements[metricName]) {
        measurements[metricName] = [];
      }
      measurements[metricName].push(value);
    }
  }

  const smoother = new MetricSmoothing(config);
  const filtered = smoother.filterWarmup(measurements);
  const smoothed = smoother.smooth(filtered);

  return {
    smoothed,
    raw: measurements,
  };
}
