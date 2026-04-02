/**
 * Declarative tool descriptor manifest for flat (non-gateway, non-code-mode)
 * MCP tool registration.
 *
 * Each descriptor captures the tool name, description, schema, handler, and
 * optional presentation overrides. Closure-bound handlers (e.g. buffer tools
 * that require `services.liveIndex`) are produced by a factory that receives
 * `ToolServices` at registration time.
 */

import type { z } from "zod";
import type { MCPServer, ToolContext } from "../../server.js";
import type { ToolServices } from "../../gateway/index.js";
import type { ToolPresentation } from "../tool-presentation.js";

import {
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  IndexRefreshRequestSchema,
  RepoOverviewRequestSchema,
  BufferPushRequestSchema,
  BufferCheckpointRequestSchema,
  BufferStatusRequestSchema,
  SymbolSearchRequestSchema,
  SymbolGetCardRequestSchema,
  SymbolGetCardsRequestSchema,
  SliceBuildRequestSchema,
  SliceRefreshRequestSchema,
  SliceSpilloverGetRequestSchema,
  DeltaGetRequestSchema,
  CodeNeedWindowRequestSchema,
  GetSkeletonRequestSchema,
  GetHotPathRequestSchema,
  PolicyGetRequestSchema,
  PolicySetRequestSchema,
  PRRiskAnalysisRequestSchema,
  AgentContextRequestSchema,
  ContextSummaryRequestSchema,
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
} from "../tools.js";

import {
  handleRepoRegister,
  handleRepoStatus,
  handleIndexRefresh,
  handleRepoOverview,
} from "./repo.js";
import {
  handleBufferPush,
  handleBufferCheckpoint,
  handleBufferStatus,
} from "./buffer.js";
import {
  handleSymbolSearch,
  handleSymbolGetCard,
  handleSymbolGetCards,
} from "./symbol.js";
import {
  handleSliceBuild,
  handleSliceRefresh,
  handleSliceSpilloverGet,
} from "./slice.js";
import { handleDeltaGet } from "./delta.js";
import {
  handleCodeNeedWindow,
  handleGetSkeleton,
  handleGetHotPath,
} from "./code.js";
import { handlePolicyGet, handlePolicySet } from "./policy.js";
import { handlePRRiskAnalysis } from "./prRisk.js";
import { handleAgentContext } from "./context.js";
import { handleContextSummary } from "./summary.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "./agent-feedback.js";
import { handleRuntimeExecute } from "./runtime.js";
import { handleRuntimeQueryOutput } from "./runtime-query.js";
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "./memory.js";
import { handleUsageStats } from "./usage.js";
import { handleFileRead } from "./file-read.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handler signature matching MCPServer.registerTool's `handler` parameter. */
export type ToolHandler = (
  args: unknown,
  context?: ToolContext,
) => Promise<unknown>;

/**
 * Declarative descriptor for a single MCP tool registration.
 *
 * The `handler` field is the final, ready-to-register handler function.
 * For tools that need closure values from `ToolServices`, use
 * `buildFlatToolDescriptors` which binds them at construction time.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: ToolHandler;
  wireSchema?: Record<string, unknown>;
  presentation?: Partial<ToolPresentation>;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the full array of flat tool descriptors, binding closure handlers
 * to the provided `services` where needed (e.g. buffer tools).
 */
