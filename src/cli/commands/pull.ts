import { pullWithFallback } from "../../sync/pull.js";
import type { SyncPullOptions } from "../../sync/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { resolve } from "path";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";

interface PullCommandOptions {
  config?: string;
  repoId?: string;
  versionId?: string;
  commitSha?: string;
  fallback?: boolean;
  retries?: number;
}

export async function pullCommand(options: PullCommandOptions): Promise<void> {
  const configPath = options.config ?? resolve("./config/sdlmcp.config.json");
  process.env.SDL_CONFIG = configPath;
  const config = loadConfig(configPath);

  const db = getDb(config.dbPath);
  runMigrations(db);

  const repoId = options.repoId ?? config.repos[0]?.repoId;
  if (!repoId) {
    console.error("No repository specified or configured");
    process.exit(1);
  }

  const pullOptions: SyncPullOptions = {
    repoId,
    targetVersionId: options.versionId,
    commitSha: options.commitSha,
    fallbackToFullIndex: options.fallback ?? true,
    maxRetries: options.retries ?? 3,
  };

  try {
    console.log(`Pulling latest state for repository: ${repoId}`);
    const result = await pullWithFallback(pullOptions);

    if (result.success) {
      console.log(`\n✓ Pull successful`);
      console.log(`  Version ID: ${result.versionId}`);
      console.log(`  Artifact ID: ${result.artifactId ?? "N/A"}`);
      console.log(`  Method: ${result.method}`);
      console.log(`  Retries: ${result.retryCount}`);
      console.log(`  Duration: ${result.durationMs}ms`);
    } else {
      console.error(`\n✗ Pull failed`);
      console.error(`  Error: ${result.error ?? "Unknown error"}`);
      console.error(`  Retries: ${result.retryCount}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(
      `Pull failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
