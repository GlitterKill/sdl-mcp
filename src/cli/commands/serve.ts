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
import { enableFileLogging, getLogFilePath } from "../../util/logger.js";
import { configureToolDispatchLimiter } from "../../mcp/dispatch-limiter.js";
import { SessionManager } from "../../mcp/session-manager.js";
import { ensureConfiguredReposRegistered } from "../../startup/bootstrap.js";

// Enable file logging by default so crash evidence is always persisted.
if (!getLogFilePath()) {
  enableFileLogging();
}

// Catch uncaught errors to prevent silent crashes (parity with main.ts)
process.on("uncaughtException", (error) => {
  process.stderr.write(`[sdl-mcp] UNCAUGHT EXCEPTION: ${error}\n`);
  process.stderr.write(`[sdl-mcp] Stack: ${error.stack}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[sdl-mcp] UNHANDLED REJECTION: ${reason}\n`);
});

export async function serveCommand(options: ServeOptions): Promise<void> {
  const configPath = activateCliConfigPath(options.config);
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
  console.error(`Graph database initialized at ${graphDbPath}`);

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

  configureDefaultLiveIndexCoordinator({
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
    stdioServer = createMCPServer({
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
  shutdownMgr.addCleanup("db", () => closeLadybugDb());
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
      });

      // Now that we know the actual bound port, write the pidfile.
      pidfilePath = writePidfile(graphDbPath, transport, httpHandle.port);
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
