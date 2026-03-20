import type { MCPServer, ToolContext } from "../server.js";
import type { CodeModeConfig } from "../config/types.js";
import type { ToolServices } from "../gateway/index.js";
import { createActionMap, type ActionMap } from "../gateway/router.js";
import { getManualCached, FN_NAME_MAP } from "./manual-generator.js";
import { parseChainRequest } from "./chain-parser.js";
import { executeChain } from "./chain-executor.js";
import { ChainRequestSchema, ChainTraceOptionsSchema } from "./types.js";
import { MANUAL_DESCRIPTION, CHAIN_DESCRIPTION, ACTION_SEARCH_DESCRIPTION } from "./descriptions.js";
import { estimateTokens } from "../util/tokenize.js";
import { buildCatalog, rankCatalog, type ActionDescriptor } from "./action-catalog.js";
import { INTERNAL_TRANSFORM_NAMES } from "./transforms.js";
import { ValidationError } from "../domain/errors.js";
import { z } from "zod";

/**
 * Register Code Mode tools (sdl.manual + sdl.chain) on the MCP server.
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

  // --- sdl.manual — enhanced with query/actions/format/schema/example filtering ---
  const ManualRequestSchema = z.object({
    query: z.string().min(1).optional(),
    actions: z.array(z.string().min(1)).optional(),
    format: z.enum(["typescript", "markdown", "json"]).default("typescript"),
    includeSchemas: z.boolean().default(false),
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

      // Default behavior: no query, no actions filter — return legacy manual
      if (!args.query && !args.actions && format === "typescript" && !includeSchemas && !includeExamples) {
        const manual = getManualCached(services.liveIndex);
        return { manual, tokenEstimate: estimateTokens(manual) };
      }

      // Build catalog with optional enrichment
      let catalog = buildCatalog({
        liveIndex: services.liveIndex,
        includeSchemas,
        includeExamples,
      });

      // Filter by exact action/fn names
      if (args.actions && args.actions.length > 0) {
        const validNames = new Set([
          ...Object.keys(FN_NAME_MAP),
          ...Object.values(FN_NAME_MAP),
          ...INTERNAL_TRANSFORM_NAMES,
        ]);

        const unknowns = args.actions.filter((a) => !validNames.has(a));
        if (unknowns.length > 0) {
          return {
            error: "UNKNOWN_ACTIONS",
            unknownActions: unknowns,
            validActions: Array.from(validNames).sort(),
          };
        }

        // Preserve caller order
        const filtered: ActionDescriptor[] = [];
        for (const name of args.actions) {
          const match = catalog.find((d) => d.action === name || d.fn === name);
          if (match && !filtered.includes(match)) {
            filtered.push(match);
          }
        }
        catalog = filtered;
      }

      // Filter by query (intersect with actions filter if both present)
      if (args.query) {
        catalog = rankCatalog(catalog, args.query);
      }

      // Return in requested format
      if (format === "json") {
        return {
          actions: catalog,
          tokenEstimate: estimateTokens(JSON.stringify(catalog)),
        };
      }

      // typescript or markdown — render as string
      const rendered = format === "markdown"
        ? renderMarkdown(catalog)
        : renderTypescript(catalog);
      return { manual: rendered, tokenEstimate: estimateTokens(rendered) };
    },
    // thin wire schema
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

  // --- sdl.action.search — discovery surface ---
  const ActionSearchRequestSchema = z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).default(10),
    includeSchemas: z.boolean().default(false),
    includeExamples: z.boolean().default(false),
  });

  server.registerTool(
    "sdl.action.search",
    ACTION_SEARCH_DESCRIPTION,
    ActionSearchRequestSchema,
    async (rawArgs: unknown) => {
      const args = ActionSearchRequestSchema.parse(rawArgs);
      const limit = args.limit;
      const catalog = buildCatalog({
        liveIndex: services.liveIndex,
        includeSchemas: args.includeSchemas,
        includeExamples: args.includeExamples,
      });

      const ranked = rankCatalog(catalog, args.query).slice(0, limit);
      return {
        actions: ranked,
        tokenEstimate: estimateTokens(JSON.stringify(ranked)),
      };
    },
    {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        includeSchemas: { type: "boolean" },
        includeExamples: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  );

  // --- sdl.chain — execute a chain of operations in a single round-trip ---
  server.registerTool(
    "sdl.chain",
    CHAIN_DESCRIPTION,
    ChainRequestSchema,
    async (rawArgs: unknown, context?: ToolContext) => {
      const parsed = parseChainRequest(rawArgs);
      if (!parsed.ok) {
        const error = new ValidationError("Invalid sdl.chain request");
        Object.assign(error, { details: parsed.errors });
        throw error;
      }

      // Extract trace options from raw args (already validated by Zod via ChainRequestSchema)
      const rawObj = rawArgs as Record<string, unknown>;
      const traceOpts = rawObj.trace
        ? ChainTraceOptionsSchema.parse(rawObj.trace)
        : undefined;

      return executeChain(parsed.request, actionMap, config, context, traceOpts);
    },
    // thin wire schema — minimal envelope
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
}

// --- Rendering Helpers ---

function renderTypescript(catalog: ActionDescriptor[]): string {
  const lines: string[] = [
    "// SDL-MCP API — use with sdl.chain tool",
    "// repoId is set in the chain envelope, not per-step.",
    "// Reference prior step results with $N (e.g., $0.symbols[0].symbolId).",
    "",
  ];

  for (const desc of catalog) {
    lines.push(`/** ${desc.description} */`);
    if (desc.schemaSummary) {
      const params = desc.schemaSummary.fields
        .map((f) => `${f.name}${f.required ? "" : "?"}: ${f.type}`)
        .join("; ");
      lines.push(`function ${desc.fn}(p: { ${params} }): object`);
    } else {
      lines.push(`function ${desc.fn}(p: object): object`);
    }
    if (desc.example) {
      lines.push(`// Example: ${desc.fn}(${JSON.stringify(desc.example)})`);
    }
  }

  return lines.join("\n");
}

function renderMarkdown(catalog: ActionDescriptor[]): string {
  const lines: string[] = [
    "# SDL-MCP API Reference",
    "",
    "Use with `sdl.chain` tool. `repoId` is set in the chain envelope.",
    "",
  ];

  for (const desc of catalog) {
    lines.push(`## \`${desc.fn}\` (\`${desc.action}\`)`);
    lines.push("");
    lines.push(desc.description);
    lines.push("");
    lines.push(`- **Kind**: ${desc.kind}`);
    lines.push(`- **Tags**: ${desc.tags.join(", ")}`);

    if (desc.schemaSummary) {
      lines.push("");
      lines.push("| Parameter | Type | Required | Default |");
      lines.push("|-----------|------|----------|---------|");
      for (const f of desc.schemaSummary.fields) {
        const def = f.default !== undefined ? JSON.stringify(f.default) : "";
        lines.push(`| ${f.name} | ${f.type} | ${f.required ? "yes" : "no"} | ${def} |`);
      }
    }

    if (desc.example) {
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(desc.example, null, 2));
      lines.push("```");
    }

    lines.push("");
  }

  return lines.join("\n");
}
