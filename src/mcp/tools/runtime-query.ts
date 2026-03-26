/**
 * MCP tool handler for sdl.runtime.queryOutput.
 *
 * Retrieves and searches stored runtime output artifacts on demand,
 * enabling a two-phase execute-then-query pattern for token efficiency.
 */

import type { ToolContext } from "../../server.js";
import {
  RuntimeQueryOutputRequestSchema,
  type RuntimeQueryOutputResponse,
} from "../tools.js";
import { queryArtifactContent } from "../../runtime/artifacts.js";
import { loadConfig } from "../../config/loadConfig.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { attachRawContext } from "../token-usage.js";
import { logger } from "../../util/logger.js";

export async function handleRuntimeQueryOutput(
  args: unknown,
  _context?: ToolContext,
): Promise<RuntimeQueryOutputResponse> {
  const request = RuntimeQueryOutputRequestSchema.parse(args);

  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});

  const { excerpts, totalLines, totalBytes, searchedStreams } =
    await queryArtifactContent(request.artifactHandle, request.queryTerms, {
      baseDir: runtimeConfig.artifactBaseDir,
      maxExcerpts: request.maxExcerpts,
      contextLines: request.contextLines,
      stream: request.stream,
    });

  logger.debug("runtime.queryOutput completed", {
    artifactHandle: request.artifactHandle,
    queryTerms: request.queryTerms,
    excerptCount: excerpts.length,
    totalLines,
    totalBytes,
  });

  const response: RuntimeQueryOutputResponse = {
    artifactHandle: request.artifactHandle,
    excerpts,
    totalLines,
    totalBytes,
    searchedStreams,
  };

  // Raw equivalent = what it would cost to read the full artifact
  const rawTokens = Math.ceil(totalBytes / 4);
  return attachRawContext(response, {
    rawTokens,
  });
}
