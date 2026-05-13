/**
 * Compact broad-mode context responses for internal accounting and response
 * limits. Final MCP text content applies the stricter model projection below.
 */

/** Fields kept in the compact broad response before final model-content projection.
 *  Shared with context-engine.ts for pre-truncation compaction. */
export const BROAD_VISIBLE_FIELDS = new Set([
  "taskId",
  "taskType",
  "success",
  "summary",
  "answer",
  "finalEvidence",
  "nextBestAction",
  "retrievalEvidence",
  "diagnostics",
  "error",
  "truncation",
  "etag",
  "_displayFooter",
]);

/** Tool names eligible for context-specific compaction. */
const CONTEXT_TOOLS = new Set(["sdl.context"]);

interface ModelContentProjectionOptions {
  includeDiagnostics: boolean;
  includeRetrievalEvidence: boolean;
}

const ALWAYS_INTERNAL_MODEL_FIELDS = new Set([
  "_displayFooter",
  "_packedStats",
  "_rawContext",
  "_tokenUsage",
  "backupPath",
  "indexUpdate",
  "preconditionSnapshot",
  "taskId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function copyIfPresent(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (key in source) {
    target[key] = source[key];
  }
}

function projectEvidenceForModel(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      return item;
    }

    const projected: Record<string, unknown> = {};
    for (const [key, itemValue] of Object.entries(item)) {
      if (key !== "timestamp") {
        projected[key] = itemValue;
      }
    }
    return projected;
  });
}

function modelOptionsFromArgs(
  args: Record<string, unknown>,
): ModelContentProjectionOptions {
  const options = isRecord(args.options) ? args.options : {};
  return {
    includeDiagnostics: args.includeDiagnostics === true,
    includeRetrievalEvidence:
      args.includeRetrievalEvidence === true
      || options.includeRetrievalEvidence === true,
  };
}

function shouldKeepModelField(
  key: string,
  options: ModelContentProjectionOptions,
): boolean {
  if (ALWAYS_INTERNAL_MODEL_FIELDS.has(key)) {
    return false;
  }
  if (key === "diagnostics") {
    return options.includeDiagnostics;
  }
  if (key === "retrievalEvidence") {
    return options.includeRetrievalEvidence;
  }
  return true;
}

function projectGenericValueForModel(
  value: unknown,
  options: ModelContentProjectionOptions,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectGenericValueForModel(item, options));
  }
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (key === "policyDecision") {
      const decision = isRecord(itemValue) ? itemValue : {};
      if (Array.isArray(decision.deniedReasons)) {
        projected.policyDecision = { deniedReasons: decision.deniedReasons };
      }
      continue;
    }
    if (!shouldKeepModelField(key, options)) {
      continue;
    }
    projected[key] = projectGenericValueForModel(itemValue, options);
  }
  return projected;
}

function projectContextResultForModel(
  result: Record<string, unknown>,
  options: ModelContentProjectionOptions,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  copyIfPresent(result, projected, "taskType");
  copyIfPresent(result, projected, "success");
  copyIfPresent(result, projected, "answer");
  if (!("answer" in result)) {
    copyIfPresent(result, projected, "summary");
  }
  if ("finalEvidence" in result) {
    projected.finalEvidence = projectEvidenceForModel(result.finalEvidence);
  }
  copyIfPresent(result, projected, "nextBestAction");
  copyIfPresent(result, projected, "error");
  copyIfPresent(result, projected, "truncation");
  copyIfPresent(result, projected, "etag");

  if (options.includeRetrievalEvidence) {
    copyIfPresent(result, projected, "retrievalEvidence");
  }
  if (options.includeDiagnostics) {
    copyIfPresent(result, projected, "diagnostics");
  }

  return projected;
}

/**
 * Returns true when the result looks like a broad context response that
 * should be compacted.
 */
export function isBroadContextResult(
  toolName: string,
  result: unknown,
): boolean {
  if (!CONTEXT_TOOLS.has(toolName)) return false;
  if (!isRecord(result)) return false;
  const r = result;
  // Broad results have actionsTaken + path + metrics (precise mode strips some of these
  // but still has actionsTaken). The key differentiator: broad mode has `answer` field.
  // Also check it's not an error result (which should pass through unchanged).
  return (
    "taskId" in r &&
    "actionsTaken" in r &&
    "answer" in r &&
    r.success !== undefined
  );
}

/**
 * Project a broad context result to its compact internal response form.
 * Returns the original result unchanged if it doesn't qualify.
 */
export function projectBroadContextResult(
  toolName: string,
  result: unknown,
): unknown {
  if (!isBroadContextResult(toolName, result)) return result;
  const r = result as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(r)) {
    if (BROAD_VISIBLE_FIELDS.has(key)) {
      projected[key] = r[key];
    }
  }
  return projected;
}

/**
 * Project tool responses before token accounting while keeping the internal raw
 * baseline hint that `computeTokenUsage()` needs.
 */
export function projectContextResultForUsageAccounting(
  toolName: string,
  result: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const projected = projectToolResultForModelContent(toolName, result, args);
  if (!isRecord(projected) || projected === result) {
    return result;
  }
  const accountingResult = projected;
  if ("_rawContext" in result) {
    return {
      ...accountingResult,
      _rawContext: result._rawContext,
    };
  }
  return accountingResult;
}

/**
 * Project the payload serialized into MCP text content for the model/user.
 * Internal diagnostics, sync details, and packing stats stay
 * available to logs/debug paths, but are not duplicated into model-visible text.
 */
export function projectToolResultForModelContent(
  toolName: string,
  result: unknown,
  args: Record<string, unknown> = {},
): unknown {
  if (!isRecord(result)) {
    return result;
  }

  const options = modelOptionsFromArgs(args);
  if (CONTEXT_TOOLS.has(toolName) && ("answer" in result || "finalEvidence" in result)) {
    return projectContextResultForModel(result, options);
  }

  return projectGenericValueForModel(result, options);
}
