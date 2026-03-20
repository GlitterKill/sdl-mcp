import { z } from "zod";

// --- Path Navigation (reuses ref-resolver's dot/bracket model without $N prefix) ---

const PATH_SEGMENT_RE = /\.([a-zA-Z_]\w*)|\[(\d+)\]/g;
const SIMPLE_FIELD_RE = /^[a-zA-Z_]\w*$/;

function navigatePath(obj: unknown, path: string): unknown {
  // Simple field name (no dots/brackets)
  if (SIMPLE_FIELD_RE.test(path)) {
    if (obj === null || obj === undefined || typeof obj !== "object") {
      return undefined;
    }
    return (obj as Record<string, unknown>)[path];
  }

  // Complex path with dots/brackets
  let current: unknown = obj;
  const segments: Array<string | number> = [];

  // If path doesn't start with a dot or bracket, the first segment is a plain field
  let rest = path;
  if (!rest.startsWith(".") && !rest.startsWith("[")) {
    const dotIdx = rest.indexOf(".");
    const bracketIdx = rest.indexOf("[");
    if (dotIdx === -1 && bracketIdx === -1) {
      // Entire path is a single field
      if (current !== null && current !== undefined && typeof current === "object") {
        return (current as Record<string, unknown>)[rest];
      }
      return undefined;
    }
    const endIdx =
      dotIdx === -1
        ? bracketIdx
        : bracketIdx === -1
          ? dotIdx
          : Math.min(dotIdx, bracketIdx);
    const firstField = rest.slice(0, endIdx);
    segments.push(firstField);
    rest = rest.slice(endIdx);
  }

  PATH_SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  const pathToParse = rest;
  const re = new RegExp(PATH_SEGMENT_RE.source, "g");
  while ((match = re.exec(pathToParse)) !== null) {
    if (match[1] !== undefined) {
      segments.push(match[1]);
    } else {
      segments.push(parseInt(match[2], 10));
    }
  }

  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;

    if (typeof seg === "number") {
      if (!Array.isArray(current)) return undefined;
      if (seg < 0 || seg >= current.length) return undefined;
      current = current[seg];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }

  return current;
}

// --- Template Rendering ---

const TEMPLATE_RE = /\{\{([^}]+)\}\}/g;

function renderTemplate(template: string, obj: unknown): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = navigatePath(obj, path.trim());
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

// --- Comparison Helpers ---

function compareValues(
  a: unknown,
  b: unknown,
  type: "string" | "number" | "date" | "boolean",
): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : -1;
  if (b === undefined || b === null) return 1;

  switch (type) {
    case "number":
      return Number(a) - Number(b);
    case "date":
      return new Date(String(a)).getTime() - new Date(String(b)).getTime();
    case "boolean":
      return (a ? 1 : 0) - (b ? 1 : 0);
    case "string":
    default:
      return String(a).localeCompare(String(b));
  }
}

// --- Schemas ---

const DataPickSchema = z.object({
  input: z.unknown(),
  fields: z.record(z.string()),
});

const DataMapSchema = z.object({
  input: z.array(z.unknown()),
  fields: z.record(z.string()),
});

const FilterClauseSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in", "exists"]),
  value: z.unknown().optional(),
});

const DataFilterSchema = z.object({
  input: z.array(z.unknown()),
  clauses: z.array(FilterClauseSchema).min(1),
  mode: z.enum(["all", "any"]).default("all"),
});

const DataSortSchema = z.object({
  input: z.array(z.unknown()),
  by: z.object({
    path: z.string().min(1),
    direction: z.enum(["asc", "desc"]).default("asc"),
    type: z.enum(["string", "number", "date", "boolean"]).default("string"),
  }),
});

const DataTemplateSchema = z.object({
  input: z.union([z.record(z.unknown()), z.array(z.unknown())]),
  template: z.string().min(1),
  joinWith: z.string().default("\n"),
});

// --- Implementations ---

function execDataPick(args: unknown): unknown {
  const parsed = DataPickSchema.parse(args);
  const { input, fields } = parsed;

  if (input === null || input === undefined || typeof input !== "object") {
    throw new TransformError("dataPick: input must be an object");
  }

  const result: Record<string, unknown> = {};
  for (const [outputKey, sourcePath] of Object.entries(fields)) {
    result[outputKey] = navigatePath(input, sourcePath);
  }
  return result;
}

