import assert from "node:assert";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

  it("opens and closes the root without enumerating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-root-bounded-probe-"));
    let opens = 0;
    let reads = 0;
    let closes = 0;
    try {
      const healthModule = await import("../../dist/services/health.js");
      const probe = Reflect.get(healthModule, "probeRepositoryRoot") as
        | ((
            rootPath: string,
            openDirectory: (rootPath: string) => Promise<{
              read(): Promise<null>;
              close(): Promise<void>;
            }>,
          ) => Promise<{ status: string }>)
        | undefined;
      assert.ok(probe);

      const result = await probe(root, async () => {
        opens++;
        return {
          read: async () => {
            reads++;
            return null;
          },
          close: async () => {
            closes++;
          },
        };
      });

      assert.deepStrictEqual(result, { status: "available" });
      assert.strictEqual(opens, 1);
      assert.strictEqual(reads, 0);
      assert.strictEqual(closes, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies a Windows-style ACL directory-open denial as unreadable", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-root-acl-probe-"));
    try {
      const healthModule = await import("../../dist/services/health.js");
      const probe = Reflect.get(healthModule, "probeRepositoryRoot") as
        | ((
            rootPath: string,
            openDirectory: (rootPath: string) => Promise<never>,
          ) => Promise<{ status: string }>)
        | undefined;
      assert.ok(probe);
      const denied = Object.assign(new Error("raw ACL detail must stay private"), {
        code: "EPERM",
      });

      const result = await probe(root, async () => {
        throw denied;
      });

      assert.deepStrictEqual(result, { status: "unreadable" });
      assert.doesNotMatch(JSON.stringify(result), /raw ACL detail/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies existing, missing, and file roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdl-root-probe-"));
    const file = join(root, "not-a-directory");
    const missing = join(root, "missing");
    writeFileSync(file, "not a root", "utf8");
    try {
      const healthModule = await import("../../dist/services/health.js");
      const probe = Reflect.get(healthModule, "probeRepositoryRoot") as
        | ((rootPath: string) => Promise<{ status: string }>)
        | undefined;
      assert.ok(probe);

      assert.deepStrictEqual(await probe(root), { status: "available" });
      assert.deepStrictEqual(await probe(missing), { status: "missing" });
      assert.deepStrictEqual(await probe(file), { status: "unreadable" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies an unreadable directory when the platform enforces read mode", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "sdl-root-unreadable-"));
    const originalMode = statSync(root).mode;
    try {
      chmodSync(root, 0);
      const healthModule = await import("../../dist/services/health.js");
      const probe = Reflect.get(healthModule, "probeRepositoryRoot") as
        | ((rootPath: string) => Promise<{ status: string }>)
        | undefined;
      assert.ok(probe);
      const result = await probe(root);
      if (result.status === "available") {
        t.skip("platform does not enforce directory read mode for this process");
        return;
      }
      assert.deepStrictEqual(result, { status: "unreadable" });
    } finally {
      chmodSync(root, originalMode);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps unavailable roots and failed-closed health in compact model output", async () => {
    const { projectToolResultForModelContent } = await import(
      "../../dist/mcp/context-response-projection.js"
    );
    const projected = projectToolResultForModelContent("sdl.repo.status", {
      repoId: "missing",
      rootAvailability: {
        status: "missing",
        nextBestAction: "Restore the repository root.",
      },
      latestVersionId: "v1",
      filesIndexed: 1,
      symbolsIndexed: 1,
      healthAvailable: false,
    }) as Record<string, unknown>;

    assert.deepStrictEqual(projected.rootAvailability, {
      status: "missing",
      nextBestAction: "Restore the repository root.",
    });
    assert.strictEqual(projected.healthAvailable, false);
    assert.strictEqual(projected.healthScore, undefined);
  });

  it("allows compact repo status without health or telemetry fields", () => {
    const parsed = RepoStatusResponseSchema.parse({
      repoId: "sdl-mcp",
      rootPath: ".",
      rootAvailability: { status: "available" },
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
      rootAvailability: { status: "available" },
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
      rootAvailability: { status: "available" },
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

describe("repo status root availability", { concurrency: 1 }, () => {
  const testRoot = join(tmpdir(), `sdl-repo-status-root-${process.pid}`);
  const dbPath = join(testRoot, "graph.lbug");
  const configPath = join(testRoot, "sdlmcp.config.json");
  const availableRoot = join(testRoot, "available");
  const missingRoot = join(testRoot, "missing");
  const configuredMissingRoot = join(testRoot, "configured-missing");
  const fileRoot = join(testRoot, "file-root");
  const originalConfig = process.env.SDL_CONFIG;
  const originalDbPath = process.env.SDL_GRAPH_DB_PATH;

  before(async () => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(availableRoot, { recursive: true });
    writeFileSync(fileRoot, "not a directory", "utf8");
    writeFileSync(
      configPath,
      JSON.stringify({
        repos: [
          { repoId: "configured-missing", rootPath: configuredMissingRoot },
        ],
        policy: {},
      }),
      "utf8",
    );
    process.env.SDL_CONFIG = configPath;
    process.env.SDL_GRAPH_DB_PATH = dbPath;

    const { invalidateConfigCache } = await import(
      "../../dist/config/loadConfig.js"
    );
    const { closeLadybugDb, initLadybugDb, withWriteConn } = await import(
      "../../dist/db/ladybug.js"
    );
    const ladybugDb = await import("../../dist/db/ladybug-queries.js");
    const derivedState = await import(
      "../../dist/db/ladybug-derived-state.js"
    );
    invalidateConfigCache();
    await closeLadybugDb();
    await initLadybugDb(dbPath);

    const roots = new Map([
      ["available", availableRoot],
      ["missing", missingRoot],
      ["configured-missing", configuredMissingRoot],
      ["file-root", fileRoot],
      ["integrity-unknown", availableRoot],
    ]);
    await withWriteConn(async (conn) => {
      for (const [repoId, rootPath] of roots) {
        await ladybugDb.upsertRepo(conn, {
          repoId,
          rootPath,
          configJson: JSON.stringify({
            repoId,
            rootPath,
            ignore: [],
            languages: ["ts"],
            maxFileBytes: 2_000_000,
            includeNodeModulesTypes: false,
            packageJsonPath: null,
            tsconfigPath: null,
            workspaceGlobs: null,
          }),
          createdAt: "2026-07-16T00:00:00.000Z",
        });
        await ladybugDb.createVersion(conn, {
          versionId: `${repoId}-v1`,
          repoId,
          createdAt: "2026-07-16T00:00:00.000Z",
          reason: "test",
          prevVersionHash: null,
          versionHash: null,
        });
      }
    });
    for (const repoId of [
      "available",
      "missing",
      "configured-missing",
      "file-root",
    ]) {
      await derivedState.markDerivedStateComputed(repoId, `${repoId}-v1`);
      await derivedState.markGraphIntegrityVerified(
        repoId,
        `${repoId}-v1`,
        "a".repeat(64),
      );
    }
  });

  after(async () => {
    const { invalidateConfigCache } = await import(
      "../../dist/config/loadConfig.js"
    );
    const { closeLadybugDb } = await import("../../dist/db/ladybug.js");
    await closeLadybugDb();
    if (originalConfig === undefined) delete process.env.SDL_CONFIG;
    else process.env.SDL_CONFIG = originalConfig;
    if (originalDbPath === undefined) delete process.env.SDL_GRAPH_DB_PATH;
    else process.env.SDL_GRAPH_DB_PATH = originalDbPath;
    invalidateConfigCache();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("returns root availability from every status detail level", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");

    for (const detail of ["minimal", "standard", "full"] as const) {
      const status = await handleRepoStatus({ repoId: "available", detail });
      assert.deepStrictEqual(status.rootAvailability, { status: "available" });
    }
  });

  it("keeps clean derived state separate from a missing runtime root", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const status = await handleRepoStatus({
      repoId: "missing",
      detail: "standard",
    });

    assert.strictEqual(status.rootAvailability.status, "missing");
    assert.match(status.rootAvailability.nextBestAction ?? "", /repo\.register/);
    assert.match(status.rootAvailability.nextBestAction ?? "", /repo\.unregister/);
    assert.strictEqual(status.derivedState?.stale, false);
    assert.strictEqual(status.derivedState?.graphIntegrityState, "verified");
    assert.strictEqual(status.healthAvailable, false);
    assert.strictEqual(status.healthScore, undefined);
  });

  it("returns configured-root recovery without runtime unregister guidance", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const status = await handleRepoStatus({
      repoId: "configured-missing",
      detail: "minimal",
    });

    assert.strictEqual(status.rootAvailability.status, "missing");
    assert.match(status.rootAvailability.nextBestAction ?? "", /SDL_CONFIG/);
    assert.doesNotMatch(
      status.rootAvailability.nextBestAction ?? "",
      /repo\.unregister/,
    );
    assert.strictEqual(status.healthAvailable, false);
    assert.strictEqual(status.healthScore, undefined);
  });

  it("treats a file root as unreadable and fails health closed", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const status = await handleRepoStatus({ repoId: "file-root", detail: "full" });

    assert.strictEqual(status.rootAvailability.status, "unreadable");
    assert.strictEqual(status.healthAvailable, false);
    assert.strictEqual(status.healthScore, undefined);
  });

  it("keeps root and graph-integrity gates independent", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const status = await handleRepoStatus({
      repoId: "integrity-unknown",
      detail: "standard",
    });

    assert.deepStrictEqual(status.rootAvailability, { status: "available" });
    assert.strictEqual(status.healthAvailable, false);
    assert.strictEqual(status.healthScore, null);
  });

  it("does not enter the repository-scan health path for minimal status", async () => {
    const repoModule = await import("../../dist/mcp/tools/repo.js");
    const setHealthLoader = Reflect.get(
      repoModule,
      "_setRepoStatusHealthLoaderForTesting",
    ) as ((loader?: (repoId: string) => Promise<never>) => void) | undefined;
    assert.strictEqual(typeof setHealthLoader, "function");
    let calls = 0;
    setHealthLoader!(async () => {
      calls++;
      throw new Error("repository scan path invoked");
    });
    try {
      const status = await repoModule.handleRepoStatus({
        repoId: "available",
        detail: "minimal",
      });
      assert.deepStrictEqual(status.rootAvailability, { status: "available" });
      assert.strictEqual(calls, 0);
    } finally {
      setHealthLoader!();
    }
  });

  it("fails health closed when root access is lost after the probe", async () => {
    const healthModule = await import("../../dist/services/health.js");
    const setScanner = Reflect.get(
      healthModule,
      "_setHealthRepositoryScannerForTesting",
    ) as ((scanner?: (rootPath: string) => Promise<never>) => void) | undefined;
    assert.strictEqual(typeof setScanner, "function");
    setScanner!(async () => {
      throw Object.assign(new Error("raw TOCTOU detail must stay private"), {
        code: "EPERM",
      });
    });
    try {
      const snapshot = await healthModule.getRepoHealthSnapshot("available");
      assert.strictEqual(snapshot.available, false);
      assert.strictEqual(snapshot.score, null);
      assert.doesNotMatch(JSON.stringify(snapshot), /raw TOCTOU detail/);
    } finally {
      setScanner!();
    }
  });

  it("is byte-stable across repeated status calls", async () => {
    const { handleRepoStatus } = await import("../../dist/mcp/tools/repo.js");
    const first = await handleRepoStatus({ repoId: "missing", detail: "minimal" });
    const second = await handleRepoStatus({ repoId: "missing", detail: "minimal" });

    assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
  });
});
