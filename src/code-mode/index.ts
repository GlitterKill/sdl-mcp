import { z } from "zod";
import type { CodeModeConfig } from "../config/types.js";
import { ValidationError } from "../domain/errors.js";
import { buildCompactJsonSchema } from "../gateway/compact-schema.js";
import type { ToolServices } from "../gateway/index.js";
import { createActionMap, type ActionMap } from "../gateway/router.js";
import {
  AgentContextOutputSchema,
  AgentContextRequestSchema,
  InfoResponseSchema,
  WorkflowRuntimeExecuteResponseSchema,
  withProjectionSuccessOutputSchema,
} from "../mcp/tools.js";
import { handleAgentContext } from "../mcp/tools/context.js";
import { handleInfo, InfoRequestSchema } from "../mcp/tools/info.js";
import { projectWorkflowChildResultForModel } from "../mcp/context-response-projection.js";
import {
  assertProjectionProfileInventory,
  assertWorkflowProjectionBindings,
} from "../mcp/response-projection/registry.js";
import {
  ProjectionRequestOptionShape,
  withProjectionRequestOptions,
  withProjectionRequestOptionsJsonSchema,
} from "../mcp/response-projection/request-options.js";
import {
  FileGatewayOutputSchema,
  FileGatewayRequestSchema as FileGatewayDomainRequestSchema,
  handleFileGateway,
} from "../mcp/tools/file-gateway.js";
import type { MCPServer, ToolContext } from "../server.js";
import { estimateTokens } from "../util/tokenize.js";

import { withExclusiveCodeModeRecoveryProjection } from "./action-reference-projection.js";
import {
  INTERNAL_TRANSFORM_SUCCESS_OUTPUT_SCHEMA_BY_ACTION,
  buildCatalog,
  getProjectionCatalogActions,
  rankCatalog,
  type ActionCatalogEntry,
  type SchemaSummaryField,
} from "./action-catalog.js";
import {
  ACTION_SEARCH_DESCRIPTION,
  CONTEXT_DESCRIPTION,
  MANUAL_DESCRIPTION,
  FILE_GATEWAY_DESCRIPTION,
  RETRIEVE_DESCRIPTION,
  WORKFLOW_DESCRIPTION,
} from "./descriptions.js";
import { INTERNAL_TRANSFORM_NAMES } from "./transforms.js";
import {
  buildRetrieveWireSchema,
  handleRetrieve,
  RetrieveOutputSchema,
  RetrieveRequestSchema as RetrieveDomainRequestSchema,
} from "./retrieve.js";
import { executeWorkflow } from "./workflow-executor.js";
import {
  getManualCached,
  getManualIndexCached,
  invalidateManualCache,
  getActiveFnNameMap,
} from "./manual-generator.js";
import { parseWorkflowRequest } from "./workflow-parser.js";

import {
  buildWorkflowPublicOutputSchema,
  WorkflowOutputSchema,
  WorkflowRequestSchema,
  WorkflowTraceOptionsSchema,
} from "./types.js";

const RetrieveRequestSchema = withProjectionRequestOptions(
  RetrieveDomainRequestSchema,
);
const FileGatewayRequestSchema = withProjectionRequestOptions(
  FileGatewayDomainRequestSchema,
);

const TRANSFORM_HINT =
  '\n\n> **Tip:** Data transforms (dataPick, dataMap, dataFilter, dataSort, dataTemplate) are available as sdl.workflow steps. Use sdl.manual({ actions: ["dataPick", "dataMap", "dataFilter", "dataSort", "dataTemplate"] }) for schemas.';

const MCP_WRAPPER_ACTION_ALIASES = new Map<string, string>([
  ["sdl.action.search", "action.search"],
  ["sdl.context", "context"],
  ["sdl.file", "file"],
  ["sdl.manual", "manual"],
  ["sdl.workflow", "workflow"],
]);

function normalizeManualActionSelector(selector: string): string {
  const trimmed = selector.trim();
  const exact = MCP_WRAPPER_ACTION_ALIASES.get(trimmed);
  if (exact) return exact;
  return trimmed.startsWith("sdl.") ? trimmed.slice("sdl.".length) : trimmed;
}

// Give compact discovery responses one stable path to expand selected schemas.
function buildFullSchemaNextAction(actions: readonly string[]): object | undefined {
  if (actions.length === 0) return undefined;
  return {
    action: "sdl.manual",
    args: {
      actions: [...actions],
      includeSchemas: true,
      detail: "full",
      format: "json",
    },
  };
}

