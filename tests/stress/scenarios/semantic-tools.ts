/**
 * Scenario 6: Semantic Tools
 *
 * Tests semantic-layer MCP tools under concurrent load:
 *   - sdl.symbol.search with `semantic: true` (embedding rerank / graceful fallback)
 *   - sdl.symbol.getCard (single + batch card fetch)
 *   - sdl.context (context retrieval with tight budget)
 *   - sdl.agent.feedback + feedback.query (feedback loop)
 *
 * Escalates from 3→N concurrent clients, each running the full semantic workflow.
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
} from "../infra/client-factory.js";
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

const SEMANTIC_QUERIES = [
  "UserRepository",
  "ApiService",
  "Middleware",
  "DataProcessor",
  "UserController",
  "Repository"];


const ITERATIONS_PER_CLIENT = 2;

/**
 * Each client runs a full semantic workflow per iteration:
 *   1. Semantic search (semantic: true)
 *   2. Batch getCard for top results
 *   3. Agent context (explain, tight budget)
 *   4. Agent feedback (record useful symbols)
 *   5. Agent feedback query
 *   6. Lexical search comparison
 *   7. Second batch getCards with ETag support
 */
async function runSemanticWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  queryIndex: number,
): Promise<void> {
  for (let i = 0; i < ITERATIONS_PER_CLIENT; i++) {
    const query = SEMANTIC_QUERIES[(queryIndex + i) % SEMANTIC_QUERIES.length];

    // 1. Semantic search
    const searchResult = await client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query,
      limit: 15,
      semantic: true,
    });
    const results = (searchResult?.results ?? []) as Array<{
      symbolId: string;
      name: string;
    }>;

    if (results.length === 0) continue;

    // 2. Batch getCard for top results
    const topSymbolIds = results.slice(0, 5).map((r) => r.symbolId);
    const cardsResult = await client.callToolParsed("sdl.symbol.getCard", {
      repoId: "stress-fixtures",
      symbolIds: topSymbolIds,
    });
    const cards = (cardsResult?.cards ?? []) as Array<{
      symbolId?: string;
      etag?: string;
    }>;


    // 3. Agent context with tight budget
    const contextResult = await client.callToolParsed(
      "sdl.context",
      {
        repoId: "stress-fixtures",
        taskType: "explain",
        taskText: `Explain how ${query} works in this codebase`,
        budget: {
          maxTokens: 3000,
          maxActions: 3,
        },
        options: {
          focusPaths: [],
          includeTests: false,
        },
      },
    );

    // 4. Agent feedback — record useful symbols from the workflow
    const sliceHandle = contextResult?.sliceHandle as string | undefined;
    const versionId = contextResult?.versionId as string | undefined;
    if (sliceHandle && versionId && topSymbolIds.length > 0) {
      await client.callToolParsed("sdl.agent.feedback", {
        repoId: "stress-fixtures",
        versionId,
        sliceHandle,
        usefulSymbols: topSymbolIds.slice(0, 3),
        taskType: "explain",
        taskText: `Explain ${query}`,
      });
    }

    // 5. Agent feedback query — verify feedback round-trip
    await client.callToolParsed("sdl.agent.feedback.query", {
      repoId: "stress-fixtures",
      limit: 5,
    });

    // 6. Also run a lexical search for comparison (same query, no semantic flag)
    await client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query,
      limit: 15,
    });

    // 7. Second batch getCard with ETag support (simulating cache hit path)
    if (cards.length > 0) {
      const knownEtags: Record<string, string> = {};
      for (const card of cards) {
        if (card.symbolId && card.etag) {
          knownEtags[card.symbolId] = card.etag;
        }
      }
      if (Object.keys(knownEtags).length > 0) {
        await client.callToolParsed("sdl.symbol.getCard", {
          repoId: "stress-fixtures",
          symbolIds: topSymbolIds,
          knownEtags,
        });
      }
    }
  }
}

export async function runSemanticTools(
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

  // Setup: register and index fixture repo (this scenario uses its own server)
  log("Setup: Registering and indexing fixture repo");
  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "setup-0",
    setupCollector,
    config.verbose,
    authToken,
  );
  try {
    await setupClient.callToolParsed("sdl.repo.register", {
      repoId: "stress-fixtures",
      rootPath: config.fixturePath,
    });
    await setupClient.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "full",
    });
  } finally {
    await disconnectAll([setupClient]);
  }
  allResultStats.push(setupCollector.getResultStats());

  for (const clientCount of config.concurrencyLevels) {
    log(`--- Round: ${clientCount} concurrent semantic clients ---`);
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
      // Run all client workflows in parallel
      const results = await Promise.allSettled(
        clients.map((client, idx) => runSemanticWorkflow(client, idx)),
      );

      // Check for failures
      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          stressLog("error", `Semantic workflow failed: ${msg}`);
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

      // Check P95 against baseline (use reader multiplier — semantic tools are read-only)
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
    name: "semantic-tools",
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
