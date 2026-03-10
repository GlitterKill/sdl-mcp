import { indexRepo, type IndexProgress, type IndexResult } from "../src/indexer/indexer.js";
import { resolveCliConfigPath } from "../src/config/configPath.js";
import { loadConfig } from "../src/config/loadConfig.js";
import type { RepoConfig, AppConfig } from "../src/config/types.js";
import { initGraphDb } from "../src/db/initGraphDb.js";
import { getLadybugConn } from "../src/db/ladybug.js";
import * as ladybugDb from "../src/db/ladybug-queries.js";
import { getCurrentTimestamp } from "../src/util/time.js";

interface CliArgs {
  repoId: string;
  mode: "full" | "incremental";
  config?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: tsx scripts/index-repo.ts <repoId> [--mode full|incremental] [--config path]",
    );
    process.exit(1);
  }

  const repoId = args[0];
  let mode: "full" | "incremental" = "full";
  let config: string | undefined;

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

  return { repoId, mode, config };
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
}

async function main(): Promise<void> {
  const { repoId, mode, config: configArg } = parseArgs(process.argv);

  console.log("Loading configuration...");
  const resolvedConfigPath = resolveCliConfigPath(configArg, "read");
  const config: AppConfig = loadConfig(resolvedConfigPath);

  await initGraphDb(config, resolvedConfigPath);

  const repoConfig = config.repos.find((r) => r.repoId === repoId);
  if (!repoConfig) {
    console.error(`Repository "${repoId}" not found in configuration`);
    process.exit(1);
  }

  console.log("Checking repository registration...");
  await registerRepoIfNotExists(repoId, repoConfig);

  console.log(`Starting ${mode} index for repository: ${repoId}`);
  const result: IndexResult = await indexRepo(repoId, mode, logProgress);

  reportResult(result);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`Error during indexing: ${msg}`);
  process.exit(1);
});