const ActionSearchDomainRequestSchema = z.object({
  query: z.string().min(1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum 50 results."),
  offset: z.number().int().min(0).optional().describe("Skip first N results"),
  includeSchemas: z.boolean().default(false),
  includeExamples: z.boolean().default(false),
  /** When true, return only counts and categories instead of full action details */
  summaryOnly: z.boolean().default(false),
  excludeDisabled: z.boolean().default(false),
  detail: ProjectionRequestOptionShape.detail.default("compact"),
  maxTokens: z.number().int().min(500).max(32000).default(4000),
});

export const ActionSearchRequestSchema = withProjectionRequestOptions(
  ActionSearchDomainRequestSchema,
);
const WorkflowActionSearchRequestSchema = withProjectionRequestOptions(
  ActionSearchDomainRequestSchema.partial().safeExtend({
    query: ActionSearchDomainRequestSchema.shape.query,
  }),
);

const ManualDomainRequestSchema = z.object({
  query: z.string().min(1).optional(),
  actions: z.array(z.string().min(1)).optional(),
  format: z.enum(["typescript", "markdown", "json"]).default("typescript"),
  includeSchemas: z.boolean().default(false),
  includeExamples: z.boolean().default(false),
  detail: ProjectionRequestOptionShape.detail.default("compact"),
});

export const ManualRequestSchema = withProjectionRequestOptions(
  ManualDomainRequestSchema,
);

export function handleActionSearch(
  rawArgs: unknown,
  services: ToolServices = {},
): object {
  const rawRecord = rawArgs != null && typeof rawArgs === "object"
    ? rawArgs as Record<string, unknown>
    : {};
  const includeSchemasSpecified = Object.hasOwn(rawRecord, "includeSchemas");
  const includeExamplesSpecified = Object.hasOwn(rawRecord, "includeExamples");
  const args = ActionSearchRequestSchema.parse(rawArgs);
  // Auto-enable schemas + examples when the caller is obviously homing in
  // on a single action (limit=1 or an exact dotted-name query). Without
  // this, the default payload omits enum values so callers frequently
  // guess param shapes wrong.
  const trimmed = normalizeManualActionSelector(args.query.trim());
  const looksLikeExactName =
    /^[a-zA-Z][\w.]*$/.test(trimmed) && trimmed.includes(".");
  const narrowLookup = args.limit === 1 || looksLikeExactName;
  const autoIncludeSchemas = narrowLookup && !includeSchemasSpecified;
  const autoIncludeExamples = narrowLookup && !includeExamplesSpecified;
  const effectiveIncludeSchemas = args.includeSchemas || autoIncludeSchemas;
  const effectiveIncludeExamples = args.includeExamples || autoIncludeExamples;
  const catalog = buildCatalog({
    memoryVisible: services.actionAvailability?.memoryTools,
    infoVisible: services.actionAvailability?.infoTool !== false,
    includeSchemas: effectiveIncludeSchemas,
    includeExamples: effectiveIncludeExamples,
    detail: args.detail === "compact" ? "compact" : "full",
  });

  let allRanked = rankCatalog(catalog, trimmed);
  if (args.summaryOnly && allRanked.length === 0) {
    allRanked = rankCatalog(catalog, "*");
  }
  const disabledRanked = allRanked.filter((a) => a.disabled);
  let filteredRanked = args.excludeDisabled
    ? allRanked.filter((a) => !a.disabled)
    : allRanked;
  const queryTerms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const disabledNamespaces = new Set(
    disabledRanked
      .map((a) => a.action.split(".")[0])
      .filter((namespace) => queryTerms.includes(namespace)),
  );
  if (args.excludeDisabled && disabledNamespaces.size > 0) {
    filteredRanked = filteredRanked.filter((a) =>
      disabledNamespaces.has(a.action.split(".")[0]),
    );
  }
  const offset = args.offset ?? 0;
  const candidates = filteredRanked.slice(offset, offset + args.limit);
  const autoEnabled =
    autoIncludeSchemas || autoIncludeExamples
      ? {
          includeSchemas: autoIncludeSchemas,
          includeExamples: autoIncludeExamples,
          reason: args.limit === 1 ? "limit=1" : "exact-name-query",
        }
      : undefined;
  // Handle summaryOnly mode - return counts/categories instead of full details.
  if (args.summaryOnly) {
    const byKind: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};
    for (const action of filteredRanked) {
      byKind[action.kind] = (byKind[action.kind] ?? 0) + 1;
      const ns = action.action.split(".")[0];
      byNamespace[ns] = (byNamespace[ns] ?? 0) + 1;
    }
    return {
      summary: {
        total: filteredRanked.length,
        byKind,
        byNamespace,
        matchedActions: filteredRanked.map((a) => a.action),
      },
      tokenEstimate: estimateTokens(
        JSON.stringify({
          total: filteredRanked.length,
          byKind,
          byNamespace,
        }),
      ),
    };
  }

  const ranked: ActionCatalogEntry[] = [];
  for (const candidate of candidates) {
    const next = [...ranked, candidate];
    if (
      ranked.length > 0 &&
      estimateTokens(JSON.stringify(next)) > args.maxTokens
    ) {
      break;
    }
    ranked.push(candidate);
  }
  const hasMore = filteredRanked.length > offset + ranked.length;

  // Compute disabled action hints.
  const disabledActions = args.excludeDisabled ? disabledRanked : ranked.filter((a) => a.disabled);
  const disabledHint =
    disabledActions.length > 0
      ? {
          count: disabledActions.length,
          message: `${disabledActions.length} action(s) are disabled. Enable them by updating your sdlmcp.config.json.`,
          actions: disabledActions.map((a) => ({
            action: a.action,
            reason: a.disabledReason ?? "Unknown",
          })),
        }
      : undefined;
  const nextAction = args.detail === "compact"
    ? buildFullSchemaNextAction(ranked.map((action) => action.action))
    : undefined;

  return {
    actions: ranked,
    total: filteredRanked.length,
    disabledHint,
    // Hint when schemas not included.
    ...(!effectiveIncludeSchemas
      ? {
          schemaHint:
            "Tip: Add includeSchemas: true to see parameter types and enum values.",
        }
      : {}),
    hasMore,
    tokenEstimate: estimateTokens(JSON.stringify(ranked)),
    offset,
    limit: args.limit,
    ...(hasMore ? { nextOffset: offset + ranked.length } : {}),
    ...(autoEnabled ? { autoEnabled } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

export function handleManual(
  rawArgs: unknown,
  services: ToolServices = {},
): object {
  const args = ManualRequestSchema.parse(rawArgs);
  const format = args.format;
  const includeSchemas = args.includeSchemas;
  const includeExamples = args.includeExamples;

  const unfocused = !args.query && !args.actions;
  if (unfocused && args.detail !== "full" && format !== "json") {
    const manual = getManualIndexCached(
      services.liveIndex,
      services.actionAvailability?.memoryTools,
      services.actionAvailability?.infoTool !== false,
    );
    return { manual, tokenEstimate: estimateTokens(manual) };
  }

  if (
    unfocused &&
    format === "typescript" &&
    !includeSchemas &&
    !includeExamples
  ) {
    const manual = getManualCached(
      services.liveIndex,
      services.actionAvailability?.memoryTools,
    );
    return { manual, tokenEstimate: estimateTokens(manual) };
  }

  const fullCatalog = buildCatalog({
    memoryVisible: services.actionAvailability?.memoryTools,
    infoVisible: services.actionAvailability?.infoTool !== false,
    includeSchemas: includeSchemas && (!unfocused || args.detail === "full"),
    includeExamples: includeExamples && (!unfocused || args.detail === "full"),
    detail: args.detail === "compact" ? "compact" : "full",
  });
  let catalog = fullCatalog.filter((entry) => !entry.disabled);
  let unknownActions: string[] = [];

  if (args.actions && args.actions.length > 0) {
    const activeFnMap = getActiveFnNameMap(
      services.actionAvailability?.memoryTools,
    );
    const validNames = new Set([
      ...Object.keys(activeFnMap),
      ...Object.values(activeFnMap),
      ...INTERNAL_TRANSFORM_NAMES,
      ...fullCatalog.flatMap((entry) => [entry.action, entry.fn]),
      "workflow",
      "context",
      "manual",
      "action.search",
    ]);

    const matchesSelector = (
      entry: ActionCatalogEntry,
      selector: string,
    ): boolean => {
      if (selector.endsWith(".*")) {
        const prefix = selector.slice(0, -1);
        return entry.action.startsWith(prefix) || entry.fn.startsWith(prefix);
      }
      return entry.action === selector || entry.fn === selector;
    };
    const knownSelector = (selector: string): boolean =>
      validNames.has(selector) ||
      (selector.endsWith(".*") &&
        fullCatalog.some((entry) => matchesSelector(entry, selector)));

    const requestedActions = args.actions.map((action) => ({
      raw: action,
      normalized: normalizeManualActionSelector(action),
    }));
    unknownActions = requestedActions
      .filter((action) => !knownSelector(action.normalized))
      .map((action) => action.raw);
    const knownRequestedActions = requestedActions.filter((action) =>
      knownSelector(action.normalized),
    );
    if (unknownActions.length > 0 && knownRequestedActions.length === 0) {
      const error = new ValidationError(
        `Unknown manual action selector(s): ${unknownActions.join(", ")}`,
      );
      Object.assign(error, {
        details: unknownActions.map(
          (action) => `Unknown action selector: ${action}`,
        ),
        fallbackTools: ["sdl.action.search"],
        fallbackRationale: "Search the enabled action catalog.",
      });
      throw error;
    }

    const filtered: ActionCatalogEntry[] = [];
    for (const { normalized: name } of knownRequestedActions) {
      const matches = fullCatalog.filter((entry) =>
        matchesSelector(entry, name),
      );
      for (const match of matches) {
        if (!filtered.includes(match)) {
          filtered.push(match);
        }
      }
    }
    catalog = filtered;
  } else if (args.query) {
    catalog = rankCatalog(fullCatalog, args.query);
  }
  if (format === "json") {
    return {
      actions: catalog,
      tokenEstimate: estimateTokens(JSON.stringify(catalog)),
      ...(unknownActions.length > 0
        ? {
            unknownActions,
            warning: `Ignored unknown action selector(s): ${unknownActions.join(", ")}`,
          }
        : {}),
    };
  }

  const rendered =
    format === "markdown" ? renderMarkdown(catalog) : renderTypescript(catalog);
  const withTransforms = rendered + TRANSFORM_HINT;
  return {
    manual: withTransforms,
    tokenEstimate: estimateTokens(withTransforms),
    ...(unknownActions.length > 0
      ? {
          unknownActions,
          warning: `Ignored unknown action selector(s): ${unknownActions.join(", ")}`,
        }
      : {}),
  };
}

const PUBLIC_CATALOG_RECORD_KEY_SCHEMA = z.string().refine(
  (key) =>
    !key.startsWith("__")
    && !["sessionId", "absolutePath", "timestamp", "privateField"].includes(key),
  { message: "Private catalog fields are not public" },
);
const PublicCatalogValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PublicCatalogValueSchema),
    z.record(PUBLIC_CATALOG_RECORD_KEY_SCHEMA, PublicCatalogValueSchema),
  ]),
);
const PublicCatalogRecordSchema = z.record(
  PUBLIC_CATALOG_RECORD_KEY_SCHEMA,
  PublicCatalogValueSchema,
);
const PublicSchemaSummaryVariantSchema = z
  .object({
    value: z.string(),
    requiredFields: z.array(z.string()),
  })
  .strict();
const PublicSchemaSummaryFieldSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      default: PublicCatalogValueSchema.optional(),
      enumValues: z.array(z.string()).optional(),
      nestedFieldCount: z.number().int().nonnegative().optional(),
      description: z.string().optional(),
      subFields: z.array(PublicSchemaSummaryFieldSchema).optional(),
      discriminator: z.string().optional(),
      variants: z.array(PublicSchemaSummaryVariantSchema).optional(),
    })
    .strict(),
);
const PublicActionCatalogEntrySchema = z
  .object({
    action: z.string(),
    fn: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(
      z.enum([
        "query",
        "code",
        "repo",
        "policy",
        "agent",
        "buffer",
        "runtime",
        "memory",
        "transform",
        "meta",
        "mutation",
      ]),
    ).optional(),
    kind: z.enum(["gateway", "internal", "meta"]).optional(),
    estTokens: z.number().int().nonnegative().optional(),
    prerequisites: z.array(z.string()).optional(),
    recommendedNextActions: z.array(z.string()).optional(),
    fallbacks: z.array(z.string()).optional(),
    requiredParams: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    disabledReason: z.string().optional(),
    schemaSummary: z
      .object({ fields: z.array(PublicSchemaSummaryFieldSchema) })
      .strict()
      .optional(),
    example: PublicCatalogRecordSchema.optional(),
  })
  .strict();

const ActionSearchSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    byKind: z.record(z.string(), z.number().int().nonnegative()).optional(),
    byNamespace: z.record(z.string(), z.number().int().nonnegative()).optional(),
    matchedActions: z.array(z.string()).optional(),
  })
  .strict();
const ActionSearchDisabledHintSchema = z
  .object({
    count: z.number().int().nonnegative(),
    message: z.string(),
    actions: z.array(
      z.object({ action: z.string(), reason: z.string() }).strict(),
    ),
  })
  .strict();
const ActionSearchAutoEnabledSchema = z
  .object({
    includeSchemas: z.boolean(),
    includeExamples: z.boolean(),
    reason: z.enum(["limit=1", "exact-name-query"]),
  })
  .strict();
const ActionSearchNextActionSchema = z.union([
  z
    .object({
      action: z.string(),
      args: PublicCatalogRecordSchema,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      args: PublicCatalogRecordSchema,
    })
    .strict(),
]);

const CompositeHandledOuterShape = {
  kind: z.unknown().optional(),
  handle: z.unknown().optional(),
};
const RETRIEVE_ADVERTISED_OUTPUT_SCHEMA = z.looseObject({
  results: z.unknown().optional(),
  card: z.unknown().optional(),
  slice: z.unknown().optional(),
  approved: z.unknown().optional(),
  ...CompositeHandledOuterShape,
});
const WORKFLOW_ADVERTISED_OUTPUT_SCHEMA = z.looseObject({
  results: z.unknown().optional(),
  ...CompositeHandledOuterShape,
});
const FILE_ADVERTISED_OUTPUT_SCHEMA = z.looseObject({
  filePath: z.unknown().optional(),
  mode: z.unknown().optional(),
  ...CompositeHandledOuterShape,
});

