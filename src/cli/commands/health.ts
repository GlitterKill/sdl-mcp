import type { HealthOptions } from "../types.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import { getBadgeColor, getRepoHealthSnapshot } from "../../mcp/health.js";

function resolveRepoId(
  repoId: string | undefined,
  configRepos: Array<{ repoId: string }>,
): string {
  return repoId ?? configRepos[0]?.repoId ?? "";
}

export async function healthCommand(options: HealthOptions): Promise<void> {
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);
  const db = getDb(config.dbPath);
  runMigrations(db);

  const repoId = resolveRepoId(options.repoId, config.repos);
  if (!repoId) {
    console.error("No repository configured");
    process.exit(1);
  }

  const snapshot = await getRepoHealthSnapshot(repoId);

  if (options.badge) {
    const message = snapshot.available ? String(snapshot.score) : "N/A";
    const color = snapshot.available ? getBadgeColor(snapshot.score) : "red";
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          label: "sdl-mcp health",
          message,
          color,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (options.jsonOutput) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  if (!snapshot.available) {
    console.log(`Health Score: N/A (${repoId})`);
    return;
  }

  console.log(`Health Score: ${snapshot.score} (${repoId})`);
  console.log(`  Freshness: ${(snapshot.components.freshness * 100).toFixed(1)}%`);
  console.log(`  Coverage: ${(snapshot.components.coverage * 100).toFixed(1)}%`);
  console.log(`  Error Rate: ${(snapshot.components.errorRate * 100).toFixed(1)}%`);
  console.log(
    `  Edge Quality: ${(snapshot.components.edgeQuality * 100).toFixed(1)}%`,
  );
}

