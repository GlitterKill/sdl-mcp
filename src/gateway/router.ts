/**
 * Gateway router — maps `action` strings to existing tool handlers.
 *
 * The gateway envelope is validated at the MCP boundary. This router then
 * prepares and parses the selected action exactly once before invocation.
 */
import type { ToolContext } from "../server.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import {
  GATEWAY_ACTION_DEFINITIONS,
  ACTION_DEFINITION_BY_ACTION,
  type ActionAvailability,
  type ActionDefinition,
} from "../code-mode/action-catalog.js";
import {
  handleSymbolSearch,
  handleSymbolGetCard,
} from "../mcp/tools/symbol.js";
import { handleSymbolEdit } from "../mcp/tools/symbol-edit/index.js";
import {
  handleSliceBuild,
  handleSliceRefresh,
  handleSliceSpilloverGet,
} from "../mcp/tools/slice.js";
import { handleDeltaGet } from "../mcp/tools/delta.js";
import { handlePRRiskAnalysis } from "../mcp/tools/prRisk.js";
import {
  handleCodeNeedWindow,
  handleGetSkeleton,
  handleGetHotPath,
} from "../mcp/tools/code.js";
import {
  handleRepoRegister,
  handleRepoStatus,
  handleRepoUnregister,
  handleRepoOverview,
  handleIndexRefresh,
} from "../mcp/tools/repo.js";
import { handlePolicyGet, handlePolicySet } from "../mcp/tools/policy.js";
import {
  handleBufferPush,
  handleBufferCheckpoint,
  handleBufferStatus,
} from "../mcp/tools/buffer.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "../mcp/tools/agent-feedback.js";
import { handleRuntimeExecute } from "../mcp/tools/runtime.js";
import { handleRuntimeQueryOutput } from "../mcp/tools/runtime-query.js";
import { handleResponseGet } from "../mcp/tools/response.js";
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "../mcp/tools/memory.js";
import { handleUsageStats } from "../mcp/tools/usage.js";
import { handleFileRead } from "../mcp/tools/file-read.js";
import { handleFileWrite } from "../mcp/tools/file-write.js";
import {
  handleSemanticEnrichmentRefresh,
  handleSemanticEnrichmentStatus,
} from "../mcp/tools/semantic-enrichment.js";
import { handleSearchEdit } from "../mcp/tools/search-edit/index.js";
import type { z } from "zod";
import { normalizeToolArguments } from "../mcp/request-normalization.js";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";
import {
  prepareAndParseActionArgs,
  type DispatchSurface,
} from "./dispatch-spine.js";

const MEMORY_ACTIONS = new Set([
  "memory.store",
  "memory.query",
  "memory.remove",
  "memory.surface",
]);

type ActionHandler = (args: unknown, context?: ToolContext) => Promise<unknown>;
export type ActionHandlerMap = Record<string, ActionHandler>;

export interface ActionEntry {
  schema: z.ZodType;
  handler: ActionHandler;
  definition?: ActionDefinition;
}

export type ActionMap = Record<string, ActionEntry>;

/**
 * Maps action name -> { schema, handler } for all gateway tool actions.
 * Some handlers need the liveIndex service — those are patched in via
 * `createActionMap()` at registration time.
 */
