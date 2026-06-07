/**
 * Compact JSON Schema emitter — deduplicates repeated sub-schemas
 * using $defs/$ref to minimize token count in tools/list responses.
 */
import { z } from "zod";
import { toJSONSchema } from "zod/v4";

/**
 * Build a compact JSON Schema from a Zod schema by:
 * 1. Converting with z.toJSONSchema
 * 2. Deduplicating repeated sub-schemas into $defs/$ref
 */
/**
 * Convert a Zod schema to JSON Schema using Zod 4 built-in conversion.
 */
export function zodSchemaToJsonSchema(

  schema: z.ZodType,
): Record<string, unknown> {
  // v3 compat schemas are structurally compatible with v4 toJSONSchema
  // io: "input" makes pipeProcessor pick the pre-transform input shape.
  // unrepresentable: "any" is a defensive fallback for non-representable nodes.
  const jsonSchema = toJSONSchema(
    schema as unknown as Parameters<typeof toJSONSchema>[0],
    { io: "input", unrepresentable: "any" },
  ) as Record<string, unknown>;
  // Remove $schema key for compact MCP tool responses
  delete jsonSchema["$schema"];
  return normalizeRootObjectSchema(jsonSchema);
}

const ROOT_COMPOSITION_KEYS = new Set(["oneOf", "anyOf", "allOf"]);

interface ObjectSchemaParts {
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: unknown;
}

export function normalizeRootObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return flattenRootObjectComposition(schema) ?? ensureObjectType(schema);
}

export function buildCompactJsonSchema(
  schema: z.ZodType,
): Record<string, unknown> {
  const raw = zodSchemaToJsonSchema(schema);
  return compactJsonSchema(raw);
}

export function compactJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return deduplicateRefs(normalizeRootObjectSchema(structuredClone(schema)));
}

function ensureObjectType(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (schema["type"] !== undefined) {
    return schema;
  }
  const variants = (schema["anyOf"] ?? schema["oneOf"]) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return schema;
  }
  if (variants.every((v) => v && v["type"] === "object")) {
    schema["type"] = "object";
  }
  return schema;
}

function flattenRootObjectComposition(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const variants = expandRootVariants(schema);
  if (variants !== undefined) {
    const parts = variants.map((variant) => flattenObjectSchema(variant));
    if (parts.some((part) => part === undefined)) {
      return undefined;
    }
    return buildRootObjectSchema(
      schema,
      mergeUnionObjectParts(parts as ObjectSchemaParts[]),
    );
  }

  if (Array.isArray(schema["allOf"])) {
    const parts = flattenObjectSchema(schema);
    if (parts !== undefined) {
      return buildRootObjectSchema(schema, parts);
    }
  }

  return undefined;
}

function expandRootVariants(
  schema: Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  const directVariants = getCompositionVariants(schema, "oneOf") ??
    getCompositionVariants(schema, "anyOf");
  if (directVariants !== undefined) {
    const base = omitCompositionKeys(schema);
    return hasObjectShape(base)
      ? directVariants.map((variant) => ({ allOf: [base, variant] }))
      : directVariants;
  }

  const allOf = getCompositionVariants(schema, "allOf");
  if (allOf === undefined) {
    return undefined;
  }

  const baseComponents: Array<Record<string, unknown>> = [];
  let unionVariants: Array<Record<string, unknown>> | undefined;
  for (const component of allOf) {
    const componentVariants = getCompositionVariants(component, "oneOf") ??
      getCompositionVariants(component, "anyOf");
    if (componentVariants !== undefined) {
      if (unionVariants !== undefined) {
        return undefined;
      }
      unionVariants = componentVariants;
      continue;
    }
    baseComponents.push(component);
  }

  if (unionVariants === undefined) {
    return undefined;
  }

  return unionVariants.map((variant) => ({
    allOf: [...baseComponents, variant],
  }));
}

