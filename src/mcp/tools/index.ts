import type { MCPServer } from "../../server.js";
import { createMemoryHintHook } from "../hooks/memory-hint.js";
import { registerGatewayTools } from "../../gateway/index.js";
import {
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  IndexRefreshRequestSchema,
  RepoOverviewRequestSchema,
  BufferPushRequestSchema,
  BufferCheckpointRequestSchema,
  BufferStatusRequestSchema,
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
  SymbolSearchRequestSchema,
  SymbolGetCardRequestSchema,
  SymbolGetCardsRequestSchema,
} from "../tools.js";
import {
  handleSymbolSearch,
  handleSymbolGetCard,
  handleSymbolGetCards,
} from "./symbol.js";
import {
  SliceBuildRequestSchema,
  SliceRefreshRequestSchema,
  SliceSpilloverGetRequestSchema,
} from "../tools.js";
import {
  handleSliceBuild,
  handleSliceRefresh,
  handleSliceSpilloverGet,
} from "./slice.js";
import { DeltaGetRequestSchema } from "../tools.js";
import { handleDeltaGet } from "./delta.js";
import {
  CodeNeedWindowRequestSchema,
  GetSkeletonRequestSchema,
  GetHotPathRequestSchema,
} from "../tools.js";
import {
  handleCodeNeedWindow,
  handleGetSkeleton,
  handleGetHotPath,
} from "./code.js";
import { PolicyGetRequestSchema, PolicySetRequestSchema } from "../tools.js";
import { handlePolicyGet, handlePolicySet } from "./policy.js";
import {
  PRRiskAnalysisRequestSchema,
  AgentOrchestrateRequestSchema,
} from "../tools.js";
import { handlePRRiskAnalysis } from "./prRisk.js";
import { handleAgentOrchestrate } from "./agent.js";
import { ContextSummaryRequestSchema } from "../tools.js";
import { handleContextSummary } from "./summary.js";
import {
  AgentFeedbackRequestSchema,
  AgentFeedbackQueryRequestSchema,
  RuntimeExecuteRequestSchema,
  MemoryStoreRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemorySurfaceRequestSchema,
  UsageStatsRequestSchema,
} from "../tools.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "./agent-feedback.js";
import { handleRuntimeExecute } from "./runtime.js";
import {
  handleMemoryStore,
  handleMemoryQuery,
  handleMemoryRemove,
  handleMemorySurface,
} from "./memory.js";
import { handleUsageStats } from "./usage.js";
import { InfoRequestSchema, handleInfo } from "./info.js";
import type { ToolServices } from "../../gateway/index.js";
import { createActionMap } from "../../gateway/router.js";
import {
  registerActionSearchTool,
  registerCodeModeTools,
} from "../../code-mode/index.js";
import type { CodeModeConfig } from "../../config/types.js";

