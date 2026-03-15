import { MCPServer } from "./server.js";
import { ConfigError, DatabaseError } from "./domain/errors.js";
import { loadConfig } from "./config/loadConfig.js";
import { activateCliConfigPath } from "./config/configPath.js";
import { initGraphDb } from "./db/initGraphDb.js";
import { closeLadybugDb } from "./db/ladybug.js";
import { CLEANUP_INTERVAL_MS } from "./config/constants.js";
import {
  configureDefaultLiveIndexCoordinator,
  getDefaultLiveIndexCoordinator,
  getDefaultOverlayStore,
} from "./live-index/coordinator.js";
import {
  DEFAULT_IDLE_CHECKPOINT_INTERVAL_MS,
  DEFAULT_IDLE_CHECKPOINT_QUIET_PERIOD_MS,
  IdleMonitor,
} from "./live-index/idle-monitor.js";
import { ShutdownManager } from "./util/shutdown.js";
import {
  findExistingProcess,
  formatExistingProcessMessage,
  writePidfile,
} from "./util/pidfile.js";
import { enableFileLogging, getLogFilePath } from "./util/logger.js";
import { ensureConfiguredReposRegistered } from "./startup/bootstrap.js";

// Enable file logging by default for the direct MCP entry point so crash
// evidence is always persisted. The SDL_LOG_FILE env var auto-enables in
// logger.ts as well, but this ensures a log file exists even without it.
if (!getLogFilePath()) {
  enableFileLogging();
}

// MCP servers must use stderr for logging - stdout is reserved for JSON-RPC
const log = (msg: string) => process.stderr.write(`[sdl-mcp] ${msg}\n`);

// Catch uncaught errors to see what's crashing the server
process.on("uncaughtException", (error) => {
  process.stderr.write(`[sdl-mcp] UNCAUGHT EXCEPTION: ${error}\n`);
  process.stderr.write(`[sdl-mcp] Stack: ${error.stack}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[sdl-mcp] UNHANDLED REJECTION: ${reason}\n`);
});

async function main(): Promise<void> {
  const server = new MCPServer();
  const watchers: Array<{ close: () => Promise<void> }> = [];
  const shutdownMgr = new ShutdownManager({ log });

  try {
    log("Loading configuration...");
    const resolvedConfigPath = activateCliConfigPath(process.env.SDL_CONFIG);
    const config = loadConfig(resolvedConfigPath);

    const graphDbPath = await initGraphDb(config, resolvedConfigPath);
    log(`Graph database initialized at ${graphDbPath}`);

    // Check for an existing live server process (stale PIDs are auto-cleaned).
    const existing = findExistingProcess(graphDbPath);
    if (existing) {
      log(formatExistingProcessMessage(graphDbPath, existing));
      process.exit(1);
    }

    await ensureConfiguredReposRegistered(config, log);

    // Write PID file for process discovery / reuse.
    const pidfilePath = writePidfile(graphDbPath, "stdio");
    shutdownMgr.setPidfilePath(pidfilePath);
    log(`PID file written: ${pidfilePath}`);

    // Dynamic imports AFTER migrations - these modules prepare SQL statements
    log("Registering MCP tools...");
    const { registerTools } = await import("./mcp/tools/index.js");
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

    if (config.indexing?.enableFileWatching) {
      log("Starting file watchers...");
      const { watchRepository } = await import("./indexer/indexer.js");
      const handles = await Promise.all(
        config.repos.map((repo) => watchRepository(repo.repoId)),
      );
      watchers.push(...handles);
      log(`File watchers started for ${watchers.length} repo(s).`);
    }

    log("Starting slice handle cleanup scheduler (interval: 1 hour)...");
    const { cleanupExpiredSliceHandles } = await import("./mcp/tools/slice.js");
    const cleanupInterval = setInterval(() => {
      try {
        void Promise.resolve(cleanupExpiredSliceHandles())
          .then((deleted: number) => {
            if (deleted > 0) {
              log(`Cleaned up ${deleted} expired slice handle(s)`);
            }
          })
          .catch((error: unknown) => {
            process.stderr.write(
              `[sdl-mcp] Slice handle cleanup error: ${error}\n`,
            );
          });
      } catch (error) {
        process.stderr.write(
          `[sdl-mcp] Slice handle cleanup error: ${error}\n`,
        );
      }
    }, CLEANUP_INTERVAL_MS);
    // Do not keep process alive solely because of periodic cleanup timer.
    cleanupInterval.unref();

    // Register cleanup callbacks (run in order during shutdown).
    shutdownMgr.addCleanup("cleanupInterval", () => {
      clearInterval(cleanupInterval);
    });
    shutdownMgr.addCleanup("idleMonitor", () => {
      idleMonitor.stop();
    });
    shutdownMgr.addCleanup("server", () => server.stop());
    shutdownMgr.addCleanup("db", () => closeLadybugDb());
    shutdownMgr.addCleanup("watchers", async () => {
      for (const watcher of watchers) {
        try {
          await watcher.close();
        } catch (error) {
          process.stderr.write(
            `[sdl-mcp] Watcher close error during shutdown: ${error}\n`,
          );
        }
      }
    });

    // Register all shutdown triggers.
    shutdownMgr.registerSignals(); // SIGINT, SIGTERM, SIGHUP
    shutdownMgr.monitorStdin(); // stdin end/close (terminal close detection)

    const activeLogFile = getLogFilePath();
    if (activeLogFile) {
      log(`File logging enabled: ${activeLogFile}`);
    }

    log("Starting MCP server...");
    await server.start();

    log("SDL-MCP server running...");
    await new Promise(() => {});
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`[sdl-mcp] Configuration error: ${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof DatabaseError) {
      process.stderr.write(`[sdl-mcp] Database error: ${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof Error) {
      process.stderr.write(`[sdl-mcp] Fatal error: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`[sdl-mcp] Fatal error: ${String(error)}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`[sdl-mcp] Uncaught error: ${error}\n`);
  process.exit(1);
});
