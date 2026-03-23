/**
 * Compact JSON Schema emitter — deduplicates repeated sub-schemas
 * using $defs/$ref to minimize token count in tools/list responses.
 */
import { z } from "zod";

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
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // Remove $schema key for compact MCP tool responses
  delete jsonSchema["$schema"];
  return jsonSchema;
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
  return deduplicateRefs(structuredClone(schema));
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
