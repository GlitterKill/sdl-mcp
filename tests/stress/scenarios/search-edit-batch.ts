import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MetricsCollector } from "../infra/metrics-collector.js";
import {
  createStressClient,
  createStressClients,
  disconnectAll,
  type StressClient,
} from "../infra/client-factory.js";
import {
  ensureStressFixtureReady,
  STRESS_REPO_ID,
} from "../infra/scenario-setup.js";
import type {
  ScenarioContext,
  ScenarioResult,
  AggregateMetrics,
  ToolResultStats,
} from "../infra/types.js";
import {
  DEFAULT_THRESHOLDS,
  mergeResultStats,
  mergeToolDiagnostics,
  stressLog,
} from "../infra/types.js";

/**
 * Scenario: Search-Edit Batch Apply Under Concurrent Reads
 *
 * Verifies the multi-file `sdl.search.edit` path (preview + apply) under
 * contention with concurrent `sdl.context` readers. Exercises the
 * serialized write-pool posture: the native addon and LadybugDB write
 * pool have triggered UAF crashes in the past when multiple writers
 * run in parallel; batch apply must keep writes strictly sequential.
 *
 * Flow per round:
 *   1. Writer client creates N scratch files in a subdirectory under
 *      the shared fixture, seeds each with a unique marker literal.
 *   2. Writer issues `sdl.search.edit` in preview mode (text targeting,
 *      literal ≥ 3 chars — triggers the hybrid narrowing path so
 *      retrievalEvidence is populated).
 *   3. Readers run `sdl.context` / `sdl.symbol.search` in parallel with
 *      the apply phase. The writer calls `sdl.search.edit` apply with
 *      the preview handle. Apply must roll back nothing and write all N
 *      files.
 *   4. Cleanup: scratch directory removed and incremental index refresh
 *      re-syncs the graph.
 *
 * Pass/fail signal:
 *   - No DB corruption / UAF signatures in the error stream.
 *   - All N files reported `status: "written"` in the apply response.
 *   - Error rate stays under `DEFAULT_THRESHOLDS.maxErrorRate`.
 *   - P95 of `sdl.search.edit` does not explode vs. baseline (mixed
 *     multiplier applies because writes contend with readers).
 */

const BATCH_FILE_COUNT = 50;
const SCRATCH_DIR_REL = "stress-search-edit-batch";
const SEARCH_LITERAL = "stressSearchEditMarker";
const SEARCH_REPLACEMENT = "stressSearchEditMarkerUpdated";
const READER_QUERIES = ["User", "Server", "Handler", "Process", "Validate"];
const READER_ITERATIONS = 4;

async function seedScratchFiles(
  fixturePath: string,
  fileCount: number,
): Promise<{ scratchDir: string; relPaths: string[] }> {
  const scratchDir = join(fixturePath, SCRATCH_DIR_REL);
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(scratchDir, { recursive: true });

  const relPaths: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const name = `batch-${String(i).padStart(3, "0")}.txt`;
    const rel = `${SCRATCH_DIR_REL}/${name}`;
    const abs = join(scratchDir, name);
    const content =
      `Line A ${SEARCH_LITERAL} iteration ${i}\n` +
      `Line B ${SEARCH_LITERAL} iteration ${i}\n`;
    await writeFile(abs, content, "utf-8");
    relPaths.push(rel);
  }
  return { scratchDir, relPaths };
}

async function verifyBatchWrites(
  fixturePath: string,
  relPaths: string[],
): Promise<{ ok: number; mismatched: string[] }> {
  let ok = 0;
  const mismatched: string[] = [];
  for (const rel of relPaths) {
    const abs = join(fixturePath, rel);
    let content = "";
    try {
      content = await readFile(abs, "utf-8");
    } catch {
      mismatched.push(rel);
      continue;
    }
    const unreplacedPattern = new RegExp(SEARCH_LITERAL + "(?!Updated)");
    if (
      content.includes(SEARCH_REPLACEMENT) &&
      !unreplacedPattern.test(content)
    ) {
      ok++;
    } else {
      mismatched.push(rel);
    }
  }
  return { ok, mismatched };
}

async function writerWorkflow(
  client: StressClient,
  fixturePath: string,
  log: (msg: string) => void,
): Promise<{
  filesWritten: number;
  rollbackTriggered: boolean;
  evidencePresent: boolean;
}> {
  const { scratchDir, relPaths } = await seedScratchFiles(
    fixturePath,
    BATCH_FILE_COUNT,
  );
  log(`  Seeded ${relPaths.length} scratch files under ${SCRATCH_DIR_REL}`);

  const previewResponse = (await client.callToolParsed("sdl.search.edit", {
    mode: "preview",
    repoId: STRESS_REPO_ID,
    targeting: "text",
    query: {
      literal: SEARCH_LITERAL,
      replacement: SEARCH_REPLACEMENT,
      global: true,
    },
    filters: {
      include: [`${SCRATCH_DIR_REL}/**`],
      extensions: [".txt"],
    },
    editMode: "replacePattern",
    maxFiles: BATCH_FILE_COUNT,
    maxMatchesPerFile: 4,
    maxTotalMatches: BATCH_FILE_COUNT * 4,
    createBackup: true,
  })) as {
    planHandle: string;
    filesMatched: number;
    retrievalEvidence?: unknown;
  };

  const evidencePresent = previewResponse.retrievalEvidence !== undefined;

  const applyResponse = (await client.callToolParsed("sdl.search.edit", {
    mode: "apply",
    repoId: STRESS_REPO_ID,
    planHandle: previewResponse.planHandle,
  })) as {
    filesWritten: number;
    filesFailed: number;
    rollback: { triggered: boolean };
  };

  const { ok, mismatched } = await verifyBatchWrites(fixturePath, relPaths);
  if (mismatched.length > 0) {
    throw new Error(
      `search-edit-batch: ${mismatched.length}/${relPaths.length} files missing replacement`,
    );
  }

  await rm(scratchDir, { recursive: true, force: true });

  return {
    filesWritten: applyResponse.filesWritten ?? ok,
    rollbackTriggered: applyResponse.rollback?.triggered ?? false,
    evidencePresent,
  };
}

