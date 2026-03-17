/**
 * Scenario 5: Dispatch Pressure
 *
 * 4 clients fire mixed tool calls concurrently (20 total).
 * Server configured with maxToolConcurrency: 4 to force queuing.
 * Tests dispatch limiter under varied tool complexity (search, card, skeleton, slice).
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
} from "../infra/client-factory.js";
import type { ScenarioContext, ScenarioResult } from "../infra/types.js";
import { stressLog } from "../infra/types.js";

import { getToolDispatchLimiter } from "../../../dist/mcp/dispatch-limiter.js";

const CLIENTS = 4;
const CALLS_PER_CLIENT = 5;
const SEARCH_QUERIES = [
  "User",
  "Server",
  "Handler",
  "Process",
  "Validate",
  "Create",
  "Repository",
  "Service",
  "Controller",
  "Middleware",
  "Router",
  "Engine",
];

/**
 * Build a mixed batch of tool calls for one client.
 * Returns promises for: search, getCard, getSkeleton, slice.build, and getHotPath.
 * This creates varied dispatch load instead of uniform search-only traffic.
 */
async function fireMixedBatch(
  client: import("../infra/client-factory.js").StressClient,
  clientIdx: number,
  firstSymbolId: string | undefined,
): Promise<Record<string, unknown>[]> {
  const baseIdx = clientIdx * CALLS_PER_CLIENT;
  const promises: Promise<Record<string, unknown>>[] = [];

  // 1. Search (always)
  const query = SEARCH_QUERIES[baseIdx % SEARCH_QUERIES.length];
  promises.push(
    client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query,
      limit: 10,
    }),
  );

  // 2. Another search with different query
  const query2 = SEARCH_QUERIES[(baseIdx + 1) % SEARCH_QUERIES.length];
  promises.push(
    client.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query: query2,
      limit: 10,
    }),
  );

  if (firstSymbolId) {
    // 3. Get card (medium cost)
    promises.push(
      client.callToolParsed("sdl.symbol.getCard", {
        repoId: "stress-fixtures",
        symbolId: firstSymbolId,
      }),
    );

    // 4. Get skeleton (higher cost — file read + AST parse)
    promises.push(
      client.callToolParsed("sdl.code.getSkeleton", {
        repoId: "stress-fixtures",
        symbolId: firstSymbolId,
      }),
    );

    // 5. Slice build (heaviest — graph traversal)
    promises.push(
      client.callToolParsed("sdl.slice.build", {
        repoId: "stress-fixtures",
        entrySymbols: [firstSymbolId],
        budget: { maxCards: 10, maxEstimatedTokens: 1500 },
      }),
    );
  } else {
    // Fallback: more searches if no symbolId available
    promises.push(
      client.callToolParsed("sdl.symbol.search", {
        repoId: "stress-fixtures",
        query: SEARCH_QUERIES[(baseIdx + 2) % SEARCH_QUERIES.length],
        limit: 10,
      }),
    );
    promises.push(
      client.callToolParsed("sdl.repo.overview", {
        repoId: "stress-fixtures",
        level: "stats",
      }),
    );
    promises.push(
      client.callToolParsed("sdl.policy.get", {
        repoId: "stress-fixtures",
      }),
    );
  }

  return Promise.all(promises);
}

