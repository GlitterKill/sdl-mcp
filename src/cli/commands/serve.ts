import { ServeOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { resolveSemanticEmbeddingModelPlan } from "../../config/semantic-embedding-model-plan.js";
import { MCPServer, createMCPServer } from "../../server.js";
import { watchRepository, IndexWatchHandle } from "../../indexer/indexer.js";
import { setupStdioTransport } from "../transport/stdio.js";
import {
  setupHttpTransport,
  setupObservabilityDashboardSidecar,
} from "../transport/http.js";
import { configureLogger } from "../logging.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { initGraphDb, resolveGraphDbPath } from "../../db/initGraphDb.js";
import { closeLadybugDb, configurePool } from "../../db/ladybug.js";
import { persistUsageSnapshot } from "../../db/ladybug-usage.js";
import { createWalCheckpointMaintenance } from "../../db/wal-maintenance.js";
import { printBanner } from "../../util/banner.js";
import { startPrefetchPolicy } from "../../startup/prefetch-startup.js";
import {
  configureDefaultLiveIndexCoordinator,
  getDefaultLiveIndexCoordinator,
  getDefaultOverlayStore,
} from "../../live-index/coordinator.js";
import {
  DEFAULT_IDLE_CHECKPOINT_INTERVAL_MS,
  DEFAULT_IDLE_CHECKPOINT_QUIET_PERIOD_MS,
  IdleMonitor,
} from "../../live-index/idle-monitor.js";
import { ShutdownManager } from "../../util/shutdown.js";
import { installProcessHandlers } from "../../startup/process-handlers.js";
import {
  findExistingProcess,
  formatExistingProcessMessage,
  removePidfile,
  writePidfile,
} from "../../util/pidfile.js";
import {
  enableFileLogging,
  getLogFilePath,
  logger,
  shutdownLogger,
} from "../../util/logger.js";
import { configureToolDispatchLimiter } from "../../mcp/dispatch-limiter.js";
import { isIndexingActive } from "../../mcp/indexing-gate.js";
import { SessionManager } from "../../mcp/session-manager.js";
import { tokenAccumulator } from "../../mcp/token-accumulator.js";
import { ensureConfiguredReposRegistered } from "../../startup/bootstrap.js";
import { recoverStaleDerivedStateOnStartup } from "../../startup/derived-state-recovery.js";
import { loadConfiguredAdapterPlugins } from "../../startup/plugins.js";
import { detectCpuProfile } from "../../util/cpu-detect.js";
import {
  BeamExplainStore,
  createObservabilityService,
  installObservabilityTap,
  setBeamExplainStore,
  startRuntimeProbes,
  stopRuntimeProbes,
} from "../../observability/index.js";
import type { ObservabilityService } from "../../observability/index.js";

export async function serveCommand(options: ServeOptions): Promise<void> {
  if (options.transport === "http" && options.dashboardPort !== undefined) {
    throw new Error("--dashboard-port can only be used with --stdio");
  }

  // Show banner for HTTP transport only (stdio needs clean output for MCP protocol)
  if (options.transport !== "stdio") {
    printBanner();
  }

  // Enable file logging by default so crash evidence is always persisted.
  // Placed inside the function body so these side effects only fire when
  // the serve command is actually invoked, not on module import.
  if (!getLogFilePath()) {
    enableFileLogging();
  }



  const configPath = activateCliConfigPath(options.config);
  const configSource = options.config
    ? "--config flag"
    : process.env.SDL_CONFIG
      ? "SDL_CONFIG"
      : process.env.SDL_CONFIG_PATH
        ? "SDL_CONFIG_PATH"
        : "auto-discovery";
  console.error(`[sdl-mcp] Config: ${configPath} (${configSource})`);
  const config = loadConfig(configPath);

  configureLogger(options.logLevel ?? "info", options.logFormat ?? "pretty");

  // Log detected CPU tier for observability.
  const cpuProfile = detectCpuProfile();
  const effectiveTier =
    config.performanceTier === "auto"
      ? cpuProfile.detectedTier
      : config.performanceTier;
  console.error(
    `[sdl-mcp] CPU tier: ${effectiveTier} (${cpuProfile.logicalCores} logical cores` +
      (cpuProfile.physicalCores
        ? `, ~${cpuProfile.physicalCores} physical`
        : "") +
      `) — indexing.concurrency=${config.indexing?.concurrency ?? "default"}, maxToolConcurrency=${config.concurrency?.maxToolConcurrency ?? "default"}`,
  );

  // Surface diagnostic modes so operators know what a "silent crash"
  // repro environment looks like. These envs are the standard isolation
  // levers when investigating native-layer aborts.
  if (process.env.SDL_MCP_DISABLE_NATIVE_ADDON) {
    console.error(
      "[sdl-mcp] SDL_MCP_DISABLE_NATIVE_ADDON is set — Rust indexer & SCIP native decoder disabled (TS fallback active). Use this to isolate native-addon crashes.",
    );
  }
  if (process.execArgv.some((a) => a.includes("abort-on-uncaught-exception"))) {
    console.error(
      "[sdl-mcp] Node started with --abort-on-uncaught-exception — uncaught errors will produce a core dump (set NODE_OPTIONS=--abort-on-uncaught-exception or pass the flag on the shebang line to enable).",
    );
  }

  // Wire concurrency configuration from config file
  const concurrency = config.concurrency;
  if (concurrency) {
    if (
      concurrency.readPoolSize != null ||
      concurrency.writeQueueTimeoutMs != null
    ) {
      configurePool({
        readPoolSize: concurrency.readPoolSize,
        writeQueueTimeoutMs: concurrency.writeQueueTimeoutMs,
      });
    }
    if (
      concurrency.maxToolConcurrency != null ||
      concurrency.toolQueueTimeoutMs != null
    ) {
      configureToolDispatchLimiter({
        maxConcurrency: concurrency.maxToolConcurrency,
        queueTimeoutMs: concurrency.toolQueueTimeoutMs,
      });
    }
  }

  const graphDbPath = resolveGraphDbPath(config, configPath);
  const graphDbSource = process.env.SDL_GRAPH_DB_DIR
    ? "SDL_GRAPH_DB_DIR"
    : process.env.SDL_GRAPH_DB_PATH
      ? "SDL_GRAPH_DB_PATH"
      : process.env.SDL_DB_PATH
        ? "SDL_DB_PATH (deprecated)"
        : config.graphDatabase?.path
          ? "config"
          : "default (beside config)";
  console.error(`[sdl-mcp] Graph DB: ${graphDbPath} (${graphDbSource})`);

  // Check for an existing live server process (stale PIDs are auto-cleaned).
  const existing = findExistingProcess(graphDbPath);
  if (existing) {
    console.error(formatExistingProcessMessage(graphDbPath, existing));
    process.exit(1);
  }

  // Claim the singleton + pidfile BEFORE opening the WAL so two concurrent
  // stdio servers cannot both open the DB and corrupt it (issue #19).
  // HTTP transport re-writes the pidfile after listen() with the bound port.
  const transport: "stdio" | "http" =
    options.transport === "stdio" ? "stdio" : "http";
  let pidfilePath: string | undefined = writePidfile(graphDbPath, transport);
  console.error(`PID file written: ${pidfilePath}`);

  await initGraphDb(config, configPath);

  await loadConfiguredAdapterPlugins(config, configPath, (message) => {
    console.error(message);
  });

  await ensureConfiguredReposRegistered(config, (message) => {
    console.error(message);
  });

  await recoverStaleDerivedStateOnStartup(config, (message) => {
    console.error(message);
  });

  await startPrefetchPolicy(config);

  // Pre-warm the local embeddings ONNX session if semantic search is on.
  // First semantic call paid ~2.7s for session creation; subsequent calls
  // were sub-300ms. Fire-and-forget so serve startup is unaffected.
  if (config.semantic?.provider === "local") {
    queueMicrotask(async () => {
      try {
        const { getEmbeddingProvider } =
          await import("../../indexer/embeddings.js");
        const modelPlan = resolveSemanticEmbeddingModelPlan(config.semantic);
        const warmupModels = [
          ...new Set([
            ...modelPlan.symbolEmbeddingModels,
            ...modelPlan.fileSummaryEmbeddingModels,
          ]),
        ];
        if (warmupModels.length === 0) {
          return;
        }
        for (const model of warmupModels) {
          const provider = getEmbeddingProvider("local", model);
          await provider.embed(["sdl-mcp warmup"]);
        }
        logger.debug("[serve] embeddings sessions pre-warmed", {
          models: warmupModels,
        });
      } catch (err) {
        logger.debug("[serve] embeddings warmup skipped", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  const watchers: IndexWatchHandle[] = [];

  if (config.indexing?.enableFileWatching && !options.noWatch) {
    console.error(
      `Starting file watchers for ${config.repos.length} repo(s)...`,
    );
    const results = await Promise.allSettled(
      config.repos.map(async (repo) => {
        try {
          return {
            repoId: repo.repoId,
            handle: await watchRepository(repo.repoId),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(`[${repo.repoId}] ${msg}`);
        }
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        watchers.push(result.value.handle);
      } else {
        console.error(`Failed to start watcher: ${String(result.reason)}`);
      }
    }
    console.error(`Watching ${watchers.length} repo(s)`);
  } else if (config.indexing?.enableFileWatching && options.noWatch) {
    console.error("File watching disabled by --no-watch");
  }

  await configureDefaultLiveIndexCoordinator({
    enabled: config.liveIndex?.enabled ?? true,
    debounceMs: config.liveIndex?.debounceMs,
    maxDraftFiles: config.liveIndex?.maxDraftFiles,
  });
  const liveIndex = getDefaultLiveIndexCoordinator();
  const idleMonitor = new IdleMonitor({
    overlayStore: getDefaultOverlayStore(),
    checkpointRepo: (request) => liveIndex.checkpointRepo(request),
    intervalMs: DEFAULT_IDLE_CHECKPOINT_INTERVAL_MS,
    quietPeriodMs:
      config.liveIndex?.idleCheckpointMs ??
      DEFAULT_IDLE_CHECKPOINT_QUIET_PERIOD_MS,
  });
  if (config.liveIndex?.enabled ?? true) {
    idleMonitor.start();
  }
  const walMaintenance = createWalCheckpointMaintenance({
    graphDbPath,
    isIndexingActive,
  });
  walMaintenance.start();

  // For stdio: create a single MCPServer (only one client possible).
  // For HTTP: the transport creates per-session servers via createMCPServer().
  let stdioServer: MCPServer | undefined;
  if (options.transport === "stdio") {
    stdioServer = await createMCPServer({
      liveIndex,
      gatewayConfig: config.gateway,
      codeModeConfig: config.codeMode,
    });
  }

  // Create session manager for HTTP transport
  const sessionManager = new SessionManager(concurrency?.maxSessions ?? 8);

  // Wire observability service + beam-explain store before HTTP transport
  // so the dashboard routes (and the global tap) see live data.
  const observabilityConfig = config.observability ?? {
    enabled: true,
    sampleIntervalMs: 2000,
    retentionShortMinutes: 15,
    retentionLongHours: 24,
    pprMetricsEnabled: true,
    packedStatsEnabled: true,
    scipIngestMetrics: true,
    beamExplainCapacity: 128,
    beamExplainEntriesPerSlice: 512,
    sseHeartbeatMs: 15000,
    sseMaxStreamMs: 3_600_000,
  };
  let observabilityService: ObservabilityService | null = null;
  let beamExplainStore: BeamExplainStore | null = null;
  if (observabilityConfig.enabled) {
    observabilityService = createObservabilityService(observabilityConfig);
    observabilityService.start();
    installObservabilityTap(observabilityService);
    startRuntimeProbes(observabilityConfig);
    beamExplainStore = new BeamExplainStore({
      capacity: observabilityConfig.beamExplainCapacity,
      maxEntriesPerSlice: observabilityConfig.beamExplainEntriesPerSlice,
    });
    setBeamExplainStore(beamExplainStore);
    observabilityService.setBeamExplainStore(beamExplainStore);
  }

  const httpPort = options.port ?? 3000;

  // Set up centralized shutdown manager.
  const shutdownMgr = new ShutdownManager({
    log: (msg) => console.error(`[sdl-mcp] ${msg}`),
  });
  const uninstallProcessHandlers = installProcessHandlers(shutdownMgr);
  shutdownMgr.addCleanup("processHandlers", uninstallProcessHandlers);
  if (pidfilePath) {
    shutdownMgr.setPidfilePath(pidfilePath);
  }

  shutdownMgr.addCleanup("idleMonitor", () => {
    idleMonitor.stop();
  });
  shutdownMgr.addCleanup("walMaintenance", () => {
    walMaintenance.stop();
  });
  if (observabilityService) {
    shutdownMgr.addCleanup("observability", () => {
      stopRuntimeProbes();
      observabilityService?.stop();
    });
  }
  if (stdioServer) {
    shutdownMgr.addCleanup("server", () => stdioServer.stop());
  }
  // Final cleanups must run after transport-specific server cleanup.
  let finalCleanupsRegistered = false;
  const registerFinalCleanups = (): void => {
    if (finalCleanupsRegistered) return;
    finalCleanupsRegistered = true;

    // Persist token usage while the DB is still open, but after transport
    // cleanup has stopped accepting new HTTP work.
    shutdownMgr.addCleanup("persistUsage", async () => {
      try {
        if (tokenAccumulator.hasUsage) {
          await persistUsageSnapshot(tokenAccumulator.getSnapshot());
        }
      } catch (err) {
        // Non-critical — don't block shutdown
        console.error(
          "[sdl-mcp] Failed to persist usage snapshot: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    });
    shutdownMgr.addCleanup("db", () => closeLadybugDb());
    shutdownMgr.addCleanup("logger", () => shutdownLogger());
    shutdownMgr.addCleanup("watchers", async () => {
      for (const watcher of watchers) {
        try {
          await watcher.close();
        } catch (error) {
          // Don't let a single watcher failure abort cleanup of others
          console.error(
            `[sdl-mcp] Watcher close error during shutdown: ${error}`,
          );
        }
      }
    });
  };

  if (options.transport === "stdio") {
    registerFinalCleanups();
  }

  // Register all shutdown triggers.
  shutdownMgr.registerSignals(); // SIGINT, SIGTERM, SIGHUP

  if (options.transport === "stdio") {
    shutdownMgr.monitorStdin();
  }

  const activeLogFile = getLogFilePath();
  if (activeLogFile) {
    console.error(`[sdl-mcp] File logging enabled: ${activeLogFile}`);
  }

  if (stdioServer) {
    // Mirror the direct entrypoint so stdio client disconnects flow through
    // the centralized shutdown path before Node can exit on its own.
    stdioServer.getServer().onclose = () => {
      console.error("[sdl-mcp] MCP transport closed, initiating shutdown...");
      void shutdownMgr.shutdown("transport closed");
    };
  }

  try {
    if (options.transport === "stdio") {

      if (options.dashboardPort !== undefined) {
        const dashboardHandle = await setupObservabilityDashboardSidecar(
          options.dashboardPort,
          {
            observabilityService,
            beamExplainStore,
            observabilitySseHeartbeatMs: observabilityConfig.sseHeartbeatMs,
            observabilitySseMaxStreamMs: observabilityConfig.sseMaxStreamMs,
          },
          config.httpAuth,
        );

        pidfilePath = writePidfile(
          graphDbPath,
          transport,
          dashboardHandle.port,
          dashboardHandle.authToken ?? undefined,
        );
        console.error(`PID file written: ${pidfilePath}`);
        shutdownMgr.setPidfilePath(pidfilePath);
        shutdownMgr.addCleanup("observabilityDashboard", () =>
          dashboardHandle.close(),
        );
        console.error(
          `[sdl-mcp] Observability dashboard: http://127.0.0.1:${dashboardHandle.port}/ui/observability`,
        );
      }

      console.error("Starting MCP server on stdio transport...");
      await setupStdioTransport(stdioServer!);
      // Wait for shutdown signal (triggered by transport close or signal handlers)
      await shutdownMgr.shutdownInitiated;
    } else {
      const host = options.host ?? "localhost";
      console.error(`Starting MCP server on http://${host}:${httpPort}...`);
      const httpHandle = await setupHttpTransport(
        host,
        httpPort,
        graphDbPath,
        {
          liveIndex,
          sessionManager,
          gatewayConfig: config.gateway,
          codeModeConfig: config.codeMode,
          observabilityService,
          beamExplainStore,
          observabilitySseHeartbeatMs: observabilityConfig.sseHeartbeatMs,
          observabilitySseMaxStreamMs: observabilityConfig.sseMaxStreamMs,
        },
        config.httpAuth,
        config.http,
      );

      // Now that we know the actual bound port, write the pidfile.
      pidfilePath = writePidfile(
        graphDbPath,
        transport,
        httpHandle.port,
        httpHandle.authToken ?? undefined,
      );
      console.error(`PID file written: ${pidfilePath}`);
      shutdownMgr.setPidfilePath(pidfilePath);

      // Register HTTP server with shutdown manager for graceful close
      shutdownMgr.addCleanup("httpServer", () => httpHandle.close());
      registerFinalCleanups();

      // Block until the server closes
      await httpHandle.serverClosed;
    }
  } catch (error) {
    if (pidfilePath) {
      try {
        removePidfile(pidfilePath);
      } catch {
        /* best-effort */
      }
    }
    console.error(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
