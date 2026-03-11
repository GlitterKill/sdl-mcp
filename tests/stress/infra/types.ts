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
  /** Path to the LadybugDB graph database directory */
  graphDbPath: string;
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

export const DEFAULT_CONFIG: Omit<
  StressTestConfig,
  "graphDbPath" | "fixturePath"
> = {
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
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
  errorCount: number;
  errorRate: number;
  throughputPerSec: number;
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
}

export const DEFAULT_THRESHOLDS: PassFailThresholds = {
  maxErrorRate: 0.05,
  readerP95MultiplierWarn: 3,
  mixedP95MultiplierWarn: 5,
  memoryGrowthWarnMB: 200,
};

// ---------------------------------------------------------------------------
// Scenario Function Signature
// ---------------------------------------------------------------------------

export type ScenarioFn = (ctx: ScenarioContext) => Promise<ScenarioResult>;

export interface ScenarioContext {
  config: StressTestConfig;
  serverPort: number;
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
