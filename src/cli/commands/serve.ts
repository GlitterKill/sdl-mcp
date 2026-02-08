import { ServeOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import { MCPServer } from "../../server.js";
import { registerTools } from "../../mcp/tools/index.js";
import { watchRepository, IndexWatchHandle } from "../../indexer/indexer.js";
import { setupStdioTransport } from "../transport/stdio.js";
import { setupHttpTransport } from "../transport/http.js";
import { configureLogger } from "../logging.js";
import { resolve } from "path";

export async function serveCommand(options: ServeOptions): Promise<void> {
  const configPath = options.config ?? resolve("./config/sdlmcp.config.json");
  process.env.SDL_CONFIG = configPath;
  const config = loadConfig(configPath);

  configureLogger(options.logLevel ?? "info", options.logFormat ?? "pretty");

  const db = getDb(config.dbPath);
  runMigrations(db);

  const watchers: IndexWatchHandle[] = [];

  if (config.indexing?.enableFileWatching) {
    console.error(
      `Starting file watchers for ${config.repos.length} repo(s)...`,
    );
    for (const repo of config.repos) {
      try {
        watchers.push(watchRepository(repo.repoId));
      } catch (error) {
        console.error(`Failed to start watcher for ${repo.repoId}: ${error}`);
      }
    }
    console.error(`Watching ${watchers.length} repo(s)`);
  }

  const server = new MCPServer();
  registerTools(server);

  let shutdownCalled = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownCalled) {
      return;
    }
    shutdownCalled = true;
    console.error(`\nReceived ${signal}, shutting down gracefully...`);
    await server.stop();
    for (const watcher of watchers) {
      await watcher.close();
    }
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  try {
    if (options.transport === "stdio") {
      console.error("Starting MCP server on stdio transport...");
      await setupStdioTransport(server);
    } else {
      const host = options.host ?? "localhost";
      const port = options.port ?? 3000;
      console.error(`Starting MCP server on http://${host}:${port}...`);
      await setupHttpTransport(server, host, port, config.dbPath);
    }

    await new Promise(() => {});
  } catch (error) {
    console.error(
      `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
