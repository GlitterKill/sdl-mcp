import { z } from "zod";

import {
  AgentContextRequestSchema,
  AgentFeedbackQueryRequestSchema,
  AgentFeedbackRequestSchema,
  BufferCheckpointRequestSchema,
  BufferPushRequestSchema,
  BufferStatusRequestSchema,
  CodeNeedWindowRequestSchema,
  DeltaGetRequestSchema,
  FileReadRequestSchema,
  FileWriteRequestSchema,
  GetHotPathRequestSchema,
  GetSkeletonRequestSchema,
  IndexRefreshRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemoryStoreRequestSchema,
  MemorySurfaceRequestSchema,
  PolicyGetRequestSchema,
  PolicySetRequestSchema,
  PRRiskAnalysisRequestSchema,
  RepoOverviewRequestSchema,
  RepoRegisterRequestSchema,
  RepoStatusRequestSchema,
  RepoUnregisterRequestSchema,
  ResponseGetRequestSchema,
  RuntimeExecuteRequestSchema,
  RuntimeQueryOutputRequestSchema,
  SearchEditRequestSchema,
  SemanticEnrichmentRefreshRequestSchema,
  SemanticEnrichmentStatusRequestSchema,
  SliceBuildRequestSchema,
  SliceRefreshRequestSchema,
  SliceSpilloverGetRequestSchema,
  SymbolEditRequestSchema,
  SymbolGetCardRequestSchema,
  SymbolSearchRequestSchema,
  UsageStatsRequestSchema,
} from "../mcp/tools.js";
import { FileGatewayRequestSchema } from "../mcp/tools/file-gateway-schema.js";
import { InfoRequestSchema } from "../mcp/tools/info.js";

import { INTERNAL_TRANSFORMS } from "./transforms.js";
import { RetrieveRequestSchema } from "./retrieve-schema.js";
import { WorkflowRequestSchema } from "./types.js";

export interface RecoveryActionDefinition {
  readonly action: string;
  readonly fn: string | null;
  readonly toolName: string | null;
  readonly schema: z.ZodType;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly kind: "gateway" | "internal" | "meta";
}

/**
 * Gateway schemas and workflow bindings share one dependency-light registry so
 * recovery validation never depends on action-catalog import side effects.
 */
export const RECOVERY_GATEWAY_ACTION_SCHEMAS = [
  ["symbol.search", "symbolSearch", SymbolSearchRequestSchema],
  ["symbol.getCard", "symbolGetCard", SymbolGetCardRequestSchema],
  ["symbol.edit", "symbolEdit", SymbolEditRequestSchema],
  ["slice.build", "sliceBuild", SliceBuildRequestSchema],
  ["slice.refresh", "sliceRefresh", SliceRefreshRequestSchema],
  ["slice.spillover.get", "sliceSpilloverGet", SliceSpilloverGetRequestSchema],
  ["delta.get", "deltaGet", DeltaGetRequestSchema],
  ["pr.risk.analyze", "prRiskAnalyze", PRRiskAnalysisRequestSchema],
  ["code.needWindow", "codeNeedWindow", CodeNeedWindowRequestSchema],
  ["code.getSkeleton", "codeSkeleton", GetSkeletonRequestSchema],
  ["code.getHotPath", "codeHotPath", GetHotPathRequestSchema],
  ["repo.register", "repoRegister", RepoRegisterRequestSchema],
  ["repo.status", "repoStatus", RepoStatusRequestSchema],
  ["repo.unregister", "repoUnregister", RepoUnregisterRequestSchema],
  ["repo.overview", "repoOverview", RepoOverviewRequestSchema],
  ["index.refresh", "indexRefresh", IndexRefreshRequestSchema],
  ["policy.get", "policyGet", PolicyGetRequestSchema],
  ["policy.set", "policySet", PolicySetRequestSchema],
  ["usage.stats", "usageStats", UsageStatsRequestSchema],
  ["file.read", "fileRead", FileReadRequestSchema],
  ["file.write", "fileWrite", FileWriteRequestSchema],
  ["search.edit", "searchEdit", SearchEditRequestSchema],
  [
    "semantic.enrichment.refresh",
    "semanticEnrichmentRefresh",
    SemanticEnrichmentRefreshRequestSchema,
  ],
  [
    "semantic.enrichment.status",
    "semanticEnrichmentStatus",
    SemanticEnrichmentStatusRequestSchema,
  ],
  ["agent.feedback", "agentFeedback", AgentFeedbackRequestSchema],
  [
    "agent.feedback.query",
    "agentFeedbackQuery",
    AgentFeedbackQueryRequestSchema,
  ],
  ["buffer.push", "bufferPush", BufferPushRequestSchema],
  ["buffer.checkpoint", "bufferCheckpoint", BufferCheckpointRequestSchema],
  ["buffer.status", "bufferStatus", BufferStatusRequestSchema],
  ["runtime.execute", "runtimeExecute", RuntimeExecuteRequestSchema],
  ["runtime.queryOutput", "runtimeQueryOutput", RuntimeQueryOutputRequestSchema],
  ["response.get", "responseGet", ResponseGetRequestSchema],
  ["memory.store", "memoryStore", MemoryStoreRequestSchema],
  ["memory.query", "memoryQuery", MemoryQueryRequestSchema],
  ["memory.remove", "memoryRemove", MemoryRemoveRequestSchema],
  ["memory.surface", "memorySurface", MemorySurfaceRequestSchema],
] as const satisfies ReadonlyArray<
  readonly [action: string, fn: string, schema: z.ZodType]
