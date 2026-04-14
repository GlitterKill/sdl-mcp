import { createActionMap } from "../gateway/router.js";
import { ACTION_TO_FN } from "./manual-generator.js";
import { INTERNAL_TRANSFORMS } from "./transforms.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import type { z } from "zod";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";

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
  | "transform"
  | "meta";

const ACTION_TAGS: Record<string, ActionTag[]> = {
  "symbol.search": ["query"],
  "symbol.getCard": ["query"],
  "slice.build": ["query"],
  "slice.refresh": ["query"],
  "slice.spillover.get": ["query"],
  "delta.get": ["query"],
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
  "file.read": ["repo"],
  "file.write": ["repo"],
  "scip.ingest": ["repo"],
};

const META_TOOL_TAGS: Record<string, ActionTag[]> = {
  "action.search": ["meta"],
  manual: ["meta"],
  context: ["meta", "agent"],
  workflow: ["meta", "runtime", "transform"],
};

// --- Schema Introspection ---

export interface SchemaSummaryField {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  enumValues?: string[];
  description?: string;
  subFields?: SchemaSummaryField[];
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
  if (
    !inner ||
    typeof (inner as unknown as Record<string, unknown>).shape !== "object"
  ) {
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
  const def = (s as unknown as Record<string, unknown>)._def as Record<
    string,
    unknown
  >;
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
      defaultValue =
        typeof def.defaultValue === "function"
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
  if (
    def?.type === "enum" &&
    (current as unknown as Record<string, unknown>).options
  ) {
    field.enumValues = (current as unknown as Record<string, unknown>)
      .options as string[];
  }

  // Extract subFields for nested ZodObject fields (e.g., dataSort.by)
  if (
    def?.type === "object" &&
    typeof (current as unknown as Record<string, unknown>).shape === "object"
  ) {
    const nestedShape = (current as unknown as Record<string, unknown>)
      .shape as Record<string, z.ZodType>;
    field.subFields = Object.entries(nestedShape).map(([subName, subSchema]) =>
      describeField(subName, subSchema),
    );
  }
  // Extract subFields for array-of-objects (e.g., dataFilter.clauses)
  if (def?.type === "array") {
    const elemType = (def.element ?? def.innerType) as z.ZodType | undefined;
    if (elemType) {
      const elemDef = (elemType as unknown as Record<string, unknown>)._def as
        | Record<string, unknown>
        | undefined;
      if (
        elemDef?.type === "object" &&
        typeof (elemType as unknown as Record<string, unknown>).shape ===
          "object"
      ) {
        const nestedShape = (elemType as unknown as Record<string, unknown>)
          .shape as Record<string, z.ZodType>;
        field.subFields = Object.entries(nestedShape).map(
          ([subName, subSchema]) => describeField(subName, subSchema),
        );
      }
    }
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
    case "literal": {
      // Zod v4 stores value in def.values array, v3 in def.value
      const litVal =
        def.value !== undefined
          ? def.value
          : Array.isArray(def.values)
            ? (def.values as unknown[])[0]
            : undefined;
      return `literal(${JSON.stringify(litVal)})`;
    }
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
  "slice.build": {
    taskText: "debug authentication flow",
    entrySymbols: ["<symbolId>"],
    budget: { maxCards: 30 },
  },
  "slice.refresh": { sliceHandle: "<handle>" },
  "slice.spillover.get": { spilloverHandle: "<handle>", pageSize: 20 },
  "delta.get": {},
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
  "runtime.execute": {
    runtime: "node",
    args: ["--version"],
    outputMode: "summary",
  },
  "runtime.queryOutput": {
    artifactHandle: "runtime-myrepo-123-abc",
    queryTerms: ["error", "failed"],
  },
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
  "file.read": { filePath: "config/sdlmcp.config.example.json" },
  "file.write": { filePath: "config/app.yaml", jsonPath: "server.port", jsonValue: 8080 },
};

// --- ActionDescriptor ---

export interface ActionDescriptor {
  /** Dot-notation action name (e.g., "symbol.search") */
  action: string;
  /** CamelCase fn name for use in sdl.workflow (e.g., "symbolSearch") */
  fn: string;
  /** Human-readable description */
  description: string;
  /** Category tags */
  tags: ActionTag[];
  /** Whether this is a gateway action, internal transform, or top-level Code Mode meta tool */
  kind: "gateway" | "internal" | "meta";
  /** Prior actions that usually improve this action's inputs */
  prerequisites: string[];
  /** Likely next actions after this action succeeds */
  recommendedNextActions: string[];
  /** Fallback actions when this action is unavailable or denied */
  fallbacks: string[];
  /** Required parameter names (always populated, excludes repoId) */
  requiredParams: string[];
  /** Whether this action is disabled (e.g., memory tools when memory.enabled is false) */
  disabled?: boolean;
  /** Reason the action is disabled */
  disabledReason?: string;
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
  "slice.build": "Build dependency graph slice",
  "slice.refresh": "Refresh existing slice (delta only)",
  "slice.spillover.get":
    "Fetch spillover page (requires spilloverHandle from slice.build spillover response)",
  "delta.get": "Get delta between versions",
  "pr.risk.analyze": "Analyze PR risk",
  "code.needWindow": "Request raw code window (requires justification)",
  "code.getSkeleton": "Get skeleton IR (signatures + control flow)",
  "code.getHotPath": "Get hot-path excerpt for specific identifiers",
  "repo.register": "Register a repository",
  "repo.status": "Get repository status",
  "repo.overview": "Get codebase overview",
  "index.refresh": "Refresh index",
  "policy.get": "Get policy config",
  "policy.set":
    "Set policy config (policyPatch wrapper: maxWindowLines, maxWindowTokens, requireIdentifiers, allowBreakGlass, defaultMinCallConfidence, defaultDenyRaw, budgetCaps)",
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
  "file.read": "Read non-indexed file content (templates, configs, docs)",
  "file.write": "Write to non-indexed files with targeted modes (line replace, pattern replace, JSON path, insert, append)",
  "scip.ingest": "Ingest a pre-built SCIP index to overlay compiler-grade cross-references onto the symbol graph",
};

const META_TOOL_DESCRIPTIONS: Record<string, string> = {
  "action.search":
    "Search the SDL-MCP catalog before choosing a tool. Best starting point when you are unsure whether to use context or workflow.",
  manual:
    "Load the focused SDL-MCP manual after discovery. Use this before composing workflow steps.",
  context:
    "Preferred first tool for explain, debug, review, implement, understand, or investigate prompts. Retrieves task-shaped code context directly and should be chosen before workflow for context retrieval.",
  workflow:
    "Preferred first tool for execute, runtime, transform, batch, or pipeline prompts. Runs multi-step workflows with $N result piping, runtime execution, data transforms, and batch mutations.",
};

const TRANSFORM_DESCRIPTIONS: Record<string, string> = {
  dataPick:
    'Project fields from an object. fields is {outputKey: "inputKey"} (Record, NOT array). First param is input, not source.',
  dataMap:
    'Project fields from each element of an array. fields is {outputKey: "inputKey"} (Record, NOT array). First param is input, not source.',
  dataFilter:
    'Filter array elements by clauses. Each clause: {path, op, value}. ops: eq|ne|gt|gte|lt|lte|contains|in|exists. mode: "all"|"any" (default "all").',
  dataSort:
    'Sort array elements. by: {path: string, direction: "asc"|"desc", type?: "string"|"number"|"date"|"boolean"}. NOT field/order.',
  dataTemplate:
    "Render {{mustache}} template strings from object or array. joinWith (default '\\n') joins array results.",
};

const TRANSFORM_EXAMPLES: Record<string, Record<string, unknown>> = {
  dataPick: { input: "$0", fields: { name: "name", file: "file" } },
  dataMap: {
    input: "$0.results",
    fields: { id: "symbolId", name: "name", file: "file" },
  },
  dataFilter: {
    input: "$0.results",
    clauses: [{ path: "kind", op: "eq", value: "function" }],
  },
  dataSort: {
    input: "$0.results",
    by: { path: "name", direction: "asc" },
  },
  dataTemplate: {
    input: "$0.results",
    template: "{{name}} ({{kind}}) in {{file}}",
    joinWith: "\n",
  },
};

const META_TOOL_EXAMPLES: Record<string, Record<string, unknown>> = {
  "action.search": { query: "debug auth flow", limit: 5 },
  manual: { query: "runtime execute workflow", format: "markdown" },
  context: {
    repoId: "<repoId>",
    taskType: "debug",
    taskText: "explain the auth failure path",
    options: { contextMode: "precise", focusPaths: ["src/auth.ts"] },
  },
  workflow: {
    repoId: "<repoId>",
    steps: [
      { fn: "repoStatus" },
      { fn: "runtimeExecute", args: { runtime: "node", args: ["--version"] } }],
  },
};

const CONTEXT_DISCOVERY_TERMS = new Set([
  "context",
  "debug",
  "review",
  "explain",
  "understand",
  "investigate",
  "implement"]);

const WORKFLOW_DISCOVERY_TERMS = new Set([
  "workflow",
  "execute",
  "runtime",
  "transform",
  "batch",
  "pipeline"]);

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
  "slice.build": {
    prerequisites: ["symbol.getCard", "repo.overview"],
    recommendedNextActions: ["slice.refresh", "code.getSkeleton"],
    fallbacks: ["repo.overview"],
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
    recommendedNextActions: ["pr.risk.analyze"],
    fallbacks: ["repo.overview"],
  },
  "pr.risk.analyze": {
    prerequisites: ["delta.get"],
    recommendedNextActions: ["symbol.getCard", "code.getHotPath"],
    fallbacks: ["repo.overview"],
  },
  "code.needWindow": {
    prerequisites: ["code.getSkeleton", "code.getHotPath"],
    recommendedNextActions: [],
    fallbacks: ["code.getSkeleton", "code.getHotPath"],
  },
  "code.getSkeleton": {
    prerequisites: ["symbol.getCard", "slice.build"],
    recommendedNextActions: ["code.getHotPath", "code.needWindow"],
    fallbacks: ["repo.overview"],
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
    fallbacks: ["repo.overview"],
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
  "agent.feedback": {
    prerequisites: ["slice.build"],
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
    recommendedNextActions: ["runtime.queryOutput"],
    fallbacks: ["code.getSkeleton"],
  },
  "runtime.queryOutput": {
    prerequisites: ["runtime.execute"],
    recommendedNextActions: ["repo.overview"],
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
  "file.read": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["repo.overview"],
    fallbacks: ["runtime.execute"],
  },
  "file.write": {
    prerequisites: ["repo.status", "file.read"],
    recommendedNextActions: [],
    fallbacks: ["runtime.execute"],
  },
  context: {
    prerequisites: ["action.search"],
    recommendedNextActions: ["agent.feedback"],
    fallbacks: ["slice.build"],
  },
  workflow: {
    prerequisites: ["action.search", "manual"],
    recommendedNextActions: ["runtime.execute", "runtime.queryOutput"],
    fallbacks: ["manual"],
  },
  manual: {
    prerequisites: ["action.search"],
    recommendedNextActions: ["context", "workflow"],
    fallbacks: [],
  },
  "action.search": {
    prerequisites: [],
    recommendedNextActions: ["context", "workflow", "manual"],
    fallbacks: [],
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
// Track the memory visibility state used when the cache was built.
let cachedMemoryVisible: boolean | null = null;

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

  // Use cached base catalog if available, but invalidate if memory visibility changed.
  const memoryVisible = anyRepoHasMemoryTools(loadConfig());
  if (
    cachedCatalog === null ||
    cachedActionMap === null ||
    cachedMemoryVisible !== memoryVisible
  ) {
    cachedActionMap = createActionMap(opts?.liveIndex);
    cachedCatalog = buildBaseCatalogFromMap(cachedActionMap);
    cachedMemoryVisible = memoryVisible;
  }

  // When memory is disabled, inject disabled placeholders so callers
  // know the tools exist and how to enable them.
  const MEMORY_ACTIONS_LIST = ["memory.store", "memory.query", "memory.remove", "memory.surface"];
  if (!memoryVisible) {
    const hasMemory = cachedCatalog.some((d) => MEMORY_ACTIONS_LIST.includes(d.action));
    if (!hasMemory) {
      for (const action of MEMORY_ACTIONS_LIST) {
        const fn = ACTION_TO_FN[action];
        if (!fn) continue;
        cachedCatalog.push({
          action,
          fn,
          description: ACTION_DESCRIPTIONS[action] ?? "",
          tags: ACTION_TAGS[action] ?? [],
          kind: "gateway",
          requiredParams: [],
          disabled: true,
          disabledReason: "Enable with memory.enabled: true in sdlmcp.config.json",
          ...getActionMetadata(action),
        });
      }
    }
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
      } else if (desc.kind === "internal") {
        const transform = INTERNAL_TRANSFORMS[desc.fn];
        if (transform) {
          result.schemaSummary = zodToSchemaSummary(transform.schema);
        }
      }
    }

    if (includeExamples) {
      if (desc.kind === "gateway") {
        result.example = EXAMPLE_REGISTRY[desc.action];
      } else if (desc.kind === "internal") {
        result.example = TRANSFORM_EXAMPLES[desc.fn];
      } else {
        result.example = META_TOOL_EXAMPLES[desc.action];
      }
    }

    return result;
  });
}

