export type PublicGraphRetrievalAdmission =
  | { mode: "excluded" }
  | { mode: "conditional" }
  | { mode: "central"; repoId: string | undefined };

const GRAPH_ACTIONS = new Set([
  "symbol.search",
  "symbol.getCard",
  "slice.build",
  "slice.spillover.get",
  "delta.get",
  "pr.risk.analyze",
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
  "repo.overview",
]);

const GRAPH_FLAT_TOOLS = new Set([
  "sdl.symbol.search",
  "sdl.symbol.getCard",
  "sdl.slice.build",
  "sdl.slice.spillover.get",
  "sdl.delta.get",
  "sdl.pr.risk.analyze",
  "sdl.code.needWindow",
  "sdl.code.getSkeleton",
  "sdl.code.getHotPath",
  "sdl.repo.overview",
]);

const GATEWAY_TOOLS = new Set([
  "sdl.query",
  "sdl.code",
  "sdl.repo",
  "sdl.agent",
]);

const RETRIEVE_OPS = new Set([
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "codeSkeleton",
  "codeHotPath",
  "codeNeedWindow",
]);

const FILE_WINDOW_OPS = new Set(["previewWindow", "sourceWindow"]);

const GRAPH_WORKFLOW_STEPS = new Set([
  ...GRAPH_ACTIONS,
  "symbolSearch",
  "symbolGetCard",
  "sliceBuild",
  "sliceSpilloverGet",
  "deltaGet",
  "prRiskAnalyze",
  "codeNeedWindow",
  "codeSkeleton",
  "codeHotPath",
  "repoOverview",
]);

const CONDITIONAL_FLAT_TOOLS = new Set(["sdl.slice.refresh"]);
const CONDITIONAL_GATEWAY_ACTIONS = new Set(["slice.refresh"]);
const CONDITIONAL_WORKFLOW_STEPS = new Set([
  "slice.refresh",
  "sliceRefresh",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasWorkflowStep(
  args: Record<string, unknown>,
  admittedSteps: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(args.steps)) return false;
  return args.steps.some((step) => {
    const record = asRecord(step);
    return (
      typeof record?.fn === "string" && admittedSteps.has(record.fn)
    );
  });
}

/** Exact public-surface allowlist; central calls never infer a repository. */
export function classifyPublicGraphRetrieval(
  toolName: string,
  args: unknown,
): PublicGraphRetrievalAdmission {
  const request = asRecord(args);
  // Dry-run workflows validate schemas and references without executing steps.
  if (toolName === "sdl.workflow" && request?.dryRun === true) {
    return { mode: "excluded" };
  }
  const central =
    GRAPH_FLAT_TOOLS.has(toolName) ||
    toolName === "sdl.context" ||
    (request !== undefined &&
      ((GATEWAY_TOOLS.has(toolName) &&
        typeof request.action === "string" &&
        GRAPH_ACTIONS.has(request.action)) ||
        (toolName === "sdl.retrieve" &&
          typeof request.op === "string" &&
          RETRIEVE_OPS.has(request.op)) ||
        (toolName === "sdl.file" &&
          typeof request.op === "string" &&
          FILE_WINDOW_OPS.has(request.op)) ||
        (toolName === "sdl.workflow" &&
          hasWorkflowStep(request, GRAPH_WORKFLOW_STEPS))));

  if (central) {
    return {
      mode: "central",
      repoId:
        request !== undefined && typeof request.repoId === "string"
          ? request.repoId
          : undefined,
    };
  }

  const conditional =
    CONDITIONAL_FLAT_TOOLS.has(toolName) ||
    (request !== undefined &&
      ((GATEWAY_TOOLS.has(toolName) &&
        typeof request.action === "string" &&
        CONDITIONAL_GATEWAY_ACTIONS.has(request.action)) ||
        (toolName === "sdl.workflow" &&
          hasWorkflowStep(request, CONDITIONAL_WORKFLOW_STEPS))));

  return conditional ? { mode: "conditional" } : { mode: "excluded" };
}
