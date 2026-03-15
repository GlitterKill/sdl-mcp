/**
 * Scenario 5: Dispatch Pressure
 *
 * 3 clients each fire 4 concurrent sdl.symbol.search calls (12 total).
 * Server configured with maxToolConcurrency: 4 to force queuing.
 * Verifies the dispatch limiter is actively queuing under load.
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

const CLIENTS = 3;
const CALLS_PER_CLIENT = 4;
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

  // Sample dispatch stats at high frequency to catch brief queuing windows.
  // Tool calls complete in ~20ms, so 100ms sampling misses the queue entirely.
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
    log(
      `Firing ${CLIENTS * CALLS_PER_CLIENT} concurrent tool calls from ${CLIENTS} clients`,
    );

    // Each client fires CALLS_PER_CLIENT searches in parallel
    const allPromises = clients.flatMap((client, clientIdx) =>
      Array.from({ length: CALLS_PER_CLIENT }, (_, callIdx) => {
        const queryIdx = clientIdx * CALLS_PER_CLIENT + callIdx;
        const query = SEARCH_QUERIES[queryIdx % SEARCH_QUERIES.length];
        return client.callToolParsed("sdl.symbol.search", {
          repoId: "stress-fixtures",
          query,
          limit: 10,
        });
      }),
    );

    const results = await Promise.allSettled(allPromises);

    // Stop sampler
    clearInterval(samplerInterval);

    // Analyze results
    const totalCalls = results.length;
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    log(`  Completed: ${succeeded}/${totalCalls} succeeded, ${failed} failed`);
    log(
      `  Peak active: ${peakActive}, peak queued: ${peakQueued} (sampled ${sampleCount} times)`,
    );

    // Check: all calls should complete
    if (failed > 0) {
      passed = false;
      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          // Queue timeouts are a specific failure mode
          if (msg.includes("timeout")) {
            warnings.push(`Queue timeout detected: ${msg}`);
          }
        }
      }
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

    // Check: total duration should be reasonable (not fully serialized)
    const totalDuration = Date.now() - start;
    const fullySerializedEstimate = totalCalls * 100; // assume ~100ms per call if serialized
    if (totalDuration > fullySerializedEstimate * 2) {
      warnings.push(
        `Duration ${totalDuration}ms seems excessive for ${totalCalls} calls — possible serialization bottleneck`,
      );
    }

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
