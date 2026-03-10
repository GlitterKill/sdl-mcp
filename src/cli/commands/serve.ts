import { ServeOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { MCPServer } from "../../server.js";
import { registerTools } from "../../mcp/tools/index.js";
import { watchRepository, IndexWatchHandle } from "../../indexer/indexer.js";
import { setupStdioTransport } from "../transport/stdio.js";
import { setupHttpTransport } from "../transport/http.js";
import { configureLogger } from "../logging.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { closeLadybugDb, getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
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
import { findExistingProcess, writePidfile } from "../../util/pidfile.js";
import { enableFileLogging, getLogFilePath } from "../../util/logger.js";

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

  const graphDbPath = await initGraphDb(config, configPath);
  console.error(`Graph database initialized at ${graphDbPath}`);

  // Check for an existing live server process (stale PIDs are auto-cleaned).
  const existing = findExistingProcess(graphDbPath);
  if (existing) {
    console.error(
      `Found existing SDL-MCP server (PID ${existing.pid}, ` +
        `transport: ${existing.transport}, started: ${existing.startedAt}). ` +
        `Kill it first or use a different SDL_GRAPH_DB_PATH.`,
    );
    process.exit(1);
  }

  // Auto-register repositories if missing in database
  const conn = await getLadybugConn();
  for (const repo of config.repos) {
    const existingRepo = await ladybugDb.getRepo(conn, repo.repoId);
    if (!existingRepo) {
      console.error(`Registering repository in database: ${repo.repoId}`);
      await ladybugDb.upsertRepo(conn, {
        repoId: repo.repoId,
        rootPath: repo.rootPath,
        configJson: JSON.stringify(repo),
        createdAt: getCurrentTimestamp(),
      });
    }
  }

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

  const server = new MCPServer();
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
  registerTools(server, { liveIndex });

  // Determine transport type and write PID file for process discovery.
  const transport: "stdio" | "http" =
    options.transport === "stdio" ? "stdio" : "http";
  const httpPort = options.port ?? 3000;
  const pidfilePath = writePidfile(
    graphDbPath,
    transport,
    transport === "http" ? httpPort : undefined,
  );
  console.error(`PID file written: ${pidfilePath}`);

  // Set up centralized shutdown manager.
  const shutdownMgr = new ShutdownManager({
    log: (msg) => console.error(`[sdl-mcp] ${msg}`),
  });
  shutdownMgr.setPidfilePath(pidfilePath);

  shutdownMgr.addCleanup("idleMonitor", () => {
    idleMonitor.stop();
  });
  shutdownMgr.addCleanup("server", () => server.stop());
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
      await setupStdioTransport(server);
    } else {
      const host = options.host ?? "localhost";
      console.error(`Starting MCP server on http://${host}:${httpPort}...`);
      await setupHttpTransport(server, host, httpPort, graphDbPath, {
        liveIndex,
      });
    }

    await new Promise(() => {});
  } catch (error) {
    console.error(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
