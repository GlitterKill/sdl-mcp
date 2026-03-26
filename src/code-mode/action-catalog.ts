import { createActionMap } from "../gateway/router.js";
import { ACTION_TO_FN } from "./manual-generator.js";
import { INTERNAL_TRANSFORMS } from "./transforms.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import type { z } from "zod";

// --- Action Tags / Categories ---

export type ActionTag =
  | "query"
  | "code"
  | "repo"
  | "policy"
  | "agent"
  | "buffer"
  | "runtime"
  | "memory"
  | "transform";

const ACTION_TAGS: Record<string, ActionTag[]> = {
  "symbol.search": ["query"],
  "symbol.getCard": ["query"],
  "symbol.getCards": ["query"],
  "slice.build": ["query"],
  "slice.refresh": ["query"],
  "slice.spillover.get": ["query"],
  "delta.get": ["query"],
  "context.summary": ["query"],
  "pr.risk.analyze": ["query"],
  "code.needWindow": ["code"],
  "code.getSkeleton": ["code"],
  "code.getHotPath": ["code"],
  "repo.register": ["repo"],
  "repo.status": ["repo"],
  "repo.overview": ["repo"],
  "index.refresh": ["repo"],
  "policy.get": ["policy"],
  "policy.set": ["policy"],
  "agent.orchestrate": ["agent"],
  "agent.feedback": ["agent"],
  "agent.feedback.query": ["agent"],
  "buffer.push": ["buffer"],
  "buffer.checkpoint": ["buffer"],
  "buffer.status": ["buffer"],
  "runtime.execute": ["runtime"],
  "runtime.queryOutput": ["runtime"],
  "memory.store": ["memory"],
  "memory.query": ["memory"],
  "memory.remove": ["memory"],
  "memory.surface": ["memory"],
  "usage.stats": ["query"],
};

// --- Schema Introspection ---

export interface SchemaSummaryField {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  description?: string;
}

export interface SchemaSummary {
  fields: SchemaSummaryField[];
}

/**
 * Converts a Zod schema into a stable SchemaSummary shape.
 * Handles ZodObject, ZodDefault, ZodOptional, ZodNullable, ZodEnum, ZodArray,
 * and ZodPassthrough. Falls back to { type: "unknown" } for unrecognized shapes.
 */
export function zodToSchemaSummary(schema: z.ZodType): SchemaSummary {
  const fields: SchemaSummaryField[] = [];

  // Unwrap to get the inner ZodObject if wrapped in ZodEffects/ZodPipeline
  const inner = unwrapZod(schema);
  if (!inner || typeof (inner as unknown as Record<string, unknown>).shape !== "object") {
    return { fields };
  }

  const shape = (inner as unknown as Record<string, unknown>).shape as Record<
    string,
    z.ZodType
  >;
  for (const [name, fieldSchema] of Object.entries(shape)) {
    fields.push(describeField(name, fieldSchema));
  }

  return { fields };
}

function unwrapZod(s: z.ZodType): z.ZodType {
  const def = (s as unknown as Record<string, unknown>)._def as Record<string, unknown>;
  if (!def) return s;

  // ZodEffects (transform, refine, preprocess)
  if (def.type === "effects" && def.schema) {
    return unwrapZod(def.schema as z.ZodType);
  }
  // ZodPipeline
  if (def.type === "pipeline" && def.in) {
    return unwrapZod(def.in as z.ZodType);
  }
  return s;
}

function describeField(name: string, schema: z.ZodType): SchemaSummaryField {
  let required = true;
  let defaultValue: unknown = undefined;
  let hasDefault = false;
  let current = schema;

  // Peel optional/default/nullable wrappers
  for (;;) {
    const def = (current as unknown as Record<string, unknown>)._def as Record<
      string,
      unknown
    >;
    if (!def) break;

    if (def.type === "default") {
      required = false;
      hasDefault = true;
      defaultValue = typeof def.defaultValue === "function"
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
      current = def.innerType as z.ZodType;
      continue;
    }
    if (def.type === "optional") {
      required = false;
      current = def.innerType as z.ZodType;
      continue;
    }
    if (def.type === "nullable") {
      current = def.innerType as z.ZodType;
      continue;
    }
    break;
  }

  const typeName = resolveTypeName(current);
  const field: SchemaSummaryField = { name, type: typeName, required };

  if (hasDefault) {
    field.default = defaultValue;
  }

  // Extract enum values
  const def = (current as unknown as Record<string, unknown>)._def as Record<
    string,
    unknown
  >;
  if (def?.type === "enum" && (current as unknown as Record<string, unknown>).options) {
    field.enumValues = (current as unknown as Record<string, unknown>).options as string[];
  }

  return field;
}

