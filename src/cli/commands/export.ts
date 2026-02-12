import { exportArtifact, listArtifacts } from "../../sync/sync.js";
import type { SyncExportOptions } from "../../sync/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import { activateCliConfigPath } from "../../config/configPath.js";

interface ExportCommandOptions {
  config?: string;
  repoId?: string;
  versionId?: string;
  commitSha?: string;
  branch?: string;
  output?: string;
  list?: boolean;
}

export async function exportCommand(
  options: ExportCommandOptions,
): Promise<void> {
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);

  const db = getDb(config.dbPath);
  runMigrations(db);

  if (options.list) {
    const repoId = options.repoId ?? config.repos[0]?.repoId;
    if (!repoId) {
      console.error("No repository specified or configured");
      process.exit(1);
    }

    const artifacts = await listArtifacts(repoId);
    if (artifacts.length === 0) {
      console.log(`No sync artifacts found for repository: ${repoId}`);
      return;
    }

    console.log(`\nSync artifacts for ${repoId}:\n`);
    for (const artifact of artifacts) {
      console.log(`  Artifact ID: ${artifact.artifact_id}`);
      console.log(`  Version ID: ${artifact.version_id}`);
      console.log(`  Commit SHA: ${artifact.commit_sha ?? "N/A"}`);
      console.log(`  Branch: ${artifact.branch ?? "N/A"}`);
      console.log(`  Created: ${artifact.created_at}`);
      console.log(`  Files: ${artifact.file_count}`);
      console.log(`  Symbols: ${artifact.symbol_count}`);
      console.log(`  Edges: ${artifact.edge_count}`);
      console.log(`  Size: ${(artifact.size_bytes / 1024).toFixed(2)} KB`);
      console.log();
    }
    return;
  }

  const repoId = options.repoId ?? config.repos[0]?.repoId;
  if (!repoId) {
    console.error("No repository specified or configured");
    process.exit(1);
  }

  const exportOptions: SyncExportOptions = {
    repoId,
    versionId: options.versionId,
    commitSha: options.commitSha,
    branch: options.branch,
    outputPath: options.output,
    includeFullState: true,
  };

  try {
    console.log(`Exporting sync artifact for repository: ${repoId}`);
    const result = await exportArtifact(exportOptions);

    console.log(`\n✓ Export successful`);
    console.log(`  Artifact ID: ${result.artifactId}`);
    console.log(`  Artifact path: ${result.artifactPath}`);
    console.log(`  Version ID: ${result.versionId}`);
    console.log(`  Commit SHA: ${result.commitSha ?? "N/A"}`);
    console.log(`  Files: ${result.fileCount}`);
    console.log(`  Symbols: ${result.symbolCount}`);
    console.log(`  Edges: ${result.edgeCount}`);
    console.log(`  Size: ${(result.sizeBytes / 1024).toFixed(2)} KB`);
    console.log(`  Duration: ${result.durationMs}ms`);
  } catch (error) {
    console.error(
      `Export failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
