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
  RepoStatusResponseSchema,
  RepoUnregisterResponseSchema,
  RuntimeExecuteResponseSchema,
  RuntimeQueryOutputResponseSchema,
} from "../tools.js";
import { ACTION_DEFINITION_BY_ACTION } from "../../code-mode/action-catalog.js";

import {
  handleRepoRegister,
  handleRepoStatus,
  handleRepoUnregister,
  handleIndexRefresh,
  handleRepoOverview,
} from "./repo.js";
import {
  handleBufferPush,
  handleBufferCheckpoint,
  handleBufferStatus,
} from "./buffer.js";
import { handleSymbolSearch, handleSymbolGetCard } from "./symbol.js";
import { handleSymbolEdit } from "./symbol-edit/index.js";
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
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "./agent-feedback.js";
import { handleRuntimeExecute } from "./runtime.js";
import { handleRuntimeQueryOutput } from "./runtime-query.js";
import { handleResponseGet } from "./response.js";
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "./memory.js";
import { handleUsageStats } from "./usage.js";
import { handleFileRead } from "./file-read.js";
import { handleFileWrite } from "./file-write.js";
import {
  handleSemanticEnrichmentRefresh,
  handleSemanticEnrichmentStatus,
} from "./semantic-enrichment.js";
import { handleSearchEdit } from "./search-edit/index.js";
import { loadConfig } from "../../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../../config/memory-config.js";

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
  outputSchema?: z.ZodType;
  presentation?: Partial<ToolPresentation>;
}

type ToolDescriptorProjection = Omit<ToolDescriptor, "name" | "schema"> & {
  action: string;
};