function resolveTypeName(schema: z.ZodType): string {
  const def = (schema as unknown as Record<string, unknown>)._def as Record<
    string,
    unknown
  >;
  if (!def?.type) return "unknown";

  switch (def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${resolveTypeName((def.element ?? def.innerType) as z.ZodType)}[]`;
    case "object":
      return "object";
    case "record":
      return "Record<string, unknown>";
    case "enum":
      return `enum(${(((schema as unknown as Record<string, unknown>).options as string[] | undefined) ?? Object.keys((def.entries ?? {}) as Record<string, unknown>)).join("|")})`;
    case "literal":
      return `literal(${JSON.stringify(def.value)})`;
    case "union":
      return (def.options as z.ZodType[])
        .map((o) => resolveTypeName(o))
        .join(" | ");
    default:
      return "unknown";
  }
}

// --- Hand-Authored Examples ---

const EXAMPLE_REGISTRY: Record<string, Record<string, unknown>> = {
  "symbol.search": { query: "handleError", kinds: ["function"], limit: 10 },
  "symbol.getCard": { symbolId: "<symbolId>" },
  "symbol.getCards": { symbolIds: ["<id1>", "<id2>"] },
  "slice.build": {
    taskText: "debug authentication flow",
    entrySymbols: ["<symbolId>"],
    budget: { maxCards: 30 },
  },
  "slice.refresh": { sliceHandle: "<handle>" },
  "slice.spillover.get": { spilloverHandle: "<handle>", pageSize: 20 },
  "delta.get": { includeBlastRadius: true },
  "context.summary": { taskQuery: "error handling patterns" },
  "pr.risk.analyze": { riskThreshold: 80 },
  "code.getSkeleton": { symbolId: "<symbolId>" },
  "code.getHotPath": {
    symbolId: "<symbolId>",
    identifiersToFind: ["validate", "parse"],
  },
  "code.needWindow": {
    symbolId: "<symbolId>",
    reason: "Need to see validation logic",
    expectedLines: 50,
    identifiersToFind: ["validateInput"],
  },
  "repo.register": { rootPath: "/path/to/repo" },
  "repo.status": {},
  "repo.overview": { level: "stats" },
  "index.refresh": { mode: "incremental" },
  "policy.get": {},
  "policy.set": { policyPatch: { maxWindowLines: 200 } },
  "agent.orchestrate": {
    taskText: "understand the auth flow",
    focusSymbols: ["<symbolId>"],
    budget: { maxTokens: 5000 },
  },
  "agent.feedback": {
    versionId: "<versionId>",
    sliceHandle: "<sliceHandle>",
    usefulSymbols: ["<symbolId>"],
    taskText: "auth debugging",
  },
  "agent.feedback.query": { limit: 10 },
  "buffer.push": {
    eventType: "change",
    filePath: "src/main.ts",
    content: "// updated",
    version: 1,
    dirty: true,
    timestamp: "2026-03-26T00:00:00Z",
  },
  "buffer.checkpoint": {},
  "buffer.status": {},
  "runtime.execute": { runtime: "node", args: ["--version"], outputMode: "summary" },
  "runtime.queryOutput": { artifactHandle: "runtime-myrepo-123-abc", queryTerms: ["error", "failed"] },
  "memory.store": {
    type: "pattern",
    title: "Auth uses JWT",
    content: "Authentication is JWT-based with refresh tokens",
    tags: ["auth"],
  },
  "memory.query": { query: "auth", limit: 5 },
  "memory.remove": { memoryId: "<memoryId>" },
  "memory.surface": { taskText: "fix auth bug", limit: 5 },
  "usage.stats": { scope: "both", since: "2026-03-01T00:00:00Z" },
};

// --- ActionDescriptor ---

export interface ActionDescriptor {
  /** Dot-notation action name (e.g., "symbol.search") */
  action: string;
  /** CamelCase fn name for use in sdl.chain (e.g., "symbolSearch") */
  fn: string;
  /** Human-readable description */
  description: string;
  /** Category tags */
  tags: ActionTag[];
  /** Whether this is a gateway action or internal transform */
  kind: "gateway" | "internal";
  /** Prior actions that usually improve this action's inputs */
  prerequisites: string[];
  /** Likely next actions after this action succeeds */
  recommendedNextActions: string[];
  /** Fallback actions when this action is unavailable or denied */
  fallbacks: string[];
  /** Schema summary (if requested) */
  schemaSummary?: SchemaSummary;
  /** Example args (if requested) */
  example?: Record<string, unknown>;
}

export interface ActionMetadata {
  prerequisites: string[];
  recommendedNextActions: string[];
  fallbacks: string[];
}

// --- Descriptions from manual template (extracted) ---

const ACTION_DESCRIPTIONS: Record<string, string> = {
  "symbol.search": "Search symbols by name/pattern",
  "symbol.getCard": "Get symbol card (metadata, deps, metrics)",
  "symbol.getCards": "Batch-fetch symbol cards",
  "slice.build": "Build dependency graph slice",
  "slice.refresh": "Refresh existing slice (delta only)",
  "slice.spillover.get": "Fetch spillover page",
  "delta.get": "Get delta between versions",
  "context.summary": "Generate context summary",
  "pr.risk.analyze": "Analyze PR risk",
  "code.needWindow": "Request raw code window (requires justification)",
  "code.getSkeleton": "Get skeleton IR (signatures + control flow)",
  "code.getHotPath": "Get hot-path excerpt for specific identifiers",
  "repo.register": "Register a repository",
  "repo.status": "Get repository status",
  "repo.overview": "Get codebase overview",
  "index.refresh": "Refresh index",
  "policy.get": "Get policy config",
  "policy.set": "Set policy config (policyPatch wrapper: maxWindowLines, maxWindowTokens, requireIdentifiers, allowBreakGlass, defaultMinCallConfidence, defaultDenyRaw, budgetCaps)",
  "agent.orchestrate": "Orchestrate multi-rung context retrieval",
  "agent.feedback": "Record agent feedback",
  "agent.feedback.query": "Query feedback records",
  "buffer.push": "Push buffer update",
  "buffer.checkpoint": "Request buffer checkpoint",
  "buffer.status": "Get buffer status",
  "runtime.execute": "Execute runtime command",
  "runtime.queryOutput": "Query stored command output by keywords",
  "memory.store": "Store a development memory",
  "memory.query": "Query memories",
  "memory.remove": "Soft-delete a memory",
  "memory.surface": "Auto-surface relevant memories",
  "usage.stats": "Get cumulative token savings statistics",
};

const TRANSFORM_DESCRIPTIONS: Record<string, string> = {
  dataPick: "Project fields from an object",
  dataMap: "Project fields from each element of an array",
  dataFilter: "Filter array elements by clauses",
  dataSort: "Sort array elements by a field",
  dataTemplate: "Render template strings from object(s)",
};

const TRANSFORM_EXAMPLES: Record<string, Record<string, unknown>> = {
  dataPick: { input: "$0", fields: { name: "name", file: "file" } },
  dataMap: { input: "$0.symbols", fields: { id: "symbolId", name: "name" } },
  dataFilter: {
    input: "$0.symbols",
    clauses: [{ path: "kind", op: "eq", value: "function" }],
  },
  dataSort: {
    input: "$0.symbols",
    by: { path: "name", direction: "asc" },
  },
  dataTemplate: {
    input: "$0.symbols",
    template: "{{name}} ({{kind}}) in {{file}}",
    joinWith: "\n",
  },
};

const EMPTY_METADATA: ActionMetadata = {
  prerequisites: [],
  recommendedNextActions: [],
  fallbacks: [],
};

const ACTION_METADATA: Record<string, ActionMetadata> = {
  "symbol.search": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["symbol.getCard", "slice.build"],
    fallbacks: ["repo.overview"],
  },
  "symbol.getCard": {
    prerequisites: ["symbol.search"],
    recommendedNextActions: ["slice.build", "code.getSkeleton"],
    fallbacks: ["symbol.search"],
  },
  "symbol.getCards": {
    prerequisites: ["symbol.search"],
    recommendedNextActions: ["slice.build"],
    fallbacks: ["symbol.getCard"],
  },
  "slice.build": {
    prerequisites: ["symbol.getCard", "repo.overview"],
    recommendedNextActions: ["slice.refresh", "code.getSkeleton"],
    fallbacks: ["context.summary"],
  },
  "slice.refresh": {
    prerequisites: ["slice.build"],
    recommendedNextActions: ["slice.spillover.get", "code.getSkeleton"],
    fallbacks: ["slice.build"],
  },
  "slice.spillover.get": {
    prerequisites: ["slice.build", "slice.refresh"],
    recommendedNextActions: ["code.getSkeleton"],
    fallbacks: ["slice.refresh"],
  },
  "delta.get": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["pr.risk.analyze", "context.summary"],
    fallbacks: ["repo.overview"],
  },
  "context.summary": {
    prerequisites: ["symbol.getCard", "slice.build"],
    recommendedNextActions: [],
    fallbacks: ["repo.overview"],
  },
  "pr.risk.analyze": {
    prerequisites: ["delta.get"],
    recommendedNextActions: ["symbol.getCard", "code.getHotPath"],
    fallbacks: ["context.summary"],
  },
  "code.needWindow": {
    prerequisites: ["code.getSkeleton", "code.getHotPath"],
    recommendedNextActions: [],
    fallbacks: ["code.getSkeleton", "code.getHotPath"],
  },
  "code.getSkeleton": {
    prerequisites: ["symbol.getCard", "slice.build"],
    recommendedNextActions: ["code.getHotPath", "code.needWindow"],
    fallbacks: ["context.summary"],
  },
  "code.getHotPath": {
    prerequisites: ["code.getSkeleton", "symbol.getCard"],
    recommendedNextActions: ["code.needWindow"],
    fallbacks: ["code.getSkeleton"],
  },
  "repo.register": {
    prerequisites: [],
    recommendedNextActions: ["repo.status", "index.refresh"],
    fallbacks: [],
  },
  "repo.status": {
    prerequisites: [],
    recommendedNextActions: ["repo.overview", "index.refresh"],
    fallbacks: [],
  },
  "repo.overview": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["symbol.search", "slice.build"],
    fallbacks: ["context.summary"],
  },
  "index.refresh": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["repo.status", "repo.overview"],
    fallbacks: ["buffer.checkpoint"],
  },
  "policy.get": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["policy.set", "code.needWindow"],
    fallbacks: [],
  },
  "policy.set": {
    prerequisites: ["policy.get"],
    recommendedNextActions: ["code.needWindow"],
    fallbacks: ["policy.get"],
  },
  "agent.orchestrate": {
    prerequisites: ["repo.status", "repo.overview"],
    recommendedNextActions: ["agent.feedback"],
    fallbacks: ["slice.build", "context.summary"],
  },
  "agent.feedback": {
    prerequisites: ["slice.build", "agent.orchestrate"],
    recommendedNextActions: ["agent.feedback.query"],
    fallbacks: [],
  },
  "agent.feedback.query": {
    prerequisites: [],
    recommendedNextActions: [],
    fallbacks: [],
  },
  "buffer.push": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["buffer.checkpoint", "buffer.status"],
    fallbacks: ["index.refresh"],
  },
  "buffer.checkpoint": {
    prerequisites: ["buffer.push"],
    recommendedNextActions: ["symbol.search", "code.getSkeleton"],
    fallbacks: ["index.refresh"],
  },
  "buffer.status": {
    prerequisites: ["buffer.push"],
    recommendedNextActions: ["buffer.checkpoint"],
    fallbacks: [],
  },
  "runtime.execute": {
    prerequisites: ["repo.status", "policy.get"],
    recommendedNextActions: ["runtime.queryOutput", "context.summary"],
    fallbacks: ["code.getSkeleton"],
  },
  "runtime.queryOutput": {
    prerequisites: ["runtime.execute"],
    recommendedNextActions: ["context.summary"],
    fallbacks: ["runtime.execute"],
  },
  "memory.store": {
    prerequisites: ["symbol.getCard", "slice.build"],
    recommendedNextActions: ["memory.surface", "memory.query"],
    fallbacks: [],
  },
  "memory.query": {
    prerequisites: [],
    recommendedNextActions: ["memory.surface"],
    fallbacks: [],
  },
  "memory.remove": {
    prerequisites: ["memory.query"],
    recommendedNextActions: [],
    fallbacks: [],
  },
  "memory.surface": {
    prerequisites: ["symbol.getCard", "slice.build"],
    recommendedNextActions: ["memory.store"],
    fallbacks: ["memory.query"],
  },
  "usage.stats": {
    prerequisites: [],
    recommendedNextActions: [],
    fallbacks: ["policy.get"],
  },
};

export function getActionMetadata(action: string): ActionMetadata {
  return ACTION_METADATA[action] ?? EMPTY_METADATA;
}

export function formatActionDiscoveryHints(action: string): string {
  const metadata = getActionMetadata(action);
  const parts: string[] = [];
  if (metadata.prerequisites.length > 0) {
    parts.push(`before: ${metadata.prerequisites.join(", ")}`);
  }
  if (metadata.recommendedNextActions.length > 0) {
    parts.push(`next: ${metadata.recommendedNextActions.join(", ")}`);
  }
  if (metadata.fallbacks.length > 0) {
    parts.push(`fallbacks: ${metadata.fallbacks.join(", ")}`);
  }
  return parts.length > 0 ? ` Hints: ${parts.join(" | ")}.` : "";
}

// --- Catalog Builder ---

let cachedCatalog: ActionDescriptor[] | null = null;
// Cache the action map alongside the catalog to avoid redundant createActionMap calls.
// Assumes liveIndex is a singleton; if it changes, call invalidateCatalog().
let cachedActionMap: ReturnType<typeof createActionMap> | null = null;

/**
 * Builds the full action catalog from the gateway action map and internal transforms.
 * Results are cached; call `invalidateCatalog()` to clear.
 */
export function buildCatalog(opts?: {
  liveIndex?: LiveIndexCoordinator;
  includeSchemas?: boolean;
  includeExamples?: boolean;
}): ActionDescriptor[] {
  const includeSchemas = opts?.includeSchemas ?? false;
  const includeExamples = opts?.includeExamples ?? false;

  // Use cached base catalog if available and no dynamic options
  if (cachedCatalog === null || cachedActionMap === null) {
    cachedActionMap = createActionMap(opts?.liveIndex);
    cachedCatalog = buildBaseCatalogFromMap(cachedActionMap);
  }

  if (!includeSchemas && !includeExamples) {
    return cachedCatalog;
  }

  // Augment with optional fields using the cached action map
  return cachedCatalog.map((desc) => {
    const result = { ...desc };

    if (includeSchemas) {
      if (desc.kind === "gateway") {
        const entry = cachedActionMap![desc.action];
        if (entry) {
          result.schemaSummary = zodToSchemaSummary(entry.schema);
        }
      } else {
        const transform = INTERNAL_TRANSFORMS[desc.fn];
        if (transform) {
          result.schemaSummary = zodToSchemaSummary(transform.schema);
        }
      }
    }

    if (includeExamples) {
      if (desc.kind === "gateway") {
        result.example = EXAMPLE_REGISTRY[desc.action];
      } else {
        result.example = TRANSFORM_EXAMPLES[desc.fn];
      }
    }

    return result;
  });
}

function buildBaseCatalogFromMap(actionMap: ReturnType<typeof createActionMap>): ActionDescriptor[] {
  const catalog: ActionDescriptor[] = [];

  // Gateway actions
  for (const action of Object.keys(actionMap)) {
    const fn = ACTION_TO_FN[action];
    if (!fn) continue;

    catalog.push({
      action,
      fn,
      description: ACTION_DESCRIPTIONS[action] ?? "",
      tags: ACTION_TAGS[action] ?? [],
      kind: "gateway",
      ...getActionMetadata(action),
    });
  }

  // Internal transforms
  for (const [fn, transform] of Object.entries(INTERNAL_TRANSFORMS)) {
    catalog.push({
      action: fn, // transforms use fn as action name
      fn,
      description: TRANSFORM_DESCRIPTIONS[fn] ?? transform.description,
      tags: ["transform"],
      kind: "internal",
      ...EMPTY_METADATA,
    });
  }

  return catalog;
}

export function invalidateCatalog(): void {
  cachedCatalog = null;
  cachedActionMap = null;
}

// --- Discovery Ranking ---

/**
 * Ranks catalog entries against a query string using deterministic lexical matching.
 * Scores based on: exact name match > prefix match > substring in name > substring in description > tag match.
 */
export function rankCatalog(
  catalog: ActionDescriptor[],
  query: string,
): ActionDescriptor[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = catalog.map((desc) => {
    let score = 0;
    const name = desc.action.toLowerCase();
    const fn = desc.fn.toLowerCase();
    const description = desc.description.toLowerCase();
    const tagStr = desc.tags.join(" ").toLowerCase();
    const metadataStr = [
      ...desc.prerequisites,
      ...desc.recommendedNextActions,
      ...desc.fallbacks,
    ]
      .join(" ")
      .toLowerCase();

    for (const term of terms) {
      // Exact name match
      if (name === term || fn === term) {
        score += 100;
      } else if (name.startsWith(term) || fn.startsWith(term)) {
        score += 50;
      } else if (name.includes(term) || fn.includes(term)) {
        score += 30;
      } else if (description.includes(term)) {
        score += 10;
      } else if (tagStr.includes(term)) {
        score += 5;
      } else if (metadataStr.includes(term)) {
        score += 4;
      }
    }

    return { desc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.desc);
}
