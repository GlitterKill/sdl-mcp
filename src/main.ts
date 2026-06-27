import { MCPServer } from "./server.js";
import { ConfigError, DatabaseError } from "./domain/errors.js";
import { loadConfig } from "./config/loadConfig.js";
import { activateCliConfigPath } from "./config/configPath.js";
import { initGraphDb, resolveGraphDbPath } from "./db/initGraphDb.js";
import { closeLadybugDb } from "./db/ladybug.js";
import { persistUsageSnapshot } from "./db/ladybug-usage.js";
import { tokenAccumulator } from "./mcp/token-accumulator.js";
import { CLEANUP_INTERVAL_MS, NODE_MIN_MAJOR_VERSION } from "./config/constants.js";
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
  removePidfile,
  writePidfile,
} from "./util/pidfile.js";
import {
  enableFileLogging,
  getLogFilePath,
  shutdownLogger,
} from "./util/logger.js";
import { ensureConfiguredReposRegistered } from "./startup/bootstrap.js";
import { recoverStaleDerivedStateOnStartup } from "./startup/derived-state-recovery.js";
import { startPrefetchPolicy } from "./startup/prefetch-startup.js";
import { loadConfiguredAdapterPlugins } from "./startup/plugins.js";
import { installProcessHandlers } from "./startup/process-handlers.js";
import { safeWriteStderr } from "./util/stdio-safety.js";

import { resetScorerPool } from "./graph/slice/beam-search-engine.js";

// Fail fast with a clear message on unsupported Node.js versions.
const _nodeMajor = parseInt(process.version.slice(1).split(".")[0], 10);
if (_nodeMajor < NODE_MIN_MAJOR_VERSION) {
  safeWriteStderr(
    "[sdl-mcp] Error: sdl-mcp requires Node.js " + NODE_MIN_MAJOR_VERSION + "+, found " + process.version + ".\n" +
    "[sdl-mcp] Please upgrade: https://nodejs.org/\n",
  );
  process.exit(1);
}

// Enable file logging by default for the direct MCP entry point so crash
// evidence is always persisted. The SDL_LOG_FILE env var auto-enables in
// logger.ts as well, but this ensures a log file exists even without it.
if (!getLogFilePath()) {
  enableFileLogging();
}

const log = (msg: string) => safeWriteStderr(`[sdl-mcp] ${msg}\n`);

