/**
 * MCP tool handler for sdl.response.get.
 *
 * Retrieves reusable response artifacts created by maybeStoreLargeResponse().
 * The handle stays opaque and path-safe; callers can ask for a bounded excerpt
 * by default or opt into full retrieval when they really need the whole payload.
 */

import type { ToolContext } from "../../server.js";
import { getLadybugConn } from "../../db/ladybug.js";
import * as ladybugDb from "../../db/ladybug-queries.js";
import { NotFoundError } from "../../domain/errors.js";
import { parseActionHandlerArgs } from "../../gateway/dispatch-spine.js";
import { RuntimeConfigSchema } from "../../config/types.js";
import { loadConfig } from "../../config/loadConfig.js";
import {
  readResponseArtifact,
  toPublicResponseArtifactMetadata,
} from "../../runtime/response-artifacts.js";
import { recordTokenSavings } from "../response-compression.js";
import { attachTokenUsage, computeSavings } from "../token-usage.js";
import {
  ResponseGetRequestSchema,
  type ResponseGetResponse,
} from "../tools.js";

async function repoExistsInDb(repoId: string): Promise<boolean> {
  const conn = await getLadybugConn();
  return Boolean(await ladybugDb.getRepo(conn, repoId));
}

let responseRepoExists: (repoId: string) => Promise<boolean> = repoExistsInDb;

export function _setResponseRepoExistsForTesting(
  checker: (repoId: string) => Promise<boolean> = repoExistsInDb,
): void {
  responseRepoExists = checker;
}

export async function handleResponseGet(
  args: unknown,
  context?: ToolContext,
): Promise<ResponseGetResponse> {
  const request = parseActionHandlerArgs(ResponseGetRequestSchema, args);
  const appConfig = loadConfig();
  const runtimeConfig = RuntimeConfigSchema.parse(appConfig.runtime ?? {});

  try {
    // Lifecycle epochs are intentionally process-local. Verify persisted repo
    // ownership as well so a failed artifact cleanup cannot resurrect a handle
    // after the server restarts and its in-memory tombstones are reset.
    if (!(await responseRepoExists(request.repoId))) {
      throw new NotFoundError(`Repository not found: ${request.repoId}`);
    }
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
    const publicMetadata = toPublicResponseArtifactMetadata(metadata);
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
