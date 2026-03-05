import { IndexOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  indexRepo,
  watchRepository,
  IndexWatchHandle,
  IndexResult,
} from "../../indexer/indexer.js";
import { initGraphDb } from "../../db/initGraphDb.js";
import { getKuzuConn } from "../../db/kuzu.js";
import * as kuzuDb from "../../db/kuzu-queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
import { activateCliConfigPath } from "../../config/configPath.js";

export async function indexCommand(options: IndexOptions): Promise<void> {
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  await initGraphDb(config, configPath);
  const conn = await getKuzuConn();

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
    const existingRepo = await kuzuDb.getRepo(conn, repo.repoId);
    if (!existingRepo) {
      console.log(`Registering repository: ${repo.repoId}`);
    }

    // Keep the DB's repo config in sync with the active config file.
    await kuzuDb.upsertRepo(conn, {
      repoId: repo.repoId,
      rootPath: repo.rootPath,
      configJson: JSON.stringify(repo),
      createdAt: existingRepo?.createdAt ?? getCurrentTimestamp(),
    });

    const mode = options.force || !existingRepo ? "full" : "incremental";
    console.log(`\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${mode}]...`);

    try {
      let lastProgressLine = "";
      const stats: IndexResult = await indexRepo(repo.repoId, mode, (progress) => {
        if (progress.stage !== "pass1" && progress.stage !== "pass2") {
          return;
        }
        const line = `  ${progress.stage}: ${progress.current}/${progress.total}${progress.currentFile ? ` ${progress.currentFile}` : ""}`;
        if (line !== lastProgressLine) {
          console.log(line);
          lastProgressLine = line;
        }
      });
      const totalSymbols = await kuzuDb.getSymbolCount(conn, repo.repoId);
      const totalEdges = await kuzuDb.getEdgeCount(conn, repo.repoId);
      console.log(`  Files: ${stats.filesProcessed}`);
      console.log(`  Symbols: ${stats.symbolsIndexed} new (${totalSymbols} total)`);
      console.log(`  Edges: ${stats.edgesCreated} new (${totalEdges} total)`);
      console.log(`  Duration: ${stats.durationMs}ms`);
      if (stats.summaryStats) {
        const s = stats.summaryStats;
        console.log(
          `  Summaries: ${s.generated} new ($${s.totalCostUsd.toFixed(4)}), ${s.skipped} cached, ${s.failed} failed`,
        );
      }
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
    const results = await Promise.allSettled(
      reposToIndex.map(async (repo) => {
        try {
          return { repoId: repo.repoId, handle: await watchRepository(repo.repoId) };
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

    const handleShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
      void shutdown().catch((error) => {
        console.error(
          `Failed to handle ${signal}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      });
    };

    process.once("SIGINT", () => handleShutdown("SIGINT"));
    process.once("SIGTERM", () => handleShutdown("SIGTERM"));

    await new Promise(() => {});
  }

  console.log("\n✓ Indexing complete");
}
