import { importArtifact } from "../../sync/sync.js";
import type { SyncImportOptions } from "../../sync/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { resolve } from "path";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";

interface ImportCommandOptions {
  config?: string;
  artifactPath?: string;
  repoId?: string;
  force?: boolean;
  verify?: boolean;
}

export async function importCommand(
  options: ImportCommandOptions,
): Promise<void> {
  const configPath = options.config ?? resolve("./config/sdlmcp.config.json");
  process.env.SDL_CONFIG = configPath;
  const config = loadConfig(configPath);

  const db = getDb(config.dbPath);
  runMigrations(db);

  const artifactPath = options.artifactPath;
  if (!artifactPath) {
    console.error("Artifact path is required (--artifact-path)");
    process.exit(1);
  }

  const importOptions: SyncImportOptions = {
    artifactPath,
    repoId: options.repoId ?? config.repos[0]?.repoId,
    force: options.force ?? false,
    verifyIntegrity: options.verify ?? true,
  };

  try {
    console.log(`Importing sync artifact from: ${artifactPath}`);
    const result = await importArtifact(importOptions);

    console.log(`\n✓ Import successful`);
    console.log(`  Repository ID: ${result.repoId}`);
    console.log(`  Version ID: ${result.versionId}`);
    console.log(`  Files restored: ${result.filesRestored}`);
    console.log(`  Symbols restored: ${result.symbolsRestored}`);
    console.log(`  Edges restored: ${result.edgesRestored}`);
    console.log(`  Verified: ${result.verified ? "Yes" : "No"}`);
    console.log(`  Duration: ${result.durationMs}ms`);
  } catch (error) {
    console.error(
      `Import failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