const ACTION_SEARCH_OUTPUT_SCHEMA = z.object({
  actions: z.array(PublicActionCatalogEntrySchema).optional(),
  summary: ActionSearchSummarySchema.optional(),
  total: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  disabledHint: ActionSearchDisabledHintSchema.optional(),
  schemaHint: z.string().optional(),
  autoEnabled: ActionSearchAutoEnabledSchema.optional(),
  nextAction: ActionSearchNextActionSchema.optional(),
}).strict();

const MANUAL_OUTPUT_SCHEMA = z.object({
  manual: z.string().optional(),
  actions: z.array(PublicActionCatalogEntrySchema).optional(),
  tokenEstimate: z.number().int().nonnegative().optional(),
  unknownActions: z.array(z.string()).optional(),
  warning: z.string().optional(),
}).strict();

export function registerActionSearchTool(
  server: MCPServer,
  services: ToolServices,
): void {
  invalidateManualCache();
  server.registerTool(
    "sdl.action.search",
    ACTION_SEARCH_DESCRIPTION,
    ActionSearchRequestSchema,
    async (rawArgs: unknown) => handleActionSearch(rawArgs, services),
    withProjectionRequestOptionsJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0 },
        maxTokens: {
          type: "integer",
          minimum: 500,
          maximum: 32000,
          default: 4000,
        },
        includeSchemas: { type: "boolean" },
        includeExamples: { type: "boolean" },
        summaryOnly: {
          type: "boolean",
          description: "Return only counts and categories",
        },
        excludeDisabled: {
          type: "boolean",
          description: "Hide disabled actions from results",
        },
      },
      required: ["query"],
      additionalProperties: false,
    }, ActionSearchRequestSchema),
    undefined,
    ACTION_SEARCH_OUTPUT_SCHEMA,
  );
}

export function assertCodeModeProjectionProfiles(): void {
  assertProjectionProfileInventory(getProjectionCatalogActions());
  assertWorkflowProjectionBindings(getActiveFnNameMap(true));
}

/**
 * Register Code Mode tools (sdl.manual + sdl.workflow + sdl.context + sdl.file) on the MCP server.
 *
 * @param prebuiltActionMap Optional pre-built action map to avoid duplicate creation
 *   when code-mode is registered alongside gateway.
 */