function buildBaseCatalogFromMap(
  actionMap: ReturnType<typeof createActionMap>,
): ActionDescriptor[] {
  const catalog: ActionDescriptor[] = [];

  // Gateway actions
  for (const action of Object.keys(actionMap)) {
    const fn = ACTION_TO_FN[action];
    if (!fn) continue;

    // Always extract required params (cheap, just field names)
    const entry = actionMap[action];
    let requiredParams: string[] = [];
    if (entry) {
      const summary = zodToSchemaSummary(entry.schema);
      requiredParams = summary.fields
        .filter((f) => f.required && f.name !== "repoId")
        .map((f) => f.name);
    }

    catalog.push({
      action,
      fn,
      description: ACTION_DESCRIPTIONS[action] ?? "",
      tags: ACTION_TAGS[action] ?? [],
      kind: "gateway",
      requiredParams,
      ...getActionMetadata(action),
    });
  }

  // Internal transforms
  for (const [fn, transform] of Object.entries(INTERNAL_TRANSFORMS)) {
    // Always extract required params for transforms too
    let transformRequiredParams: string[] = [];
    if (transform.schema) {
      const summary = zodToSchemaSummary(transform.schema);
      transformRequiredParams = summary.fields
        .filter((f) => f.required && f.name !== "repoId")
        .map((f) => f.name);
    }

    catalog.push({
      action: fn, // transforms use fn as action name
      fn,
      description: TRANSFORM_DESCRIPTIONS[fn] ?? transform.description,
      tags: ["transform"],
      kind: "internal",
      requiredParams: transformRequiredParams,
      ...EMPTY_METADATA,
    });
  }

  // Top-level Code Mode meta tools
  for (const action of ["action.search", "manual", "context", "workflow"]) {
    catalog.push({
      action,
      fn: action,
      description: META_TOOL_DESCRIPTIONS[action] ?? "",
      tags: META_TOOL_TAGS[action] ?? ["meta"],
      kind: "meta",
      requiredParams: [],
      ...getActionMetadata(action),
    });
  }

  return catalog;
}

