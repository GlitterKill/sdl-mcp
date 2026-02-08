import { IndexOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import {
  indexRepo,
  watchRepository,
  IndexWatchHandle,
  IndexResult,
} from "../../indexer/indexer.js";
import { getRepo, createRepo } from "../../db/queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
import { resolve } from "path";

export async function indexCommand(options: IndexOptions): Promise<void> {
  const configPath = options.config ?? resolve("./config/sdlmcp.config.json");
  process.env.SDL_CONFIG = configPath;
  const config = loadConfig(configPath);

  const db = getDb(config.dbPath);
  runMigrations(db);

  const reposToIndex = options.repoId
    ? config.repos.filter((r) => r.repoId === options.repoId)
    : config.repos;

  if (reposToIndex.length === 0) {
    console.error(
      options.repoId
        ? `Repository not found: ${options.repoId}`
        : "No repositories configured",
    );
    process.exit(1);
  }

  console.log(`Indexing ${reposToIndex.length} repo(s)...`);

  for (const repo of reposToIndex) {
    // Register repo in database if it doesn't exist
    const existingRepo = getRepo(repo.repoId);
    if (!existingRepo) {
      console.log(`Registering repository: ${repo.repoId}`);
      createRepo({
        repo_id: repo.repoId,
        root_path: repo.rootPath,
        config_json: JSON.stringify(repo),
        created_at: getCurrentTimestamp(),
      });
    }

    console.log(`\nIndexing ${repo.repoId} (${repo.rootPath})...`);

    try {
      const stats: IndexResult = await indexRepo(repo.repoId, "full");
      console.log(`  Files: ${stats.filesProcessed}`);
      console.log(`  Symbols: ${stats.symbolsIndexed}`);
      console.log(`  Edges: ${stats.edgesCreated}`);
      console.log(`  Duration: ${stats.durationMs}ms`);
    } catch (error) {
      console.error(
        `  Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }

    if (options.watch) {
      console.log(`  Starting file watcher for ${repo.repoId}...`);
    }
  }

  if (options.watch) {
    console.log("\nWatching for file changes (Ctrl+C to stop)...");

    const watchers: IndexWatchHandle[] = [];
    for (const repo of reposToIndex) {
      try {
        const watcher = watchRepository(repo.repoId);
        watchers.push(watcher);
      } catch (error) {
        console.error(`Failed to start watcher for ${repo.repoId}: ${error}`);
      }
    }

    console.log(`Watching ${watchers.length} repo(s)`);

    let shutdownCalled = false;
    const shutdown = async (): Promise<void> => {
      if (shutdownCalled) {
        return;
      }
      shutdownCalled = true;
      console.log("\nStopping watchers...");
      for (const watcher of watchers) {
        await watcher.close();
      }
      process.exit(0);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    await new Promise(() => {});
  }

  console.log("\n✓ Indexing complete");
}