export function registerTools(
  server: MCPServer,
  services: ToolServices = {},
  gatewayConfig?: { enabled?: boolean; emitLegacyTools?: boolean },
  codeModeConfig?: CodeModeConfig,
): void {
  // Register memory hint hook for all modes
  server.registerPostDispatchHook(createMemoryHintHook());

  // Universal discovery surface
  registerActionSearchTool(server, services);

  server.registerTool(
    "sdl.info",
    "Get unified SDL-MCP runtime, config, logging, Ladybug, and native-addon status.",
    InfoRequestSchema,
    handleInfo,
    undefined,
    { title: "SDL Info" },
  );

  // Code Mode exclusive: register action search plus code-mode tools only
  if (codeModeConfig?.enabled && codeModeConfig?.exclusive) {
    registerCodeModeTools(server, services, codeModeConfig);
    return;
  }

  if (gatewayConfig?.enabled) {
    server.gatewayMode = true;

    // When both gateway and code-mode are active, share one actionMap
    const sharedActionMap = codeModeConfig?.enabled
      ? createActionMap(services.liveIndex)
      : undefined;

    registerGatewayTools(
      server,
      services,
      {
        enabled: true,
        emitLegacyTools: gatewayConfig.emitLegacyTools ?? true,
      },
      sharedActionMap,
    );

    // Code Mode alongside gateway — reuse shared action map
    if (codeModeConfig?.enabled && sharedActionMap) {
      registerCodeModeTools(server, services, codeModeConfig, sharedActionMap);
    }
    return;
  }

  server.registerTool(
    "sdl.repo.register",
    "Register a new repository for indexing",
    RepoRegisterRequestSchema,
    handleRepoRegister,
  );

  server.registerTool(
    "sdl.repo.status",
    "Get status information about a repository",
    RepoStatusRequestSchema,
    handleRepoStatus,
  );

  server.registerTool(
    "sdl.index.refresh",
    "Refresh index for a repository (full or incremental)",
    IndexRefreshRequestSchema,
    handleIndexRefresh,
  );

  server.registerTool(
    "sdl.buffer.push",
    "Push editor buffer updates for live draft indexing",
    BufferPushRequestSchema,
    (args, context) => handleBufferPush(args, context, services.liveIndex),
  );

  server.registerTool(
    "sdl.buffer.checkpoint",
    "Request a live draft checkpoint for a repository",
    BufferCheckpointRequestSchema,
    (args, context) =>
      handleBufferCheckpoint(args, context, services.liveIndex),
  );

  server.registerTool(
    "sdl.buffer.status",
    "Get live draft buffer status for a repository",
    BufferStatusRequestSchema,
    (args, context) => handleBufferStatus(args, context, services.liveIndex),
  );

  server.registerTool(
    "sdl.symbol.search",
    "Search for symbols by name or summary",
    SymbolSearchRequestSchema,
    handleSymbolSearch,
  );

  server.registerTool(
    "sdl.symbol.getCard",
    "Get a single symbol card by ID",
    SymbolGetCardRequestSchema,
    handleSymbolGetCard,
  );

  server.registerTool(
    "sdl.symbol.getCards",
    "Batch fetch symbol cards for multiple symbolIds in a single round trip. " +
      "Pass knownEtags (map of symbolId → ETag) to skip unchanged cards — " +
      "they return notModified instead of the full card payload.",
    SymbolGetCardsRequestSchema,
    handleSymbolGetCards,
  );

  server.registerTool(
    "sdl.slice.build",
    "Build a graph slice for a task context. Accepts taskText alone (no entrySymbols required) " +
      "to auto-discover relevant symbols via full-text search in a single round trip. " +
      "Providing entrySymbols in addition to taskText improves precision. " +
      "When editedFiles is provided, all symbols in those files plus their immediate callers are included as forced entries regardless of score threshold.",
    SliceBuildRequestSchema,
    handleSliceBuild,
  );

  server.registerTool(
    "sdl.slice.refresh",
    "Refresh an existing slice handle and return incremental delta",
    SliceRefreshRequestSchema,
    handleSliceRefresh,
  );

  server.registerTool(
    "sdl.slice.spillover.get",
    "Fetch overflow symbols via spillover handle with pagination",
    SliceSpilloverGetRequestSchema,
    handleSliceSpilloverGet,
  );

  server.registerTool(
    "sdl.delta.get",
    "Get delta pack between two versions with blast radius",
    DeltaGetRequestSchema,
    handleDeltaGet,
  );

  server.registerTool(
    "sdl.code.needWindow",
    "Request access to raw code window for a symbol with gating policy",
    CodeNeedWindowRequestSchema,
    handleCodeNeedWindow,
  );

  server.registerTool(
    "sdl.code.getSkeleton",
    "Get skeleton view of code (signatures + control flow + elided bodies)",
    GetSkeletonRequestSchema,
    handleGetSkeleton,
  );

  server.registerTool(
    "sdl.code.getHotPath",
    "Get hot-path excerpt showing only lines matching identifiers with context",
    GetHotPathRequestSchema,
    handleGetHotPath,
  );

  server.registerTool(
    "sdl.policy.get",
    "Get policy configuration for a repository",
    PolicyGetRequestSchema,
    handlePolicyGet,
  );

  server.registerTool(
    "sdl.policy.set",
    "Update policy configuration for a repository",
    PolicySetRequestSchema,
    handlePolicySet,
  );

  server.registerTool(
    "sdl.repo.overview",
    "Get token-efficient codebase overview with directory summaries and hotspots",
    RepoOverviewRequestSchema,
    handleRepoOverview,
  );

  server.registerTool(
    "sdl.pr.risk.analyze",
    "Analyze PR risk by computing delta between versions, assessing blast radius, and recommending tests",
    PRRiskAnalysisRequestSchema,
    handlePRRiskAnalysis,
  );

  server.registerTool(
    "sdl.agent.orchestrate",
    "Orchestrate agent task execution with automated rung path selection and evidence capture",
    AgentOrchestrateRequestSchema,
    handleAgentOrchestrate,
  );

  server.registerTool(
    "sdl.context.summary",
    "Generate token-bounded context summary for a symbol, file, or task query",
    ContextSummaryRequestSchema,
    handleContextSummary,
  );

  server.registerTool(
    "sdl.agent.feedback",
    "Record feedback about useful and missing symbols for offline tuning",
    AgentFeedbackRequestSchema,
    handleAgentFeedback,
  );

  server.registerTool(
    "sdl.agent.feedback.query",
    "Query feedback records and aggregated statistics for offline tuning pipelines",
    AgentFeedbackQueryRequestSchema,
    handleAgentFeedbackQuery,
  );

  server.registerTool(
    "sdl.runtime.execute",
    "Execute a command in a repo-scoped subprocess with structured output, " +
      "artifact persistence, and deterministic excerpts. Requires runtime.enabled = true in config.",
    RuntimeExecuteRequestSchema,
    handleRuntimeExecute,
  );

  server.registerTool(
    "sdl.memory.store",
    "Store or update an agent memory (decision, bugfix, or task context) with optional symbol and file links",
    MemoryStoreRequestSchema,
    handleMemoryStore,
  );

  server.registerTool(
    "sdl.memory.query",
    "Search and filter agent memories by text, type, tags, or linked symbols",
    MemoryQueryRequestSchema,
    handleMemoryQuery,
  );

  server.registerTool(
    "sdl.memory.remove",
    "Soft-delete a memory from the graph and optionally from disk",
    MemoryRemoveRequestSchema,
    handleMemoryRemove,
  );

  server.registerTool(
    "sdl.memory.surface",
    "Auto-surface relevant memories for a task context based on symbol overlap and recency",
    MemorySurfaceRequestSchema,
    handleMemorySurface,
  );

  server.registerTool(
    "sdl.usage.stats",
    "Get cumulative token savings statistics for the current session and/or historical sessions",
    UsageStatsRequestSchema,
    handleUsageStats,
  );

  // Code Mode alongside flat tools
  if (codeModeConfig?.enabled) {
    registerCodeModeTools(server, services, codeModeConfig);
  }
}
