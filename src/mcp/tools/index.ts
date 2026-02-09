import type { MCPServer } from "../../server.js";
import {
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  IndexRefreshRequestSchema,
  RepoOverviewRequestSchema,
} from "../tools.js";
import {
  handleRepoRegister,
  handleRepoStatus,
  handleIndexRefresh,
  handleRepoOverview,
} from "./repo.js";
import {
  SymbolSearchRequestSchema,
  SymbolGetCardRequestSchema,
} from "../tools.js";
import { handleSymbolSearch, handleSymbolGetCard } from "./symbol.js";
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

export function registerTools(server: MCPServer): void {
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
    "sdl.slice.build",
    "Build a graph slice for a task context",
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
}
