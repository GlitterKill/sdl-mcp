import { z } from "zod";
import type { CodeModeConfig } from "../config/types.js";
import { ValidationError } from "../domain/errors.js";
import type { ToolServices } from "../gateway/index.js";
import { createActionMap, type ActionMap } from "../gateway/router.js";
import { AgentContextRequestSchema } from "../mcp/tools.js";
import { handleAgentContext } from "../mcp/tools/context.js";
import {
  FileGatewayRequestSchema,
  handleFileGateway,
} from "../mcp/tools/file-gateway.js";
import type { MCPServer, ToolContext } from "../server.js";
import { estimateTokens } from "../util/tokenize.js";
import {
  buildCatalog,
  rankCatalog,
  type ActionDescriptor,
} from "./action-catalog.js";
import {
  ACTION_SEARCH_DESCRIPTION,
  CONTEXT_DESCRIPTION,
  MANUAL_DESCRIPTION,
  FILE_GATEWAY_DESCRIPTION,
  WORKFLOW_DESCRIPTION,
} from "./descriptions.js";
import { INTERNAL_TRANSFORM_NAMES } from "./transforms.js";
import { executeWorkflow } from "./workflow-executor.js";
import {
  getManualCached,
  invalidateManualCache,
  getActiveFnNameMap,
} from "./manual-generator.js";
import { parseWorkflowRequest } from "./workflow-parser.js";

import { WorkflowRequestSchema, WorkflowTraceOptionsSchema } from "./types.js";

const TRANSFORM_HINT =
  '\n\n> **Tip:** Data transforms (dataPick, dataMap, dataFilter, dataSort, dataTemplate) are available as sdl.workflow steps. Use sdl.manual({ actions: ["dataPick", "dataMap", "dataFilter", "dataSort", "dataTemplate"] }) for schemas.';

export const ActionSearchRequestSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).optional().describe("Skip first N results"),
  includeSchemas: z.boolean().default(false),
  includeExamples: z.boolean().default(false),
  /** When true, return only counts and categories instead of full action details */
  summaryOnly: z.boolean().default(false),
  excludeDisabled: z.boolean().default(false),
});

