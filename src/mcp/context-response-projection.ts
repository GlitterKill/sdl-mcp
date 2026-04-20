/**
 * Compact broad-mode context responses by projecting only model-visible fields.
 * Precise-mode and non-context tool results pass through unchanged.
 */

/** Fields kept in the compact broad response.
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
  "error",
  "truncation",
  "etag",
  "_displayFooter",
]);

/** Tool names eligible for broad compaction. */
const CONTEXT_TOOLS = new Set(["sdl.context"]);

/**
 * Returns true when the result looks like a broad context response that
 * should be compacted.
 */
export function isBroadContextResult(
  toolName: string,
  result: unknown,
): boolean {
  if (!CONTEXT_TOOLS.has(toolName)) return false;
  if (!result || typeof result !== "object" || Array.isArray(result))
    return false;
  const r = result as Record<string, unknown>;
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
 * Project a broad context result to its compact model-visible form.
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
