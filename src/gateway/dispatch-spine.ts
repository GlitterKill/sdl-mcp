import { z } from "zod";

import type { ActionDefinition } from "../code-mode/action-catalog.js";

export type ResponseMode = "inline" | "auto" | "handle";

/** Surface policy carried to the single pre-parse action seam. */
export type DispatchSurface =
  | { kind: "gateway" | "cli" | "direct" | "flat-mcp" }
  | { kind: "workflow"; forceJsonWireFormat?: boolean }
  | { kind: "retrieve"; responseMode?: ResponseMode };

const parsedActionSchemas = new WeakMap<object, Set<z.ZodType>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markParsed<T>(schema: z.ZodType, value: T): T {
  if (isRecord(value)) {
    const schemas = parsedActionSchemas.get(value) ?? new Set<z.ZodType>();
    schemas.add(schema);
    parsedActionSchemas.set(value, schemas);
  }
  return value;
}

/** Mark values already validated by the flat MCP server schema gate. */
export function markActionArgsParsed<T>(schema: z.ZodType, value: T): T {
  return markParsed(schema, value);
}

/**
 * Preserve validating direct-handler wrappers without parsing values that have
 * already crossed the Dispatch Spine.
 */
export function parseActionHandlerArgs<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  prepare?: (value: unknown) => unknown,
): z.output<T> {
  if (isRecord(raw) && parsedActionSchemas.get(raw)?.has(schema)) {
    return raw as z.output<T>;
  }
  return markParsed(schema, schema.parse(prepare ? prepare(raw) : raw));
}

function applyAliases(
  definition: ActionDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!definition.aliases) return args;

  const prepared = { ...args };
  for (const [alias, canonical] of Object.entries(definition.aliases)) {
    if (prepared[canonical] === undefined && prepared[alias] !== undefined) {
      prepared[canonical] = prepared[alias];
    }
    delete prepared[alias];
  }
  return prepared;
}

function parseStructuredSymbolRef(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !["code.needWindow", "code.getSkeleton", "code.getHotPath"].includes(
      action,
    ) ||
    typeof args.symbolRef !== "string"
  ) {
    return args;
  }

  try {
    const parsed = JSON.parse(args.symbolRef) as unknown;
    return isRecord(parsed) ? { ...args, symbolRef: parsed } : args;
  } catch {
    return args;
  }
}

function applySurfacePolicy(
  action: string,
  args: Record<string, unknown>,
  surface: DispatchSurface,
): Record<string, unknown> {
  const prepared = { ...args };

  if (action === "buffer.push" && typeof prepared.timestamp === "number") {
    prepared.timestamp = new Date(prepared.timestamp).toISOString();
  }

  if (surface.kind === "workflow" && surface.forceJsonWireFormat) {
    prepared.wireFormat ??= "json";
  }

  if (surface.kind !== "retrieve") return prepared;

  if (action === "symbol.search") prepared.wireFormat ??= "auto";
  if (action === "slice.build") {
    prepared.wireFormat ??= "auto";
    prepared.cardDetail ??= "compact";
    prepared.includeLegend ??= false;
    prepared.includeRetrievalEvidence ??= false;
    prepared.includeProcesses ??= false;
  }
  if (action === "code.needWindow") {
    prepared.responseMode ??= surface.responseMode ?? "auto";
  }

  return prepared;
}

/** Apply aliases/defaults before exactly one parse with the published schema. */
export function prepareAndParseActionArgs(
  definition: ActionDefinition,
  raw: unknown,
  surface: DispatchSurface,
): unknown {
  if (!isRecord(raw)) {
    return markParsed(definition.schema, definition.schema.parse(raw));
  }

  const aliased = applyAliases(definition, raw);
  const structured = parseStructuredSymbolRef(definition.action, aliased);
  const prepared = applySurfacePolicy(definition.action, structured, surface);
  return markParsed(definition.schema, definition.schema.parse(prepared));
}
