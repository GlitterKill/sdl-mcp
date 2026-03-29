/**
 * Scenario 7: Limit Stress
 *
 * Pushes the server to its maximum connection topology:
 *   - 8 sessions (maxSessions: 8) — 1 writer + 7 readers
 *   - maxToolConcurrency: 8
 *   - Extended duration: 5 writer iterations, 5 reader iterations
 *   - Full context ladder per reader (search → card → slice → skeleton → hotPath → needWindow)
 *   - High-frequency dispatch + memory sampling for bottleneck detection
 *
 * Produces rich per-tool, per-client, and timeline stats to identify
 * where latency accumulates under maximum load.
 */

import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
} from "../infra/client-factory.js";
import { importStressDistModule } from "../infra/dist-runtime.js";
import type {
  ScenarioContext,
  ScenarioResult,
} from "../infra/types.js";
import { stressLog, DEFAULT_THRESHOLDS } from "../infra/types.js";

const { getToolDispatchLimiter } = await importStressDistModule<{
  getToolDispatchLimiter: () => { getStats(): { active: number; queued: number } };
}>(import.meta.url, "mcp/dispatch-limiter.js");

const READER_COUNT = 7;
const WRITER_ITERATIONS = 5;
const READER_ITERATIONS = 5;

const SEARCH_QUERIES = [
  "User",
  "Server",
  "Handler",
  "Process",
  "Validate",
  "Create",
  "Repository",
];

// ---------------------------------------------------------------------------
// Writer workflow — continuous re-index + status + policy + overview
// ---------------------------------------------------------------------------

async function writerWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  log: (msg: string) => void,
): Promise<void> {
  for (let i = 0; i < WRITER_ITERATIONS; i++) {
    // Incremental re-index (write operation)
    await client.callToolParsed("sdl.index.refresh", {
      repoId: "stress-fixtures",
      mode: "incremental",
    });

    // Status check — validates index integrity after write
    await client.callToolParsed("sdl.repo.status", {
      repoId: "stress-fixtures",
    });

    // Overview — medium-weight read during write phase
    await client.callToolParsed("sdl.repo.overview", {
      repoId: "stress-fixtures",
      level: "stats",
    });

    // Policy read — lightweight, tests dispatch fairness
    await client.callToolParsed("sdl.policy.get", {
      repoId: "stress-fixtures",
    });

    // Stagger writes slightly so reads have windows of contention
    await new Promise((r) => setTimeout(r, 60));
  }
  log(`  Writer completed ${WRITER_ITERATIONS} iterations`);
}

// ---------------------------------------------------------------------------
// Reader workflow — full context ladder per iteration
// ---------------------------------------------------------------------------

