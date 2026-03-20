/**
 * Legacy tool aliases — registers the original 29 flat tool names
 * for backward compatibility when gateway mode is active.
 */
import type { MCPServer } from "../server.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
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
  UsageStatsRequestSchema,
  PRRiskAnalysisRequestSchema,
  AgentOrchestrateRequestSchema,
  ContextSummaryRequestSchema,
  AgentFeedbackRequestSchema,
  AgentFeedbackQueryRequestSchema,
  RuntimeExecuteRequestSchema,
  MemoryStoreRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemorySurfaceRequestSchema,
} from "../mcp/tools.js";
import {
  handleRepoRegister,
  handleRepoStatus,
  handleIndexRefresh,
  handleRepoOverview,
} from "../mcp/tools/repo.js";
import {
  handleBufferPush,
  handleBufferCheckpoint,
  handleBufferStatus,
} from "../mcp/tools/buffer.js";
import {
  handleSymbolSearch,
  handleSymbolGetCard,
  handleSymbolGetCards,
} from "../mcp/tools/symbol.js";
import {
  handleSliceBuild,
  handleSliceRefresh,
  handleSliceSpilloverGet,
} from "../mcp/tools/slice.js";
import { handleDeltaGet } from "../mcp/tools/delta.js";
import {
  handleCodeNeedWindow,
  handleGetSkeleton,
  handleGetHotPath,
} from "../mcp/tools/code.js";
import { handlePolicyGet, handlePolicySet } from "../mcp/tools/policy.js";
import { handleUsageStats } from "../mcp/tools/usage.js";
import { handlePRRiskAnalysis } from "../mcp/tools/prRisk.js";
import { handleAgentOrchestrate } from "../mcp/tools/agent.js";
import { handleContextSummary } from "../mcp/tools/summary.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "../mcp/tools/agent-feedback.js";
import { handleRuntimeExecute } from "../mcp/tools/runtime.js";
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "../mcp/tools/memory.js";

type ToolServices = {
  liveIndex?: LiveIndexCoordinator;
};

/**
 * Register legacy (flat) tool names alongside gateway tools for backward compat.
 * Descriptions include a deprecation notice pointing to the gateway tool.
 */
