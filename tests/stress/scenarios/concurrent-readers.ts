/**
 * Scenario 2: Concurrent Readers
 *
 * N clients perform simultaneous read-only workflows.
 * Escalates from 3→4→5→6 concurrent clients.
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

const SEARCH_QUERIES = [
  "User",
  "Server",
  "Handler",
  "Process",
  "Validate",
  "Create",
];
const ITERATIONS_PER_CLIENT = 4;

async function runReaderWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  queryIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS_PER_CLIENT; i++) {
    const query = SEARCH_QUERIES[(queryIndex + i) % SEARCH_QUERIES.length];

    // 1. Search
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

    // 2. Get card
    await client.callToolParsed("sdl.symbol.getCard", {
      repoId: "stress-fixtures",
      symbolId,
    });

    // 3. Build slice
    await client.callToolParsed("sdl.slice.build", {
      repoId: "stress-fixtures",
      entrySymbols: [symbolId],
      budget: { maxCards: 20, maxEstimatedTokens: 3000 },
    });

    // 4. Get skeleton
    await client.callToolParsed("sdl.code.getSkeleton", {
      repoId: "stress-fixtures",
      symbolId,
    });

    // 5. Hot path — find specific identifiers in the symbol
    await client.callToolParsed("sdl.code.getHotPath", {
      repoId: "stress-fixtures",
      symbolId,
      identifiersToFind: [query, "return"],
    });

    // 6. Need window — full code ladder escalation
    try {
      await client.callToolParsed("sdl.code.needWindow", {
        repoId: "stress-fixtures",
        symbolId,
        reason: `Stress test: verify ${query} implementation`,
        expectedLines: 50,
        identifiersToFind: [query],
      });
    } catch {
      // Policy denial is acceptable — we're testing throughput not gating
    }

    // 7. Repo overview (lightweight stats call)
    await client.callToolParsed("sdl.repo.overview", {
      repoId: "stress-fixtures",
      level: "stats",
    });

    // 8. Policy check
    await client.callToolParsed("sdl.policy.get", {
      repoId: "stress-fixtures",
    });
  }
}

export async function runConcurrentReaders(
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
    log(`--- Round: ${clientCount} concurrent readers ---`);
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
      // Run all client readers in parallel
      const results = await Promise.allSettled(
        clients.map((client, idx) => runReaderWorkflow(client, idx)),
      );

      // Check for failures
      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          stressLog("error", `Reader failed: ${msg}`);
        }
      }

      collector.recordMemorySnapshot();
      const roundDuration = Date.now() - roundStart;
      totalDuration += roundDuration;

      const roundErrors = collector.getErrors();
      allErrors.push(...roundErrors);

      const roundMetrics = collector.getAllToolMetrics();
      for (const [name, metrics] of Object.entries(roundMetrics)) {
        // Keep the round with the worst P95 — that's the regression signal
        if (!allToolMetrics[name] || metrics.p95 > allToolMetrics[name].p95) {
          allToolMetrics[name] = metrics;
        }
      }

      const memPeak = collector.getMemoryPeakMB();
      peakMemory = Math.max(peakMemory, memPeak);

      // Evaluate pass criteria
      const errorRate =
        roundErrors.length / Math.max(collector.getRecordCount(), 1);
      if (errorRate > DEFAULT_THRESHOLDS.maxErrorRate) {
        anyFailed = true;
        allWarnings.push(
          `Round ${clientCount}: error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(DEFAULT_THRESHOLDS.maxErrorRate * 100).toFixed(1)}%`,
        );
      }

      // Check P95 against baseline
      if (baselineMetrics) {
        for (const [tool, metrics] of Object.entries(roundMetrics)) {
          const baseP95 = baselineMetrics[tool]?.p95;
          if (
            baseP95 &&
            baseP95 > 0 &&
            metrics.p95 > baseP95 * DEFAULT_THRESHOLDS.readerP95MultiplierWarn &&
            metrics.p95 - baseP95 > DEFAULT_THRESHOLDS.minWarnDeltaMs
          ) {
            allWarnings.push(
              `Round ${clientCount}: ${tool} P95 ${metrics.p95}ms > ${DEFAULT_THRESHOLDS.readerP95MultiplierWarn}x baseline (${baseP95}ms)`,
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
    name: "concurrent-readers",
    passed: !anyFailed && allErrors.length === 0,
    clients: config.concurrencyLevels[config.concurrencyLevels.length - 1],
    durationMs: totalDuration,
    toolMetrics: allToolMetrics,
    errors: allErrors,
    memoryPeakMB: peakMemory,
    warnings: allWarnings,
    toolResultStats: mergeResultStats(allResultStats),
  };
}
