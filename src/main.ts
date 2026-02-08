import { MCPServer } from "./server.js";
import { ConfigError, DatabaseError } from "./mcp/errors.js";
import { loadConfig } from "./config/loadConfig.js";
import { getDb } from "./db/db.js";
import { runMigrations } from "./db/migrations.js";
import { CLEANUP_INTERVAL_MS } from "./config/constants.js";

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
  let watchers: Array<{ close: () => Promise<void> }> = [];
  let shutdownCalled = false;

  try {
    log("Loading configuration...");
    const configPath = process.env.SDL_CONFIG;
    const config = loadConfig(configPath);

    const dbPath = process.env.SDL_DB_PATH ?? config.dbPath;
    log(`Initializing database connection at ${dbPath}...`);
    const db = getDb(dbPath);

    log("Running database migrations...");
    const migrationResult = runMigrations(db);
    if (migrationResult.applied.length > 0) {
      log(`Applied ${migrationResult.applied.length} migration(s).`);
    } else {
      log("No pending migrations to apply.");
    }

    // Dynamic imports AFTER migrations - these modules prepare SQL statements
    log("Registering MCP tools...");
    const { registerTools } = await import("./mcp/tools/index.js");
    registerTools(server);

    if (config.indexing?.enableFileWatching) {
      log("Starting file watchers...");
      const { watchRepository } = await import("./indexer/indexer.js");
      for (const repo of config.repos) {
        watchers.push(watchRepository(repo.repoId));
      }
      log(`File watchers started for ${watchers.length} repo(s).`);
    }

    log("Starting slice handle cleanup scheduler (interval: 1 hour)...");
    const { cleanupExpiredSliceHandles } = await import("./mcp/tools/slice.js");
    const cleanupInterval = setInterval(() => {
      try {
        const deleted = cleanupExpiredSliceHandles();
        if (deleted > 0) {
          log(`Cleaned up ${deleted} expired slice handle(s)`);
        }
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
      await server.stop();
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
