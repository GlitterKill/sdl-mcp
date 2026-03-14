import type { MCPServer } from "../../server.js";
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
} from "../tools.js";
import {
  handleAgentFeedback,
  handleAgentFeedbackQuery,
} from "./agent-feedback.js";
import { handleRuntimeExecute } from "./runtime.js";
import type { LiveIndexCoordinator } from "../../live-index/types.js";

type ToolServices = {
  liveIndex?: LiveIndexCoordinator;
};

export function registerTools(
  server: MCPServer,
  services: ToolServices = {},
  gatewayConfig?: { enabled?: boolean; emitLegacyTools?: boolean },
): void {
  if (gatewayConfig?.enabled) {
    server.gatewayMode = true;
    registerGatewayTools(server, services, {
      enabled: true,
      emitLegacyTools: gatewayConfig.emitLegacyTools ?? true,
    });
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
}
