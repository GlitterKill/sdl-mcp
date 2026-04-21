/**
 * Gateway router — maps `action` strings to existing tool handlers.
 *
 * Performs double validation:
 * 1. Gateway schema (discriminated union) — cheap first-pass
 * 2. Original handler schema — strict second-pass via ACTION_MAP
 *
 * The shared `repoId` is merged back into the action params for handler compatibility.
 */
import type { ToolContext } from "../server.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import {
  SymbolSearchRequestSchema,
  SymbolGetCardRequestSchema,
  SliceBuildRequestSchema,
  SliceRefreshRequestSchema,
  SliceSpilloverGetRequestSchema,
  DeltaGetRequestSchema,
  PRRiskAnalysisRequestSchema,
  CodeNeedWindowRequestSchema,
  GetSkeletonRequestSchema,
  GetHotPathRequestSchema,
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  RepoOverviewRequestSchema,
  IndexRefreshRequestSchema,
  PolicyGetRequestSchema,
  PolicySetRequestSchema,
  BufferPushRequestSchema,
  BufferCheckpointRequestSchema,
  BufferStatusRequestSchema,
  AgentFeedbackRequestSchema,
  AgentFeedbackQueryRequestSchema,
  RuntimeExecuteRequestSchema,
  RuntimeQueryOutputRequestSchema,
  MemoryStoreRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemorySurfaceRequestSchema,
  UsageStatsRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  SearchEditRequestSchema,
  ScipIngestRequestSchema,
} from "../mcp/tools.js";
import {
  handleSymbolSearch,
  handleSymbolGetCard,
} from "../mcp/tools/symbol.js";
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
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "../mcp/tools/memory.js";
import { handleUsageStats } from "../mcp/tools/usage.js";
import { handleFileRead } from "../mcp/tools/file-read.js";
import { handleFileWrite } from "../mcp/tools/file-write.js";
import { handleScipIngest } from "../mcp/tools/scip.js";
import { handleSearchEdit } from "../mcp/tools/search-edit/index.js";
import type { z } from "zod";
import { normalizeToolArguments } from "../mcp/request-normalization.js";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";

const MEMORY_ACTIONS = new Set(["memory.store", "memory.query", "memory.remove", "memory.surface"]);

type ActionHandler = (args: unknown, context?: ToolContext) => Promise<unknown>;

export interface ActionEntry {
  schema: z.ZodType;
  handler: ActionHandler;
}

export type ActionMap = Record<string, ActionEntry>;

/**
 * Maps action name -> { schema, handler } for all gateway tool actions.
 * Some handlers need the liveIndex service — those are patched in via
 * `createActionMap()` at registration time.
 */