async function closeDbAfterStartupFailure(): Promise<void> {
  try {
    await closeLadybugDb();
  } catch (error) {
    log(
      `LadybugDB cleanup after startup failure failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main(): Promise<void> {
  const server = new MCPServer();
  const watchers: Array<{ close: () => Promise<void> }> = [];
  let cleanupInterval: NodeJS.Timeout | undefined;
  let watcherStartTimer: NodeJS.Timeout | undefined;
  let idleMonitor: IdleMonitor | undefined;
  const shutdownMgr = new ShutdownManager({ log });
  const uninstallProcessHandlers = installProcessHandlers(shutdownMgr);
  shutdownMgr.addCleanup("processHandlers", uninstallProcessHandlers);
  shutdownMgr.addCleanup("cleanupInterval", () => {
    if (cleanupInterval) clearInterval(cleanupInterval);
  });
  shutdownMgr.addCleanup("watcherStartTimer", () => {
    if (watcherStartTimer) clearTimeout(watcherStartTimer);
  });
  shutdownMgr.addCleanup("idleMonitor", () => {
    idleMonitor?.stop();
  });
  shutdownMgr.addCleanup("server", () => server.stop());
  shutdownMgr.addCleanup("persistUsage", async () => {
    try {
      if (tokenAccumulator.hasUsage) {
        await persistUsageSnapshot(tokenAccumulator.getSnapshot());
      }
    } catch {
      // Non-critical — don't block shutdown.
    }
  });
  shutdownMgr.addCleanup("scorerPool", () => resetScorerPool());
  shutdownMgr.addCleanup("watchers", async () => {
    for (const watcher of watchers) {
      try {
        await watcher.close();
      } catch (error) {
        safeWriteStderr(
          `[sdl-mcp] Watcher close error during shutdown: ${error}\n`,
        );
      }
    }
  });
  shutdownMgr.addCleanup("db", () => closeLadybugDb());
  shutdownMgr.addCleanup("logger", () => shutdownLogger());

  // Hoisted so the catch handler can clean up if startup fails after the pidfile is claimed.
  let pidfilePath: string | undefined;

  try {
    log("Loading configuration...");
    const resolvedConfigPath = activateCliConfigPath(process.env.SDL_CONFIG);
    const config = loadConfig(resolvedConfigPath);

    const graphDbPath = resolveGraphDbPath(config, resolvedConfigPath);

    // Claim the singleton + pidfile BEFORE opening the WAL so two concurrent
    // stdio servers cannot both open the DB and corrupt it (issue #19).
    const existing = findExistingProcess(graphDbPath);
    if (existing) {
      log(formatExistingProcessMessage(graphDbPath, existing));
      process.exit(1);
    }
    pidfilePath = writePidfile(graphDbPath, "stdio");
    shutdownMgr.setPidfilePath(pidfilePath);
    log(`PID file written: ${pidfilePath}`);

    shutdownMgr.registerSignals(); // SIGINT, SIGTERM, SIGHUP
    shutdownMgr.monitorStdin();

    await initGraphDb(config, resolvedConfigPath);
    log(`Graph database initialized at ${graphDbPath}`);

    await loadConfiguredAdapterPlugins(config, resolvedConfigPath, log);
    await ensureConfiguredReposRegistered(config, log);
    await recoverStaleDerivedStateOnStartup(config, log);
    await startPrefetchPolicy(config);

    // Dynamic imports AFTER migrations - these modules prepare SQL statements
    log("Registering MCP tools...");
    const { registerTools } = await import("./mcp/tools/index.js");
    await configureDefaultLiveIndexCoordinator({
      enabled: config.liveIndex?.enabled ?? true,
      debounceMs: config.liveIndex?.debounceMs,
      maxDraftFiles: config.liveIndex?.maxDraftFiles,
    });
    const liveIndex = getDefaultLiveIndexCoordinator();
    idleMonitor = new IdleMonitor({
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
    registerTools(server, { liveIndex }, config.gateway, config.codeMode);

    if (config.indexing?.enableFileWatching) {
      log("Scheduling file watchers after stdio startup...");
      watcherStartTimer = setTimeout(() => {
        void (async () => {
          try {
            log("Starting file watchers...");
            const { watchRepository } = await import("./indexer/indexer.js");
            const results = await Promise.allSettled(
              config.repos.map(async (repo) => {
                try {
                  return {
                    repoId: repo.repoId,
                    handle: await watchRepository(repo.repoId),
                  };
                } catch (error) {
                  const msg =
                    error instanceof Error ? error.message : String(error);
                  throw new Error(`[${repo.repoId}] ${msg}`);
                }
              }),
            );

            for (const result of results) {
              if (result.status === "fulfilled") {
                watchers.push(result.value.handle);
              } else {
                safeWriteStderr(
                  `[sdl-mcp] Failed to start watcher: ${String(
                    result.reason,
                  )}\n`,
                );
              }
            }
            log(`File watchers started for ${watchers.length} repo(s).`);
          } catch (error) {
            safeWriteStderr(
              `[sdl-mcp] File watcher startup error: ${error}\n`,
            );
          }
        })();
      }, 5_000);
      watcherStartTimer.unref();
    }

    log("Starting slice handle cleanup scheduler (interval: 1 hour)...");
    const { cleanupExpiredSliceHandles } = await import("./mcp/tools/slice.js");
    cleanupInterval = setInterval(() => {
      try {
        void Promise.resolve(cleanupExpiredSliceHandles())
          .then((deleted: number) => {
            if (deleted > 0) {
              log(`Cleaned up ${deleted} expired slice handle(s)`);
            }
          })
          .catch((error: unknown) => {
            safeWriteStderr(
              `[sdl-mcp] Slice handle cleanup error: ${error}\n`,
            );
          });
      } catch (error) {
        safeWriteStderr(
          `[sdl-mcp] Slice handle cleanup error: ${error}\n`,
        );
      }
    }, CLEANUP_INTERVAL_MS);
    // Do not keep process alive solely because of periodic cleanup timer.
    cleanupInterval.unref();

    const activeLogFile = getLogFilePath();
    if (activeLogFile) {
      log(`File logging enabled: ${activeLogFile}`);
    }

    log("Starting MCP server...");
    // Detect transport close so the server does not hang as a zombie (C3).
    server.getServer().onclose = () => {
      log("MCP transport closed, initiating shutdown...");
      void shutdownMgr.shutdown("transport closed");
    };

    await server.start();

    log("SDL-MCP server running...");
    await shutdownMgr.shutdownInitiated;
  } catch (error) {
    if (pidfilePath) {
      try { removePidfile(pidfilePath); } catch { /* best-effort */ }
    }
    await closeDbAfterStartupFailure();
    if (error instanceof ConfigError) {
      safeWriteStderr(`[sdl-mcp] Configuration error: ${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof DatabaseError) {
      safeWriteStderr(`[sdl-mcp] Database error: ${error.message}\n`);
      process.exit(1);
    }
    if (error instanceof Error) {
      safeWriteStderr(`[sdl-mcp] Fatal error: ${error.message}\n`);
      process.exit(1);
    }
    safeWriteStderr(`[sdl-mcp] Fatal error: ${String(error)}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  safeWriteStderr(`[sdl-mcp] Uncaught error: ${error}\n`);
  process.exit(1);
});