export async function runDispatchPressure(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, authToken, log } = ctx;
  const collector = new MetricsCollector();
  const warnings: string[] = [];
  const start = Date.now();
  let passed = true;

  collector.recordMemorySnapshot();

  // Setup: register and index fixture repo (this scenario uses its own server)
  log("Setup: Registering and indexing fixture repo");
  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "dp-setup",
    setupCollector,
    config.verbose,
    authToken,
  );

  // Get a symbolId during setup so mixed batches can use card/skeleton/slice
  let knownSymbolId: string | undefined;
  try {
    await setupClient.callToolParsed("sdl.repo.register", {
      repoId: "stress-fixtures",
      rootPath: config.fixturePath,
    });
    await setupClient.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "full",
    });

    // Pre-fetch a symbolId for the mixed tool calls
    const preSearch = await setupClient.callToolParsed("sdl.symbol.search", {
      repoId: "stress-fixtures",
      query: "User",
      limit: 1,
    });
    const preResults = (preSearch?.results ?? []) as Array<{
      symbolId: string;
    }>;
    if (preResults.length > 0) {
      knownSymbolId = preResults[0].symbolId;
    }
  } finally {
    await disconnectAll([setupClient]);
  }

  // Sample dispatch stats at high frequency to catch brief queuing windows.
  let peakQueued = 0;
  let peakActive = 0;
  let sampleCount = 0;
  const samplerInterval = setInterval(() => {
    try {
      const stats = getToolDispatchLimiter().getStats();
      collector.recordDispatchStats(stats);
      if (stats.queued > peakQueued) {
        peakQueued = stats.queued;
      }
      if (stats.active > peakActive) {
        peakActive = stats.active;
      }
      sampleCount++;
    } catch {
      // Ignore sampling errors
    }
  }, 5);

  const clients = await createStressClients(
    serverPort,
    CLIENTS,
    collector,
    config.verbose,
    0,
    authToken,
  );

  try {
    const totalExpected = CLIENTS * CALLS_PER_CLIENT;
    log(
      `Firing ${totalExpected} concurrent mixed tool calls from ${CLIENTS} clients`,
    );

    // Start the clock for actual tool calls (excludes setup overhead)
    const callStart = Date.now();

    // Each client fires a mixed batch in parallel
    const allPromises = clients.map((client, clientIdx) =>
      fireMixedBatch(client, clientIdx, knownSymbolId),
    );

    const batchResults = await Promise.allSettled(allPromises);

    // Stop sampler
    clearInterval(samplerInterval);

    const callDuration = Date.now() - callStart;

    // Count results across all batches
    let succeeded = 0;
    let failed = 0;
    for (const batch of batchResults) {
      if (batch.status === "fulfilled") {
        succeeded += batch.value.length;
      } else {
        failed += CALLS_PER_CLIENT; // entire batch failed
        const msg =
          batch.reason instanceof Error
            ? batch.reason.message
            : String(batch.reason);
        if (msg.includes("timeout")) {
          warnings.push(`Queue timeout detected: ${msg}`);
        }
      }
    }

    const totalCalls = succeeded + failed;
    log(`  Completed: ${succeeded}/${totalCalls} succeeded, ${failed} failed`);
    log(
      `  Peak active: ${peakActive}, peak queued: ${peakQueued} (sampled ${sampleCount} times)`,
    );
    log(`  Call phase duration: ${callDuration}ms`);

    // Check: all calls should complete
    if (failed > 0) {
      passed = false;
      warnings.push(`${failed}/${totalCalls} calls failed`);
    }

    // Check: queuing should have been observed — this is the core assertion
    if (peakQueued === 0) {
      passed = false;
      warnings.push(
        "Dispatch limiter queuing was not observed (peakQueued=0). Limiter may not be active.",
      );
    } else {
      log(`  Dispatch limiter working: peak queued=${peakQueued}`);
    }

    // Check: call-phase duration should be reasonable (not fully serialized)
    const fullySerializedEstimate = totalCalls * 100;
    if (callDuration > fullySerializedEstimate * 2) {
      warnings.push(
        `Duration ${callDuration}ms seems excessive for ${totalCalls} calls — possible serialization bottleneck`,
      );
    }

    // Report dispatch stats for bottleneck analysis
    const avgQueued = collector.getAvgDispatchQueued();
    log(`  Avg dispatch queue depth: ${avgQueued}`);

    collector.recordMemorySnapshot();
  } finally {
    clearInterval(samplerInterval);
    await disconnectAll(clients);
  }

  return {
    name: "dispatch-pressure",
    passed,
    clients: CLIENTS,
    durationMs: Date.now() - start,
    toolMetrics: collector.getAllToolMetrics(),
    errors: collector.getErrors(),
    memoryPeakMB: collector.getMemoryPeakMB(),
    warnings,
    toolResultStats: collector.getResultStats(),
  };
}
