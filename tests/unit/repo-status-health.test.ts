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
    assert.ok(
      source.includes("graphIntegrityIsVerifiedForVersion("),
      "repo.status must gate even cached health against current integrity state",
    );
    assert.ok(source.includes("serverInfo: getServerInfo(),"));
  });

  it("allows compact repo status without health or telemetry fields", () => {
    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      latestVersionId: "v1",
      filesIndexed: 1,
      symbolsIndexed: 1,
      lastIndexedAt: new Date().toISOString(),
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
        graphIntegrityState: "verified",
        graphIntegrityVersionId: "v1",
        graphIntegrityDigest: "a".repeat(64),
      },
    });

    assert.strictEqual(parsed.healthAvailable, undefined);
    assert.strictEqual(parsed.healthComponents, undefined);
    assert.strictEqual(parsed.watcherHealth, undefined);
    assert.strictEqual(parsed.prefetchStats, undefined);
    assert.strictEqual(parsed.liveIndexStatus, undefined);
    assert.strictEqual(parsed.serverInfo, undefined);
    assert.strictEqual(parsed.derivedState?.stale, false);
    assert.strictEqual(
      parsed.derivedState?.graphIntegrityState,
      "verified",
    );
    assert.strictEqual(parsed.derivedState?.graphIntegrityVersionId, "v1");
    assert.strictEqual(
      parsed.derivedState?.graphIntegrityDigest,
      "a".repeat(64),
    );
  });

  it("keeps integrity failure details out of repo status", () => {
    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      latestVersionId: "v2",
      filesIndexed: 1,
      symbolsIndexed: 1,
      lastIndexedAt: null,
      healthScore: 99,
      healthAvailable: false,
      derivedState: {
        stale: false,
        clustersDirty: false,
        processesDirty: false,
        algorithmsDirty: false,
        summariesDirty: false,
        embeddingsDirty: false,
        targetVersionId: "v2",
        computedVersionId: "v2",
        updatedAt: "2026-07-16T01:02:03.000Z",
        graphIntegrityState: "failed",
        graphIntegrityVersionId: "v2",
        graphIntegrityDigest: null,
        graphIntegrityError: "nondeterministic internal mismatch detail",
        nextBestAction:
          'Graph integrity verification failed. Run sdl.index.refresh with mode:"full" to rebuild and verify the graph. If full verification fails again, stop SDL-MCP, delete the configured .lbug database directory, and rebuild from source.',
      },
    });

    assert.equal(parsed.healthAvailable, false);
    assert.equal(parsed.derivedState?.graphIntegrityState, "failed");
    assert.equal("graphIntegrityError" in (parsed.derivedState ?? {}), false);
    assert.equal(
      parsed.derivedState?.nextBestAction,
      'Graph integrity verification failed. Run sdl.index.refresh with mode:"full" to rebuild and verify the graph. If full verification fails again, stop SDL-MCP, delete the configured .lbug database directory, and rebuild from source.',
    );
  });

  it("accepts compact standard/full telemetry fields when requested", () => {
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
      watcherHealth: {
        enabled: true,
        running: true,
        provider: "watchman",
        configuredProvider: "auto",
        fallbackReason: null,
        errors: 0,
        queueDepth: 0,
        stale: false,
      },
      prefetchStats: {
        enabled: false,
        queueDepth: 0,
        running: false,
        hitRate: 0,
        wasteRate: 5.5,
        avgLatencyReductionMs: 0,
        lastRunAt: null,
        policyMode: "safe",
        suppressedPrefetch: 0,
        acceptedPrefetch: 0,
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
    assert.ok(parsed.watcherHealth);
    assert.equal("watchmanVersion" in parsed.watcherHealth, false);
    assert.ok(parsed.prefetchStats);
    assert.strictEqual(parsed.prefetchStats.wasteRate, 5.5);
    assert.equal("strategyMetrics" in parsed.prefetchStats, false);
    assert.equal("topStrategies" in parsed.prefetchStats, false);
    assert.strictEqual(parsed.liveIndexStatus?.enabled, true);
    assert.strictEqual(parsed.liveIndexStatus?.lastCheckpointResult, "success");
    assert.strictEqual(parsed.serverInfo?.version, "0.0.0-test");
  });
});