async function readerWorkflow(
  client: import("../infra/client-factory.js").StressClient,
  readerIdx: number,
): Promise<void> {
  for (let i = 0; i < READER_ITERATIONS; i++) {
    const query =
      SEARCH_QUERIES[(readerIdx + i) % SEARCH_QUERIES.length];

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
    const sliceResult = await client.callToolParsed("sdl.slice.build", {
      repoId: "stress-fixtures",
      entrySymbols: [symbolId],
      budget: { maxCards: 20, maxEstimatedTokens: 3000 },
    }) as Record<string, unknown> & { slice?: { vid?: string } };

    // 4. Skeleton
    await client.callToolParsed("sdl.code.getSkeleton", {
      repoId: "stress-fixtures",
      symbolId,
    });

    // 5. Hot path — focused identifier search
    await client.callToolParsed("sdl.code.getHotPath", {
      repoId: "stress-fixtures",
      symbolId,
      identifiersToFind: [query, "return"],
    });

    // 6. Need window — full code (top of ladder)
    try {
      await client.callToolParsed("sdl.code.needWindow", {
        repoId: "stress-fixtures",
        symbolId,
        reason: `Limit stress: verify ${query} under max load`,
        expectedLines: 60,
        identifiersToFind: [query],
      });
    } catch {
      // Policy denial is acceptable
    }

    // 7. Slice refresh if we have a handle (tests incremental path)
    const sliceHandle = sliceResult?.sliceHandle as string | undefined;
    const knownVersion = (
      sliceResult?.ledgerVersion ?? sliceResult?.slice?.vid
    ) as string | undefined;
    if (sliceHandle && knownVersion) {
      try {
        await client.callToolParsed("sdl.slice.refresh", {
          sliceHandle,
          knownVersion,
        });
      } catch {
        // Handle may have expired under heavy load — acceptable
      }
    }

    // 8. Policy check (lightweight, interleaved)
    await client.callToolParsed("sdl.policy.get", {
      repoId: "stress-fixtures",
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario entry point
// ---------------------------------------------------------------------------

export async function runLimitStress(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, authToken, log, baselineMetrics } = ctx;
  const collector = new MetricsCollector();
  const warnings: string[] = [];
  const start = Date.now();
  let passed = true;

  collector.recordMemorySnapshot();

  // Setup: register and index fixture repo
  log("Setup: Registering and indexing fixture repo");
  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "ls-setup",
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

  // Create 8 clients: 1 writer + 7 readers (fills maxSessions)
  log(`Creating ${READER_COUNT + 1} clients (1 writer + ${READER_COUNT} readers)`);
  const writerCollector = new MetricsCollector();
  const writerClient = await createStressClient(
    serverPort,
    "ls-writer",
    collector,
    config.verbose,
    authToken,
  );

  const readerClients = await createStressClients(
    serverPort,
    READER_COUNT,
    collector,
    config.verbose,
    0,
    authToken,
  );

  // High-frequency dispatch + memory sampler (3ms interval)
  let peakQueued = 0;
  let peakActive = 0;
  let sampleCount = 0;
  const memSnapshots: Array<{ offsetMs: number; rss: number; heapUsed: number }> = [];
  const dispatchTimeline: Array<{ offsetMs: number; active: number; queued: number }> = [];
  const sampleStart = Date.now();

  const samplerInterval = setInterval(() => {
    try {
      const stats = getToolDispatchLimiter().getStats();
      collector.recordDispatchStats(stats);
      const offsetMs = Date.now() - sampleStart;
      dispatchTimeline.push({ offsetMs, active: stats.active, queued: stats.queued });
      if (stats.queued > peakQueued) peakQueued = stats.queued;
      if (stats.active > peakActive) peakActive = stats.active;

      // Memory sample every 10th dispatch sample (~30ms)
      if (sampleCount % 10 === 0) {
        const mem = process.memoryUsage();
        memSnapshots.push({
          offsetMs,
          rss: Math.round(mem.rss / (1024 * 1024)),
          heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
        });
      }
      sampleCount++;
    } catch {
      // Ignore sampling errors
    }
  }, 3);

  const callStart = Date.now();

  try {
    log(
      `Running: 1 writer (${WRITER_ITERATIONS} iters) + ${READER_COUNT} readers (${READER_ITERATIONS} iters each)`,
    );

    // Run all clients in parallel
    const results = await Promise.allSettled([
      writerWorkflow(writerClient, log),
      ...readerClients.map((client, idx) => readerWorkflow(client, idx)),
    ]);

    clearInterval(samplerInterval);
    const callDuration = Date.now() - callStart;

    collector.recordMemorySnapshot();

    // Analyze failures
    const failures = results.filter((r) => r.status === "rejected");
    for (const f of failures) {
      if (f.status === "rejected") {
        const msg =
          f.reason instanceof Error ? f.reason.message : String(f.reason);
        stressLog("error", `Limit stress workflow failed: ${msg}`);
      }
    }

    const errors = collector.getErrors();

    // Check for DB corruption errors
    const corruptionErrors = errors.filter(
      (e) =>
        e.message.includes("corrupt") ||
        e.message.includes("database is locked"),
    );
    if (corruptionErrors.length > 0) {
      passed = false;
      warnings.push(
        `${corruptionErrors.length} DB corruption/lock errors detected`,
      );
    }

    // Check error rate
    const totalCalls = collector.getRecordCount();
    const errorRate = errors.length / Math.max(totalCalls, 1);
    if (errorRate > DEFAULT_THRESHOLDS.maxErrorRate) {
      passed = false;
      warnings.push(
        `Error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(DEFAULT_THRESHOLDS.maxErrorRate * 100).toFixed(1)}%`,
      );
    }

    // Check P95 against baseline (use mixed multiplier — we have write contention)
    const toolMetrics = collector.getAllToolMetrics();
    if (baselineMetrics) {
      for (const [tool, metrics] of Object.entries(toolMetrics)) {
        const baseP95 = baselineMetrics[tool]?.p95;
        if (
          baseP95 &&
          baseP95 > 0 &&
          metrics.p95 > baseP95 * DEFAULT_THRESHOLDS.mixedP95MultiplierWarn &&
          metrics.p95 - baseP95 > DEFAULT_THRESHOLDS.minWarnDeltaMs
        ) {
          warnings.push(
            `${tool} P95 ${metrics.p95}ms > ${DEFAULT_THRESHOLDS.mixedP95MultiplierWarn}x baseline (${baseP95}ms)`,
          );
        }
      }
    }

    // Memory growth check
    const memLeak = collector.detectMemoryLeak(
      DEFAULT_THRESHOLDS.memoryGrowthWarnMB,
    );
    if (memLeak.leaked) {
      warnings.push(
        `Memory grew ${memLeak.growthMB}MB (threshold: ${DEFAULT_THRESHOLDS.memoryGrowthWarnMB}MB)`,
      );
    }

    // -----------------------------------------------------------------------
    // Rich stats for bottleneck targeting
    // -----------------------------------------------------------------------

    // Per-client breakdown — detect uneven load distribution
    const perClient = collector.getPerClientMetrics();
    const clientP95s = Object.entries(perClient)
      .map(([id, m]) => ({ id, p95: m.p95, count: m.count, errRate: m.errorRate }))
      .sort((a, b) => b.p95 - a.p95);

    // Exclude the writer client from imbalance detection — it runs
    // index.refresh (~500ms+) which is structurally slower than reads.
    const readerP95s = clientP95s.filter((c) => !c.id.includes("writer"));
    if (readerP95s.length > 1) {
      const slowest = readerP95s[0];
      const fastest = readerP95s[readerP95s.length - 1];
      if (slowest.p95 > fastest.p95 * 3 && fastest.p95 > 0) {
        warnings.push(
          `Load imbalance: slowest reader ${slowest.id} P95=${slowest.p95}ms vs fastest ${fastest.id} P95=${fastest.p95}ms`,
        );
      }
    }

    // Dispatch queue saturation analysis
    const avgQueued = collector.getAvgDispatchQueued();
    const queueSaturationPct =
      sampleCount > 0
        ? Math.round(
            (dispatchTimeline.filter((d) => d.queued > 0).length /
              sampleCount) *
              100,
          )
        : 0;

    // Throughput timeline (1-second buckets)
    const timeline = collector.getThroughputTimeline(1000);
    const peakThroughput = Math.max(...timeline.map((b) => b.calls), 0);

    log(`  Call phase: ${callDuration}ms`);
    log(`  Total tool calls: ${totalCalls}`);
    log(`  Peak dispatch: active=${peakActive}, queued=${peakQueued}`);
    log(`  Avg queue depth: ${avgQueued}, queue saturation: ${queueSaturationPct}%`);
    log(`  Peak throughput: ${peakThroughput} calls/sec`);
    log(`  Dispatch samples: ${sampleCount}`);
    log(`  Memory snapshots: ${memSnapshots.length}`);
    if (memSnapshots.length >= 2) {
      const firstMem = memSnapshots[0];
      const lastMem = memSnapshots[memSnapshots.length - 1];
      log(
        `  Memory: RSS ${firstMem.rss}MB → ${lastMem.rss}MB, Heap ${firstMem.heapUsed}MB → ${lastMem.heapUsed}MB`,
      );
    }

    // Per-client summary
    log(`  Per-client breakdown:`);
    for (const c of clientP95s) {
      log(
        `    ${c.id}: ${c.count} calls, P95=${c.p95}ms, err=${(c.errRate * 100).toFixed(1)}%`,
      );
    }

    return {
      name: "limit-stress",
      passed,
      clients: READER_COUNT + 1,
      durationMs: Date.now() - start,
      toolMetrics,
      errors,
      memoryPeakMB: collector.getMemoryPeakMB(),
      warnings,
      toolResultStats: collector.getResultStats(),
    };
  } finally {
    clearInterval(samplerInterval);
    await disconnectAll([writerClient, ...readerClients]);
  }
}