export function registerCodeModeTools(
  server: MCPServer,
  services: ToolServices,
  config: CodeModeConfig,
  prebuiltActionMap?: ActionMap,
  publicSuccessOutputSchemaByAction: ReadonlyMap<string, z.ZodType> = new Map(),
): void {
  assertCodeModeProjectionProfiles();
  const actionMap = prebuiltActionMap ?? createActionMap(
    services.liveIndex,
    services.actionAvailability,
  );
  // Meta tools are not gateway actions, but the manual documents them as
  // workflow steps. Extend the
  // workflow-facing map (copy, not mutation — the base map is shared with
  // gateway registration) so those steps route to the meta handler. The
  // permissive META schema defers default-filling to handleActionSearch so
  // its narrow-lookup auto-include heuristic still sees the raw args.
  const workflowActionMap: ActionMap = {
    ...actionMap,
    "action.search": {
      schema: WorkflowActionSearchRequestSchema,
      handler: async (args: unknown) => handleActionSearch(args, services),
    },
    info: {
      schema: InfoRequestSchema,
      handler: async (args: unknown) => handleInfo(args),
    },
  };
  const activeGatewayBindings = Object.entries(
    getActiveFnNameMap(services.actionAvailability?.memoryTools),
  ).filter(([, action]) => Object.hasOwn(workflowActionMap, action));
  const activeGatewayFunctions = activeGatewayBindings.map(([fn]) => fn);
  const actionSearchOutputSchema = ACTION_SEARCH_OUTPUT_SCHEMA;
  const workflowSuccessOutputSchemaByFn = Object.fromEntries([
    ["actionSearch", actionSearchOutputSchema],
    ["action.search", actionSearchOutputSchema],
    ...activeGatewayBindings.flatMap(([fn, action]) => {
      const outputSchema =
        action === "action.search"
          ? withProjectionSuccessOutputSchema(
              action,
              ACTION_SEARCH_OUTPUT_SCHEMA,
            )
          : action === "runtime.execute"
            ? WorkflowRuntimeExecuteResponseSchema
            : action === "info"
              ? withProjectionSuccessOutputSchema(action, InfoResponseSchema)
              : publicSuccessOutputSchemaByAction.get(action);
      return outputSchema === undefined ? [] : [[fn, outputSchema] as const];
    }),
    ...Object.entries(INTERNAL_TRANSFORM_SUCCESS_OUTPUT_SCHEMA_BY_ACTION),
  ]);
  // Direct unit harnesses may omit the flat descriptor map; production registration
  // always supplies it so the advertised workflow schema remains action-specific.
  const workflowOutputSchema =
    publicSuccessOutputSchemaByAction.size === 0
      ? WorkflowOutputSchema
      : buildWorkflowPublicOutputSchema(workflowSuccessOutputSchemaByFn);
  // Recovery validation uses the same fixed functions and dispatch map as this server.
  server.setActiveWorkflowFunctions?.([
    ...activeGatewayFunctions,
    ...INTERNAL_TRANSFORM_NAMES,
    "actionSearch",
  ]);

  server.registerTool(
    "sdl.manual",
    MANUAL_DESCRIPTION,
    ManualRequestSchema,
    async (rawArgs: unknown) => handleManual(rawArgs, services),
    withProjectionRequestOptionsJsonSchema({
      type: "object",
      properties: {
        query: { type: "string" },
        actions: { type: "array", items: { type: "string" } },
        format: { type: "string", enum: ["typescript", "markdown", "json"] },
        includeSchemas: { type: "boolean" },
        includeExamples: { type: "boolean" },
      },
      additionalProperties: false,
    }, ManualRequestSchema),
    undefined,
    MANUAL_OUTPUT_SCHEMA,
  );

  server.registerTool(
    "sdl.retrieve",
    RETRIEVE_DESCRIPTION,
    RetrieveRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) =>
      withExclusiveCodeModeRecoveryProjection(
        config.exclusive,
        () => handleRetrieve(rawArgs, actionMap, context),
        rawArgs,
      ),
    withProjectionRequestOptionsJsonSchema(
      buildRetrieveWireSchema(actionMap),
      RetrieveRequestSchema,
    ),
    undefined,
    RETRIEVE_ADVERTISED_OUTPUT_SCHEMA,
    RetrieveOutputSchema,
  );

  server.registerTool(
    "sdl.workflow",
    WORKFLOW_DESCRIPTION,
    WorkflowRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) => {
      const parsed = parseWorkflowRequest(
        rawArgs,
        services.actionAvailability?.memoryTools,
      );
      if (!parsed.ok) {
        const error = new ValidationError("Invalid sdl.workflow request");
        Object.assign(error, { details: parsed.errors });
        throw error;
      }

      const rawObject = rawArgs as Record<string, unknown>;
      const traceOpts = rawObject.trace
        ? WorkflowTraceOptionsSchema.parse(rawObject.trace)
        : undefined;

      return withExclusiveCodeModeRecoveryProjection(
        config.exclusive,
        () =>
          executeWorkflow(
            parsed.request,
            workflowActionMap,
            config,
            context,
            traceOpts,
            (fn, result, args, projectionOptions) =>
              projectWorkflowChildResultForModel(
                fn,
                result,
                { ...rawObject, ...projectionOptions },
                { ...args, ...projectionOptions },
              ),
          ),
        rawArgs,
      );
    },
    buildCompactJsonSchema(WorkflowRequestSchema),
    undefined,
    WORKFLOW_ADVERTISED_OUTPUT_SCHEMA,
    workflowOutputSchema,
  );

  server.registerTool(
    "sdl.context",
    CONTEXT_DESCRIPTION,
    AgentContextRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) =>
      handleAgentContext(rawArgs, context, services.contextEngine),
    buildCompactJsonSchema(AgentContextRequestSchema),
    undefined,
    AgentContextOutputSchema,
  );

  server.registerTool(
    "sdl.file",
    FILE_GATEWAY_DESCRIPTION,
    FileGatewayRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) =>
      withExclusiveCodeModeRecoveryProjection(
        config.exclusive,
        () => handleFileGateway(rawArgs, context),
        rawArgs,
      ),
    withProjectionRequestOptionsJsonSchema({
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "read",
            "write",
            "searchEditPreview",
            "searchEditApply",
            "symbolEditPreview",
            "symbolEditApply",
            "symbolEditApplyNow",
            "previewWindow",
            "sourceWindow",
          ],
        },
        repoId: { type: "string", minLength: 1 },
        filePath: { type: "string" },
        maxBytes: { type: "number" },
        offset: { type: "number" },
        limit: { type: "number" },
        search: { type: "string" },
        searchContext: { type: "number" },
        jsonPath: { type: "string" },
        responseMode: {
          type: "string",
          enum: ["inline", "auto", "handle"],
        },
        deltaMode: { type: "string", enum: ["off", "auto"] },
        maxDeltaLines: { type: "number" },
        content: { type: "string" },
        replaceLines: { type: "object" },
        replacePattern: { type: "object" },
        jsonValue: {},
        insertAt: { type: "object" },
        append: { type: "string" },
        createBackup: { type: "boolean" },
        createIfMissing: { type: "boolean" },
        targeting: {
          type: "string",
          enum: ["text", "symbol", "identifier", "structural"],
        },
        query: { type: "object" },
        operations: {
          type: "array",
          items: { type: "object" },
        },
        filters: { type: "object" },
        editMode: { type: "string" },
        previewContextLines: { type: "number" },
        maxFiles: { type: "number" },
        maxMatchesPerFile: { type: "number" },
        maxTotalMatches: { type: "number" },
        planHandle: { type: "string" },
        symbolId: { type: "string" },
        symbolRef: { type: "object" },
        operation: { type: "object" },
        expectedAstFingerprint: { type: "string" },
        expectedRange: { type: "object" },
        reason: { type: "string" },
        expectedLines: { type: "number" },
        identifiersToFind: { type: "array", items: { type: "string" } },
        granularity: {
          type: "string",
          enum: ["symbol", "block", "fileWindow"],
        },
        maxTokens: { type: "number" },
        sliceContext: { type: "object" },
        cursor: { type: "number" },
        ifNoneMatch: { type: "string" },
      },
      required: ["op", "repoId"],
      additionalProperties: false,
    }, FileGatewayRequestSchema),
    undefined,
    FILE_ADVERTISED_OUTPUT_SCHEMA,
    FileGatewayOutputSchema,
  );
}

