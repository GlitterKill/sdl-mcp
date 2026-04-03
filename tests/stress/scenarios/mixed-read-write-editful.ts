/**
 * Scenario: Mixed Read-Write Editful
 *
 * One writer mutates a fixture TypeScript file before each incremental refresh
 * while readers query concurrently. This measures the real incremental edit
 * path under contention instead of the no-op refresh fast path.
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
} from "../infra/client-factory.js";
import {
  createStressFixtureEditSession,
  ensureStressFixtureReady,
  STRESS_REPO_ID,
} from "../infra/scenario-setup.js";
import type {
  AggregateMetrics,
  ScenarioContext,
  ScenarioResult,
  ToolResultStats,
} from "../infra/types.js";
import {
  DEFAULT_THRESHOLDS,
  mergeResultStats,
  mergeToolDiagnostics,
  stressLog,
} from "../infra/types.js";

const WRITER_ITERATIONS = 4;
const READER_ITERATIONS = 6;
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
  editSession: Awaited<ReturnType<typeof createStressFixtureEditSession>>,
): Promise<void> {
  for (let i = 0; i < WRITER_ITERATIONS; i++) {
    await editSession.applyIteration(i + 1);

    await client.callToolParsed("sdl.index.refresh", {
      repoId: STRESS_REPO_ID,
      mode: "incremental",
    });

    await client.callToolParsed("sdl.repo.status", {
      repoId: STRESS_REPO_ID,
    });

    await client.callToolParsed("sdl.repo.overview", {
      repoId: STRESS_REPO_ID,
      level: "stats",
    });

    await client.callToolParsed("sdl.policy.get", {
      repoId: STRESS_REPO_ID,
    });

    await new Promise((r) => setTimeout(r, 80));
  }
}

async function readerWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  queryIndex: number,
): Promise<void> {
  for (let i = 0; i < READER_ITERATIONS; i++) {
    const query = SEARCH_QUERIES[(queryIndex + i) % SEARCH_QUERIES.length];

    const searchResult = await client.callToolParsed("sdl.symbol.search", {
      repoId: STRESS_REPO_ID,
      query,
      limit: 10,
    });
    const results = (searchResult?.results ?? []) as Array<{
      symbolId: string;
    }>;

    if (results.length === 0) continue;

    const symbolId = results[0].symbolId;

    await client.callToolParsed("sdl.symbol.getCard", {
      repoId: STRESS_REPO_ID,
      symbolId,
    });

    await client.callToolParsed("sdl.slice.build", {
      repoId: STRESS_REPO_ID,
      entrySymbols: [symbolId],
      budget: { maxCards: 15, maxEstimatedTokens: 2000 },
    });

    await client.callToolParsed("sdl.code.getSkeleton", {
      repoId: STRESS_REPO_ID,
      symbolId,
    });

    await client.callToolParsed("sdl.code.getHotPath", {
      repoId: STRESS_REPO_ID,
      symbolId,
      identifiersToFind: [query],
    });
  }
}

export async function runMixedReadWriteEditful(
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
  const allToolDiagnostics: Array<
    ReturnType<MetricsCollector["getToolTimingDiagnostics"]>
  > = [];

  log("Setup: Ensuring fixture repo is ready for editful mixed read-write");
  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "mrwe-setup",
    setupCollector,
    config.verbose,
    authToken,
  );
  try {
    await ensureStressFixtureReady(setupClient, config.fixturePath, log);
  } finally {
    await disconnectAll([setupClient]);
  }

  for (const clientCount of config.concurrencyLevels) {
    log(
      `--- Round: ${clientCount} clients (1 writer + ${clientCount - 1} readers, editful) ---`,
    );
    const collector = new MetricsCollector();
    collector.recordMemorySnapshot();

    const editSession = await createStressFixtureEditSession(config.fixturePath);
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
      const writerClient = clients[0];
      const readerClients = clients.slice(1);

      const results = await Promise.allSettled([
        writerWorkflow(writerClient, editSession),
        ...readerClients.map((client, idx) => readerWorkflow(client, idx)),
      ]);

      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          stressLog("error", `Mixed read-write editful failed: ${msg}`);
        }
      }

      collector.recordMemorySnapshot();
      const roundDuration = Date.now() - roundStart;
      totalDuration += roundDuration;

      const roundErrors = collector.getErrors();
      allErrors.push(...roundErrors);

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
        if (!allToolMetrics[name] || metrics.p95 > allToolMetrics[name].p95) {
          allToolMetrics[name] = metrics;
        }
      }

      const memPeak = collector.getMemoryPeakMB();
      peakMemory = Math.max(peakMemory, memPeak);

      const errorRate =
        roundErrors.length / Math.max(collector.getRecordCount(), 1);
      if (errorRate > DEFAULT_THRESHOLDS.maxErrorRate) {
        anyFailed = true;
        allWarnings.push(
          `Round ${clientCount}: error rate ${(errorRate * 100).toFixed(1)}%`,
        );
      }

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
      allToolDiagnostics.push(collector.getToolTimingDiagnostics());

      log(
        `  Round ${clientCount}: ${collector.getRecordCount()} calls, ${roundErrors.length} errors, ${roundDuration}ms`,
      );
    } finally {
      await disconnectAll(clients);

      // Keep later rounds and scenarios honest by restoring the shared fixture
      // on disk and re-syncing the graph outside the measured round metrics.
      const cleanupCollector = new MetricsCollector();
      const cleanupClient = await createStressClient(
        serverPort,
        `mrwe-cleanup-${clientCount}`,
        cleanupCollector,
        config.verbose,
        authToken,
      );
      try {
        await editSession.restore();
        await cleanupClient.callToolParsed("sdl.index.refresh", {
          repoId: STRESS_REPO_ID,
          mode: "incremental",
        });
      } catch (error) {
        anyFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        allWarnings.push(
          `Round ${clientCount}: fixture cleanup failed (${message})`,
        );
      } finally {
        await disconnectAll([cleanupClient]);
      }
    }
  }

  return {
    name: "mixed-read-write-editful",
    passed: !anyFailed,
    clients: config.concurrencyLevels[config.concurrencyLevels.length - 1],
    durationMs: totalDuration,
    toolMetrics: allToolMetrics,
    errors: allErrors,
    memoryPeakMB: peakMemory,
    warnings: allWarnings,
    toolResultStats: mergeResultStats(allResultStats),
    toolDiagnostics: mergeToolDiagnostics(allToolDiagnostics),
  };
}