export function createActionHandlerMap(
  liveIndex?: LiveIndexCoordinator,
): ActionHandlerMap {
  return {
    "symbol.search": handleSymbolSearch,
    "symbol.getCard": handleSymbolGetCard,
    "symbol.edit": handleSymbolEdit,
    "slice.build": handleSliceBuild,
    "slice.refresh": handleSliceRefresh,
    "slice.spillover.get": handleSliceSpilloverGet,
    "delta.get": handleDeltaGet,
    "pr.risk.analyze": handlePRRiskAnalysis,
    "code.needWindow": handleCodeNeedWindow,
    "code.getSkeleton": handleGetSkeleton,
    "code.getHotPath": handleGetHotPath,
    "repo.register": handleRepoRegister,
    "repo.status": handleRepoStatus,
    "repo.unregister": (args, ctx) =>
      handleRepoUnregister(args, ctx, liveIndex),
    "repo.overview": handleRepoOverview,
    "index.refresh": handleIndexRefresh,
    "policy.get": handlePolicyGet,
    "policy.set": handlePolicySet,
    "usage.stats": handleUsageStats,
    "file.read": handleFileRead,
    "file.write": handleFileWrite,
    "search.edit": handleSearchEdit,
    "semantic.enrichment.refresh": handleSemanticEnrichmentRefresh,
    "semantic.enrichment.status": handleSemanticEnrichmentStatus,
    "agent.feedback": handleAgentFeedback,
    "agent.feedback.query": handleAgentFeedbackQuery,
    "buffer.push": (args, ctx) => handleBufferPush(args, ctx, liveIndex),
    "buffer.checkpoint": (args, ctx) =>
      handleBufferCheckpoint(args, ctx, liveIndex),
    "buffer.status": (args, ctx) => handleBufferStatus(args, ctx, liveIndex),
    "runtime.execute": handleRuntimeExecute,
    "runtime.queryOutput": handleRuntimeQueryOutput,
    "response.get": handleResponseGet,
    "memory.store": handleMemoryStore,
    "memory.query": handleMemoryQuery,
    "memory.remove": handleMemoryRemove,
    "memory.surface": handleMemorySurface,
  };
}

export function createActionMap(
  liveIndex?: LiveIndexCoordinator,
  availability: ActionAvailability = {
    memoryTools: anyRepoHasMemoryTools(loadConfig()),
  },
): ActionMap {
  const handlers = createActionHandlerMap(liveIndex);
  const map: ActionMap = {};

  for (const definition of GATEWAY_ACTION_DEFINITIONS) {
    if (!availability.memoryTools && MEMORY_ACTIONS.has(definition.action)) {
      continue;
    }
    const handler = handlers[definition.action];
    if (!handler) {
      throw new Error(`Missing gateway handler for action: ${definition.action}`);
    }
    map[definition.action] = {
      schema: definition.schema,
      handler,
      definition,
    };
  }

  return map;
}

/**
 * Route a gateway tool call to the appropriate handler.
 *
 * @param rawArgs - The gateway-level args ({ repoId, action, ...actionParams })
 * @param actionMap - The action map from createActionMap()
 * @param ctx - MCP tool context
 * @returns The handler result
 */
function definitionForEntry(
  action: string,
  entry: ActionEntry,
): ActionDefinition {
  return (
    entry.definition ??
    {
      action,
      fn: null,
      toolName: null,
      schema: entry.schema,
      aliases: ACTION_DEFINITION_BY_ACTION[action]?.aliases,
      description: "",
      prerequisites: [],
      recommendedNextActions: [],
      fallbacks: [],
      requiredParams: [],
      rung: null,
      tags: [],
      kind: "gateway",
    }
  );
}

export function prepareActionEntryArgs(
  action: string,
  entry: ActionEntry,
  raw: unknown,
  surface: DispatchSurface,
): unknown {
  return prepareAndParseActionArgs(
    definitionForEntry(action, entry),
    raw,
    surface,
  );
}

export async function dispatchAction(
  action: string,
  raw: unknown,
  actionMap: ActionMap,
  surface: DispatchSurface,
  ctx?: ToolContext,
): Promise<unknown> {
  const entry = actionMap[action];
  if (!entry) throw new Error(`Unknown gateway action: ${action}`);
  const parsed = prepareActionEntryArgs(action, entry, raw, surface);
  return entry.handler(parsed, ctx);
}

export async function routeGatewayCall(
  rawArgs: unknown,
  actionMap: ActionMap,
  ctx?: ToolContext,
  surface: DispatchSurface = { kind: "gateway" },
): Promise<unknown> {
  const normalizedArgs = normalizeToolArguments(rawArgs, ctx?.sessionId);
  if (!normalizedArgs || typeof normalizedArgs !== "object") {
    throw new Error("Gateway args must be a non-null object");
  }
  const args = normalizedArgs as Record<string, unknown>;
  const action = args.action as string;
  const repoId = args.repoId as string | undefined;

  // Build the handler-compatible payload: merge repoId back in, strip action
  const { action: _action, ...rest } = args;
  const merged = repoId !== undefined ? { repoId, ...rest } : rest;

  return dispatchAction(action, merged, actionMap, surface, ctx);
}