export function invalidateCatalog(): void {
  cachedCatalog = null;
  cachedActionMap = null;
  cachedMemoryVisible = null;
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

  // Wildcard or empty query returns all actions sorted alphabetically
  if (terms.length === 0 || (terms.length === 1 && terms[0] === "*")) {
    return [...catalog].sort((a, b) => a.action.localeCompare(b.action));
  }

  // Pre-build word-boundary regexes to avoid O(catalog * terms) compilations
  const wordBoundaryRegexes = new Map<string, RegExp>();
  for (const term of terms) {
    wordBoundaryRegexes.set(
      term,
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    );
  }

  const scored = catalog.map((desc) => {
    let score = 0;
    const name = desc.action.toLowerCase();
    const fn = desc.fn.toLowerCase();
    const description = desc.description.toLowerCase();
    const tagStr = desc.tags.join(" ").toLowerCase();
    const metadataStr = [
      ...desc.prerequisites,
      ...desc.recommendedNextActions,
      ...desc.fallbacks]
      .join(" ")
      .toLowerCase();

    for (const term of terms) {
      // Exact name match (highest weight)
      if (name === term || fn === term) {
        score += 100;
      } else if (name.startsWith(term) || fn.startsWith(term)) {
        score += 50;
      } else if (name.includes(term) || fn.includes(term)) {
        score += 30;
      } else if (tagStr.includes(term)) {
        // Tags before description: "memory" tag should outrank "stored" in description
        score += 20;
      } else {
        // Word-boundary match in description (avoid partial matches like "store" in "stored")
        const wordBoundaryRe = wordBoundaryRegexes.get(term)!;
        if (wordBoundaryRe.test(description)) {
          score += 10;
        } else if (description.includes(term)) {
          score += 3;
        } else if (metadataStr.includes(term)) {
          score += 2;
        }
      }
    }

    if (desc.kind === "meta") {
      const matchingContextTerms = terms.filter((term) =>
        CONTEXT_DISCOVERY_TERMS.has(term),
      ).length;
      const matchingWorkflowTerms = terms.filter((term) =>
        WORKFLOW_DISCOVERY_TERMS.has(term),
      ).length;

      if (desc.action === "context" && matchingContextTerms > 0) {
        score += 60 + matchingContextTerms * 10;
      }

      if (desc.action === "workflow" && matchingWorkflowTerms > 0) {
        score += 60 + matchingWorkflowTerms * 10;
      }
    }

    return { desc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.desc);
}
