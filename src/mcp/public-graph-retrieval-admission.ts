export type PublicGraphRetrievalAdmission =
  | { required: false }
  | { required: true; repoId: string | undefined };

const GRAPH_ACTIONS = new Set([
  "symbol.search",
  "symbol.getCard",
  "symbol.getCards",
  "slice.build",
  "slice.refresh",
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
  "sdl.symbol.getCards",
  "sdl.slice.build",
  "sdl.slice.refresh",
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
  "symbolGetCards",
  "sliceBuild",
  "sliceRefresh",
  "sliceSpilloverGet",
  "deltaGet",
  "prRiskAnalyze",
  "codeNeedWindow",
  "codeSkeleton",
  "codeHotPath",
  "repoOverview",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasGraphWorkflowStep(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.steps)) return false;
  return args.steps.some((step) => {
    const record = asRecord(step);
    return (
      typeof record?.fn === "string" && GRAPH_WORKFLOW_STEPS.has(record.fn)
    );
  });
}

/** Exact public-surface allowlist; validated calls never infer a repository. */
export function classifyPublicGraphRetrieval(
  toolName: string,
  args: unknown,
): PublicGraphRetrievalAdmission {
  const request = asRecord(args);
  const required =
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
        (toolName === "sdl.workflow" && hasGraphWorkflowStep(request))));

  if (!required) return { required: false };
  return {
    required: true,
    repoId:
      request !== undefined && typeof request.repoId === "string"
        ? request.repoId
        : undefined,
  };
}