export function registerActionSearchTool(
  server: MCPServer,
  services: ToolServices,
): void {
  invalidateManualCache();
  server.registerTool(
    "sdl.action.search",
    ACTION_SEARCH_DESCRIPTION,
    ActionSearchRequestSchema,
    async (rawArgs: unknown) => {
      const args = ActionSearchRequestSchema.parse(rawArgs);
      // Auto-enable schemas + examples when the caller is obviously homing in
      // on a single action (limit=1 or an exact dotted-name query). Without
      // this, the default payload omits enum values so callers frequently
      // guess param shapes wrong.
      const trimmed = args.query.trim();
      const looksLikeExactName =
        /^[a-zA-Z][\w.]*$/.test(trimmed) && trimmed.includes(".");
      const narrowLookup = args.limit === 1 || looksLikeExactName;
      const effectiveIncludeSchemas = args.includeSchemas || narrowLookup;
      const effectiveIncludeExamples = args.includeExamples || narrowLookup;
      const catalog = buildCatalog({
        liveIndex: services.liveIndex,
        includeSchemas: effectiveIncludeSchemas,
        includeExamples: effectiveIncludeExamples,
      });

      const allRanked = rankCatalog(catalog, args.query);
      const filteredRanked = args.excludeDisabled
        ? allRanked.filter((a) => !a.disabled)
        : allRanked;
      const offset = args.offset ?? 0;
      const ranked = filteredRanked.slice(offset, offset + args.limit);
      const autoEnabled =
        narrowLookup && (!args.includeSchemas || !args.includeExamples)
          ? {
              includeSchemas: !args.includeSchemas,
              includeExamples: !args.includeExamples,
              reason: args.limit === 1 ? "limit=1" : "exact-name-query",
            }
          : undefined;
      // Handle summaryOnly mode - return counts/categories instead of full details
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

      // Compute disabled action hints
      const disabledActions = ranked.filter((a) => a.disabled);
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

      return {
        actions: ranked,
        total: filteredRanked.length,
        disabledHint,
        // Hint when schemas not included
        ...(!effectiveIncludeSchemas
          ? {
              schemaHint:
                "Tip: Add includeSchemas: true to see parameter types and enum values.",
            }
          : {}),
        hasMore: filteredRanked.length > offset + args.limit,
        tokenEstimate: estimateTokens(JSON.stringify(ranked)),
        ...(autoEnabled ? { autoEnabled } : {}),
      };
    },
    {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0 },
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
    },
  );
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
): void {
  const actionMap = prebuiltActionMap ?? createActionMap(services.liveIndex);

  const ManualRequestSchema = z.object({
    query: z.string().min(1).optional(),
    actions: z.array(z.string().min(1)).optional(),
    format: z.enum(["typescript", "markdown", "json"]).default("typescript"),
    includeSchemas: z.boolean().default(true),
    includeExamples: z.boolean().default(false),
  });

  server.registerTool(
    "sdl.manual",
    MANUAL_DESCRIPTION,
    ManualRequestSchema,
    async (rawArgs: unknown) => {
      const args = ManualRequestSchema.parse(rawArgs);
      const format = args.format;
      const includeSchemas = args.includeSchemas;
      const includeExamples = args.includeExamples;

      if (
        !args.query &&
        !args.actions &&
        format === "typescript" &&
        !includeSchemas &&
        !includeExamples
      ) {
        const manual = getManualCached(services.liveIndex);
        return { manual, tokenEstimate: estimateTokens(manual) };
      }

      let catalog = buildCatalog({
        liveIndex: services.liveIndex,
        includeSchemas,
        includeExamples,
      });

      if (args.actions && args.actions.length > 0) {
        const activeFnMap = getActiveFnNameMap();
        const validNames = new Set([
          ...Object.keys(activeFnMap),
          ...Object.values(activeFnMap),
          ...INTERNAL_TRANSFORM_NAMES,
          "workflow",
          "context",
          "manual",
          "action.search",
        ]);

        const unknowns = args.actions.filter(
          (action) => !validNames.has(action),
        );
        if (unknowns.length > 0) {
          return {
            error: "UNKNOWN_ACTIONS",
            unknownActions: unknowns,
            validActions: Array.from(validNames).sort(),
          };
        }

        const filtered: ActionDescriptor[] = [];
        for (const name of args.actions) {
          const match = catalog.find(
            (entry) => entry.action === name || entry.fn === name,
          );
          if (match && !filtered.includes(match)) {
            filtered.push(match);
          }
        }
        catalog = filtered;
      }

      if (args.query) {
        catalog = rankCatalog(catalog, args.query);
      }

      if (format === "json") {
        return {
          actions: catalog,
          tokenEstimate: estimateTokens(JSON.stringify(catalog)),
        };
      }

      const rendered =
        format === "markdown"
          ? renderMarkdown(catalog)
          : renderTypescript(catalog);
      const withTransforms = rendered + TRANSFORM_HINT;
      return {
        manual: withTransforms,
        tokenEstimate: estimateTokens(withTransforms),
      };
    },
    {
      type: "object",
      properties: {
        query: { type: "string" },
        actions: { type: "array", items: { type: "string" } },
        format: { type: "string", enum: ["typescript", "markdown", "json"] },
        includeSchemas: { type: "boolean" },
        includeExamples: { type: "boolean" },
      },
      additionalProperties: false,
    },
  );

  server.registerTool(
    "sdl.workflow",
    WORKFLOW_DESCRIPTION,
    WorkflowRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) => {
      const parsed = parseWorkflowRequest(rawArgs);
      if (!parsed.ok) {
        const error = new ValidationError("Invalid sdl.workflow request");
        Object.assign(error, { details: parsed.errors });
        throw error;
      }

      const rawObject = rawArgs as Record<string, unknown>;
      const traceOpts = rawObject.trace
        ? WorkflowTraceOptionsSchema.parse(rawObject.trace)
        : undefined;

      return executeWorkflow(
        parsed.request,
        actionMap,
        config,
        context,
        traceOpts,
      );
    },
    {
      type: "object",
      properties: {
        repoId: { type: "string", minLength: 1 },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fn: { type: "string" },
              args: { type: "object" },
            },
            required: ["fn"],
          },
          minItems: 1,
        },
        budget: { type: "object" },
        onError: { type: "string", enum: ["continue", "stop"] },
        trace: { type: "object" },
      },
      required: ["repoId", "steps"],
      additionalProperties: false,
    },
  );

  server.registerTool(
    "sdl.context",
    CONTEXT_DESCRIPTION,
    AgentContextRequestSchema,
    async (rawArgs: unknown) => handleAgentContext(rawArgs),
    {
      type: "object",
      properties: {
        repoId: { type: "string", minLength: 1 },
        taskType: {
          type: "string",
          enum: ["debug", "review", "implement", "explain"],
        },
        taskText: { type: "string", minLength: 1 },
        budget: { type: "object" },
        options: { type: "object" },
      },
      required: ["repoId", "taskType", "taskText"],
      additionalProperties: false,
    },
  );

  server.registerTool(
    "sdl.file",
    FILE_GATEWAY_DESCRIPTION,
    FileGatewayRequestSchema,
    async (rawArgs: unknown) => handleFileGateway(rawArgs),
    {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["read", "write", "searchEditPreview", "searchEditApply"],
        },
        repoId: { type: "string", minLength: 1 },
        filePath: { type: "string" },
        maxBytes: { type: "number" },
        offset: { type: "number" },
        limit: { type: "number" },
        search: { type: "string" },
        searchContext: { type: "number" },
        jsonPath: { type: "string" },
        content: { type: "string" },
        replaceLines: { type: "object" },
        replacePattern: { type: "object" },
        jsonValue: {},
        insertAt: { type: "object" },
        append: { type: "string" },
        createBackup: { type: "boolean" },
        createIfMissing: { type: "boolean" },
        targeting: { type: "string", enum: ["text", "symbol"] },
        query: { type: "object" },
        filters: { type: "object" },
        editMode: { type: "string" },
        previewContextLines: { type: "number" },
        maxFiles: { type: "number" },
        maxMatchesPerFile: { type: "number" },
        maxTotalMatches: { type: "number" },
        planHandle: { type: "string" },
      },
      required: ["op", "repoId"],
      additionalProperties: false,
    },
  );
}

