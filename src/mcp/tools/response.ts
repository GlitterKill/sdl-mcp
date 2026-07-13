/**
 * MCP tool handler for sdl.response.get.
 *
 * Retrieves reusable response artifacts created by maybeStoreLargeResponse().
 * The handle stays opaque and path-safe; callers can ask for a bounded excerpt
 * by default or opt into full retrieval when they really need the whole payload.
 */

import type { ToolContext } from "../../server.js";
import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import { readResponseArtifact } from "../../runtime/response-artifacts.js";
import { recordTokenSavings } from "../response-compression.js";
import { attachTokenUsage, computeSavings } from "../token-usage.js";
import {
  ResponseGetRequestSchema,
  type ResponseGetResponse,
} from "../tools.js";

export async function handleResponseGet(
  args: unknown,
  context?: ToolContext,
): Promise<ResponseGetResponse> {
  const request = parseActionHandlerArgs(ResponseGetRequestSchema, args);
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
      jsonPath: request.jsonPath,
      raw: request.raw,
      offset: request.offset,
      limit: request.limit,
      artifactBaseDir: runtimeConfig.artifactBaseDir,
      maxFullBytes: runtimeConfig.maxArtifactBytes,
      sessionId: context?.sessionId,
    });
    const { savings, metadata, range, ...rest } = response;
    const { estimatedOriginalTokens: _estimatedOriginalTokens, ...publicMetadata } = metadata;
    const { estimatedReturnedTokens: _estimatedReturnedTokens, ...publicRange } = range;
    const publicResponse = {
      ...rest,
      metadata: publicMetadata,
      range: publicRange,
    };
    recordTokenSavings({
      repoId: request.repoId,
      source: "responseArtifact",
      tool: "sdl.response.get",
      estimatedTokensAvoided: savings.savedTokens,
      originalTokens: savings.originalTokens,
      returnedTokens: savings.returnedTokens,
      savedTokens: savings.savedTokens,
      opportunity: true,
      hit: true,
      realized: true,
    });
    return attachTokenUsage(
      publicResponse,
      computeSavings(savings.returnedTokens, savings.originalTokens),
    );
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