function renderTypescriptFieldType(field: SchemaSummaryField): string {
  if (
    field.type !== "object" ||
    !field.discriminator ||
    !field.variants?.length
  ) {
    return field.type;
  }
  return field.variants
    .map((variant) => {
      const requiredFields = variant.requiredFields
        .filter((name) => name !== field.discriminator)
        .map((name) => `${name}: unknown`);
      return `{ ${[
        `${field.discriminator}: ${JSON.stringify(variant.value)}`,
        ...requiredFields,
      ].join("; ")} }`;
    })
    .join(" | ");
}

function renderTypescript(catalog: ActionCatalogEntry[]): string {
  const lines: string[] = [
    "// SDL-MCP API - use with sdl.workflow for multi-step operations",
    "// Prefer sdl.context for explain/debug/review/implement context retrieval.",
    "// repoId is set in the workflow envelope and auto-injected into every",
    "// gateway step, so it is omitted from per-step signatures below.",
    "// Reference prior step results with $N (e.g., $0.results[0].symbolId).",
    '// wireFormat="auto" (default for slice.build / symbol.search /',
    "// sdl.context) returns either a JSON object OR a packed `#PACKED/...`",
    "// string when packed encoding saves tokens; check the response shape.",
    "",
  ];

  for (const descriptor of catalog) {
    const topLevelOnly =
      descriptor.kind === "meta" && descriptor.action !== "action.search";
    lines.push(`/** ${descriptor.description} */`);
    if (topLevelOnly) {
      lines.push(
        `// Top-level only: call sdl.${descriptor.action} directly; not valid as an sdl.workflow step.`,
      );
    }
    if (descriptor.disabled) {
      lines.push(`// Disabled: ${descriptor.disabledReason ?? "not enabled"}`);
    }
    if (descriptor.prerequisites.length > 0) {
      lines.push(`// Prerequisites: ${descriptor.prerequisites.join(", ")}`);
    }

    if (descriptor.recommendedNextActions.length > 0) {
      lines.push(`// Next: ${descriptor.recommendedNextActions.join(", ")}`);
    }
    if (descriptor.fallbacks.length > 0) {
      lines.push(`// Fallbacks: ${descriptor.fallbacks.join(", ")}`);
    }
    if (descriptor.schemaSummary) {
      const params = descriptor.schemaSummary.fields
        .map(
          (field) =>
            `${field.name}${field.required ? "" : "?"}: ${renderTypescriptFieldType(field)}`,
        )
        .join("; ");
      lines.push(
        topLevelOnly
          ? `// sdl.${descriptor.action}(p: { ${params} }): object`
          : `function ${descriptor.fn}(p: { ${params} }): object`,
      );
    } else {
      lines.push(
        topLevelOnly
          ? `// sdl.${descriptor.action}(p: object): object`
          : `function ${descriptor.fn}(p: object): object`,
      );
    }
    if (descriptor.schemaSummary) {
      for (const field of descriptor.schemaSummary.fields) {
        if (field.description) {
          lines.push(`//   ${field.name}: ${field.description}`);
        }
        if (field.subFields && field.subFields.length > 0) {
          const subParams = field.subFields
            .map(
              (subField) =>
                `${subField.name}${subField.required ? "" : "?"}: ${subField.type}`,
            )
            .join("; ");
          lines.push(`//   ${field.name} shape: { ${subParams} }`);
        }
      }
    }
    if (descriptor.example) {
      lines.push(
        `// Example: ${descriptor.fn}(${JSON.stringify(descriptor.example)})`,
      );
    }
  }

  return lines.join("\n");
}

