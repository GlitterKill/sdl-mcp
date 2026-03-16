import type { MCPServer, ToolContext } from "../server.js";
import type { CodeModeConfig } from "../config/types.js";
import type { ToolServices } from "../gateway/index.js";
import { createActionMap, type ActionMap } from "../gateway/router.js";
import { getManualCached } from "./manual-generator.js";
import { parseChainRequest } from "./chain-parser.js";
import { executeChain } from "./chain-executor.js";
import { ChainRequestSchema } from "./types.js";
import { MANUAL_DESCRIPTION, CHAIN_DESCRIPTION } from "./descriptions.js";
import { estimateTokens } from "../util/tokenize.js";
import { z } from "zod";

/**
 * Register Code Mode tools (sdl.manual + sdl.chain) on the MCP server.
 *
 * @param prebuiltActionMap Optional pre-built action map to avoid duplicate creation
 *   when code-mode is registered alongside gateway.
 */
export function registerCodeModeTools(
  server: MCPServer,
  services: ToolServices,
  config: CodeModeConfig,
  prebuiltActionMap?: ActionMap,
): void {
  const actionMap = prebuiltActionMap ?? createActionMap(services.liveIndex);

  // sdl.manual — returns the compact TypeScript API reference
  server.registerTool(
    "sdl.manual",
    MANUAL_DESCRIPTION,
    z.object({
      format: z.enum(["typescript"]).default("typescript").optional(),
    }),
    async () => {
      const manual = getManualCached(services.liveIndex);
      return { manual, tokenEstimate: estimateTokens(manual) };
    },
    // thin wire schema
    { type: "object", properties: {}, additionalProperties: false },
  );

  // sdl.chain — execute a chain of operations in a single round-trip
  server.registerTool(
    "sdl.chain",
    CHAIN_DESCRIPTION,
    ChainRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) => {
      const parsed = parseChainRequest(rawArgs);
      if (!parsed.ok) {
        return { error: "CHAIN_VALIDATION_ERROR", details: parsed.errors };
      }
      return executeChain(parsed.request, actionMap, config, context);
    },
    // thin wire schema — minimal envelope
    {
      type: "object",
      properties: {
        repoId: { type: "string", minLength: 1 },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fn: { type: "string" },
              args: { type: "object" },
            },
            required: ["fn"],
          },
          minItems: 1,
        },
        budget: { type: "object" },
        onError: { type: "string", enum: ["continue", "stop"] },
      },
      required: ["repoId", "steps"],
      additionalProperties: false,
    },
  );
}