>;

export const RECOVERY_FN_NAME_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    RECOVERY_GATEWAY_ACTION_SCHEMAS.map(([action, fn]) => [fn, action]),
  ),
);

export const RECOVERY_GATEWAY_ACTION_DEFINITIONS: readonly RecoveryActionDefinition[] =
  Object.freeze(
    RECOVERY_GATEWAY_ACTION_SCHEMAS.map(([action, fn, schema]) =>
      Object.freeze({
        action,
        fn,
        toolName: `sdl.${action}`,
        schema,
        ...(action === "code.getSkeleton"
          ? { aliases: Object.freeze({ filePath: "file" }) }
          : {}),
        kind: "gateway" as const,
      }),
    ),
  );

const RECOVERY_META_ACTION_SEARCH_SCHEMA = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
  includeSchemas: z.boolean().optional(),
  includeExamples: z.boolean().optional(),
  excludeDisabled: z.boolean().optional(),
  summaryOnly: z.boolean().optional(),
  detail: z.enum(["compact", "standard", "full"]).optional().default("compact"),
  maxTokens: z.number().int().min(500).max(32000).optional().default(4000),
});

const RECOVERY_META_MANUAL_SCHEMA = z.object({
  format: z.enum(["typescript", "markdown", "json"]).optional(),
  query: z.string().optional(),
  actions: z.array(z.string()).optional(),
  includeSchemas: z.boolean().optional(),
  includeExamples: z.boolean().optional(),
  detail: z.enum(["compact", "standard", "full"]).optional().default("compact"),
});

const RECOVERY_META_ACTION_SCHEMAS = [
  ["action.search", RECOVERY_META_ACTION_SEARCH_SCHEMA],
  ["info", InfoRequestSchema],
  ["manual", RECOVERY_META_MANUAL_SCHEMA],
  ["context", AgentContextRequestSchema],
  ["file", FileGatewayRequestSchema],
  ["retrieve", RetrieveRequestSchema],
  ["workflow", WorkflowRequestSchema],
] as const satisfies ReadonlyArray<
  readonly [action: string, schema: z.ZodType]
>;

const META_RECOVERY_ACTION_DEFINITIONS: readonly RecoveryActionDefinition[] =
  Object.freeze(
    RECOVERY_META_ACTION_SCHEMAS.map(([action, schema]) =>
      Object.freeze({
        action,
        fn: null,
        toolName: `sdl.${action}`,
        schema,
        kind: "meta" as const,
      }),
    ),
  );

const INTERNAL_RECOVERY_ACTION_DEFINITIONS: readonly RecoveryActionDefinition[] =
  Object.freeze(
    Object.entries(INTERNAL_TRANSFORMS).map(([fn, transform]) =>
      Object.freeze({
        action: fn,
        fn,
        toolName: null,
        schema: transform.schema,
        kind: "internal" as const,
      }),
    ),
  );

const RECOVERY_ACTION_DEFINITION_BY_ACTION: Readonly<
  Record<string, RecoveryActionDefinition>
> = Object.freeze(
  Object.fromEntries(
    [
      ...RECOVERY_GATEWAY_ACTION_DEFINITIONS,
      ...INTERNAL_RECOVERY_ACTION_DEFINITIONS,
      ...META_RECOVERY_ACTION_DEFINITIONS,
    ].map((definition) => [definition.action, definition]),
  ),
);

/** Resolve canonical, flat-tool, and workflow-fn names without load-order state. */
export function resolveRecoveryActionDefinition(
  actionOrToolName: string,
): RecoveryActionDefinition | undefined {
  const unprefixed = actionOrToolName.startsWith("sdl.")
    ? actionOrToolName.slice("sdl.".length)
    : actionOrToolName;
  const action = Object.hasOwn(RECOVERY_FN_NAME_MAP, unprefixed)
    ? RECOVERY_FN_NAME_MAP[unprefixed]
    : unprefixed;
  return Object.hasOwn(RECOVERY_ACTION_DEFINITION_BY_ACTION, action)
    ? RECOVERY_ACTION_DEFINITION_BY_ACTION[action]
    : undefined;
}

/** Resolve the registry's canonical workflow function without runtime config. */
export function resolveRecoveryWorkflowFunction(
  actionOrToolName: string,
): string | undefined {
  const definition = resolveRecoveryActionDefinition(actionOrToolName);
  if (!definition?.fn) return undefined;

  if (definition.kind === "gateway") {
    return RECOVERY_FN_NAME_MAP[definition.fn] === definition.action
      ? definition.fn
      : undefined;
  }
  if (definition.kind === "internal") {
    return Object.hasOwn(INTERNAL_TRANSFORMS, definition.fn)
      ? definition.fn
      : undefined;
  }
  return undefined;
}
