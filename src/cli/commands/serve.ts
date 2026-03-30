import { ServeOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { MCPServer, createMCPServer } from "../../server.js";
import { watchRepository, IndexWatchHandle } from "../../indexer/indexer.js";
import { setupStdioTransport } from "../transport/stdio.js";
import { setupHttpTransport } from "../transport/http.js";
import { configureLogger } from "../logging.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { closeLadybugDb, configurePool } from "../../db/ladybug.js";
import { persistUsageSnapshot } from "../../db/ladybug-usage.js";
import {
  configurePrefetch,
  warmPrefetchOnServeStart,
} from "../../graph/prefetch.js";
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
import {
  findExistingProcess,
  formatExistingProcessMessage,
  writePidfile,
} from "../../util/pidfile.js";
import {
  enableFileLogging,
  getLogFilePath,
  logger,
  shutdownLogger,
} from "../../util/logger.js";
import { configureToolDispatchLimiter } from "../../mcp/dispatch-limiter.js";
import { SessionManager } from "../../mcp/session-manager.js";
import { tokenAccumulator } from "../../mcp/token-accumulator.js";
import { ensureConfiguredReposRegistered } from "../../startup/bootstrap.js";

export async function serveCommand(options: ServeOptions): Promise<void> {
  // Enable file logging by default so crash evidence is always persisted.
  // Placed inside the function body so these side effects only fire when
  // the serve command is actually invoked, not on module import.
  if (!getLogFilePath()) {
    enableFileLogging();
  }

  // Catch uncaught errors — sanitize stderr output, log full details to file, then exit.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[sdl-mcp] Fatal uncaught exception: ${error instanceof Error ? error.message : String(error)}\n`);
    logger.error("Uncaught exception", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`[sdl-mcp] Unhandled rejection: ${message}\n`);
    logger.error("Unhandled rejection", { error: message, stack: reason instanceof Error ? reason.stack : undefined });
  });

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

  const graphDbPath = await initGraphDb(config, configPath);
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

  await ensureConfiguredReposRegistered(config, (message) => {
    console.error(message);
  });

  configurePrefetch({
    enabled: config.prefetch?.enabled ?? true,
    maxBudgetPercent: config.prefetch?.maxBudgetPercent ?? 20,
  });
  if (config.prefetch?.enabled ?? true) {
    for (const repo of config.repos) {
      warmPrefetchOnServeStart(repo.repoId, config.prefetch?.warmTopN ?? 50);
    }
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

  // Determine transport type and write PID file for process discovery.
  // For HTTP transport, the pidfile is written after the server starts so we
  // can record the actual bound port (e.g. when port 0 is requested).
  const transport: "stdio" | "http" =
    options.transport === "stdio" ? "stdio" : "http";
  const httpPort = options.port ?? 3000;
  let pidfilePath: string | undefined;
  if (transport === "stdio") {
    pidfilePath = writePidfile(graphDbPath, transport);
    console.error(`PID file written: ${pidfilePath}`);
  }

  // Set up centralized shutdown manager.
  const shutdownMgr = new ShutdownManager({
    log: (msg) => console.error(`[sdl-mcp] ${msg}`),
  });
  if (pidfilePath) {
    shutdownMgr.setPidfilePath(pidfilePath);
  }

  shutdownMgr.addCleanup("idleMonitor", () => {
    idleMonitor.stop();
  });
  if (stdioServer) {
    shutdownMgr.addCleanup("server", () => stdioServer.stop());
  }
  // Persist token usage BEFORE closing the DB — MCPServer.stop() runs during
  // httpServer cleanup (registered later, executes later), so the DB would
  // already be closed by that point.  Doing it here guarantees availability.
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
      await watcher.close();
    }
  });

  // Register all shutdown triggers.
  shutdownMgr.registerSignals(); // SIGINT, SIGTERM, SIGHUP

  if (options.transport === "stdio") {
    // Monitor stdin so we detect terminal close / MCP client disconnect.
    shutdownMgr.monitorStdin();
  }

  const activeLogFile = getLogFilePath();
  if (activeLogFile) {
    console.error(`[sdl-mcp] File logging enabled: ${activeLogFile}`);
  }

  try {
    if (options.transport === "stdio") {
      console.error("Starting MCP server on stdio transport...");
      await setupStdioTransport(stdioServer!);
      // Stdio transport blocks until the client disconnects
      await new Promise(() => {});
    } else {
      const host = options.host ?? "localhost";
      console.error(`Starting MCP server on http://${host}:${httpPort}...`);
      const httpHandle = await setupHttpTransport(host, httpPort, graphDbPath, {
        liveIndex,
        sessionManager,
        gatewayConfig: config.gateway,
        codeModeConfig: config.codeMode,
      }, config.httpAuth);

      // Now that we know the actual bound port, write the pidfile.
      pidfilePath = writePidfile(graphDbPath, transport, httpHandle.port, httpHandle.authToken ?? undefined);
      console.error(`PID file written: ${pidfilePath}`);
      shutdownMgr.setPidfilePath(pidfilePath);

      // Register HTTP server with shutdown manager for graceful close
      shutdownMgr.addCleanup("httpServer", () => httpHandle.close());

      // Block until the server closes
      await httpHandle.serverClosed;
    }
  } catch (error) {
    console.error(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