function renderMarkdown(catalog: ActionCatalogEntry[]): string {
  const lines: string[] = [
    "# SDL-MCP API Reference",
    "",
    "Use with `sdl.workflow` for multi-step operations. Prefer `sdl.context` for context retrieval.",
    "",
  ];

  for (const descriptor of catalog) {
    const topLevelOnly =
      descriptor.kind === "meta" && descriptor.action !== "action.search";
    lines.push(`## \`${descriptor.fn}\` (\`${descriptor.action}\`)`);
    lines.push("");
    lines.push(descriptor.description);
    lines.push("");
    if (descriptor.disabled) {
      lines.push(
        `- **Status**: disabled (${descriptor.disabledReason ?? "not enabled"})`,
      );
    }

    lines.push(`- **Kind**: ${descriptor.kind}`);
    lines.push(
      topLevelOnly
        ? `- **Invocation**: top-level tool \`sdl.${descriptor.action}\` only; not an \`sdl.workflow\` step`
        : "- **Invocation**: `sdl.workflow` step",
    );
    lines.push(`- **Tags**: ${descriptor.tags.join(", ")}`);
    if (descriptor.prerequisites.length > 0) {
      lines.push(`- **Prerequisites**: ${descriptor.prerequisites.join(", ")}`);
    }
    if (descriptor.recommendedNextActions.length > 0) {
      lines.push(
        `- **Recommended next**: ${descriptor.recommendedNextActions.join(", ")}`,
      );
    }
    if (descriptor.fallbacks.length > 0) {
      lines.push(`- **Fallbacks**: ${descriptor.fallbacks.join(", ")}`);
    }

    if (descriptor.schemaSummary) {
      lines.push("");
      lines.push("| Parameter | Type | Required | Default | Description |");
      lines.push("|-----------|------|----------|---------|-------------|");
      for (const field of descriptor.schemaSummary.fields) {
        const defaultValue =
          field.default !== undefined ? JSON.stringify(field.default) : "";
        lines.push(
          `| ${field.name} | ${field.type} | ${field.required ? "yes" : "no"} | ${defaultValue} | ${field.description ?? ""} |`,
        );
      }
      for (const field of descriptor.schemaSummary.fields) {
        if (field.subFields && field.subFields.length > 0) {
          lines.push("");
          lines.push(`**${field.name}** shape:`);
          lines.push("");
          lines.push("| Field | Type | Required | Default | Description |");
          lines.push("|-------|------|----------|---------|-------------|");
          for (const subField of field.subFields) {
            const defaultValue =
              subField.default !== undefined
                ? JSON.stringify(subField.default)
                : "";
            lines.push(
              `| ${subField.name} | ${subField.type} | ${subField.required ? "yes" : "no"} | ${defaultValue} | ${subField.description ?? ""} |`,
            );
          }
        }
        if (field.discriminator && field.variants?.length) {
          lines.push("");
          lines.push(
            `**${field.name}**: discriminated union on ${field.discriminator}`,
          );
          lines.push("");
          lines.push("| Variant | Required fields |");
          lines.push("|---------|-----------------|");
          for (const variant of field.variants) {
            lines.push(
              `| ${variant.value} | required: ${variant.requiredFields.join(", ")} |`,
            );
          }
        }
      }
    }

    if (descriptor.example) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(descriptor.example, null, 2));
      lines.push("```");
    }

    lines.push("");
  }

  // Step reference patterns for workflow users
  lines.push("## Step Reference Patterns");
  lines.push("");
  lines.push("Use `$N.field` to reference results from prior workflow steps:");
  lines.push("");
  lines.push("| Pattern | Description |");
  lines.push("|---------|-------------|");
  lines.push("| `$0.results[0].symbolId` | First symbol ID from search |");
  lines.push("| `$0.card.symbolId` | Symbol ID from getCard |");
  lines.push("| `$0.slice.si[0]` | First symbol in slice (compact) |");
  lines.push("| `$0.sliceHandle` | Handle from slice.build |");
  lines.push("| `$0.artifactHandle` | Handle from runtime.execute |");
  lines.push(
    "| `$0.truncatedResponse.continuationHandle` | Handle for a truncated workflow step result |",
  );
  lines.push("| `$0.skeleton` | Skeleton IR string |");
  lines.push("| `$0.excerpt` | Hot-path excerpt string |");
  lines.push("| `$N.result.fieldName` | Any field from step N result |");
  lines.push("");
  return lines.join("\n");
}
