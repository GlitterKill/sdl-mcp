/**
 * Metrics Collector — records, aggregates, and analyzes tool call performance data.
 */

import type {
  ToolCallRecord,
  ToolResultCheck,
  ToolResultStats,
  AggregateMetrics,
  NumericSummary,
  ToolDiagnostics,
  MemorySnapshot,
  PoolSnapshot,
  DispatchSnapshot,
  SessionSnapshot,
} from "./types.js";

export class MetricsCollector {
  private records: ToolCallRecord[] = [];
  private memorySnapshots: MemorySnapshot[] = [];
  private poolSnapshots: PoolSnapshot[] = [];
  private dispatchSnapshots: DispatchSnapshot[] = [];
  private sessionSnapshots: SessionSnapshot[] = [];
  private resultChecks: ToolResultCheck[] = [];
  private sampleValues: Map<string, string> = new Map();
  private toolTimingSamples: Map<
    string,
    { totalMs: number[]; phases: Map<string, number[]> }
  > = new Map();

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  recordToolCall(
    clientId: string,
    toolName: string,
    durationMs: number,
    success: boolean,
    responseSize: number,
    error?: string,
  ): void {
    this.records.push({
      clientId,
      toolName,
      durationMs,
      success,
      responseSize,
      error,
      timestamp: Date.now(),
    });
  }

  recordMemorySnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      timestamp: Date.now(),
    };
    this.memorySnapshots.push(snapshot);
    return snapshot;
  }

  recordPoolStats(stats: {
    readPoolSize: number;
    readPoolInitialized: number;
    writeQueued: number;
    writeActive: number;
  }): void {
    this.poolSnapshots.push({ ...stats, timestamp: Date.now() });
  }

  recordDispatchStats(stats: { active: number; queued: number }): void {
    this.dispatchSnapshots.push({ ...stats, timestamp: Date.now() });
  }

  recordSessionStats(stats: {
    activeSessions: number;
    maxSessions: number;
  }): void {
    this.sessionSnapshots.push({ ...stats, timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // Aggregation
  // ---------------------------------------------------------------------------

  getAggregateMetrics(toolName?: string): AggregateMetrics {
    const filtered = toolName
      ? this.records.filter((r) => r.toolName === toolName)
      : this.records;

    if (filtered.length === 0) {
      return {
        count: 0,
        min: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        max: 0,
        avg: 0,
        errorCount: 0,
        errorRate: 0,
        throughputPerSec: 0,
        avgResponseSize: 0,
        maxResponseSize: 0,
      };
    }

    const durations = filtered.map((r) => r.durationMs).sort((a, b) => a - b);
    const errorCount = filtered.filter((r) => !r.success).length;
    const totalMs =
      filtered.length > 1
        ? filtered[filtered.length - 1].timestamp - filtered[0].timestamp
        : 1000;

    const sizes = filtered.map((r) => r.responseSize);
    const totalSize = sizes.reduce((a, b) => a + b, 0);

    return {
      count: filtered.length,
      min: durations[0],
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations[durations.length - 1],
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      errorCount,
      errorRate: errorCount / filtered.length,
      throughputPerSec:
        Math.round((filtered.length / (totalMs / 1000)) * 100) / 100,
      avgResponseSize: Math.round(totalSize / filtered.length),
      maxResponseSize: Math.max(...sizes),
    };
  }

  getToolNames(): string[] {
    return [...new Set(this.records.map((r) => r.toolName))];
  }

  getAllToolMetrics(): Record<string, AggregateMetrics> {
    const result: Record<string, AggregateMetrics> = {};
    for (const name of this.getToolNames()) {
      result[name] = this.getAggregateMetrics(name);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Error Access
  // ---------------------------------------------------------------------------

  getErrors(): Array<{
    clientId: string;
    toolName: string;
    message: string;
    timestamp: number;
  }> {
    return this.records
      .filter((r) => !r.success && r.error)
      .map((r) => ({
        clientId: r.clientId,
        toolName: r.toolName,
        message: r.error!,
        timestamp: r.timestamp,
      }));
  }

  // ---------------------------------------------------------------------------
  // Result Validation
  // ---------------------------------------------------------------------------

  recordResultChecks(checks: ToolResultCheck[]): void {
    this.resultChecks.push(...checks);
  }

  recordSampleValues(toolName: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
      this.sampleValues.set(`${toolName}:${key}`, value);
    }
  }

  recordToolTimingDiagnostics(
    toolName: string,
    diagnostics: unknown,
  ): void {
    const timings = extractTimingsPayload(diagnostics);
    if (!timings) return;

    const existing = this.toolTimingSamples.get(toolName) ?? {
      totalMs: [],
      phases: new Map<string, number[]>(),
    };

    existing.totalMs.push(timings.totalMs);
    for (const [phaseName, durationMs] of Object.entries(timings.phases)) {
      const phaseSamples = existing.phases.get(phaseName) ?? [];
      phaseSamples.push(durationMs);
      existing.phases.set(phaseName, phaseSamples);
    }

    this.toolTimingSamples.set(toolName, existing);
  }

  getResultStats(): ToolResultStats {
    const passed = this.resultChecks.filter((c) => c.passed).length;
    const failed = this.resultChecks.filter((c) => !c.passed).length;
    return {
      checksRun: this.resultChecks.length,
      checksPassed: passed,
      checksFailed: failed,
      failures: this.resultChecks.filter((c) => !c.passed),
      sampleValues: Object.fromEntries(this.sampleValues),
    };
  }

  getToolTimingDiagnostics(): Record<string, ToolDiagnostics> {
    const diagnostics: Record<string, ToolDiagnostics> = {};
    for (const [toolName, samples] of this.toolTimingSamples.entries()) {
      if (samples.totalMs.length === 0) continue;
      const phases: Record<string, NumericSummary> = {};
      for (const [phaseName, values] of samples.phases.entries()) {
        if (values.length === 0) continue;
        phases[phaseName] = summarizeNumbers(values);
      }
      diagnostics[toolName] = {
        timings: {
          totalMs: summarizeNumbers(samples.totalMs),
          phases,
        },
      };
    }
    return diagnostics;
  }

  // ---------------------------------------------------------------------------
  // Memory Analysis
  // ---------------------------------------------------------------------------

  getMemoryPeakMB(): number {
    if (this.memorySnapshots.length === 0) return 0;
    const peakRss = Math.max(...this.memorySnapshots.map((s) => s.rss));
    return Math.round((peakRss / (1024 * 1024)) * 10) / 10;
  }

  detectMemoryLeak(thresholdMB: number): { leaked: boolean; growthMB: number } {
    if (this.memorySnapshots.length < 2) {
      return { leaked: false, growthMB: 0 };
    }
    const first = this.memorySnapshots[0].rss;
    const last = this.memorySnapshots[this.memorySnapshots.length - 1].rss;
    const growthMB = Math.round(((last - first) / (1024 * 1024)) * 10) / 10;
    return { leaked: growthMB > thresholdMB, growthMB };
  }

  // ---------------------------------------------------------------------------
  // Dispatch Analysis
  // ---------------------------------------------------------------------------

  getPeakDispatchQueued(): number {
    if (this.dispatchSnapshots.length === 0) return 0;
    return Math.max(...this.dispatchSnapshots.map((s) => s.queued));
  }

  getPeakDispatchActive(): number {
    if (this.dispatchSnapshots.length === 0) return 0;
    return Math.max(...this.dispatchSnapshots.map((s) => s.active));
  }

  getAvgDispatchQueued(): number {
    if (this.dispatchSnapshots.length === 0) return 0;
    const sum = this.dispatchSnapshots.reduce((a, s) => a + s.queued, 0);
    return Math.round((sum / this.dispatchSnapshots.length) * 10) / 10;
  }

  getDispatchSampleCount(): number {
    return this.dispatchSnapshots.length;
  }

  // ---------------------------------------------------------------------------
  // Per-Client Analysis
  // ---------------------------------------------------------------------------

  /** Get metrics broken down by clientId — reveals uneven load distribution. */
  getPerClientMetrics(): Record<string, AggregateMetrics> {
    const clientIds = [...new Set(this.records.map((r) => r.clientId))];
    const result: Record<string, AggregateMetrics> = {};
    for (const id of clientIds) {
      const filtered = this.records.filter((r) => r.clientId === id);
      if (filtered.length === 0) continue;
      const durations = filtered.map((r) => r.durationMs).sort((a, b) => a - b);
      const sizes = filtered.map((r) => r.responseSize);
      const errorCount = filtered.filter((r) => !r.success).length;
      const totalMs =
        filtered.length > 1
          ? filtered[filtered.length - 1].timestamp - filtered[0].timestamp
          : 1000;
      result[id] = {
        count: filtered.length,
        min: durations[0],
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
        max: durations[durations.length - 1],
        avg: Math.round(durations.reduce((a, b) => a + b, 0) / filtered.length),
        errorCount,
        errorRate: errorCount / filtered.length,
        throughputPerSec:
          Math.round((filtered.length / (totalMs / 1000)) * 100) / 100,
        avgResponseSize: Math.round(
          sizes.reduce((a, b) => a + b, 0) / filtered.length,
        ),
        maxResponseSize: Math.max(...sizes),
      };
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Throughput Timeline
  // ---------------------------------------------------------------------------

  /**
   * Return time-bucketed throughput and error counts.
   * Each bucket covers `bucketMs` milliseconds from the first recorded call.
   */
  getThroughputTimeline(
    bucketMs: number = 1000,
  ): Array<{ offsetMs: number; calls: number; errors: number }> {
    if (this.records.length === 0) return [];
    const sorted = [...this.records].sort((a, b) => a.timestamp - b.timestamp);
    const startTs = sorted[0].timestamp;
    const endTs = sorted[sorted.length - 1].timestamp;
    const buckets: Array<{ offsetMs: number; calls: number; errors: number }> =
      [];
    for (let t = startTs; t <= endTs + bucketMs; t += bucketMs) {
      const inBucket = sorted.filter(
        (r) => r.timestamp >= t && r.timestamp < t + bucketMs,
      );
      buckets.push({
        offsetMs: t - startTs,
        calls: inBucket.length,
        errors: inBucket.filter((r) => !r.success).length,
      });
    }
    return buckets;
  }

  /** Expose raw records for advanced external analysis. */
  getRawRecords(): readonly ToolCallRecord[] {
    return this.records;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  reset(): void {
    this.records = [];
    this.memorySnapshots = [];
    this.poolSnapshots = [];
    this.dispatchSnapshots = [];
    this.sessionSnapshots = [];
    this.resultChecks = [];
    this.sampleValues = new Map();
    this.toolTimingSamples = new Map();
  }

  getRecordCount(): number {
    return this.records.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function summarizeNumbers(values: number[]): NumericSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    avg:
      sorted.length > 0
        ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
        : 0,
  };
}

function extractTimingsPayload(
  diagnostics: unknown,
): { totalMs: number; phases: Record<string, number> } | null {
  if (!diagnostics || typeof diagnostics !== "object") {
    return null;
  }
  const timings = (diagnostics as { timings?: unknown }).timings;
  if (!timings || typeof timings !== "object") {
    return null;
  }

  const totalMs = (timings as { totalMs?: unknown }).totalMs;
  const phases = (timings as { phases?: unknown }).phases;
  if (typeof totalMs !== "number" || !phases || typeof phases !== "object") {
    return null;
  }

  const numericPhases: Record<string, number> = {};
  for (const [phaseName, value] of Object.entries(phases)) {
    if (typeof value === "number") {
      numericPhases[phaseName] = value;
    }
  }

  return { totalMs, phases: numericPhases };
}
