import { indexRepo, type IndexProgress, type IndexResult } from "../src/indexer/indexer.js";
import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import type { RepoConfig, AppConfig } from "../src/config/types.js";
import { initGraphDb } from "../src/db/initGraphDb.js";
import { closeLadybugDb, getLadybugConn } from "../src/db/ladybug.js";
import * as ladybugDb from "../src/db/ladybug-queries.js";
import {
  disableDerivedRefreshQueue,
  enableDerivedRefreshQueue,
  shutdownDerivedRefreshQueue,
} from "../src/indexer/derived-refresh-queue.js";
import { getCurrentTimestamp } from "../src/util/time.js";

interface CliArgs {
  repoId: string;
  mode: "full" | "incremental";
  config?: string;
  diagnostics: boolean;
  quietProgress: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: tsx scripts/index-repo.ts <repoId> [--mode full|incremental] [--config path] [--diagnostics] [--quiet-progress]",
    );
    process.exit(1);
  }

  const repoId = args[0];
  let mode: "full" | "incremental" = "full";
  let config: string | undefined;
  const diagnostics = args.includes("--diagnostics");
  const quietProgress = args.includes("--quiet-progress");

  const modeIndex = args.findIndex((arg) => arg === "--mode");
  if (modeIndex !== -1 && modeIndex + 1 < args.length) {
    const modeValue = args[modeIndex + 1];
    if (modeValue !== "full" && modeValue !== "incremental") {
      console.error('Mode must be either "full" or "incremental"');
      process.exit(1);
    }
    mode = modeValue;
  }

  const configIndex = args.findIndex((arg) => arg === "--config");
  if (configIndex !== -1 && configIndex + 1 < args.length) {
    const configValue = args[configIndex + 1];
    if (configValue && !configValue.startsWith("--")) {
      config = configValue;
    }
  }

  return { repoId, mode, config, diagnostics, quietProgress };
}

async function registerRepoIfNotExists(
  repoId: string,
  repoConfig: RepoConfig,
): Promise<void> {
  const conn = await getLadybugConn();
  const existingRepo = await ladybugDb.getRepo(conn, repoId);

  if (!existingRepo) {
    await ladybugDb.upsertRepo(conn, {
      repoId,
      rootPath: repoConfig.rootPath,
      configJson: JSON.stringify(repoConfig),
      createdAt: getCurrentTimestamp(),
    });
    console.log(`Registered repository: ${repoId}`);
  }
}

function logProgress(progress: IndexProgress): void {
  const { stage, current, total, currentFile } = progress;
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

  let message = `[${stage}] ${current}/${total} (${percentage}%)`;
  if (currentFile) {
    message += ` - ${currentFile}`;
  }

  console.log(message);
}

function reportResult(result: IndexResult): void {
  console.log("\n=== Indexing Complete ===");
  console.log(`Version ID: ${result.versionId}`);
  console.log(`Files processed: ${result.filesProcessed}`);
  console.log(`Files changed: ${result.changedFiles}`);
  console.log(`Files removed: ${result.removedFiles}`);
  console.log(`Symbols indexed: ${result.symbolsIndexed}`);
  console.log(`Edges created: ${result.edgesCreated}`);
  console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
  if (result.timings) {
    console.log("\n=== Timing Diagnostics ===");
    for (const [phase, ms] of Object.entries(result.timings.phases).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`${ms.toString().padStart(8)}ms  ${phase}`);
    }
    if (result.timings.pass1Drain) {
      const drain = result.timings.pass1Drain;
      console.log("\n=== Pass 1 Write Drain ===");
      console.log(
        `Batches: ${drain.batches}; rows: ${drain.rows.total}; write wall: ${drain.totalMs}ms`,
      );
      console.log(
        `Rows by kind: files=${drain.rows.files}, symbols=${drain.rows.symbols}, refs=${drain.rows.refs}, edges=${drain.rows.edges}, existingFiles=${drain.rows.existingFiles}`,
      );
      for (const [phase, detail] of Object.entries(drain.phases).sort(
        (a, b) => b[1].totalMs - a[1].totalMs,
      )) {
        console.log(
          `${detail.totalMs.toString().padStart(8)}ms  ${phase} (${detail.rows} row(s), ${detail.count} call(s), max=${detail.maxMs}ms)`,
        );
      }
      if (drain.largestBatch) {
        console.log(
          `Largest batch: ${drain.largestBatch.rows} row(s), ${drain.largestBatch.totalMs}ms`,
        );
      }
    }
  }
}

async function cleanupCliResources(): Promise<void> {
  try {
    await shutdownDerivedRefreshQueue();
    await closeLadybugDb();
  } finally {
    enableDerivedRefreshQueue();
  }
}

async function main(): Promise<void> {
  const {
    repoId,
    mode,
    config: configArg,
    diagnostics,
    quietProgress,
  } = parseArgs(process.argv);
  disableDerivedRefreshQueue();
  const previousSdlConfig = process.env.SDL_CONFIG;

  try {
    console.log("Loading configuration...");
    const resolvedConfigPath = resolveCliConfigPath(configArg, "read");
    process.env.SDL_CONFIG = resolvedConfigPath;
    const config: AppConfig = loadConfig(resolvedConfigPath);

    await initGraphDb(config, resolvedConfigPath);

    const repoConfig = config.repos.find((r) => r.repoId === repoId);
    if (!repoConfig) {
      throw new Error(`Repository "${repoId}" not found in configuration`);
    }

    console.log("Checking repository registration...");
    await registerRepoIfNotExists(repoId, repoConfig);

    console.log(`Starting ${mode} index for repository: ${repoId}`);
    const result: IndexResult = await indexRepo(
      repoId,
      mode,
      quietProgress ? undefined : logProgress,
      undefined,
      { includeTimings: diagnostics },
    );

    reportResult(result);
  } finally {
    if (previousSdlConfig === undefined) {
      delete process.env.SDL_CONFIG;
    } else {
      process.env.SDL_CONFIG = previousSdlConfig;
    }
    await cleanupCliResources();
  }
  process.exit(0);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Error during indexing: ${msg}`);
  process.exit(1);
});
