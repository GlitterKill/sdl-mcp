#!/usr/bin/env node
/**
 * SDL-MCP Stress Test Orchestrator
 *
 * Entry point that runs all stress test scenarios sequentially:
 * 1. Build dist/
 * 2. Start server harness
 * 3. Run baseline (must pass before continuing)
 * 4. Run concurrent readers (3->4->5->6)
 * 5. Run mixed read/write no-op refreshes (3->4->5->6)
 * 6. Run mixed read/write editful refreshes (3->4->5->6)
 * 7. Reconfigure maxSessions: 4 and run session saturation
 * 8. Reconfigure maxToolConcurrency: 4 and run dispatch pressure
 * 9. Reconfigure default limits and run semantic tools
 * 10. Reconfigure max limits and run limit stress (1 writer + 7 readers)
 * 11. Generate report (stdout summary + JSON artifact)
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
import { runSearchEditBatch } from "./scenarios/search-edit-batch.js";
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

function flushWritable(
  stream: NodeJS.WriteStream | NodeJS.Socket,
): Promise<void> {
  return new Promise((resolve) => {
    if ((stream as { destroyed?: boolean }).destroyed) {
      resolve();
      return;
    }
    stream.write("", () => resolve());
  });
}

async function flushStdStreams(): Promise<void> {
  // Best-effort flush so final report lines are not lost before process.exit.
  await Promise.allSettled([
    flushWritable(process.stdout),
    flushWritable(process.stderr),
  ]);
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
    stressLog("error", "Build failed - cannot run stress tests without dist/");
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

  const harness = new ServerHarness(config);
  let port: number;
  let token: string;

  try {
    port = await harness.start({ maxSessions: 8, maxToolConcurrency: 8 });
    token = harness.getAuthToken();
  } catch (err) {
    stressLog(
      "error",
      `Failed to start server: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
    return;
  }

  try {
    // ---------------------------------------------------------------------
    // Scenario 1: Baseline (default caps)
    // ---------------------------------------------------------------------
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
          "Baseline FAILED - remaining scenarios may be unreliable",
        );
      }
    }

    // ---------------------------------------------------------------------
    // Scenario 2: Concurrent Readers (default caps)
    // ---------------------------------------------------------------------
    if (shouldRun("concurrent-readers")) {
      stressLog("info", "=== Scenario 2: Concurrent Readers ===");
      const result = await withTimeout(
        runConcurrentReaders(makeCtx(port, token)),
        cliArgs.timeout * config.concurrencyLevels.length,
        "concurrent-readers",
      );
      scenarios.push(result);
    }

    // ---------------------------------------------------------------------
    // Scenario 3: Mixed Read-Write (default caps)
    // ---------------------------------------------------------------------
    if (shouldRun("mixed-read-write")) {
      stressLog("info", "=== Scenario 3: Mixed Read-Write ===");
      const result = await withTimeout(
        runMixedReadWrite(makeCtx(port, token)),
        cliArgs.timeout * config.concurrencyLevels.length,
        "mixed-read-write",
      );
      scenarios.push(result);
    }

    // ---------------------------------------------------------------------
    // Scenario 4: Mixed Read-Write Editful (default caps)
    // ---------------------------------------------------------------------
    if (shouldRun("mixed-read-write-editful")) {
      stressLog("info", "=== Scenario 4: Mixed Read-Write Editful ===");
      const result = await withTimeout(
        runMixedReadWriteEditful(makeCtx(port, token)),
        cliArgs.timeout * config.concurrencyLevels.length,
        "mixed-read-write-editful",
      );
      scenarios.push(result);
    }

    // ---------------------------------------------------------------------
    // Scenario 5: Session Saturation (maxSessions: 4)
    // ---------------------------------------------------------------------
    if (shouldRun("session-saturation")) {
      stressLog(
        "info",
        "=== Scenario 5: Session Saturation (maxSessions: 4) ===",
      );
      try {
        harness.reconfigureSessions(4);
        harness.reconfigureDispatch({
          maxConcurrency: 8,
          queueTimeoutMs: config.toolCallTimeoutMs,
        });
        const result = await withTimeout(
          runSessionSaturation(makeCtx(port, token)),
          cliArgs.timeout,
          "session-saturation",
        );
        scenarios.push(result);
      } catch (err) {
        scenarios.push(errorResult("session-saturation", err));
      }
    }

    // ---------------------------------------------------------------------
    // Scenario 6: Dispatch Pressure (maxToolConcurrency: 4)
    // ---------------------------------------------------------------------
    if (shouldRun("dispatch-pressure")) {
      stressLog(
        "info",
        "=== Scenario 6: Dispatch Pressure (maxToolConcurrency: 4) ===",
      );
      try {
        harness.reconfigureSessions(8);
        harness.reconfigureDispatch({
          maxConcurrency: 4,
          queueTimeoutMs: config.toolCallTimeoutMs,
        });
        const result = await withTimeout(
          runDispatchPressure(makeCtx(port, token)),
          cliArgs.timeout,
          "dispatch-pressure",
        );
        scenarios.push(result);
      } catch (err) {
        scenarios.push(errorResult("dispatch-pressure", err));
      }
    }

    // ---------------------------------------------------------------------
    // Scenario 7: Semantic Tools (default caps)
    // ---------------------------------------------------------------------
    if (shouldRun("semantic-tools")) {
      stressLog("info", "=== Scenario 7: Semantic Tools ===");
      try {
        harness.reconfigureSessions(8);
        harness.reconfigureDispatch({
          maxConcurrency: 8,
          queueTimeoutMs: config.toolCallTimeoutMs,
        });
        const result = await withTimeout(
          runSemanticTools(makeCtx(port, token)),
          cliArgs.timeout * config.concurrencyLevels.length,
          "semantic-tools",
        );
        scenarios.push(result);
      } catch (err) {
        scenarios.push(errorResult("semantic-tools", err));
      }
    }

    // ---------------------------------------------------------------------
    // Scenario 8: Limit Stress (maxSessions: 9, 1 setup + 1 writer + 7 readers)
    // ---------------------------------------------------------------------
    if (shouldRun("limit-stress")) {
      stressLog(
        "info",
        "=== Scenario 8: Limit Stress (1 setup + 1 writer + 7 readers, max sessions) ===",
      );
      try {
        harness.reconfigureSessions(9);
        harness.reconfigureDispatch({
          maxConcurrency: 8,
          queueTimeoutMs: config.toolCallTimeoutMs,
        });
        const result = await withTimeout(
          runLimitStress(makeCtx(port, token)),
          cliArgs.timeout * 2, // extended timeout for longer scenario
          "limit-stress",
        );
        scenarios.push(result);
      } catch (err) {
        scenarios.push(errorResult("limit-stress", err));
      }
    }

    // ---------------------------------------------------------------------
    // Scenario 9: Search-Edit Batch (50-file preview+apply under concurrent reads)
    // ---------------------------------------------------------------------
    if (shouldRun("search-edit-batch")) {
      stressLog(
        "info",
        "=== Scenario 9: Search-Edit Batch (50-file apply + concurrent readers) ===",
      );
      try {
        const result = await withTimeout(
          runSearchEditBatch(makeCtx(port, token)),
          cliArgs.timeout * config.concurrencyLevels.length,
          "search-edit-batch",
        );
        scenarios.push(result);
      } catch (err) {
        scenarios.push(errorResult("search-edit-batch", err));
      }
    }
  } finally {
    await harness.stop();
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

  await flushStdStreams();

  // Force GC while kuzu objects are still reachable via closed handles,
  // then exit immediately to skip V8's at-exit GC sweep (which can
  // segfault on kuzu 0.15.2 N-API destructors).
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await flushStdStreams();
  const code = report.overallPassed ? 0 : 1;
  setImmediate(() => process.exit(code));
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
