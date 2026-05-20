import { createActionMap } from "../gateway/router.js";
import { ACTION_TO_FN } from "./manual-generator.js";
import { INTERNAL_TRANSFORMS } from "./transforms.js";
import type { LiveIndexCoordinator } from "../live-index/types.js";
import { z } from "zod";
import { loadConfig } from "../config/loadConfig.js";
import { anyRepoHasMemoryTools } from "../config/memory-config.js";
import {
  AgentContextRequestSchema,
  MemoryStoreRequestSchema,
  MemoryQueryRequestSchema,
  MemoryRemoveRequestSchema,
  MemorySurfaceRequestSchema,
} from "../mcp/tools.js";
import { FileGatewayRequestSchema } from "../mcp/tools/file-gateway.js";
import { WorkflowRequestSchema } from "./types.js";

// Meta-tool schemas. ActionSearchRequestSchema is also exported from
// `./index.ts`, but importing from there creates a load-time circularity
// (index.ts imports this module). Keep the meta schemas local so the manual
// renderer can introspect them without pulling the whole gateway.
const META_ACTION_SEARCH_SCHEMA = z.object({
  query: z.string().min(1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum 50 results."),
  offset: z.number().int().min(0).optional(),
  includeSchemas: z.boolean().optional(),
  includeExamples: z.boolean().optional(),
  excludeDisabled: z.boolean().optional(),
  summaryOnly: z.boolean().optional(),
});
const META_MANUAL_SCHEMA = z.object({
  format: z.enum(["typescript", "markdown", "json"]).optional(),
  query: z.string().optional(),
  actions: z.array(z.string()).optional(),
  includeSchemas: z.boolean().optional(),
  includeExamples: z.boolean().optional(),
});

const META_TOOL_SCHEMAS: Record<string, z.ZodType> = {
  "action.search": META_ACTION_SEARCH_SCHEMA,
  manual: META_MANUAL_SCHEMA,
  context: AgentContextRequestSchema,
  file: FileGatewayRequestSchema,
  workflow: WorkflowRequestSchema,
};

const DISABLED_GATEWAY_FALLBACK_SCHEMAS: Record<string, z.ZodType> = {
  "memory.store": MemoryStoreRequestSchema,
  "memory.query": MemoryQueryRequestSchema,
  "memory.remove": MemoryRemoveRequestSchema,
  "memory.surface": MemorySurfaceRequestSchema,
};

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
  | "meta"
  | "mutation";

const ACTION_TAGS: Record<string, ActionTag[]> = {
  "symbol.search": ["query"],
  "symbol.getCard": ["query"],
  "symbol.edit": ["repo", "mutation"],
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
  "response.get": ["query"],
  "memory.store": ["memory"],
  "memory.query": ["memory"],
  "memory.remove": ["memory"],
  "memory.surface": ["memory"],
  "usage.stats": ["query"],
  "file.read": ["repo"],
  "file.write": ["repo", "mutation"],
  "search.edit": ["repo", "mutation"],
  "scip.ingest": ["repo"],
  "semantic.enrichment.refresh": ["repo", "mutation"],
  "semantic.enrichment.status": ["repo"],
};

const META_TOOL_TAGS: Record<string, ActionTag[]> = {
  "action.search": ["meta"],
  manual: ["meta"],
  context: ["meta", "agent"],
  file: ["meta", "repo", "mutation"],
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
 * Handles common Zod v4 schema surfaces without relying on legacy typeName
 * strings. Falls back to { type: "unknown" } for unrecognized shapes.
 */
export function zodToSchemaSummary(schema: z.ZodType): SchemaSummary {
  const fields: SchemaSummaryField[] = [];

  const inner = unwrapZod(schema);
  const discriminator = getDiscriminator(inner);

  if (discriminator) {
    const optionList = getUnionOptions(inner);
    const seen = new Map<
      string,
      {
        field: SchemaSummaryField;
        occurrences: number;
        requiredOccurrences: number;
      }
    >();
    let validOptionCount = 0;
    for (const opt of optionList) {
      const optShape = getObjectShape(opt);
      if (!optShape) continue;
      validOptionCount++;
      for (const [name, fieldSchema] of Object.entries(optShape)) {
        const described = describeField(name, fieldSchema);
        const existing = seen.get(name);
        if (existing) {
          mergeSchemaSummaryField(existing.field, described);
          existing.occurrences++;
          if (described.required) existing.requiredOccurrences++;
          continue;
        }
        seen.set(name, {
          field: described,
          occurrences: 1,
          requiredOccurrences: described.required ? 1 : 0,
        });
        fields.push(described);
      }
    }
    for (const [name, entry] of seen) {
      entry.field.required =
        name === discriminator ||
        (entry.occurrences === validOptionCount &&
          entry.requiredOccurrences === validOptionCount);
    }
    return { fields };
  }

  const shape = getObjectShape(inner);
  if (!shape) {
    return { fields };
  }

  for (const [name, fieldSchema] of Object.entries(shape)) {
    fields.push(describeField(name, fieldSchema));
  }

  return { fields };
}

type ZodDef = Record<string, unknown>;

type ZodInspectable = z.ZodType & {
  def?: ZodDef;
  _def?: ZodDef;
  type?: unknown;
  shape?: unknown;
  options?: unknown;
  values?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function inspectable(schema: z.ZodType): ZodInspectable {
  return schema as ZodInspectable;
}

function zodDef(schema: z.ZodType): ZodDef {
  const candidate = inspectable(schema);
  if (isRecord(candidate.def)) return candidate.def;
  if (isRecord(candidate._def)) return candidate._def;
  return {};
}

function zodKind(schema: z.ZodType): string {
  const candidate = inspectable(schema);
  if (typeof candidate.type === "string") return candidate.type;

  const def = zodDef(schema);
  return typeof def.type === "string" ? def.type : "unknown";
}

function zodDescription(schema: z.ZodType): string | undefined {
  const candidate = inspectable(schema) as ZodInspectable & {
    description?: unknown;
  };
  if (typeof candidate.description === "string") return candidate.description;
  const def = zodDef(schema);
  return typeof def.description === "string" ? def.description : undefined;
}

function asZodType(value: unknown): z.ZodType | undefined {
  return isZodType(value) ? value : undefined;
}

function asZodShape(value: unknown): Record<string, z.ZodType> | undefined {
  if (!isRecord(value)) return undefined;

  const shape: Record<string, z.ZodType> = {};
  for (const [name, fieldSchema] of Object.entries(value)) {
    if (isZodType(fieldSchema)) {
      shape[name] = fieldSchema;
    }
  }

  return Object.keys(shape).length === Object.keys(value).length
    ? shape
    : undefined;
}

function resolveShapeCandidate(candidate: unknown): unknown {
  if (typeof candidate === "function") {
    return (candidate as () => unknown)();
  }
  return candidate;
}

function getObjectShape(
  schema: z.ZodType,
  depth = 0,
): Record<string, z.ZodType> | undefined {
  if (depth > 8) return undefined;

  const current = unwrapZod(schema);
  const kind = zodKind(current);
  const def = zodDef(current);

  if (kind === "object") {
    return (
      asZodShape(resolveShapeCandidate(inspectable(current).shape)) ??
      asZodShape(resolveShapeCandidate(def.shape))
    );
  }

  if (kind === "intersection") {
    const left = asZodType(def.left);
    const right = asZodType(def.right);
    const leftShape = left ? getObjectShape(left, depth + 1) : undefined;
    const rightShape = right ? getObjectShape(right, depth + 1) : undefined;
    if (!leftShape && !rightShape) return undefined;
    return { ...(leftShape ?? {}), ...(rightShape ?? {}) };
  }

  return undefined;
}

function getDiscriminator(schema: z.ZodType): string | undefined {
  const def = zodDef(schema);
  return typeof def.discriminator === "string" ? def.discriminator : undefined;
}

function getUnionOptions(schema: z.ZodType): z.ZodType[] {
  const candidate = inspectable(schema).options;
  if (Array.isArray(candidate)) return candidate.filter(isZodType);
  if (candidate instanceof Map) {
    return Array.from(candidate.values()).filter(isZodType);
  }

  const def = zodDef(schema);
  if (Array.isArray(def.options)) return def.options.filter(isZodType);
  if (def.options instanceof Map) {
    return Array.from(def.options.values()).filter(isZodType);
  }
  if (def.optionsMap instanceof Map) {
    return Array.from(def.optionsMap.values()).filter(isZodType);
  }

  return [];
}

function unwrapZod(s: z.ZodType): z.ZodType {
  // Peel wrappers that hide the input schema shape. Intersections are handled
  // by getObjectShape so both sides can contribute fields.
  let current = s;
  for (let depth = 0; depth < 16; depth++) {
    const def = zodDef(current);
    const kind = zodKind(current);
    if (
      (kind === "effects" || kind === "transform") &&
      asZodType(def.schema ?? def.innerType)
    ) {
      current = asZodType(def.schema ?? def.innerType) ?? current;
      continue;
    }
    if (
      (kind === "pipeline" || kind === "pipe") &&
      asZodType(def.in ?? def.schema)
    ) {
      current = asZodType(def.in ?? def.schema) ?? current;
      continue;
    }
    return current;
  }
  return current;
}

function literalValueFromType(type: string): string | undefined {
  const match = /^literal\((.*)\)$/.exec(type);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1] ?? "");
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function fieldEnumValues(field: SchemaSummaryField): string[] {
  const values = field.enumValues ?? [];
  const literal = literalValueFromType(field.type);
  return literal ? [...values, literal] : values;
}

function mergeSchemaSummaryField(
  target: SchemaSummaryField,
  incoming: SchemaSummaryField,
): void {
  const enumValues = new Set([
    ...fieldEnumValues(target),
    ...fieldEnumValues(incoming),
  ]);
  if (enumValues.size > 0) {
    target.enumValues = [...enumValues];
    target.type = `enum(${target.enumValues.join("|")})`;
  }
  if (!target.description && incoming.description) {
    target.description = incoming.description;
  }
  if (!target.subFields && incoming.subFields) {
    target.subFields = incoming.subFields;
  }
}

function describeField(name: string, schema: z.ZodType): SchemaSummaryField {
  let required = true;
  let defaultValue: unknown = undefined;
  let hasDefault = false;
  let current = schema;
  const initialDescription = zodDescription(schema);

  // Peel optional/default/nullable wrappers.
  for (let depth = 0; depth < 16; depth++) {
    const def = zodDef(current);
    const kind = zodKind(current);

    if (kind === "default") {
      required = false;
      hasDefault = true;
      defaultValue =
        typeof def.defaultValue === "function"
          ? (def.defaultValue as () => unknown)()
          : def.defaultValue;
      current = asZodType(def.innerType) ?? current;
      continue;
    }
    if (kind === "optional") {
      required = false;
      current = asZodType(def.innerType) ?? current;
      continue;
    }
    if (kind === "nullable") {
      current = asZodType(def.innerType) ?? current;
      continue;
    }
    break;
  }

  current = unwrapZod(current);
  const typeName = resolveTypeName(current);
  const field: SchemaSummaryField = { name, type: typeName, required };
  const description = initialDescription ?? zodDescription(current);
  if (description) {
    field.description = description;
  }

  if (hasDefault) {
    field.default = defaultValue;
  }

  const enumValues = enumValuesFor(current);
  if (enumValues.length > 0) {
    field.enumValues = enumValues;
  }

  const nestedShape = getObjectShape(current);
  if (nestedShape) {
    field.subFields = Object.entries(nestedShape).map(([subName, subSchema]) =>
      describeField(subName, subSchema),
    );
  }

  const def = zodDef(current);
  if (zodKind(current) === "array") {
    const elemType = asZodType(def.element ?? def.innerType);
    const elemShape = elemType ? getObjectShape(elemType) : undefined;
    if (elemShape) {
      field.subFields = Object.entries(elemShape).map(([subName, subSchema]) =>
        describeField(subName, subSchema),
      );
    }
  }

  return field;
}

function resolveTypeName(schema: z.ZodType): string {
  const def = zodDef(schema);

  switch (zodKind(schema)) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${resolveTypeName(asZodType(def.element ?? def.innerType) ?? z.unknown())}[]`;
    case "object":
      return "object";
    case "record":
      return "Record<string, unknown>";
    case "enum":
      return `enum(${enumValuesFor(schema).join("|")})`;
    case "literal": {
      const litVal = literalValuesFor(schema)[0];
      return `literal(${JSON.stringify(litVal)})`;
    }
    case "union":
      return getUnionOptions(schema)
        .map((o) => resolveTypeName(o))
        .join(" | ");
    default:
      return "unknown";
  }
}

function enumValuesFor(schema: z.ZodType): string[] {
  const candidate = inspectable(schema);
  if (Array.isArray(candidate.options)) {
    return candidate.options.filter(
      (value): value is string => typeof value === "string",
    );
  }

  const def = zodDef(schema);
  if (isRecord(def.entries)) {
    return Object.values(def.entries).filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (Array.isArray(def.values)) {
    return def.values.filter(
      (value): value is string => typeof value === "string",
    );
  }

  return [];
}

function literalValuesFor(schema: z.ZodType): unknown[] {
  const candidate = inspectable(schema);
  if (candidate.values instanceof Set) return Array.from(candidate.values);

  const def = zodDef(schema);
  if (Array.isArray(def.values)) return def.values;
  return def.value === undefined ? [] : [def.value];
}

// --- Hand-Authored Examples ---

const EXAMPLE_REGISTRY: Record<string, Record<string, unknown>> = {
  "symbol.search": { query: "handleError", kinds: ["function"], limit: 10 },
  "symbol.getCard": { symbolId: "<symbolId>" },
  "symbol.edit": {
    mode: "preview",
    symbolId: "<symbolId>",
    operation: { kind: "replaceBody", content: "return true;\n" },
  },
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
  "index.refresh": { mode: "incremental", async: true },
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
  "response.get": {
    handle: "response-myrepo-1770000000000-0123456789abcdef",
    maxBytes: 8192,
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
  "file.write": {
    filePath: "config/app.yaml",
    jsonPath: "server.port",
    jsonValue: 8080,
  },

  "search.edit": {
    mode: "preview",
    targeting: "text",
    query: { literal: "oldName", replacement: "newName", global: true },
    editMode: "replacePattern",
  },
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
  "symbol.edit":
    "Preview/apply symbol-scoped edits with astFingerprint, range, file sha, draft preconditions, and parse-after validation",
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
  "index.refresh":
    "Refresh index. Use async:true from agent workflows unless the caller can tolerate a long foreground run; while async indexing is active, poll repo.status and wait for completion before dependent work.",
  "policy.get": "Get policy config",
  "policy.set":
    "Set policy config (policyPatch wrapper: maxWindowLines, maxWindowTokens, requireIdentifiers, allowBreakGlass, defaultMinCallConfidence, defaultDenyRaw, budgetCaps)",
  "agent.feedback": "Record agent feedback",
  "agent.feedback.query": "Query feedback records",
  "buffer.push": "Push buffer update",
  "buffer.checkpoint":
    "Request buffer checkpoint. Zero-file success responses include a message explaining why no clean buffers were checkpointed.",
  "buffer.status": "Get buffer status",
  "runtime.execute":
    "Execute runtime command. Shell runtime requires code; direct args-only shell execution is rejected. maxResponseLines accepts 5-1000 lines (default 100).",
  "runtime.queryOutput": "Query stored command output by keywords",
  "response.get": "Retrieve a stored large tool response by handle",
  "memory.store": "Store a development memory",
  "memory.query": "Query memories",
  "memory.remove": "Soft-delete a memory",
  "memory.surface": "Auto-surface relevant memories",
  "usage.stats": "Get cumulative token savings statistics",
  "file.read": "Read non-indexed file content (templates, configs, docs)",
  "file.write":
    "Write to a single file (indexed or non-indexed) with targeted modes (line replace, pattern replace, JSON path, insert, append); use search.edit for cross-file batching",
  "search.edit":
    "Cross-file search-and-edit in two phases (preview + apply) with server-side plan handles, sha256 preconditions, rollback, and ignored/dot-directory refusal; use file.write for explicit single-file writes where allowed.",
  "scip.ingest":
    "Ingest a pre-built SCIP index to overlay compiler-grade cross-references onto the symbol graph",
  "semantic.enrichment.refresh":
    "Run provider-backed semantic enrichment with SCIP > LSP source selection",
  "semantic.enrichment.status":
    "Report semantic enrichment source selection, skipped providers, last runs, and precision scores",
};

const META_TOOL_DESCRIPTIONS: Record<string, string> = {
  "action.search":
    "Search the SDL-MCP catalog before choosing a tool. Best starting point when you are unsure whether to use context or workflow; limit accepts at most 50 results.",
  manual:
    "Load the focused SDL-MCP manual after discovery. Use this before composing workflow steps.",
  context:
    "Preferred first tool for explain, debug, review, implement, understand, or investigate prompts. Retrieves task-shaped code context directly and should be chosen before workflow for context retrieval.",
  file: "Unified sdl.file gateway for non-indexed file reads, targeted writes, two-phase search edits, symbol edit wrappers, and plan-bound previewWindow/sourceWindow code windows. previewWindow/sourceWindow need planHandle, reason, expectedLines, identifiersToFind, and symbolId for the planned indexed source file.",
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
    "Render {{mustache}} template strings from object or array and return the rendered string. joinWith (default '\\n') joins array results.",
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
  file: {
    op: "previewWindow",
    repoId: "my-repo",
    planHandle: "<planHandle>",
    filePath: "src/main.ts",
    symbolId: "<symbolId>",
    reason: "Inspect planned source edit",
    expectedLines: 40,
    identifiersToFind: ["targetFunction"],
  },
  workflow: {
    repoId: "<repoId>",
    steps: [
      { fn: "repoStatus" },
      { fn: "runtimeExecute", args: { runtime: "node", args: ["--version"], maxResponseLines: 5 } },
    ],
  },
};

const CONTEXT_DISCOVERY_TERMS = new Set([
  "context",
  "debug",
  "review",
  "explain",
  "understand",
  "investigate",
  "implement",
]);

const WORKFLOW_DISCOVERY_TERMS = new Set([
  "workflow",
  "execute",
  "runtime",
  "transform",
  "batch",
  "pipeline",
]);

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
  "symbol.edit": {
    prerequisites: ["symbol.getCard"],
    recommendedNextActions: ["symbol.edit"],
    fallbacks: ["search.edit", "file.write"],
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
  "response.get": {
    prerequisites: [],
    recommendedNextActions: [],
    fallbacks: ["action.search"],
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
    fallbacks: ["symbol.getCard", "code.getSkeleton"],
  },
  "file.write": {
    prerequisites: ["repo.status", "file.read"],
    recommendedNextActions: ["search.edit"],
    fallbacks: ["runtime.execute"],
  },
  file: {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["file"],
    fallbacks: ["file.write", "search.edit", "symbol.edit", "code.needWindow"],
  },

  "search.edit": {
    prerequisites: ["repo.status"],
    recommendedNextActions: ["search.edit"],
    fallbacks: ["file.write"],
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
  const MEMORY_ACTIONS_LIST = [
    "memory.store",
    "memory.query",
    "memory.remove",
    "memory.surface",
  ];
  if (!memoryVisible) {
    const hasMemory = cachedCatalog.some((d) =>
      MEMORY_ACTIONS_LIST.includes(d.action),
    );
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
          disabledReason:
            "Enable with memory.enabled: true in sdlmcp.config.json",
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
        } else {
          // Disabled gateway placeholder (e.g. memory.* with memory off).
          // Fall back to the static schema so the manual still describes
          // the parameters callers will need once the tool is enabled.
          const fallback = DISABLED_GATEWAY_FALLBACK_SCHEMAS[desc.action];
          if (fallback) {
            result.schemaSummary = zodToSchemaSummary(fallback);
          }
        }
      } else if (desc.kind === "internal") {
        const transform = INTERNAL_TRANSFORMS[desc.fn];
        if (transform) {
          result.schemaSummary = zodToSchemaSummary(transform.schema);
        }
      } else if (desc.kind === "meta") {
        const schema = META_TOOL_SCHEMAS[desc.action];
        if (schema) {
          result.schemaSummary = zodToSchemaSummary(schema);
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
  for (const action of [
    "action.search",
    "manual",
    "context",
    "file",
    "workflow",
  ]) {
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

/** Synonym expansion for action search - maps user terms to SDL action-related terms */
const ACTION_SEARCH_SYNONYMS: Record<string, string[]> = {
  // Test-related - match terms in catalog descriptions like "metadata, deps, metrics"
  test: ["metrics", "symbol", "canonical"],
  tests: ["metrics", "symbol"],
  testing: ["metrics", "symbol"],
  coverage: ["metrics", "symbol", "card"],

  // Code quality
  quality: ["metrics", "churn", "fanin", "fanout"],
  complexity: ["metrics", "fanin", "fanout"],

  // Navigation
  find: ["search", "symbol"],
  lookup: ["search", "getcard", "symbol"],
  locate: ["search", "symbol"],

  // Dependencies - match catalog terms like "dependency graph slice"
  deps: ["slice", "dependency", "graph"],
  dependencies: ["slice", "dependency", "graph"],
  imports: ["slice", "dependency"],
  callers: ["fanin", "slice"],
  callees: ["fanout", "slice", "calls"],

  // Changes
  changes: ["delta", "churn", "pr"],
  diff: ["delta", "pr"],
  history: ["delta", "churn"],

  // Risk
  risk: ["pr", "blast", "delta"],
  impact: ["blast", "pr", "fanin"],

  // Reading code
  read: ["skeleton", "hotpath", "window", "code"],
  view: ["skeleton", "hotpath", "window", "code"],
  show: ["skeleton", "hotpath", "window", "code"],

  // Running
  run: ["runtime", "execute"],
  exec: ["runtime", "execute"],
  execute: ["runtime"],
};

export function rankCatalog(
  catalog: ActionDescriptor[],
  query: string,
): ActionDescriptor[] {
  const q = query.toLowerCase();
  const rawTerms = q.split(/\s+/).filter(Boolean);

  // Expand synonyms: add related terms for better matching
  const terms = rawTerms.flatMap((term) => {
    const synonyms = ACTION_SEARCH_SYNONYMS[term];
    return synonyms ? [term, ...synonyms] : [term];
  });

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
      ...desc.fallbacks,
    ]
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
