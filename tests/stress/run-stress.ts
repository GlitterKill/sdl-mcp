#!/usr/bin/env node
/**
 * SDL-MCP Stress Test Orchestrator
 *
 * Entry point that runs all stress test scenarios sequentially:
 * 1. Build dist/
 * 2. Start server harness
 * 3. Run baseline (must pass before continuing)
 * 4. Run concurrent readers (3→4→5→6)
 * 5. Run mixed read/write no-op refreshes (3→4→5→6)
 * 6. Run mixed read/write editful refreshes (3→4→5→6)
 * 7. Restart server with maxSessions: 4 → run session saturation
 * 8. Restart server with maxToolConcurrency: 4 → run dispatch pressure
 * 9. Restart server (default config) → run semantic tools
 * 10. Restart server (max config) → run limit stress (1 writer + 7 readers)
 * 11. Generate report
 *
 * Usage:
 *   node --import tsx tests/stress/run-stress.ts
 *   node --import tsx tests/stress/run-stress.ts --scenario single-client-baseline
 *   node --import tsx tests/stress/run-stress.ts --verbose
 *   node --import tsx tests/stress/run-stress.ts --max-clients 4
 */

import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

import { resolveStressRepoRoot } from "./infra/dist-runtime.js";
import { ServerHarness } from "./infra/server-harness.js";
import { writeConsoleReport, writeJsonReport } from "./infra/report-writer.js";
import { runSingleClientBaseline } from "./scenarios/single-client-baseline.js";
import { runConcurrentReaders } from "./scenarios/concurrent-readers.js";
import { runMixedReadWrite } from "./scenarios/mixed-read-write.js";
import { runMixedReadWriteEditful } from "./scenarios/mixed-read-write-editful.js";
import { runSessionSaturation } from "./scenarios/session-saturation.js";
import { runDispatchPressure } from "./scenarios/dispatch-pressure.js";
import { runSemanticTools } from "./scenarios/semantic-tools.js";
import { runLimitStress } from "./scenarios/limit-stress.js";
import type {
  StressTestConfig,
  ScenarioResult,
  StressReport,
  ScenarioContext,
  AggregateMetrics,
} from "./infra/types.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  stressLog,
} from "./infra/types.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  scenario?: string;
  maxClients: number;
  timeout: number;
  verbose: boolean;
  skipBuild: boolean;
  port: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    maxClients: 6,
    timeout: 120_000,
    verbose: false,
    skipBuild: false,
    port: 19876,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--scenario":
        result.scenario = args[++i];
        break;
      case "--max-clients":
        result.maxClients = parseInt(args[++i], 10);
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i], 10);
        break;
      case "--verbose":
        result.verbose = true;
        break;
      case "--skip-build":
        result.skipBuild = true;
        break;
      case "--port":
        result.port = parseInt(args[++i], 10);
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build step
// ---------------------------------------------------------------------------

