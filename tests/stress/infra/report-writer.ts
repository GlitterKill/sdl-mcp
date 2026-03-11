/**
 * Report Writer — outputs stress test results to console and JSON file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StressReport, ScenarioResult } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function pass(text: string): string {
  return `${GREEN}✓ ${text}${RESET}`;
}
function fail(text: string): string {
  return `${RED}✗ ${text}${RESET}`;
}
function warn(text: string): string {
  return `${YELLOW}⚠ ${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Console Report
// ---------------------------------------------------------------------------

export function writeConsoleReport(report: StressReport): void {
  const w = (msg: string = "") => console.error(msg);

  w();
  w(
    `${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`,
  );
  w(`${BOLD}${CYAN}  SDL-MCP Stress Test Report${RESET}`);
  w(
    `${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`,
  );
  w();
  w(`  Timestamp:  ${report.timestamp}`);
  w(`  Version:    ${report.version}`);
  w(`  Duration:   ${formatDuration(report.durationMs)}`);
  w(`  Overall:    ${report.overallPassed ? pass("PASSED") : fail("FAILED")}`);
  w();

  for (const scenario of report.scenarios) {
    writeScenarioSection(scenario);
  }

  w(
    `${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}`,
  );
  w();
}

function writeScenarioSection(scenario: ScenarioResult): void {
  const w = (msg: string = "") => console.error(msg);

  const status = scenario.passed ? pass("PASS") : fail("FAIL");
  w(
    `${BOLD}  ─── ${scenario.name} (${scenario.clients} clients) ─── ${status}${RESET}`,
  );
  w(
    `  ${DIM}Duration: ${formatDuration(scenario.durationMs)} | Peak Memory: ${scenario.memoryPeakMB}MB${RESET}`,
  );
  w();

  // Tool metrics table
  const toolNames = Object.keys(scenario.toolMetrics);
  if (toolNames.length > 0) {
    w(
      `  ${"Tool".padEnd(30)} ${"Count".padStart(6)} ${"P50".padStart(8)} ${"P95".padStart(8)} ${"P99".padStart(8)} ${"Max".padStart(8)} ${"Err%".padStart(7)}`,
    );
    w(
      `  ${"─".repeat(30)} ${"─".repeat(6)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(7)}`,
    );

    for (const name of toolNames) {
      const m = scenario.toolMetrics[name];
      const errStr =
        m.errorRate > 0
          ? `${RED}${(m.errorRate * 100).toFixed(1)}%${RESET}`
          : `${GREEN}0%${RESET}`;
      w(
        `  ${name.padEnd(30)} ${String(m.count).padStart(6)} ${formatMs(m.p50).padStart(8)} ${formatMs(m.p95).padStart(8)} ${formatMs(m.p99).padStart(8)} ${formatMs(m.max).padStart(8)} ${errStr.padStart(7 + RED.length + RESET.length)}`,
      );
    }
    w();
  }

  // Warnings
  for (const warning of scenario.warnings) {
    w(`  ${warn(warning)}`);
  }

  // Errors (show first 5)
  if (scenario.errors.length > 0) {
    w(`  ${RED}Errors (${scenario.errors.length} total):${RESET}`);
    for (const err of scenario.errors.slice(0, 5)) {
      w(`    ${DIM}[${err.clientId}]${RESET} ${err.toolName}: ${err.message}`);
    }
    if (scenario.errors.length > 5) {
      w(`    ${DIM}... and ${scenario.errors.length - 5} more${RESET}`);
    }
    w();
  }

  w();
}

// ---------------------------------------------------------------------------
// JSON Report
// ---------------------------------------------------------------------------

export function writeJsonReport(
  report: StressReport,
  resultsDir: string,
): string {
  mkdirSync(resultsDir, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .split("Z")[0];
  const filename = `stress-report-${ts}.json`;
  const filePath = join(resultsDir, filename);

  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