function execDataMap(args: unknown): unknown {
  const parsed = DataMapSchema.parse(args);
  const { input, fields } = parsed;

  return input.map((item) => {
    const result: Record<string, unknown> = {};
    for (const [outputKey, sourcePath] of Object.entries(fields)) {
      result[outputKey] = navigatePath(item, sourcePath);
    }
    return result;
  });
}

function matchesClause(
  item: unknown,
  clause: { path: string; op: string; value?: unknown },
): boolean {
  const fieldVal = navigatePath(item, clause.path);

  switch (clause.op) {
    case "exists":
      return fieldVal !== undefined && fieldVal !== null;
    case "eq":
      return fieldVal === clause.value;
    case "ne":
      return fieldVal !== clause.value;
    case "gt":
      return Number(fieldVal) > Number(clause.value);
    case "gte":
      return Number(fieldVal) >= Number(clause.value);
    case "lt":
      return Number(fieldVal) < Number(clause.value);
    case "lte":
      return Number(fieldVal) <= Number(clause.value);
    case "contains":
      if (typeof fieldVal === "string" && typeof clause.value === "string") {
        return fieldVal.includes(clause.value);
      }
      if (Array.isArray(fieldVal)) {
        return fieldVal.includes(clause.value);
      }
      return false;
    case "in":
      if (Array.isArray(clause.value)) {
        return clause.value.includes(fieldVal);
      }
      return false;
    default:
      return false;
  }
}

function execDataFilter(args: unknown): unknown {
  const parsed = DataFilterSchema.parse(args);
  const { input, clauses, mode } = parsed;

  return input.filter((item) => {
    if (mode === "any") {
      return clauses.some((c) => matchesClause(item, c));
    }
    return clauses.every((c) => matchesClause(item, c));
  });
}

function execDataSort(args: unknown): unknown {
  const parsed = DataSortSchema.parse(args);
  const { input, by } = parsed;

  const sorted = [...input];
  sorted.sort((a, b) => {
    const va = navigatePath(a, by.path);
    const vb = navigatePath(b, by.path);
    const cmp = compareValues(va, vb, by.type);
    return by.direction === "desc" ? -cmp : cmp;
  });
  return sorted;
}

function execDataTemplate(args: unknown): unknown {
  const parsed = DataTemplateSchema.parse(args);
  const { input, template, joinWith } = parsed;

  if (Array.isArray(input)) {
    return input.map((item) => renderTemplate(template, item)).join(joinWith);
  }
  return renderTemplate(template, input);
}

// --- Transform Error ---

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}

// --- Registry ---

export interface InternalTransformEntry {
  schema: z.ZodType;
  handler: (args: unknown) => unknown;
  description: string;
}

export const INTERNAL_TRANSFORM_NAMES = [
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
] as const;

export type InternalTransformName = (typeof INTERNAL_TRANSFORM_NAMES)[number];

export const INTERNAL_TRANSFORMS: Record<string, InternalTransformEntry> = {
  dataPick: {
    schema: DataPickSchema,
    handler: execDataPick,
    description: "Project fields from an object",
  },
  dataMap: {
    schema: DataMapSchema,
    handler: execDataMap,
    description: "Project fields from each element of an array",
  },
  dataFilter: {
    schema: DataFilterSchema,
    handler: execDataFilter,
    description: "Filter array elements by clauses",
  },
  dataSort: {
    schema: DataSortSchema,
    handler: execDataSort,
    description: "Sort array elements by a field",
  },
  dataTemplate: {
    schema: DataTemplateSchema,
    handler: execDataTemplate,
    description: "Render template strings from object(s)",
  },
};

/**
 * Check if a function name is an internal transform.
 */
export function isInternalTransform(fn: string): fn is InternalTransformName {
  return fn in INTERNAL_TRANSFORMS;
}

/**
 * Execute an internal transform by name.
 * Throws TransformError on invalid input.
 */
export function executeTransform(fn: string, args: unknown): unknown {
  const entry = INTERNAL_TRANSFORMS[fn];
  if (!entry) {
    throw new TransformError(`Unknown transform: ${fn}`);
  }

  try {
    return entry.handler(args);
  } catch (err) {
    if (err instanceof TransformError) throw err;
    if (err instanceof z.ZodError) {
      const messages = err.issues.map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") + ": " : "";
        return `${path}${i.message}`;
      });
      throw new TransformError(`${fn}: ${messages.join("; ")}`);
    }
    throw new TransformError(`${fn}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
