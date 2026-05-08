/**
 * MCP tool handler for sdl.response.get.
 *
 * Retrieves reusable response artifacts created by maybeStoreLargeResponse().
 * The handle stays opaque and path-safe; callers can ask for a bounded excerpt
 * by default or opt into full retrieval when they really need the whole payload.
 */

import type { ToolContext } from "../../server.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { readResponseArtifact } from "../../runtime/response-artifacts.js";
import { recordTokenSavings } from "../response-compression.js";
import {
  ResponseGetRequestSchema,
  type ResponseGetResponse,
} from "../tools.js";

export async function handleResponseGet(
  args: unknown,
  context?: ToolContext,
): Promise<ResponseGetResponse> {
  const request = ResponseGetRequestSchema.parse(args);
  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});

  try {
    const response = await readResponseArtifact({
      repoId: request.repoId,
      handle: request.handle,
      full: request.full,
      maxBytes: request.maxBytes,
      maxTokens: request.maxTokens,
      offsetBytes: request.offsetBytes,
      artifactBaseDir: runtimeConfig.artifactBaseDir,
      maxFullBytes: runtimeConfig.maxArtifactBytes,
      sessionId: context?.sessionId,
    });
    recordTokenSavings({
      repoId: request.repoId,
      source: "responseArtifact",
      tool: "sdl.response.get",
      estimatedTokensAvoided: response.savings.savedTokens,
      opportunity: true,
      hit: true,
      realized: true,
    });
    return response;
  } catch (error) {
    recordTokenSavings({
      repoId: request.repoId,
      source: "responseArtifact",
      tool: "sdl.response.get",
      estimatedTokensAvoided: 0,
      opportunity: true,
      hit: false,
      realized: false,
    });
    throw error;
  }
}
