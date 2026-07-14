export const CUSTOM_RESPONSE_PROJECTION_ACTIONS = [
  "action.search",
  "code.needWindow",
  "context",
  "delta.get",
  "repo.overview",
  "repo.status",
  "slice.build",
  "symbol.search",
  "usage.stats",
  "workflow",
] as const;

export type ResponseProjectionAction =
  (typeof CUSTOM_RESPONSE_PROJECTION_ACTIONS)[number];

export type ResponseProjector =
  | "actionSearch"
  | "context"
  | "generic"
  | "repoStatus"
  | "usage"
  | "workflow";

export interface ResponseProjectionRule {
  projector: ResponseProjector;
  omitTopLevelFields?: readonly string[];
  showRepoId?: boolean;
  keepTopLevelMatchedLines?: boolean;
  keepNestedWhyApproved?: boolean;
  omitBudget?: boolean;
  omitSymbols?: boolean;
}

type ResponseProjectionEntry = readonly [
  ResponseProjectionAction,
  Readonly<ResponseProjectionRule>,
];

const CUSTOM_ACTION_SET = new Set<string>(CUSTOM_RESPONSE_PROJECTION_ACTIONS);

/** Build the closed custom-projection registry and reject accidental drift. */
export function createResponseProjectionRegistry(
  entries: readonly ResponseProjectionEntry[],
): Readonly<Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>> {
  const registry: Partial<
    Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>
  > = {};
  for (const [action, rule] of entries) {
    if (!CUSTOM_ACTION_SET.has(action)) {
      throw new Error(`Unknown response projection action: ${action}`);
    }
    registry[action] = Object.freeze({ ...rule });
  }

  for (const action of CUSTOM_RESPONSE_PROJECTION_ACTIONS) {
    if (!(action in registry)) {
      throw new Error(`Missing response projection action: ${action}`);
    }
  }

  return Object.freeze(registry) as Readonly<
    Record<ResponseProjectionAction, Readonly<ResponseProjectionRule>>
  >;
}

export const RESPONSE_PROJECTION_RULES = createResponseProjectionRegistry([
  ["action.search", { projector: "actionSearch" }],
  [
    "code.needWindow",
    {
      projector: "generic",
      omitTopLevelFields: ["whyApproved", "estimatedTokens"],
      keepTopLevelMatchedLines: true,
      keepNestedWhyApproved: true,
    },
  ],
  ["context", { projector: "context" }],
  ["delta.get", { projector: "generic", showRepoId: true }],
  ["repo.overview", { projector: "generic", showRepoId: true }],
  ["repo.status", { projector: "repoStatus", showRepoId: true }],
  ["slice.build", { projector: "generic", omitBudget: true }],
  ["symbol.search", { projector: "generic", omitSymbols: true }],
  [
    "usage.stats",
    { projector: "usage", omitTopLevelFields: ["formattedSummary"] },
  ],
  ["workflow", { projector: "workflow", showRepoId: true }],
]);

function canonicalActionName(toolName: string): string {
  return toolName.startsWith("sdl.") ? toolName.slice(4) : toolName;
}

export function getResponseProjectionRule(
  toolName: string,
): Readonly<ResponseProjectionRule> | undefined {
  const action = canonicalActionName(toolName);
  return CUSTOM_ACTION_SET.has(action)
    ? RESPONSE_PROJECTION_RULES[action as ResponseProjectionAction]
    : undefined;
}

const WORKFLOW_CHILD_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  actionSearch: "action.search",
  codeHotPath: "code.getHotPath",
  codeNeedWindow: "code.needWindow",
  codeSkeleton: "code.getSkeleton",
  deltaGet: "delta.get",
  file: "sdl.file",
  sdlFile: "sdl.file",
  fileRead: "file.read",
  fileWrite: "file.write",
  indexRefresh: "index.refresh",
  policyGet: "policy.get",
  policySet: "policy.set",
  prRiskAnalyze: "pr.risk.analyze",
  repoOverview: "repo.overview",
  repoStatus: "repo.status",
  semanticEnrichmentStatus: "semantic.enrichment.status",
  bufferStatus: "buffer.status",
  runtimeExecute: "runtime.execute",
  runtimeQueryOutput: "runtime.queryOutput",
  searchEdit: "search.edit",
  sliceBuild: "slice.build",
  sliceRefresh: "slice.refresh",
  symbolEdit: "symbol.edit",
  symbolGetCard: "symbol.getCard",
  symbolGetCards: "symbol.getCards",
  symbolSearch: "symbol.search",
  usageStats: "usage.stats",
});

export function getWorkflowChildAction(fn: string): string {
  return WORKFLOW_CHILD_ACTIONS[fn] ?? "workflow";
}