function projectToolDescriptor(
  projection: ToolDescriptorProjection,
): ToolDescriptor {
  const { action, description, ...rest } = projection;
  const definition = ACTION_DEFINITION_BY_ACTION[action];
  if (!definition?.toolName) {
    throw new Error(`Missing flat-tool Action Definition: ${action}`);
  }
  return {
    name: definition.toolName,
    description,
    schema: definition.schema,
    ...rest,
  };
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
  const memoryToolsVisible =
    services.actionAvailability?.memoryTools ??
    anyRepoHasMemoryTools(loadConfig());

  const projections: ToolDescriptorProjection[] = [
    {
      action: "repo.register",
      description: "Register a new repository for indexing",
      handler: handleRepoRegister,
    },
    {
      action: "repo.status",
      description: "Get status information about a repository",
      outputSchema: RepoStatusResponseSchema,
      handler: handleRepoStatus,
    },
    {
      action: "repo.unregister",
      description: "Permanently remove a runtime repository registration",
      outputSchema: RepoUnregisterResponseSchema,
      handler: (args, context) =>
        handleRepoUnregister(args, context, services.liveIndex),
    },
    {
      action: "index.refresh",
      description: "Refresh index for a repository (full or incremental)",
      handler: handleIndexRefresh,
    },
    {
      action: "repo.overview",
      description:
        "Get token-efficient codebase overview with directory summaries and hotspots",
      handler: handleRepoOverview,
    },
    {
      action: "buffer.push",
      description: "Push editor buffer updates for live draft indexing",
      handler: (args, context) =>
        handleBufferPush(args, context, services.liveIndex),
    },
    {
      action: "buffer.checkpoint",
      description: "Request a live draft checkpoint for a repository",
      handler: (args, context) =>
        handleBufferCheckpoint(args, context, services.liveIndex),
    },
    {
      action: "buffer.status",
      description: "Get live draft buffer status for a repository",
      handler: (args, context) =>
        handleBufferStatus(args, context, services.liveIndex),
    },
    {
      action: "symbol.search",
      description: "Search for symbols by name or summary",
      handler: handleSymbolSearch,
    },
    {
      action: "symbol.getCard",
      description: "Get a single symbol card by ID",
      handler: handleSymbolGetCard,
    },
    {
      action: "symbol.edit",
      description:
        "Symbol-scoped edit preview/apply/applyNow with astFingerprint, range, file sha, draft preconditions, and parse-after validation.",
      handler: handleSymbolEdit,
    },
    {
      action: "slice.build",
      description:
        "Build a graph slice for a task context. Accepts taskText alone (no entrySymbols required) " +
        "to auto-discover relevant symbols via full-text search in a single round trip. " +
        "Providing entrySymbols in addition to taskText improves precision. " +
        "When editedFiles is provided, all symbols in those files plus their immediate callers are included as forced entries regardless of score threshold.",
      handler: handleSliceBuild,
    },
    {
      action: "slice.refresh",
      description:
        "Refresh an existing slice handle and return incremental delta",
      handler: handleSliceRefresh,
    },
    {
      action: "slice.spillover.get",
      description:
        "Fetch overflow symbols via spillover handle with pagination",
      handler: handleSliceSpilloverGet,
    },
    {
      action: "delta.get",
      description: "Get delta pack between two versions with blast radius",
      handler: handleDeltaGet,
    },
    {
      action: "code.needWindow",
      description:
        "Request access to raw code window for a symbol with gating policy",
      handler: handleCodeNeedWindow,
    },
    {
      action: "code.getSkeleton",
      description:
        "Get skeleton view of code (signatures + control flow + elided bodies)",
      handler: handleGetSkeleton,
    },
    {
      action: "code.getHotPath",
      description:
        "Get hot-path excerpt showing only lines matching identifiers with context",
      handler: handleGetHotPath,
    },
    {
      action: "policy.get",
      description: "Get policy configuration for a repository",
      handler: handlePolicyGet,
    },
    {
      action: "policy.set",
      description: "Update policy configuration for a repository",
      handler: handlePolicySet,
    },
    {
      action: "pr.risk.analyze",
      description:
        "Analyze PR risk by computing delta between versions, assessing blast radius, and recommending tests",
      handler: handlePRRiskAnalysis,
    },
    {
      action: "agent.feedback",
      description:
        "Record feedback about useful and missing symbols for offline tuning",
      handler: handleAgentFeedback,
    },
    {
      action: "agent.feedback.query",
      description:
        "Query feedback records and aggregated statistics for offline tuning pipelines",
      handler: handleAgentFeedbackQuery,
    },
    {
      action: "runtime.execute",
      description:
        "Execute a command in a repo-scoped subprocess with structured output, " +
        "artifact persistence, and deterministic excerpts. Enabled by default; set runtime.enabled = false to disable.",
      outputSchema: RuntimeExecuteResponseSchema,
      handler: handleRuntimeExecute,
    },
    {
      action: "runtime.queryOutput",
      description:
        "Query stored command output by keywords and retrieve specific sections of previous runtime execution results",
      outputSchema: RuntimeQueryOutputResponseSchema,
      handler: handleRuntimeQueryOutput,
    },
    {
      action: "response.get",
      description:
        "Retrieve a stored large tool response by handle, with bounded excerpt or full payload modes",
      handler: handleResponseGet,
    },
    {
      action: "memory.store",
      description:
        "Store or update an agent memory (decision, bugfix, or task context) with optional symbol and file links",
      handler: handleMemoryStore,
    },
    {
      action: "memory.query",
      description:
        "Search and filter agent memories by text, type, tags, or linked symbols",
      handler: handleMemoryQuery,
    },
    {
      action: "memory.remove",
      description:
        "Soft-delete a memory from the graph and optionally from disk",
      handler: handleMemoryRemove,
    },
    {
      action: "memory.surface",
      description:
        "Auto-surface relevant memories for a task context based on symbol overlap and recency",
      handler: handleMemorySurface,
    },
    {
      action: "usage.stats",
      description:
        "Get cumulative token savings statistics for the current session and/or historical sessions",
      handler: handleUsageStats,
    },
    {
      action: "file.read",
      description:
        "Read non-indexed files (templates, configs, docs) with optional line range, search, or JSON path extraction",
      handler: handleFileRead,
    },
    {
      action: "file.write",
      description:
        "Write to a single file (indexed or non-indexed) with targeted modes; use sdl.search.edit for cross-file batching: full content, line replacement, pattern replacement, JSON path update, insert, or append",
      handler: handleFileWrite,
    },
    {
      action: "semantic.enrichment.refresh",
      description:
        "Run provider-backed semantic enrichment for a repository using SCIP or LSP source selection.",
      handler: handleSemanticEnrichmentRefresh,
    },
    {
      action: "semantic.enrichment.status",
      description:
        "Report semantic enrichment provider selection, skipped providers, last runs, and precision scores.",
      handler: handleSemanticEnrichmentStatus,
    },
    {
      action: "search.edit",
      description:
        'Cross-file search-and-edit in two phases: mode:"preview" returns a planHandle summarizing proposed edits; mode:"apply" executes the plan with sha256/mtime preconditions and rollback on mid-batch failure. Supports text, symbol, identifier, and structural tree-sitter targeting for safer edits across supported structural languages. Also supports targeting:"rename" (graph-scoped symbol rename) and targeting:"signature" (TS/JS signature change with AST-based callsite propagation). Preview responses default to responseMode:"auto". Prefer this over composing repeated file.write calls.',
      handler: handleSearchEdit,
    },
  ];
  const all = projections.map(projectToolDescriptor);

  if (!memoryToolsVisible) {
    return all.filter((d) => !d.name.startsWith("sdl.memory."));
  }
  return all;
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
      d.outputSchema,
    );
  }
}
