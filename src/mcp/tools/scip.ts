/**
 * MCP tool handler for sdl.scip.ingest — delegates to the SCIP ingestion pipeline.
 */

import type { ToolContext } from "../../server.js";
import { ingestScipIndex } from "../../scip/ingestion.js";
import { ScipIngestRequestSchema } from "../tools.js";
import { loadConfig } from "../../config/loadConfig.js";
import type { ScipConfig } from "../../config/types.js";
import { ConfigError } from "../../domain/errors.js";
import { logger } from "../../util/logger.js";

/**
 * Handle `sdl.scip.ingest` — ingest a pre-built SCIP index file to overlay
 * compiler-grade cross-references onto the symbol graph.
 */
export async function handleScipIngest(
  args: unknown,
  _context?: ToolContext,
): Promise<object> {
  const request = ScipIngestRequestSchema.parse(args);
  const { repoId, indexPath, dryRun } = request;

  const config = loadConfig();
  const scipConfig: ScipConfig = config.scip ?? {
    enabled: false,
    indexes: [],
    externalSymbols: { enabled: true, maxPerIndex: 10_000 },
    confidence: 0.95,
    autoIngestOnRefresh: true,
    ingestConcurrency: 1,
    generator: {
      enabled: false,
      binary: "scip-io",
      args: [],
      autoInstall: true,
      timeoutMs: 10 * 60 * 1000,
      cleanupAfterIngest: true,
    },
  };

  if (!scipConfig.enabled) {
    throw new ConfigError(
      "SCIP ingestion is disabled. Set scip.enabled = true in your sdlmcp.config.json.",
    );
  }

  logger.info("SCIP ingest requested via MCP tool", {
    repoId,
    indexPath,
    dryRun: dryRun ?? false,
  });

  const result = await ingestScipIndex(
    {
      repoId,
      indexPath,
      dryRun: dryRun ?? false,
    },
    scipConfig,
  );

  return result;
}
