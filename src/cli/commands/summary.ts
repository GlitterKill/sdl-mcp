import { writeFileSync } from "fs";
import { resolve } from "path";
import type { SummaryOptions } from "../types.js";
import { activateCliConfigPath } from "../../config/configPath.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getDb } from "../../db/db.js";
import { runMigrations } from "../../db/migrations.js";
import {
  detectSummaryScope,
  generateContextSummary,
  renderContextSummary,
} from "../../mcp/summary.js";
import { logSummaryGenerationEvent } from "../../mcp/telemetry.js";
import type { ContextSummaryFormat, ContextSummaryScope } from "../../mcp/types.js";

function resolveRepoId(
  repoId: string | undefined,
  repos: Array<{ repoId: string; rootPath: string }>,
): string {
  if (repoId) {
    return repoId;
  }

  const cwd = resolve(process.cwd()).toLowerCase();
  const fromCwd = repos.find((repo) => {
    const root = resolve(repo.rootPath).toLowerCase();
    return cwd.startsWith(root);
  });
  return fromCwd?.repoId ?? repos[0]?.repoId ?? "";
}

export async function summaryCommand(options: SummaryOptions): Promise<void> {
  const startedAt = Date.now();
  const configPath = activateCliConfigPath(options.config);
  const config = loadConfig(configPath);
  const db = getDb(config.dbPath);
  runMigrations(db);

  const repoId = resolveRepoId(options.repoId, config.repos);
  if (!repoId) {
    console.error("No repository configured");
    process.exit(1);
  }

  const format = (options.format ?? "markdown") as ContextSummaryFormat;
  const scope = (options.scope ??
    detectSummaryScope(options.query)) as ContextSummaryScope;
  const budget = options.budget ?? 2000;

  const summary = generateContextSummary({
    repoId,
    query: options.query,
    budget,
    scope,
  });
  const rendered = renderContextSummary(summary, format);
  logSummaryGenerationEvent({
    repoId,
    query: options.query,
    scope,
    format,
    budget,
    summaryTokens: summary.metadata.summaryTokens,
    truncated: summary.metadata.truncated,
    durationMs: Date.now() - startedAt,
  });

  if (options.output) {
    writeFileSync(options.output, rendered, "utf8");
    console.log(`Summary written: ${options.output}`);
    return;
  }

  process.stdout.write(rendered);
}