export function registerLegacyTools(
  server: MCPServer,
  services: ToolServices,
): void {
  const dep = (gateway: string, desc: string) =>
    `[Legacy — prefer ${gateway}] ${desc}`;

  server.registerTool(
    "sdl.repo.register",
    dep("sdl.repo", "Register a new repository for indexing"),
    RepoRegisterRequestSchema,
    handleRepoRegister,
  );
  server.registerTool(
    "sdl.repo.status",
    dep("sdl.repo", "Get status information about a repository"),
    RepoStatusRequestSchema,
    handleRepoStatus,
  );
  server.registerTool(
    "sdl.index.refresh",
    dep("sdl.repo", "Refresh index for a repository (full or incremental)"),
    IndexRefreshRequestSchema,
    handleIndexRefresh,
  );
  server.registerTool(
    "sdl.buffer.push",
    dep("sdl.agent", "Push editor buffer updates for live draft indexing"),
    BufferPushRequestSchema,
    (args, context) => handleBufferPush(args, context, services.liveIndex),
  );
  server.registerTool(
    "sdl.buffer.checkpoint",
    dep("sdl.agent", "Request a live draft checkpoint for a repository"),
    BufferCheckpointRequestSchema,
    (args, context) =>
      handleBufferCheckpoint(args, context, services.liveIndex),
  );
  server.registerTool(
    "sdl.buffer.status",
    dep("sdl.agent", "Get live draft buffer status for a repository"),
    BufferStatusRequestSchema,
    (args, context) => handleBufferStatus(args, context, services.liveIndex),
  );
  server.registerTool(
    "sdl.symbol.search",
    dep("sdl.query", "Search for symbols by name or summary"),
    SymbolSearchRequestSchema,
    handleSymbolSearch,
  );
  server.registerTool(
    "sdl.symbol.getCard",
    dep("sdl.query", "Get a single symbol card by ID"),
    SymbolGetCardRequestSchema,
    handleSymbolGetCard,
  );
  server.registerTool(
    "sdl.symbol.getCards",
    dep("sdl.query", "Batch fetch symbol cards for multiple symbolIds"),
    SymbolGetCardsRequestSchema,
    handleSymbolGetCards,
  );
  server.registerTool(
    "sdl.slice.build",
    dep("sdl.query", "Build a graph slice for a task context"),
    SliceBuildRequestSchema,
    handleSliceBuild,
  );
  server.registerTool(
    "sdl.slice.refresh",
    dep("sdl.query", "Refresh an existing slice handle"),
    SliceRefreshRequestSchema,
    handleSliceRefresh,
  );
  server.registerTool(
    "sdl.slice.spillover.get",
    dep("sdl.query", "Fetch overflow symbols via spillover handle"),
    SliceSpilloverGetRequestSchema,
    handleSliceSpilloverGet,
  );
  server.registerTool(
    "sdl.delta.get",
    dep("sdl.query", "Get delta pack between two versions"),
    DeltaGetRequestSchema,
    handleDeltaGet,
  );
  server.registerTool(
    "sdl.code.needWindow",
    dep("sdl.code", "Request access to raw code window for a symbol"),
    CodeNeedWindowRequestSchema,
    handleCodeNeedWindow,
  );
  server.registerTool(
    "sdl.code.getSkeleton",
    dep("sdl.code", "Get skeleton view of code"),
    GetSkeletonRequestSchema,
    handleGetSkeleton,
  );
  server.registerTool(
    "sdl.code.getHotPath",
    dep("sdl.code", "Get hot-path excerpt"),
    GetHotPathRequestSchema,
    handleGetHotPath,
  );
  server.registerTool(
    "sdl.policy.get",
    dep("sdl.repo", "Get policy configuration for a repository"),
    PolicyGetRequestSchema,
    handlePolicyGet,
  );
  server.registerTool(
    "sdl.policy.set",
    dep("sdl.repo", "Update policy configuration for a repository"),
    PolicySetRequestSchema,
    handlePolicySet,
  );
  server.registerTool(
    "sdl.repo.overview",
    dep("sdl.repo", "Get token-efficient codebase overview"),
    RepoOverviewRequestSchema,
    handleRepoOverview,
  );
  server.registerTool(
    "sdl.usage.stats",
    dep("sdl.repo", "Get token usage statistics for the current session or history"),
    UsageStatsRequestSchema,
    handleUsageStats,
  );
  server.registerTool(
    "sdl.pr.risk.analyze",
    dep("sdl.query", "Analyze PR risk"),
    PRRiskAnalysisRequestSchema,
    handlePRRiskAnalysis,
  );
  server.registerTool(
    "sdl.agent.orchestrate",
    dep("sdl.agent", "Orchestrate agent task execution"),
    AgentOrchestrateRequestSchema,
    handleAgentOrchestrate,
  );
  server.registerTool(
    "sdl.context.summary",
    dep("sdl.query", "Generate token-bounded context summary"),
    ContextSummaryRequestSchema,
    handleContextSummary,
  );
  server.registerTool(
    "sdl.agent.feedback",
    dep("sdl.agent", "Record feedback about useful and missing symbols"),
    AgentFeedbackRequestSchema,
    handleAgentFeedback,
  );
  server.registerTool(
    "sdl.agent.feedback.query",
    dep("sdl.agent", "Query feedback records and aggregated statistics"),
    AgentFeedbackQueryRequestSchema,
    handleAgentFeedbackQuery,
  );
  server.registerTool(
    "sdl.runtime.execute",
    dep("sdl.agent", "Execute a command in a repo-scoped subprocess"),
    RuntimeExecuteRequestSchema,
    handleRuntimeExecute,
  );
  server.registerTool(
    "sdl.memory.store",
    dep(
      "sdl.agent",
      "Store or update an agent memory with optional symbol and file links",
    ),
    MemoryStoreRequestSchema,
    handleMemoryStore,
  );
  server.registerTool(
    "sdl.memory.query",
    dep(
      "sdl.agent",
      "Search and filter agent memories by text, type, tags, or linked symbols",
    ),
    MemoryQueryRequestSchema,
    handleMemoryQuery,
  );
  server.registerTool(
    "sdl.memory.remove",
    dep(
      "sdl.agent",
      "Soft-delete a memory from the graph and optionally from disk",
    ),
    MemoryRemoveRequestSchema,
    handleMemoryRemove,
  );
  server.registerTool(
    "sdl.memory.surface",
    dep("sdl.agent", "Auto-surface relevant memories for a task context"),
    MemorySurfaceRequestSchema,
    handleMemorySurface,
  );
}