async function readerWorkflow(
  client: StressClient,
  queryIndex: number,
): Promise<void> {
  const query = READER_QUERIES[queryIndex % READER_QUERIES.length];
  for (let i = 0; i < READER_ITERATIONS; i++) {
    try {
      await client.callToolParsed("sdl.symbol.search", {
        repoId: STRESS_REPO_ID,
        query,
        limit: 10,
      });
    } catch {
      // Metrics collector already captured the error.
    }
    try {
      await client.callToolParsed("sdl.context", {
        repoId: STRESS_REPO_ID,
        taskType: "explain",
        taskText: `explain the ${query} implementation briefly`,
        budget: { maxTokens: 1500 },
      });
    } catch {
      // Metrics collector already captured the error.
    }
  }
}

export async function runSearchEditBatch(
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, serverPort, authToken, baselineMetrics } = ctx;
  const log = (msg: string) => stressLog("info", msg);

  const setupCollector = new MetricsCollector();
  const setupClient = await createStressClient(
    serverPort,
    "sse-batch-setup",
    setupCollector,
    config.verbose,
    authToken,
  );
  try {
    await ensureStressFixtureReady(setupClient, config.fixturePath, log);
  } finally {
    await disconnectAll([setupClient]);
  }

  const allToolMetrics: Record<string, AggregateMetrics> = {};
  const allErrors: ScenarioResult["errors"] = [];
  const allWarnings: string[] = [];
  const allResultStats: ToolResultStats[] = [];
  const allToolDiagnostics: Array<Record<string, unknown>> = [];
  let totalDuration = 0;
  let peakMemory = 0;
  let anyFailed = false;
  let lastEvidencePresent = false;

  for (const clientCount of config.concurrencyLevels) {
    const roundStart = Date.now();
    const collector = new MetricsCollector();
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

      let writerResult: Awaited<ReturnType<typeof writerWorkflow>> | null =
        null;
      const results = await Promise.allSettled([
        writerWorkflow(writerClient, config.fixturePath, log).then((r) => {
          writerResult = r;
        }),
        ...readerClients.map((client, idx) => readerWorkflow(client, idx)),
      ]);

      for (const result of results) {
        if (result.status === "rejected") {
          const msg =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
          stressLog("error", `search-edit batch failed: ${msg}`);
          anyFailed = true;
          allWarnings.push(`Round ${clientCount}: ${msg}`);
        }
      }

      if (writerResult !== null) {
        const wr = writerResult as Awaited<ReturnType<typeof writerWorkflow>>;
        lastEvidencePresent ||= wr.evidencePresent;
        if (wr.filesWritten !== BATCH_FILE_COUNT) {
          anyFailed = true;
          allWarnings.push(
            `Round ${clientCount}: expected ${BATCH_FILE_COUNT} files written, got ${wr.filesWritten}`,
          );
        }
        if (wr.rollbackTriggered) {
          anyFailed = true;
          allWarnings.push(
            `Round ${clientCount}: rollback triggered unexpectedly`,
          );
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
          e.message.includes("database is locked") ||
          e.message.toLowerCase().includes("use-after-free"),
      );
      if (corruptionErrors.length > 0) {
        anyFailed = true;
        allWarnings.push(
          `Round ${clientCount}: ${corruptionErrors.length} DB corruption/UAF errors`,
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
            metrics.p95 > baseP95 * DEFAULT_THRESHOLDS.mixedP95MultiplierWarn &&
            metrics.p95 - baseP95 > DEFAULT_THRESHOLDS.minWarnDeltaMs
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

      // Restore index state between rounds outside the measured window so
      // later rounds and scenarios start from a clean fixture graph.
      const cleanupCollector = new MetricsCollector();
      const cleanupClient = await createStressClient(
        serverPort,
        `sse-batch-cleanup-${clientCount}`,
        cleanupCollector,
        config.verbose,
        authToken,
      );
      try {
        await rm(join(config.fixturePath, SCRATCH_DIR_REL), {
          recursive: true,
          force: true,
        });
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

  if (!lastEvidencePresent) {
    allWarnings.push(
      "search.edit preview did not populate retrievalEvidence for any round",
    );
  }

  return {
    name: "search-edit-batch",
    passed: !anyFailed,
    clients: config.concurrencyLevels[config.concurrencyLevels.length - 1],
    durationMs: totalDuration,
    toolMetrics: allToolMetrics,
    errors: allErrors,
    memoryPeakMB: peakMemory,
    warnings: allWarnings,
    toolResultStats: mergeResultStats(allResultStats),
    toolDiagnostics: mergeToolDiagnostics(
      allToolDiagnostics as Array<
        Record<string, import("../infra/types.js").ToolDiagnostics>
      >,
    ),
  };
}