function getCompositionVariants(
  schema: Record<string, unknown>,
  key: "oneOf" | "anyOf" | "allOf",
): Array<Record<string, unknown>> | undefined {
  const value = schema[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (value.every((item) => isRecord(item))) {
    return value;
  }
  return undefined;
}

function flattenObjectSchema(
  schema: Record<string, unknown>,
): ObjectSchemaParts | undefined {
  const parts: ObjectSchemaParts = {
    properties: {},
    required: [],
  };
  let sawObjectShape = false;

  if (hasObjectShape(schema)) {
    mergeIntersectionParts(parts, objectPartsFromOwnSchema(schema));
    sawObjectShape = true;
  }

  const allOf = getCompositionVariants(schema, "allOf");
  if (allOf !== undefined) {
    for (const component of allOf) {
      const componentParts = flattenObjectSchema(component);
      if (componentParts === undefined) {
        return undefined;
      }
      mergeIntersectionParts(parts, componentParts);
    }
    sawObjectShape = true;
  }

  if (
    getCompositionVariants(schema, "oneOf") !== undefined ||
    getCompositionVariants(schema, "anyOf") !== undefined
  ) {
    return undefined;
  }

  return sawObjectShape ? parts : undefined;
}

function hasObjectShape(schema: Record<string, unknown>): boolean {
  return (
    schema["type"] === "object" ||
    isRecord(schema["properties"]) ||
    Array.isArray(schema["required"])
  );
}

function objectPartsFromOwnSchema(
  schema: Record<string, unknown>,
): ObjectSchemaParts {
  return {
    properties: isRecord(schema["properties"])
      ? structuredClone(schema["properties"])
      : {},
    required: readRequired(schema),
    additionalProperties: schema["additionalProperties"],
  };
}

function mergeIntersectionParts(
  target: ObjectSchemaParts,
  source: ObjectSchemaParts,
): void {
  mergePropertiesInto(target.properties, source.properties);
  target.required = orderedUnion(target.required, source.required);
  target.additionalProperties = mergeAdditionalProperties(
    target.additionalProperties,
    source.additionalProperties,
  );
}

function mergeUnionObjectParts(parts: ObjectSchemaParts[]): ObjectSchemaParts {
  const result: ObjectSchemaParts = {
    properties: {},
    required: parts.length > 0 ? [...parts[0].required] : [],
  };

  for (const part of parts) {
    mergePropertiesInto(result.properties, part.properties);
    result.required = orderedIntersection(result.required, part.required);
    result.additionalProperties = mergeAdditionalProperties(
      result.additionalProperties,
      part.additionalProperties,
    );
  }

  return result;
}

function mergePropertiesInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] =
      key in target
        ? mergePropertySchemas(target[key], value)
        : structuredClone(value);
  }
}

function mergePropertySchemas(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) {
    return canonicalize(left) === canonicalize(right) ? left : {};
  }
  if (canonicalize(left) === canonicalize(right)) {
    return left;
  }

  const literalSchema = mergeLiteralSchemas(left, right);
  if (literalSchema !== undefined) {
    return literalSchema;
  }

  const leftType = readSchemaType(left);
  const rightType = readSchemaType(right);
  if (leftType === undefined || rightType === undefined) {
    return mergeFallbackSchema(left, right);
  }

  if (
    (leftType === "number" || leftType === "integer") &&
    (rightType === "number" || rightType === "integer")
  ) {
    return mergeNumberSchemas(left, right);
  }

  if (leftType !== rightType) {
    return mergeFallbackSchema(left, right);
  }

  if (leftType === "string") {
    return mergeStringSchemas(left, right);
  }
  if (leftType === "array") {
    return mergeArraySchemas(left, right);
  }
  if (leftType === "object") {
    return mergeObjectPropertySchemas(left, right);
  }

  return mergeFallbackSchema(left, right);
}

function mergeLiteralSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const leftLiterals = readLiteralValues(left);
  const rightLiterals = readLiteralValues(right);
  if (leftLiterals === undefined || rightLiterals === undefined) {
    return undefined;
  }

  const values = uniqueByCanonical([...leftLiterals, ...rightLiterals]);
  const type = commonLiteralType(values);
  return withDescription(
    {
      ...(type !== undefined ? { type } : {}),
      enum: values,
    },
    left,
    right,
  );
}

function mergeNumberSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  return withDescription(
    {
      type:
        readSchemaType(left) === "integer" && readSchemaType(right) === "integer"
          ? "integer"
          : "number",
      ...mergeMinMax(left, right, "minimum", Math.min),
      ...mergeMinMax(left, right, "maximum", Math.max),
    },
    left,
    right,
  );
}

function mergeStringSchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftLiterals = readLiteralValues(left);
  const rightLiterals = readLiteralValues(right);
  if (leftLiterals !== undefined && rightLiterals !== undefined) {
    return mergeLiteralSchemas(left, right) ?? {};
  }
  if (leftLiterals !== undefined || rightLiterals !== undefined) {
    return withDescription({ type: "string" }, left, right);
  }

  const result: Record<string, unknown> = {
    type: "string",
    ...mergeMinMax(left, right, "minLength", Math.min),
    ...mergeMinMax(left, right, "maxLength", Math.max),
  };
  if (left["pattern"] === right["pattern"] && left["pattern"] !== undefined) {
    result["pattern"] = left["pattern"];
  }
  return withDescription(result, left, right);
}

function mergeArraySchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: "array",
    ...mergeMinMax(left, right, "minItems", Math.min),
    ...mergeMinMax(left, right, "maxItems", Math.max),
  };
  if (canonicalize(left["items"]) === canonicalize(right["items"])) {
    if (left["items"] !== undefined) {
      result["items"] = structuredClone(left["items"]);
    }
  } else {
    result["items"] = {};
  }
  return withDescription(result, left, right);
}

function mergeObjectPropertySchemas(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (isRecord(left["properties"])) {
    mergePropertiesInto(properties, left["properties"]);
  }
  if (isRecord(right["properties"])) {
    mergePropertiesInto(properties, right["properties"]);
  }

  const required = orderedIntersection(readRequired(left), readRequired(right));
  const result: Record<string, unknown> = { type: "object" };
  if (Object.keys(properties).length > 0) {
    result["properties"] = properties;
  }
  if (required.length > 0) {
    result["required"] = required;
  }
  const additionalProperties = mergeAdditionalProperties(
    left["additionalProperties"],
    right["additionalProperties"],
  );
  if (additionalProperties !== undefined) {
    result["additionalProperties"] = additionalProperties;
  }
  return withDescription(result, left, right);
}

function mergeFallbackSchema(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  return withDescription({}, left, right);
}

function mergeMinMax(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
  combine: (a: number, b: number) => number,
): Record<string, number> {
  const leftValue = typeof left[key] === "number" ? left[key] : undefined;
  const rightValue = typeof right[key] === "number" ? right[key] : undefined;
  if (leftValue === undefined) {
    return rightValue === undefined ? {} : { [key]: rightValue };
  }
  if (rightValue === undefined) {
    return { [key]: leftValue };
  }
  return { [key]: combine(leftValue, rightValue) };
}

function mergeAdditionalProperties(
  left: unknown,
  right: unknown,
): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return canonicalize(left) === canonicalize(right) ? left : undefined;
}

function buildRootObjectSchema(
  root: Record<string, unknown>,
  parts: ObjectSchemaParts,
): Record<string, unknown> {
  const result = copyRootMetadata(root);
  result["type"] = "object";
  if (Object.keys(parts.properties).length > 0) {
    result["properties"] = parts.properties;
  }
  if (parts.required.length > 0) {
    result["required"] = parts.required;
  }
  if (parts.additionalProperties !== undefined) {
    result["additionalProperties"] = parts.additionalProperties;
  }
  return result;
}

function copyRootMetadata(
  root: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (
      key === "type" ||
      key === "properties" ||
      key === "required" ||
      key === "additionalProperties" ||
      ROOT_COMPOSITION_KEYS.has(key)
    ) {
      continue;
    }
    result[key] = structuredClone(value);
  }
  return result;
}

