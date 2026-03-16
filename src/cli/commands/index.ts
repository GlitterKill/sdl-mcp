import { IndexOptions } from "../types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  indexRepo,
  watchRepository,
  IndexWatchHandle,
  IndexResult,
} from "../../indexer/indexer.js";
import { initGraphDb, resolveGraphDbPath } from "../../db/initGraphDb.js";
import { getLadybugConn, withWriteConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { getCurrentTimestamp } from "../../util/time.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { findExistingProcess, type PidfileData } from "../../util/pidfile.js";
import { connectSSE, type SSEEvent } from "../../util/sse-client.js";

/**
 * Delegate indexing for a single repo to the running HTTP server via SSE.
 * Returns true if delegation succeeded, false if it failed (caller should
 * fall back to direct indexing).
 */
async function delegateIndexToServer(
  server: PidfileData,
  repoId: string,
  mode: "full" | "incremental",
): Promise<boolean> {
  console.log(
    `  Delegating to running server (PID ${server.pid}, port ${server.port})...`,
  );

  let lastProgressLine = "";
  let completed = false;

  try {
    await connectSSE({
      host: "localhost",
      port: server.port!,
      path: `/api/repo/${encodeURIComponent(repoId)}/reindex-stream`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode }),
      onEvent: (evt: SSEEvent) => {
        if (evt.event === "progress") {
          const p = JSON.parse(evt.data) as {
            stage: string;
            current: number;
            total: number;
            currentFile?: string;
          };
          if (p.stage === "pass1" || p.stage === "pass2") {
            const line = `  ${p.stage}: ${p.current}/${p.total}${p.currentFile ? ` ${p.currentFile}` : ""}`;
            if (line !== lastProgressLine) {
              console.log(line);
              lastProgressLine = line;
            }
          }
        } else if (evt.event === "complete") {
          const c = JSON.parse(evt.data) as {
            filesProcessed: number;
            symbolsIndexed: number;
            totalSymbols: number;
            edgesCreated: number;
            totalEdges: number;
            durationMs: number;
            summaryStats?: {
              generated: number;
              totalCostUsd: number;
              skipped: number;
              failed: number;
            } | null;
          };
          console.log(`  Files: ${c.filesProcessed}`);
          console.log(
            `  Symbols: ${c.symbolsIndexed} new (${c.totalSymbols} total)`,
          );
          console.log(
            `  Edges: ${c.edgesCreated} new (${c.totalEdges} total)`,
          );
          console.log(`  Duration: ${c.durationMs}ms`);
          if (c.summaryStats) {
            const s = c.summaryStats;
            console.log(
              `  Summaries: ${s.generated} new ($${s.totalCostUsd.toFixed(4)}), ${s.skipped} cached, ${s.failed} failed`,
            );
          }
          completed = true;
        } else if (evt.event === "error") {
          const e = JSON.parse(evt.data) as { message: string };
          console.error(`  Error from server: ${e.message}`);
        }
      },
    });

    return completed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to delegate to server: ${msg}`);
    return false;
  }
}

export async function indexCommand(options: IndexOptions): Promise<void> {
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  // Check if an HTTP server is already running on this database.
  const graphDbPath = resolveGraphDbPath(config, configPath);
  const existing = findExistingProcess(graphDbPath);

  const canDelegate =
    existing &&
    existing.transport === "http" &&
    existing.port != null &&
    existing.authToken != null;

  if (canDelegate) {
    console.log(
      `Detected running SDL-MCP HTTP server (PID ${existing.pid}, port ${existing.port}).`,
    );
    console.log("Delegating indexing to the running server.\n");

    if (options.watch) {
      console.log(
        "Note: --watch flag is ignored when delegating to a running server " +
          "(the server manages its own file watchers).\n",
      );
    }
  }

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

  // If we cannot delegate, initialize the DB for direct indexing.
  // Track initialization state for lazy init on delegation fallback.
  let dbInitialized = false;
  if (!canDelegate) {
    await initGraphDb(config, configPath);
    dbInitialized = true;
  }

  console.log(`Indexing ${reposToIndex.length} repo(s)...`);

  for (const repo of reposToIndex) {
    const mode = options.force ? "full" : "incremental";
    console.log(
      `\nIndexing ${repo.repoId} (${repo.rootPath}) [mode=${mode}]...`,
    );

    // Try delegating to the running server first.
    if (canDelegate) {
      const ok = await delegateIndexToServer(existing, repo.repoId, mode);
      if (ok) {
        continue;
      }
      // Delegation failed — fall back to direct indexing.
      console.log("  Falling back to direct indexing...");
      if (!dbInitialized) {
        await initGraphDb(config, configPath);
        dbInitialized = true;
      }
    }

    // Direct indexing path (original behavior).
    const conn = await getLadybugConn();

    const existingRepo = await ladybugDb.getRepo(conn, repo.repoId);
    if (!existingRepo) {
      console.log(`  Registering repository: ${repo.repoId}`);
    }

    await withWriteConn(async (wConn) => {
      await ladybugDb.upsertRepo(wConn, {
        repoId: repo.repoId,
        rootPath: repo.rootPath,
        configJson: JSON.stringify(repo),
        createdAt: existingRepo?.createdAt ?? getCurrentTimestamp(),
      });
    });

    const directMode =
      options.force || !existingRepo ? "full" : "incremental";

    try {
      let lastProgressLine = "";
      const stats: IndexResult = await indexRepo(
        repo.repoId,
        directMode,
        (progress) => {
          if (progress.stage !== "pass1" && progress.stage !== "pass2") {
            return;
          }
          const line = `  ${progress.stage}: ${progress.current}/${progress.total}${progress.currentFile ? ` ${progress.currentFile}` : ""}`;
          if (line !== lastProgressLine) {
            console.log(line);
            lastProgressLine = line;
          }
        },
      );
      const totalSymbols = await ladybugDb.getSymbolCount(conn, repo.repoId);
      const totalEdges = await ladybugDb.getEdgeCount(conn, repo.repoId);
      console.log(`  Files: ${stats.filesProcessed}`);
      console.log(
        `  Symbols: ${stats.symbolsIndexed} new (${totalSymbols} total)`,
      );
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

  if (options.watch && !canDelegate) {
    console.log("\nWatching for file changes (Ctrl+C to stop)...");

    const watchers: IndexWatchHandle[] = [];
    const results = await Promise.allSettled(
      reposToIndex.map(async (repo) => {
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