function runBuild(): void {
  stressLog("info", "Building dist/ via npm run build:runtime");
  try {
    execSync("npm run build:runtime", {
      cwd: resolveStressRepoRoot(import.meta.url),
      stdio: "inherit",
      timeout: 120_000,
    });
    stressLog("info", "Build complete");
  } catch (err) {
    stressLog("error", "Build failed — cannot run stress tests without dist/");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgs();

  const projectRoot = resolveStressRepoRoot(import.meta.url);
  const fixturePath = resolve(join(projectRoot, "tests/stress/fixtures"));
  const resultsDir = resolve(join(projectRoot, "tests/stress/results"));

  // Determine concurrency levels based on max-clients
  const levels: number[] = [];
  for (let n = 3; n <= cliArgs.maxClients; n++) {
    levels.push(n);
  }

  const config: StressTestConfig = {
    ...DEFAULT_CONFIG,
    port: cliArgs.port,
    fixturePath,
    concurrencyLevels: levels,
    scenarioTimeoutMs: cliArgs.timeout,
    verbose: cliArgs.verbose,
  };

  stressLog("info", "SDL-MCP Stress Test Suite starting", {
    maxClients: cliArgs.maxClients,
    scenario: cliArgs.scenario ?? "all",
    verbose: cliArgs.verbose,
  });

  // Step 1: Build
  if (!cliArgs.skipBuild) {
    runBuild();
  }

  const scenarios: ScenarioResult[] = [];
  const suiteStart = Date.now();
  let baselineMetrics: Record<string, AggregateMetrics> | undefined;

  const shouldRun = (name: string): boolean =>
    !cliArgs.scenario || cliArgs.scenario === name;

  // Helper: create scenario context
  const makeCtx = (serverPort: number, authToken: string): ScenarioContext => ({
    config,
    serverPort,
    authToken,
    baselineMetrics,
    log: (msg: string) => {
      if (config.verbose) stressLog("info", msg);
    },
  });

  // -----------------------------------------------------------------------
  // Scenarios 1-4: Baseline, Concurrent Readers, Mixed Read-Write, Editful Mixed Read-Write
  // -----------------------------------------------------------------------
  if (
    shouldRun("single-client-baseline") ||
    shouldRun("concurrent-readers") ||
    shouldRun("mixed-read-write") ||
    shouldRun("mixed-read-write-editful")
  ) {
    const harness = new ServerHarness(config);
    let port: number;

    try {
      port = await harness.start({ maxSessions: 8, maxToolConcurrency: 8 });
    } catch (err) {
      stressLog(
        "error",
        `Failed to start server: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
      return;
    }

    const token = harness.getAuthToken();

    try {
      // Scenario 1: Baseline
      if (shouldRun("single-client-baseline") || !cliArgs.scenario) {
        stressLog("info", "=== Scenario 1: Single Client Baseline ===");
        const result = await withTimeout(
          runSingleClientBaseline(makeCtx(port, token)),
          cliArgs.timeout,
          "single-client-baseline",
        );
        scenarios.push(result);
        baselineMetrics = result.toolMetrics;

        if (!result.passed) {
          stressLog(
            "error",
            "Baseline FAILED — remaining scenarios may be unreliable",
          );
        }
      }

      // Scenario 2: Concurrent Readers
      if (shouldRun("concurrent-readers")) {
        stressLog("info", "=== Scenario 2: Concurrent Readers ===");
        const result = await withTimeout(
          runConcurrentReaders(makeCtx(port, token)),
          cliArgs.timeout * config.concurrencyLevels.length,
          "concurrent-readers",
        );
        scenarios.push(result);
      }

      // Scenario 3: Mixed Read-Write
      if (shouldRun("mixed-read-write")) {
        stressLog("info", "=== Scenario 3: Mixed Read-Write ===");
        const result = await withTimeout(
          runMixedReadWrite(makeCtx(port, token)),
          cliArgs.timeout * config.concurrencyLevels.length,
          "mixed-read-write",
        );
        scenarios.push(result);
      }

      // Scenario 4: Mixed Read-Write Editful
      if (shouldRun("mixed-read-write-editful")) {
        stressLog("info", "=== Scenario 4: Mixed Read-Write Editful ===");
        const result = await withTimeout(
          runMixedReadWriteEditful(makeCtx(port, token)),
          cliArgs.timeout * config.concurrencyLevels.length,
          "mixed-read-write-editful",
        );
        scenarios.push(result);
      }
    } finally {
      await harness.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Scenario 5: Session Saturation (maxSessions: 4)
  // -----------------------------------------------------------------------
  if (shouldRun("session-saturation")) {
    stressLog(
      "info",
      "=== Scenario 5: Session Saturation (maxSessions: 4) ===",
    );
    const harness = new ServerHarness(config);
    try {
      const port = await harness.start({
        maxSessions: 4,
        maxToolConcurrency: 8,
      });
      const result = await withTimeout(
        runSessionSaturation(makeCtx(port, harness.getAuthToken())),
        cliArgs.timeout,
        "session-saturation",
      );
      scenarios.push(result);
    } catch (err) {
      scenarios.push(errorResult("session-saturation", err));
    } finally {
      await harness.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Scenario 6: Dispatch Pressure (maxToolConcurrency: 4)
  // -----------------------------------------------------------------------
  if (shouldRun("dispatch-pressure")) {
    stressLog(
      "info",
      "=== Scenario 6: Dispatch Pressure (maxToolConcurrency: 4) ===",
    );
    const harness = new ServerHarness(config);
    try {
      const port = await harness.start({
        maxSessions: 8,
        maxToolConcurrency: 4,
      });
      const result = await withTimeout(
        runDispatchPressure(makeCtx(port, harness.getAuthToken())),
        cliArgs.timeout,
        "dispatch-pressure",
      );
      scenarios.push(result);
    } catch (err) {
      scenarios.push(errorResult("dispatch-pressure", err));
    } finally {
      await harness.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Scenario 7: Semantic Tools (default server config)
  // -----------------------------------------------------------------------
  if (shouldRun("semantic-tools")) {
    stressLog("info", "=== Scenario 7: Semantic Tools ===");
    const harness = new ServerHarness(config);
    try {
      const port = await harness.start({
        maxSessions: 8,
        maxToolConcurrency: 8,
      });
      const result = await withTimeout(
        runSemanticTools(makeCtx(port, harness.getAuthToken())),
        cliArgs.timeout * config.concurrencyLevels.length,
        "semantic-tools",
      );
      scenarios.push(result);
    } catch (err) {
      scenarios.push(errorResult("semantic-tools", err));
    } finally {
      await harness.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Scenario 8: Limit Stress (maxSessions: 9, 1 setup + 1 writer + 7 readers)
  // -----------------------------------------------------------------------
  if (shouldRun("limit-stress")) {
    stressLog(
      "info",
      "=== Scenario 8: Limit Stress (1 setup + 1 writer + 7 readers, max sessions) ===",
    );
    const harness = new ServerHarness(config);
    try {
      const port = await harness.start({
        maxSessions: 9,
        maxToolConcurrency: 8,
      });
      const result = await withTimeout(
        runLimitStress(makeCtx(port, harness.getAuthToken())),
        cliArgs.timeout * 2, // extended timeout for longer scenario
        "limit-stress",
      );
      scenarios.push(result);
    } catch (err) {
      scenarios.push(errorResult("limit-stress", err));
    } finally {
      await harness.stop();
    }
  }

  // -----------------------------------------------------------------------
  // Generate Report
  // -----------------------------------------------------------------------
  const require = createRequire(import.meta.url);
  const pkg = require(join(projectRoot, "package.json")) as { version: string };

  // Check if any scenario has result validation failures
  const totalResultChecksFailed = scenarios.reduce(
    (sum, s) => sum + (s.toolResultStats?.checksFailed ?? 0),
    0,
  );
  const totalResultChecksRun = scenarios.reduce(
    (sum, s) => sum + (s.toolResultStats?.checksRun ?? 0),
    0,
  );

  const report: StressReport = {
    timestamp: new Date().toISOString(),
    version: pkg.version,
    scenarios,
    overallPassed:
      scenarios.every((s) => s.passed) && totalResultChecksFailed === 0,
    thresholds: DEFAULT_THRESHOLDS,
    durationMs: Date.now() - suiteStart,
  };

  writeConsoleReport(report);

  // Log result-validation summary
  if (totalResultChecksRun > 0) {
    const pct =
      totalResultChecksRun > 0
        ? (
            ((totalResultChecksRun - totalResultChecksFailed) /
              totalResultChecksRun) *
            100
          ).toFixed(1)
        : "0";
    stressLog("info", `Result validation: ${pct}% passed`, {
      checksRun: totalResultChecksRun,
      checksFailed: totalResultChecksFailed,
    });
  }

  const jsonPath = writeJsonReport(report, resultsDir);
  stressLog("info", `JSON report saved to: ${jsonPath}`);

  // Set exit code and allow stderr to flush before force-exiting.
  // process.exit() alone truncates buffered console.error output on Windows.
  // The unref'd timer lets the process exit naturally if no dangling handles
  // remain, but forces exit after 500ms if handles keep the loop alive.
  process.exitCode = report.overallPassed ? 0 : 1;
  setTimeout(() => process.exit(), 500).unref();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTimeout(
  promise: Promise<ScenarioResult>,
  timeoutMs: number,
  name: string,
): Promise<ScenarioResult> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<ScenarioResult>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Scenario "${name}" timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
    }),
  ])
    .then((result) => {
      clearTimeout(timer);
      return result;
    })
    .catch((err) => {
      clearTimeout(timer);
      return errorResult(name, err);
    });
}

function errorResult(name: string, err: unknown): ScenarioResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    name,
    passed: false,
    clients: 0,
    durationMs: 0,
    toolMetrics: {},
    errors: [
      {
        clientId: "orchestrator",
        toolName: "scenario",
        message: msg,
        timestamp: Date.now(),
      },
    ],
    memoryPeakMB: 0,
    warnings: [`Scenario failed with error: ${msg}`],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Stress test suite crashed:", err);
  process.exit(1);
});
