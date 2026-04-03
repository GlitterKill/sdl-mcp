/**
 * Shared type definitions for the SDL-MCP stress test suite.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StressTestConfig {
  /** HTTP server host (default: "127.0.0.1") */
  host: string;
  /** HTTP server port (0 = OS-assigned) */
  port: number;
  /** Absolute path to the fixture repo root */
  fixturePath: string;
  /** Concurrency levels to escalate through */
  concurrencyLevels: number[];
  /** Per-tool-call timeout in ms */
  toolCallTimeoutMs: number;
  /** Per-scenario timeout in ms */
  scenarioTimeoutMs: number;
  /** Enable verbose per-operation logging */
  verbose: boolean;
}

export const DEFAULT_CONFIG: Omit<StressTestConfig, "fixturePath"> = {
  host: "127.0.0.1",
  port: 0,
  concurrencyLevels: [3, 4, 5, 6],
  toolCallTimeoutMs: 30_000,
  scenarioTimeoutMs: 120_000,
  verbose: false,
};

// ---------------------------------------------------------------------------
// Tool Call Recording
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  clientId: string;
  toolName: string;
  durationMs: number;
  success: boolean;
  responseSize: number;
  error?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Aggregate Metrics
// ---------------------------------------------------------------------------

export interface AggregateMetrics {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
  errorCount: number;
  errorRate: number;
  throughputPerSec: number;
  /** Average response payload size in bytes */
  avgResponseSize: number;
  /** Maximum response payload size in bytes */
  maxResponseSize: number;
}

// ---------------------------------------------------------------------------
// Memory & Pool Snapshots
// ---------------------------------------------------------------------------

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  timestamp: number;
}

export interface PoolSnapshot {
  readPoolSize: number;
  readPoolInitialized: number;
  writeQueued: number;
  writeActive: number;
  timestamp: number;
}

export interface DispatchSnapshot {
  active: number;
  queued: number;
  timestamp: number;
}

export interface SessionSnapshot {
  activeSessions: number;
  maxSessions: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tool Result Validation
// ---------------------------------------------------------------------------

/**
 * A single semantic check on a tool response.
 *
 * Each check validates one aspect of the response content, e.g.
 * "search returned > 0 results" or "card contains a valid symbolId".
 */
export interface ToolResultCheck {
  tool: string;
  check: string;
  passed: boolean;
  /** The actual value observed (e.g. "12", "missing", "empty") */
  actual?: string;
}

/**
 * Aggregated result-validation statistics for a scenario.
 *
 * These are the "smoke-test" stats that tell you whether each tool is
 * returning structurally/semantically valid responses — not just "200 OK."
 */
export interface ToolResultStats {
  checksRun: number;
  checksPassed: number;
  checksFailed: number;
  failures: ToolResultCheck[];
  /**
   * Per-tool sample values surfaced in the report, e.g.
   *   "sdl.symbol.search:resultCount" → "15"
   *   "sdl.symbol.getCard:hasSignature" → "true"
   */
  sampleValues: Record<string, string>;
}

export interface NumericSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

export interface ToolTimingSummary {
  totalMs: NumericSummary;
  phases: Record<string, NumericSummary>;
}

export interface ToolDiagnostics {
  timings: ToolTimingSummary;
}

/**
 * Merge multiple ToolResultStats (e.g. from successive concurrency rounds)
 * into a single aggregate.
 */
export function mergeResultStats(parts: ToolResultStats[]): ToolResultStats {
  const merged: ToolResultStats = {
    checksRun: 0,
    checksPassed: 0,
    checksFailed: 0,
    failures: [],
    sampleValues: {},
  };
  for (const p of parts) {
    merged.checksRun += p.checksRun;
    merged.checksPassed += p.checksPassed;
    merged.checksFailed += p.checksFailed;
    merged.failures.push(...p.failures);
    Object.assign(merged.sampleValues, p.sampleValues);
  }
  return merged;
}

export function mergeToolDiagnostics(
  parts: Array<Record<string, ToolDiagnostics>>,
): Record<string, ToolDiagnostics> {
  const merged: Record<string, ToolDiagnostics> = {};
  for (const part of parts) {
    for (const [toolName, diagnostics] of Object.entries(part)) {
      const existing = merged[toolName];
      if (
        !existing ||
        diagnostics.timings.totalMs.p95 > existing.timings.totalMs.p95
      ) {
        merged[toolName] = diagnostics;
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Scenario Results
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  name: string;
  passed: boolean;
  clients: number;
  durationMs: number;
  toolMetrics: Record<string, AggregateMetrics>;
  errors: Array<{
    clientId: string;
    toolName: string;
    message: string;
    timestamp: number;
  }>;
  memoryPeakMB: number;
  warnings: string[];
  /** Semantic validation of tool response content — release smoke-test signal */
  toolResultStats?: ToolResultStats;
  toolDiagnostics?: Record<string, ToolDiagnostics>;
}

// ---------------------------------------------------------------------------
// Stress Report
// ---------------------------------------------------------------------------

export interface StressReport {
  timestamp: string;
  version: string;
  scenarios: ScenarioResult[];
  overallPassed: boolean;
  thresholds: PassFailThresholds;
  durationMs: number;
}

export interface PassFailThresholds {
  maxErrorRate: number;
  readerP95MultiplierWarn: number;
  mixedP95MultiplierWarn: number;
  memoryGrowthWarnMB: number;
  /** Minimum absolute P95 increase (ms) required to emit a warning */
  minWarnDeltaMs: number;
}

export const DEFAULT_THRESHOLDS: PassFailThresholds = {
  maxErrorRate: 0.05,
  readerP95MultiplierWarn: 3,
  mixedP95MultiplierWarn: 5,
  memoryGrowthWarnMB: 200,
  /** Minimum absolute P95 delta (ms) to trigger a warning — suppresses noise from fast tools */
  minWarnDeltaMs: 25,
};

// ---------------------------------------------------------------------------
// Scenario Function Signature
// ---------------------------------------------------------------------------

export type ScenarioFn = (ctx: ScenarioContext) => Promise<ScenarioResult>;

export interface ScenarioContext {
  config: StressTestConfig;
  serverPort: number;
  /** Bearer token for HTTP transport auth. */
  authToken: string;
  /** Baseline metrics from single-client scenario (undefined for the baseline itself) */
  baselineMetrics?: Record<string, AggregateMetrics>;
  log: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error" | "debug";

export function stressLog(
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const fieldStr = fields
    ? " | " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" | ")
    : "";
  const prefix =
    level === "error"
      ? "[STRESS:ERROR]"
      : level === "warn"
        ? "[STRESS:WARN]"
        : level === "debug"
          ? "[STRESS:DEBUG]"
          : "[STRESS]";
  console.error(`${prefix} ${ts}${fieldStr} | ${msg}`);
}