function omitCompositionKeys(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ROOT_COMPOSITION_KEYS.has(key)) {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function readRequired(schema: Record<string, unknown>): string[] {
  const required = schema["required"];
  return Array.isArray(required)
    ? required.filter((item): item is string => typeof item === "string")
    : [];
}

function readSchemaType(schema: Record<string, unknown>): string | undefined {
  const value = schema["type"];
  return typeof value === "string" ? value : undefined;
}

function readLiteralValues(
  schema: Record<string, unknown>,
): unknown[] | undefined {
  if ("const" in schema) {
    return [schema["const"]];
  }
  const enumValues = schema["enum"];
  return Array.isArray(enumValues) ? enumValues : undefined;
}

function commonLiteralType(values: unknown[]): string | undefined {
  const types = uniqueByCanonical(values.map((value) => typeof value));
  if (types.length !== 1) {
    return undefined;
  }
  const [type] = types;
  return type === "string" || type === "number" || type === "boolean"
    ? type
    : undefined;
}

function uniqueByCanonical<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = canonicalize(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function orderedUnion(left: string[], right: string[]): string[] {
  return uniqueByCanonical([...left, ...right]);
}

function orderedIntersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function withDescription(
  result: Record<string, unknown>,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const description =
    typeof left["description"] === "string"
      ? left["description"]
      : typeof right["description"] === "string"
        ? right["description"]
        : undefined;
  if (description !== undefined) {
    result["description"] = description;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deduplicate repeated sub-schemas by hoisting them into $defs
 * and replacing inline occurrences with $ref pointers.
 *
 * Algorithm:
 * 1. Walk the schema tree and fingerprint every object node
 * 2. Count occurrences of each fingerprint
 * 3. For fingerprints appearing 2+ times with object size > threshold,
 *    hoist to $defs and replace with $ref
 */
function deduplicateRefs(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  // Phase 1: Fingerprint all object nodes
  const fingerprints = new Map<string, { count: number; value: unknown }>();
  collectFingerprints(schema, fingerprints);

  // Phase 2: Identify candidates for hoisting (appear 2+ times, size > 40 chars)
  const MIN_SIZE = 40;
  const hoistable = new Map<string, string>(); // fingerprint -> def name
  let defIndex = 0;
  const defs: Record<string, unknown> = {};

  for (const [fp, entry] of fingerprints) {
    if (entry.count >= 2 && fp.length > MIN_SIZE) {
      const defName = `d${defIndex++}`;
      hoistable.set(fp, defName);
      defs[defName] = entry.value;
    }
  }

  if (Object.keys(defs).length === 0) {
    return schema;
  }

  // Phase 3: Replace occurrences with $ref, but skip root and skip within $defs itself
  const replaced = replaceWithRefs(schema, hoistable, true) as Record<
    string,
    unknown
  >;

  // Merge $defs into the root schema
  const existing = (replaced.$defs ?? {}) as Record<string, unknown>;
  replaced.$defs = { ...existing, ...defs };
  return replaced;
}

function canonicalize(obj: unknown): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    sorted
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalize((obj as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function collectFingerprints(
  obj: unknown,
  map: Map<string, { count: number; value: unknown }>,
): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectFingerprints(item, map);
    return;
  }

  const rec = obj as Record<string, unknown>;
  // Only fingerprint objects with "type" key (actual schema nodes)
  if (
    "type" in rec ||
    "properties" in rec ||
    "oneOf" in rec ||
    "anyOf" in rec ||
    "allOf" in rec
  ) {
    const fp = canonicalize(rec);
    const existing = map.get(fp);
    if (existing) {
      existing.count++;
    } else {
      map.set(fp, { count: 1, value: structuredClone(rec) });
    }
  }

  // Recurse into children
  for (const value of Object.values(rec)) {
    collectFingerprints(value, map);
  }
}

function replaceWithRefs(
  obj: unknown,
  hoistable: Map<string, string>,
  isRoot: boolean,
): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => replaceWithRefs(item, hoistable, false));
  }

  const rec = obj as Record<string, unknown>;

  // Check if this entire object should be replaced with a $ref
  if (!isRoot) {
    if (
      "type" in rec ||
      "properties" in rec ||
      "oneOf" in rec ||
      "anyOf" in rec ||
      "allOf" in rec
    ) {
      const fp = canonicalize(rec);
      const defName = hoistable.get(fp);
      if (defName) {
        return { $ref: `#/$defs/${defName}` };
      }
    }
  }

  // Recurse into children
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rec)) {
    result[key] = replaceWithRefs(value, hoistable, false);
  }
  return result;
}
