import { WorkflowRequestSchema, type WorkflowBudget } from "./types.js";
import { getActiveFnNameMap, getActiveActionToFn } from "./manual-generator.js";
import { isInternalTransform } from "./transforms.js";

export interface ParsedWorkflowStep {
  fn: string; // original camelCase name
  action: string; // dot-notation action name (e.g., "symbol.search")
  args: Record<string, unknown>;
  /** Whether this step is an internal transform (not routed through gateway) */
  internal: boolean;
  maxResponseTokens?: number;
  /**
   * When true, the executor must skip this step and emit an `error`-status
   * result for it. Set by the parser when `onError: "continue"` lets us
   * tolerate per-step validation failures (unknown fn, disabled tool) so
   * sibling steps can still execute.
   */
  skip?: boolean;
  /** Human-readable reason populated when `skip` is true. */
  skipReason?: string;
}

export interface ParsedWorkflowRequest {
  repoId: string;
  steps: ParsedWorkflowStep[];
  budget?: WorkflowBudget;
  onError: "continue" | "stop";
  defaultMaxResponseTokens?: number;
  onlyFinalResult?: boolean;
  /** When true, validate steps and references without executing */
  /** Prior workflow etagCache to seed */
  etagCache?: Record<string, string>;
  dryRun?: boolean;
}

/**
 * Recursively walks an args object and extracts all $N step reference indices.
 * Returns a deduplicated, sorted array of referenced step indices.
 */
export function findRefsInArgs(args: Record<string, unknown>): number[] {
  const refs = new Set<number>();
  const refPattern = /\$(\d+)/g;

  function walkValue(value: unknown): void {
    if (typeof value === "string") {
      let match: RegExpExecArray | null;
      refPattern.lastIndex = 0;
      while ((match = refPattern.exec(value)) !== null) {
        refs.add(parseInt(match[1], 10));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walkValue(item);
      }
    } else if (value !== null && typeof value === "object") {
      for (const nestedValue of Object.values(
        value as Record<string, unknown>,
      )) {
        walkValue(nestedValue);
      }
    }
  }

  walkValue(args);
  return Array.from(refs).sort((a, b) => a - b);
}

/**
 * Parses and validates a raw workflow request.
 *
 * Returns `{ ok: true; request }` on success, or `{ ok: false; errors }` if
 * Zod validation fails or any step references an out-of-range $N index.
 */
export function parseWorkflowRequest(
  raw: unknown,
):
  | { ok: true; request: ParsedWorkflowRequest }
  | { ok: false; errors: string[] } {
  const parsed = WorkflowRequestSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
      return `${path}${issue.message}`;
    });
    return { ok: false, errors };
  }

  const {
    repoId,
    steps,
    budget,
    onError,
    defaultMaxResponseTokens,
    onlyFinalResult,
    dryRun,
    etagCache,
  } = parsed.data;
  const errors: string[] = [];
  const parsedSteps: ParsedWorkflowStep[] = [];
  const fnNameMap = getActiveFnNameMap();
  const actionToFn = getActiveActionToFn();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isTransform = isInternalTransform(step.fn);

    // Normalize dot-notation (e.g., "repo.status") to camelCase (e.g., "repoStatus")
    let resolvedFn = step.fn;
    if (!isTransform && !(resolvedFn in fnNameMap)) {
      const mapped = actionToFn[resolvedFn];
      if (mapped) {
        resolvedFn = mapped;
      }
    }

    if (!isTransform && !(resolvedFn in fnNameMap)) {
      const memoryNames = new Set([
        "memory.store",
        "memory.query",
        "memory.remove",
        "memory.surface",
        "memoryStore",
        "memoryQuery",
        "memoryRemove",
        "memorySurface",
      ]);
      const isMemoryFn =
        memoryNames.has(step.fn) || memoryNames.has(resolvedFn);
      const hint = isMemoryFn
        ? ` — this tool is disabled. Enable with memory.enabled: true in your sdlmcp.config.json.`
        : "";
      const available = Object.keys(fnNameMap);
      const availSummary =
        available.length > 25
          ? `${available.slice(0, 25).join(", ")} (and ${available.length - 25} more — call sdl.action.search to discover)`
          : available.join(", ");
      const message = `Step ${i}: unknown function '${step.fn}'${hint}. Available: ${availSummary}, dataPick, dataMap, dataFilter, dataSort, dataTemplate, workflowContinuationGet`;
      // With `onError: "continue"` we record the bad step as a soft skip
      // and let the executor emit a per-step `error` result, so sibling
      // steps in the same envelope still run. Without `continue`, this
      // remains a hard validation failure that aborts the workflow.
      if (onError === "continue") {
        parsedSteps.push({
          fn: step.fn,
          action: step.fn,
          args: step.args,
          internal: false,
          maxResponseTokens: step.maxResponseTokens,
          skip: true,
          skipReason: message,
        });
      } else {
        errors.push(message);
      }
      continue;
    }

    const refs = findRefsInArgs(step.args);
    for (const ref of refs) {
      if (ref >= i) {
        errors.push(`Step ${i} references $${ref} which hasn't executed yet`);
      }
    }

    parsedSteps.push({
      fn: resolvedFn,
      action: isTransform ? step.fn : fnNameMap[resolvedFn],
      args: step.args,
      internal: isTransform,
      maxResponseTokens: step.maxResponseTokens,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: {
      repoId,
      steps: parsedSteps,
      budget,
      onError,
      defaultMaxResponseTokens,
      onlyFinalResult,
      dryRun,
      etagCache,
    },
  };
}