export function buildFlatToolDescriptors(
  services: ToolServices,
): ToolDescriptor[] {
  return [
    {
      name: "sdl.repo.register",
      description: "Register a new repository for indexing",
      schema: RepoRegisterRequestSchema,
      handler: handleRepoRegister,
    },
    {
      name: "sdl.repo.status",
      description: "Get status information about a repository",
      schema: RepoStatusRequestSchema,
      handler: handleRepoStatus,
    },
    {
      name: "sdl.index.refresh",
      description:
        "Refresh index for a repository (full or incremental)",
      schema: IndexRefreshRequestSchema,
      handler: handleIndexRefresh,
    },
    {
      name: "sdl.repo.overview",
      description:
        "Get token-efficient codebase overview with directory summaries and hotspots",
      schema: RepoOverviewRequestSchema,
      handler: handleRepoOverview,
    },
    {
      name: "sdl.buffer.push",
      description: "Push editor buffer updates for live draft indexing",
      schema: BufferPushRequestSchema,
      handler: (args, context) =>
        handleBufferPush(args, context, services.liveIndex),
    },
    {
      name: "sdl.buffer.checkpoint",
      description:
        "Request a live draft checkpoint for a repository",
      schema: BufferCheckpointRequestSchema,
      handler: (args, context) =>
        handleBufferCheckpoint(args, context, services.liveIndex),
    },
    {
      name: "sdl.buffer.status",
      description:
        "Get live draft buffer status for a repository",
      schema: BufferStatusRequestSchema,
      handler: (args, context) =>
        handleBufferStatus(args, context, services.liveIndex),
    },
    {
      name: "sdl.symbol.search",
      description: "Search for symbols by name or summary",
      schema: SymbolSearchRequestSchema,
      handler: handleSymbolSearch,
    },
    {
      name: "sdl.symbol.getCard",
      description: "Get a single symbol card by ID",
      schema: SymbolGetCardRequestSchema,
      handler: handleSymbolGetCard,
    },
    {
      name: "sdl.symbol.getCards",
      description:
        "Batch fetch symbol cards for multiple symbolIds in a single round trip. " +
        "Pass knownEtags (map of symbolId \u2192 ETag) to skip unchanged cards \u2014 " +
        "they return notModified instead of the full card payload.",
      schema: SymbolGetCardsRequestSchema,
      handler: handleSymbolGetCards,
    },
    {
      name: "sdl.slice.build",
      description:
        "Build a graph slice for a task context. Accepts taskText alone (no entrySymbols required) " +
        "to auto-discover relevant symbols via full-text search in a single round trip. " +
        "Providing entrySymbols in addition to taskText improves precision. " +
        "When editedFiles is provided, all symbols in those files plus their immediate callers are included as forced entries regardless of score threshold.",
      schema: SliceBuildRequestSchema,
      handler: handleSliceBuild,
    },
    {
      name: "sdl.slice.refresh",
      description:
        "Refresh an existing slice handle and return incremental delta",
      schema: SliceRefreshRequestSchema,
      handler: handleSliceRefresh,
    },
    {
      name: "sdl.slice.spillover.get",
      description:
        "Fetch overflow symbols via spillover handle with pagination",
      schema: SliceSpilloverGetRequestSchema,
      handler: handleSliceSpilloverGet,
    },
    {
      name: "sdl.delta.get",
      description:
        "Get delta pack between two versions with blast radius",
      schema: DeltaGetRequestSchema,
      handler: handleDeltaGet,
    },
    {
      name: "sdl.code.needWindow",
      description:
        "Request access to raw code window for a symbol with gating policy",
      schema: CodeNeedWindowRequestSchema,
      handler: handleCodeNeedWindow,
    },
    {
      name: "sdl.code.getSkeleton",
      description:
        "Get skeleton view of code (signatures + control flow + elided bodies)",
      schema: GetSkeletonRequestSchema,
      handler: handleGetSkeleton,
    },
    {
      name: "sdl.code.getHotPath",
      description:
        "Get hot-path excerpt showing only lines matching identifiers with context",
      schema: GetHotPathRequestSchema,
      handler: handleGetHotPath,
    },
    {
      name: "sdl.policy.get",
      description: "Get policy configuration for a repository",
      schema: PolicyGetRequestSchema,
      handler: handlePolicyGet,
    },
    {
      name: "sdl.policy.set",
      description:
        "Update policy configuration for a repository",
      schema: PolicySetRequestSchema,
      handler: handlePolicySet,
    },
    {
      name: "sdl.pr.risk.analyze",
      description:
        "Analyze PR risk by computing delta between versions, assessing blast radius, and recommending tests",
      schema: PRRiskAnalysisRequestSchema,
      handler: handlePRRiskAnalysis,
    },
    {
      name: "sdl.agent.context",
      description:
        "Retrieve task-shaped context with automated rung path selection, adaptive symbol relevance ranking, and contextMode (precise/broad) for token-efficient context retrieval",
      schema: AgentContextRequestSchema,
      handler: handleAgentContext,
    },
    {
      name: "sdl.context.summary",
      description:
        "Generate token-bounded context summary for a symbol, file, or task query",
      schema: ContextSummaryRequestSchema,
      handler: handleContextSummary,
    },
    {
      name: "sdl.agent.feedback",
      description:
        "Record feedback about useful and missing symbols for offline tuning",
      schema: AgentFeedbackRequestSchema,
      handler: handleAgentFeedback,
    },
    {
      name: "sdl.agent.feedback.query",
      description:
        "Query feedback records and aggregated statistics for offline tuning pipelines",
      schema: AgentFeedbackQueryRequestSchema,
      handler: handleAgentFeedbackQuery,
    },
    {
      name: "sdl.runtime.execute",
      description:
        "Execute a command in a repo-scoped subprocess with structured output, " +
        "artifact persistence, and deterministic excerpts. Enabled by default; set runtime.enabled = false to disable.",
      schema: RuntimeExecuteRequestSchema,
      handler: handleRuntimeExecute,
    },
    {
      name: "sdl.runtime.queryOutput",
      description:
        "Query stored command output by keywords and retrieve specific sections of previous runtime execution results",
      schema: RuntimeQueryOutputRequestSchema,
      handler: handleRuntimeQueryOutput,
    },
    {
      name: "sdl.memory.store",
      description:
        "Store or update an agent memory (decision, bugfix, or task context) with optional symbol and file links",
      schema: MemoryStoreRequestSchema,
      handler: handleMemoryStore,
    },
    {
      name: "sdl.memory.query",
      description:
        "Search and filter agent memories by text, type, tags, or linked symbols",
      schema: MemoryQueryRequestSchema,
      handler: handleMemoryQuery,
    },
    {
      name: "sdl.memory.remove",
      description:
        "Soft-delete a memory from the graph and optionally from disk",
      schema: MemoryRemoveRequestSchema,
      handler: handleMemoryRemove,
    },
    {
      name: "sdl.memory.surface",
      description:
        "Auto-surface relevant memories for a task context based on symbol overlap and recency",
      schema: MemorySurfaceRequestSchema,
      handler: handleMemorySurface,
    },
    {
      name: "sdl.usage.stats",
      description:
        "Get cumulative token savings statistics for the current session and/or historical sessions",
      schema: UsageStatsRequestSchema,
      handler: handleUsageStats,
    },
    {
      name: "sdl.file.read",
      description:
        "Read non-indexed files (templates, configs, docs) with optional line range, search, or JSON path extraction",
      schema: FileReadRequestSchema,
      handler: handleFileRead,
    },
  ];
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

/**
 * Register an array of tool descriptors on the given MCP server.
 * Each descriptor is forwarded to `server.registerTool(...)` with the
 * same positional arguments that the manual calls used.
 */
export function registerFlatTools(
  server: MCPServer,
  descriptors: ToolDescriptor[],
): void {
  for (const d of descriptors) {
    server.registerTool(
      d.name,
      d.description,
      d.schema,
      d.handler,
      d.wireSchema,
      d.presentation,
    );
  }
}
