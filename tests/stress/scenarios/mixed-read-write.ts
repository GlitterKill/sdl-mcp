/**
 * Scenario 3: Mixed Read-Write
 *
 * One "writer" client does incremental re-indexing while N-1 "reader" clients query.
 * Tests write serialization and read pool round-robin under contention.
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import { createStressClients, disconnectAll } from "../infra/client-factory.js";
import type {
  ScenarioContext,
  ScenarioResult,
  AggregateMetrics,
  ToolResultStats,
} from "../infra/types.js";
import {
  stressLog,
  DEFAULT_THRESHOLDS,
  mergeResultStats,
} from "../infra/types.js";

const WRITER_ITERATIONS = 3;
const READER_ITERATIONS = 5;
const SEARCH_QUERIES = [
  "User",
  "Server",
  "Handler",
  "Process",
  "Validate",
  "Create",
];

async function writerWorkflow(
  client: import("../infra/client-factory.js").StressClient,
): Promise<void> {
  for (let i = 0; i < WRITER_ITERATIONS; i++) {
    // Incremental re-index
    await client.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "incremental",
    });

    // Check status after each re-index
    await client.callToolParsed("sdl.repo.status", {
      repoId: "stress-fixtures",
    });

    // Small delay to simulate realistic write cadence
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function readerWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  queryIndex: number,
): Promise<void> {
  for (let i = 0; i < READER_ITERATIONS; i++) {
    const query = SEARCH_QUERIES[(queryIndex + i) % SEARCH_QUERIES.length];

    // Search
    const searchResult = await client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query,
      limit: 10,
    });
    const results = (searchResult?.results ?? []) as Array<{
      symbolId: string;
    }>;

    if (results.length === 0) continue;

    const symbolId = results[0].symbolId;

    // Get card
    await client.callToolParsed("sdl.symbol.getCard", {
      repoId: "stress-fixtures",
      symbolId,
    });

    // Build slice
    await client.callToolParsed("sdl.slice.build", {
      repoId: "stress-fixtures",
      entrySymbols: [symbolId],
      budget: { maxCards: 15, maxEstimatedTokens: 2000 },
    });
  }
}

export async function runMixedReadWrite(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, authToken, log, baselineMetrics } = ctx;
  const allWarnings: string[] = [];
  const allErrors: Array<{
    clientId: string;
    toolName: string;
    message: string;
    timestamp: number;
  }> = [];
  const allToolMetrics: Record<string, AggregateMetrics> = {};
  let totalDuration = 0;
  let peakMemory = 0;
  let anyFailed = false;
  const allResultStats: ToolResultStats[] = [];

  for (const clientCount of config.concurrencyLevels) {
    log(
      `--- Round: ${clientCount} clients (1 writer + ${clientCount - 1} readers) ---`,
    );
    const collector = new MetricsCollector();
    collector.recordMemorySnapshot();

    const roundStart = Date.now();
    const clients = await createStressClients(
      serverPort,
      clientCount,
      collector,
      config.verbose,
      0,
      authToken,
    );

    try {
      // First client is the writer, rest are readers
      const writerClient = clients[0];
      const readerClients = clients.slice(1);

      const results = await Promise.allSettled([
        writerWorkflow(writerClient),
        ...readerClients.map((client, idx) => readerWorkflow(client, idx)),
      ]);

      // Check for failures
      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          stressLog("error", `Mixed read-write failed: ${msg}`);
        }
      }

      collector.recordMemorySnapshot();
      const roundDuration = Date.now() - roundStart;
      totalDuration += roundDuration;

      const roundErrors = collector.getErrors();
      allErrors.push(...roundErrors);

      // Check for DB corruption errors specifically
      const corruptionErrors = roundErrors.filter(
        (e) =>
          e.message.includes("corrupt") ||
          e.message.includes("database is locked"),
      );
      if (corruptionErrors.length > 0) {
        anyFailed = true;
        allWarnings.push(
          `Round ${clientCount}: ${corruptionErrors.length} DB corruption errors`,
        );
      }

      const roundMetrics = collector.getAllToolMetrics();
      for (const [name, metrics] of Object.entries(roundMetrics)) {
        // Keep the round with the worst P95 — that's the regression signal
        if (!allToolMetrics[name] || metrics.p95 > allToolMetrics[name].p95) {
          allToolMetrics[name] = metrics;
        }
      }

      const memPeak = collector.getMemoryPeakMB();
      peakMemory = Math.max(peakMemory, memPeak);

      // Check error rate
      const errorRate =
        roundErrors.length / Math.max(collector.getRecordCount(), 1);
      if (errorRate > DEFAULT_THRESHOLDS.maxErrorRate) {
        anyFailed = true;
        allWarnings.push(
          `Round ${clientCount}: error rate ${(errorRate * 100).toFixed(1)}%`,
        );
      }

      // Check P95 against baseline (more lenient for mixed workload)
      if (baselineMetrics) {
        for (const [tool, metrics] of Object.entries(roundMetrics)) {
          const baseP95 = baselineMetrics[tool]?.p95;
          if (
            baseP95 &&
            baseP95 > 0 &&
            metrics.p95 > baseP95 * DEFAULT_THRESHOLDS.mixedP95MultiplierWarn
          ) {
            allWarnings.push(
              `Round ${clientCount}: ${tool} P95 ${metrics.p95}ms > ${DEFAULT_THRESHOLDS.mixedP95MultiplierWarn}x baseline (${baseP95}ms)`,
            );
          }
        }
      }

      allResultStats.push(collector.getResultStats());

      log(
        `  Round ${clientCount}: ${collector.getRecordCount()} calls, ${roundErrors.length} errors, ${roundDuration}ms`,
      );
    } finally {
      await disconnectAll(clients);
    }
  }

  return {
    name: "mixed-read-write",
    passed: !anyFailed,
    clients: config.concurrencyLevels[config.concurrencyLevels.length - 1],
    durationMs: totalDuration,
    toolMetrics: allToolMetrics,
    errors: allErrors,
    memoryPeakMB: peakMemory,
    warnings: allWarnings,
    toolResultStats: mergeResultStats(allResultStats),
  };
}