function renderTypescript(catalog: ActionDescriptor[]): string {
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
    lines.push(`/** ${descriptor.description} */`);
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
          (field) => `${field.name}${field.required ? "" : "?"}: ${field.type}`,
        )
        .join("; ");
      lines.push(`function ${descriptor.fn}(p: { ${params} }): object`);
    } else {
      lines.push(`function ${descriptor.fn}(p: object): object`);
    }
    if (descriptor.schemaSummary) {
      for (const field of descriptor.schemaSummary.fields) {
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

function renderMarkdown(catalog: ActionDescriptor[]): string {
  const lines: string[] = [
    "# SDL-MCP API Reference",
    "",
    "Use with `sdl.workflow` for multi-step operations. Prefer `sdl.context` for context retrieval.",
    "",
  ];

  for (const descriptor of catalog) {
    lines.push(`## \`${descriptor.fn}\` (\`${descriptor.action}\`)`);
    lines.push("");
    lines.push(descriptor.description);
    lines.push("");
    lines.push(`- **Kind**: ${descriptor.kind}`);
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
      lines.push("| Parameter | Type | Required | Default |");
      lines.push("|-----------|------|----------|---------|");
      for (const field of descriptor.schemaSummary.fields) {
        const defaultValue =
          field.default !== undefined ? JSON.stringify(field.default) : "";
        lines.push(
          `| ${field.name} | ${field.type} | ${field.required ? "yes" : "no"} | ${defaultValue} |`,
        );
      }
      for (const field of descriptor.schemaSummary.fields) {
        if (field.subFields && field.subFields.length > 0) {
          lines.push("");
          lines.push(`**${field.name}** shape:`);
          lines.push("");
          lines.push("| Field | Type | Required | Default |");
          lines.push("|-------|------|----------|---------|");
          for (const subField of field.subFields) {
            const defaultValue =
              subField.default !== undefined
                ? JSON.stringify(subField.default)
                : "";
            lines.push(
              `| ${subField.name} | ${subField.type} | ${subField.required ? "yes" : "no"} | ${defaultValue} |`,
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
  lines.push("| `$0.skeleton` | Skeleton IR string |");
  lines.push("| `$0.excerpt` | Hot-path excerpt string |");
  lines.push("| `$N.result.fieldName` | Any field from step N result |");
  lines.push("");
  return lines.join("\n");
}
