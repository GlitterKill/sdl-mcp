import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  RepoStatusRequestSchema,
  RepoStatusResponseSchema,
} from "../../dist/mcp/tools.js";

describe("repo status health fields", () => {
  it("defaults requests to compact status with telemetry opt-in disabled", () => {
    const parsed = RepoStatusRequestSchema.parse({ repoId: "sdl-mcp" });

    assert.strictEqual(parsed.detail, "minimal");
    assert.strictEqual(parsed.includeTelemetry, false);
  });

  it("keeps compact repo status cheap unless telemetry is requested", () => {
    // ponytail: source-adjacent guard until repo status dependencies have injection seams.
    const source = readFileSync(
      new URL("../../src/mcp/tools/repo.ts", import.meta.url),
      "utf8",
    );

    assert.ok(source.includes('const includeExpensiveStatus = detail !== "minimal" || includeTelemetry;'));
    assert.ok(source.includes("const healthResult = includeExpensiveStatus"));
    assert.ok(source.includes("const watcherHealth = includeExpensiveStatus"));
    assert.ok(source.includes("const prefetchStats = includeExpensiveStatus"));
    assert.ok(source.includes("serverInfo: getServerInfo(),"));
  });

  it("allows compact repo status without full health telemetry fields", () => {
    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      latestVersionId: "v1",
      filesIndexed: 1,
      symbolsIndexed: 1,
      lastIndexedAt: new Date().toISOString(),
      healthAvailable: false,
      derivedState: {
        stale: false,
        clustersDirty: false,
        processesDirty: false,
        algorithmsDirty: false,
        summariesDirty: false,
        embeddingsDirty: false,
        targetVersionId: "v1",
        computedVersionId: "v1",
        updatedAt: null,
      },
    });

    assert.strictEqual(parsed.healthComponents, undefined);
    assert.strictEqual(parsed.watcherHealth, undefined);
    assert.strictEqual(parsed.prefetchStats, undefined);
    assert.strictEqual(parsed.liveIndexStatus, undefined);
    assert.strictEqual(parsed.serverInfo, undefined);
    assert.strictEqual(parsed.derivedState?.stale, false);
  });

  it("accepts standard/full telemetry fields when requested", () => {
    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      latestVersionId: "v1",
      filesIndexed: 1,
      symbolsIndexed: 1,
      lastIndexedAt: new Date().toISOString(),
      healthScore: 88,
      healthComponents: {
        freshness: 1,
        coverage: 1,
        errorRate: 1,
        edgeQuality: 1,
      },
      healthAvailable: true,
      watcherHealth: null,
      prefetchStats: {
        enabled: false,
        queueDepth: 0,
        running: false,
        completed: 0,
        cancelled: 0,
        cacheHits: 0,
        cacheMisses: 0,
        wastedPrefetch: 0,
        hitRate: 0,
        wasteRate: 5.5,
        avgLatencyReductionMs: 0,
        lastRunAt: null,
        modelEnabled: true,
        strategyMetrics: [],
        deterministicFallback: false,
        policyMode: "safe",
        outcomeSamples: 0,
        suppressedPrefetch: 0,
        acceptedPrefetch: 0,
        topStrategies: [],
      },
      liveIndexStatus: {
        enabled: true,
        pendingBuffers: 0,
        dirtyBuffers: 0,
        parseQueueDepth: 0,
        checkpointPending: false,
        lastBufferEventAt: null,
        lastCheckpointAt: null,
        lastCheckpointAttemptAt: "2026-03-07T12:02:00.000Z",
        lastCheckpointResult: "success",
        lastCheckpointError: null,
        lastCheckpointReason: "save",
        reconcileQueueDepth: 0,
        oldestReconcileAt: null,
        lastReconciledAt: null,
        reconcileInflight: false,
        reconcileLastError: null,
      },
      serverInfo: {
        version: "0.0.0-test",
        node: "v24.0.0",
        startedAt: "2026-03-07T12:02:00.000Z",
        driftWarnings: [],
      },
    });

    assert.strictEqual(parsed.healthScore, 88);
    assert.strictEqual(parsed.healthAvailable, true);
    assert.ok(parsed.prefetchStats);
    assert.strictEqual(parsed.prefetchStats.wasteRate, 5.5);
    assert.strictEqual(parsed.prefetchStats.modelEnabled, true);
    assert.deepStrictEqual(parsed.prefetchStats.strategyMetrics, []);
    assert.strictEqual(parsed.prefetchStats.deterministicFallback, false);
    assert.strictEqual(parsed.prefetchStats.policyMode, "safe");
    assert.deepStrictEqual(parsed.prefetchStats.topStrategies, []);
    assert.strictEqual(parsed.liveIndexStatus?.enabled, true);
    assert.strictEqual(parsed.liveIndexStatus?.lastCheckpointResult, "success");
    assert.strictEqual(parsed.serverInfo?.version, "0.0.0-test");
  });
});
