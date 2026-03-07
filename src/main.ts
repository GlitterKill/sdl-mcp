import { MCPServer } from "./server.js";
import { ConfigError, DatabaseError } from "./mcp/errors.js";
import { loadConfig } from "./config/loadConfig.js";
import { activateCliConfigPath } from "./config/configPath.js";
import { initGraphDb } from "./db/initGraphDb.js";
import { closeKuzuDb } from "./db/kuzu.js";
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
  let shutdownCalled = false;

  try {
    log("Loading configuration...");
    const resolvedConfigPath = activateCliConfigPath(process.env.SDL_CONFIG);
    const config = loadConfig(resolvedConfigPath);

    const graphDbPath = await initGraphDb(config, resolvedConfigPath);
    log(`Graph database initialized at ${graphDbPath}`);

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
        const maybePromise = cleanupExpiredSliceHandles() as unknown as
          | number
          | Promise<number>;

        void Promise.resolve(maybePromise)
          .then((deleted) => {
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

    const shutdown = async (signal: string): Promise<void> => {
      if (shutdownCalled) {
        return;
      }
      shutdownCalled = true;

      process.stderr.write(
        `\n[sdl-mcp] Received ${signal}, shutting down gracefully...\n`,
      );
      clearInterval(cleanupInterval);
      idleMonitor.stop();
      await server.stop();
      await closeKuzuDb();
      for (const watcher of watchers) {
        try {
          await watcher.close();
        } catch (error) {
          process.stderr.write(
            `[sdl-mcp] Watcher close error during shutdown: ${error}\n`,
          );
        }
      }
      process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.stdin.once("end", () => void shutdown("stdin-end"));
    process.stdin.once("close", () => void shutdown("stdin-close"));

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
