/**
 * Generic CLI argument parser for tool actions.
 *
 * Translates CLI flags (parsed by Node's `util.parseArgs`) into
 * handler-compatible argument objects using action definitions from tool-actions.ts.
 */

import type { ActionDefinition, ActionArgDef } from "./tool-actions.js";

/**
 * Convert a kebab-case flag name to the corresponding parseArgs key.
 * "--repo-id" → "repo-id" (strip leading dashes)
 */
function stripDashes(flag: string): string {
  return flag.replace(/^-+/, "");
}

/**
 * Convert a value to the expected type based on the arg definition.
 */
function coerceValue(
  def: ActionArgDef,
  value: unknown,
): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  switch (def.type) {
    case "string":
      return String(value);

    case "number": {
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`--${stripDashes(def.flag)} must be a number, got: ${value}`);
      }
      return num;
    }

    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return Boolean(value);

    case "string[]": {
      if (Array.isArray(value)) {
        return value.flatMap((v: unknown) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
      }
      return String(value).split(",").map((s) => s.trim()).filter(Boolean);
    }

    case "json": {
      if (typeof value === "object" && value !== null) return value;
      try {
        return JSON.parse(String(value));
      } catch {
        throw new Error(`--${stripDashes(def.flag)} must be valid JSON, got: ${value}`);
      }
    }

    default:
      return value;
  }
}

/**
 * Build the handler-compatible args object from CLI flag values.
 *
 * @param definition The action definition with arg specs
 * @param values     Parsed values from Node's parseArgs
 * @param stdinArgs  Optional pre-parsed args from stdin JSON (merged first, flags override)
 * @returns Handler-compatible args object
 * @throws Error if required args are missing
 */
export function parseToolArgs(
  definition: ActionDefinition,
  values: Record<string, unknown>,
  stdinArgs?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Start with stdin args if provided
  if (stdinArgs) {
    Object.assign(result, stdinArgs);
  }

  // Map CLI flag values to handler fields (flags override stdin)
  for (const argDef of definition.args) {
    const flagKey = stripDashes(argDef.flag);
    const rawValue = values[flagKey];

    if (rawValue !== undefined) {
      const coerced = coerceValue(argDef, rawValue);
      if (coerced !== undefined) {
        result[argDef.field] = coerced;
      }
    }
  }

  // Handle budget fields: merge _budgetMaxCards and _budgetMaxTokens into a budget object
  const budgetMaxCards = result._budgetMaxCards;
  const budgetMaxTokens = result._budgetMaxTokens;
  if (budgetMaxCards !== undefined || budgetMaxTokens !== undefined) {
    const budget: Record<string, unknown> = (result.budget as Record<string, unknown>) ?? {};
    if (budgetMaxCards !== undefined) {
      budget.maxCards = budgetMaxCards;
    }
    if (budgetMaxTokens !== undefined) {
      budget.maxEstimatedTokens = budgetMaxTokens;
    }
    result.budget = budget;
    delete result._budgetMaxCards;
    delete result._budgetMaxTokens;
  }

  // Validate required args
  const missing: string[] = [];
  for (const argDef of definition.args) {
    if (argDef.required && result[argDef.field] === undefined) {
      missing.push(argDef.flag);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required argument(s): ${missing.join(", ")}\n` +
      `Run: sdl-mcp tool ${definition.action} --help`,
    );
  }

  return result;
}

/**
 * Get all flag names registered for an action definition.
 * Returns both long (--flag) and short (-f) variants.
 */
export function getActionFlagNames(
  definition: ActionDefinition,
): string[] {
  const flags: string[] = [];
  for (const arg of definition.args) {
    flags.push(arg.flag);
    if (arg.short) {
      flags.push(arg.short);
    }
  }
  return flags;
}

/**
 * Build a parseArgs options spec from an action definition.
 * Returns an options object suitable for Node's parseArgs().
 */
export function buildParseArgsOptions(
  definition: ActionDefinition,
): Record<string, { type: "string" | "boolean"; short?: string }> {
  const options: Record<string, { type: "string" | "boolean"; short?: string }> = {};

  for (const arg of definition.args) {
    const key = stripDashes(arg.flag);
    // For parseArgs: boolean flags use "boolean", everything else uses "string"
    // (we coerce strings to numbers/arrays/json ourselves)
    const parseType = arg.type === "boolean" ? "boolean" : "string";
    const entry: { type: "string" | "boolean"; short?: string; multiple?: boolean } = { type: parseType };
    if (arg.short) {
      entry.short = arg.short.replace(/^-/, "");
    }
    if (arg.type === "string[]") {
      entry.multiple = true;
    }
    options[key] = entry as any;
  }

  return options;
}