export function createActionMap(liveIndex?: LiveIndexCoordinator): ActionMap {
  const map: ActionMap = {
    // === Query actions ===
    "symbol.search": {
      schema: SymbolSearchRequestSchema,
      handler: handleSymbolSearch,
    },
    "symbol.getCard": {
      schema: SymbolGetCardRequestSchema,
      handler: handleSymbolGetCard,
    },
    "slice.build": {
      schema: SliceBuildRequestSchema,
      handler: handleSliceBuild,
    },
    "slice.refresh": {
      schema: SliceRefreshRequestSchema,
      handler: handleSliceRefresh,
    },
    "slice.spillover.get": {
      schema: SliceSpilloverGetRequestSchema,
      handler: handleSliceSpilloverGet,
    },
    "delta.get": {
      schema: DeltaGetRequestSchema,
      handler: handleDeltaGet,
    },
    "pr.risk.analyze": {
      schema: PRRiskAnalysisRequestSchema,
      handler: handlePRRiskAnalysis,
    },

    // === Code actions ===
    "code.needWindow": {
      schema: CodeNeedWindowRequestSchema,
      handler: handleCodeNeedWindow,
    },
    "code.getSkeleton": {
      schema: GetSkeletonRequestSchema,
      handler: handleGetSkeleton,
    },
    "code.getHotPath": {
      schema: GetHotPathRequestSchema,
      handler: handleGetHotPath,
    },

    // === Repo actions ===
    "repo.register": {
      schema: RepoRegisterRequestSchema,
      handler: handleRepoRegister,
    },
    "repo.status": {
      schema: RepoStatusRequestSchema,
      handler: handleRepoStatus,
    },
    "repo.overview": {
      schema: RepoOverviewRequestSchema,
      handler: handleRepoOverview,
    },
    "index.refresh": {
      schema: IndexRefreshRequestSchema,
      handler: handleIndexRefresh,
    },
    "policy.get": {
      schema: PolicyGetRequestSchema,
      handler: handlePolicyGet,
    },
    "policy.set": {
      schema: PolicySetRequestSchema,
      handler: handlePolicySet,
    },
    "usage.stats": {
      schema: UsageStatsRequestSchema,
      handler: handleUsageStats,
    },
    "file.read": {
      schema: FileReadRequestSchema,
      handler: handleFileRead,
    },
    "file.write": {
      schema: FileWriteRequestSchema,
      handler: handleFileWrite,
    },
    "search.edit": {
      schema: SearchEditRequestSchema,
      handler: handleSearchEdit,
    },
    "scip.ingest": {
      schema: ScipIngestRequestSchema,
      handler: handleScipIngest,
    },

    // === Agent actions ===
    "agent.feedback": {
      schema: AgentFeedbackRequestSchema,
      handler: handleAgentFeedback,
    },
    "agent.feedback.query": {
      schema: AgentFeedbackQueryRequestSchema,
      handler: handleAgentFeedbackQuery,
    },
    "buffer.push": {
      schema: BufferPushRequestSchema,
      handler: (args, ctx) => handleBufferPush(args, ctx, liveIndex),
    },
    "buffer.checkpoint": {
      schema: BufferCheckpointRequestSchema,
      handler: (args, ctx) => handleBufferCheckpoint(args, ctx, liveIndex),
    },
    "buffer.status": {
      schema: BufferStatusRequestSchema,
      handler: (args, ctx) => handleBufferStatus(args, ctx, liveIndex),
    },
    "runtime.execute": {
      schema: RuntimeExecuteRequestSchema,
      handler: handleRuntimeExecute,
    },
    "runtime.queryOutput": {
      schema: RuntimeQueryOutputRequestSchema,
      handler: handleRuntimeQueryOutput,
    },
    "memory.store": {
      schema: MemoryStoreRequestSchema,
      handler: handleMemoryStore,
    },
    "memory.query": {
      schema: MemoryQueryRequestSchema,
      handler: handleMemoryQuery,
    },
    "memory.remove": {
      schema: MemoryRemoveRequestSchema,
      handler: handleMemoryRemove,
    },
    "memory.surface": {
      schema: MemorySurfaceRequestSchema,
      handler: handleMemorySurface,
    },
  };

  if (!anyRepoHasMemoryTools(loadConfig())) {
    for (const key of MEMORY_ACTIONS) {
      delete map[key];
    }
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
/**
 * Pre-normalize action args before Zod schema validation.
 * Coerces known fields (e.g., numeric timestamps) so callers don't
 * need to know the exact schema type expectations.
 */
function preNormalizeArgs(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // buffer.push: coerce numeric timestamp (epoch ms) to ISO string
  if (action === "buffer.push" && typeof args.timestamp === "number") {
    return { ...args, timestamp: new Date(args.timestamp).toISOString() };
  }
  return args;
}

export async function routeGatewayCall(
  rawArgs: unknown,
  actionMap: ActionMap,
  ctx?: ToolContext,
): Promise<unknown> {
  const normalizedArgs = normalizeToolArguments(rawArgs);
  if (!normalizedArgs || typeof normalizedArgs !== "object") {
    throw new Error("Gateway args must be a non-null object");
  }
  const args = normalizedArgs as Record<string, unknown>;
  const action = args.action as string;
  const repoId = args.repoId as string | undefined;

  const entry = actionMap[action];
  if (!entry) {
    throw new Error(`Unknown gateway action: ${action}`);
  }

  // Build the handler-compatible payload: merge repoId back in, strip action
  const { action: _action, ...rest } = args;
  const merged = repoId !== undefined ? { repoId, ...rest } : rest;

  // Pre-normalize known fields before schema validation.
  // Coerce numeric timestamps to ISO strings so callers can pass epoch ms.
  const normalized = preNormalizeArgs(action, merged as Record<string, unknown>);

  // Second-pass validation using the original strict Zod schema
  const parsed = entry.schema.parse(normalized);

  return entry.handler(parsed, ctx);
}
