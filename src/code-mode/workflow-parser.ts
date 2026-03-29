import {
  WorkflowRequestSchema,
  type WorkflowBudget,
} from "./types.js";
import { ACTION_TO_FN, FN_NAME_MAP } from "./manual-generator.js";
import { isInternalTransform } from "./transforms.js";

export interface ParsedWorkflowStep {
  fn: string; // original camelCase name
  action: string; // dot-notation action name (e.g., "symbol.search")
  args: Record<string, unknown>;
  /** Whether this step is an internal transform (not routed through gateway) */
  internal: boolean;
  maxResponseTokens?: number;
}

export interface ParsedWorkflowRequest {
  repoId: string;
  steps: ParsedWorkflowStep[];
  budget?: WorkflowBudget;
  onError: "continue" | "stop";
  defaultMaxResponseTokens?: number;
}

/**
 * Recursively walks an args object and extracts all $N step reference indices.
 * Returns a deduplicated, sorted array of referenced step indices.
 */
function findRefsInArgs(args: Record<string, unknown>): number[] {
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
      for (const nestedValue of Object.values(value as Record<string, unknown>)) {
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

  const { repoId, steps, budget, onError, defaultMaxResponseTokens } = parsed.data;
  const errors: string[] = [];
  const parsedSteps: ParsedWorkflowStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isTransform = isInternalTransform(step.fn);

    // Normalize dot-notation (e.g., "repo.status") to camelCase (e.g., "repoStatus")
    let resolvedFn = step.fn;
    if (!isTransform && !(resolvedFn in FN_NAME_MAP)) {
      const mapped = ACTION_TO_FN[resolvedFn];
      if (mapped) {
        resolvedFn = mapped;
      }
    }

    if (!isTransform && !(resolvedFn in FN_NAME_MAP)) {
      errors.push(
        `Unknown function '${step.fn}' in step ${i}. Available: ${Object.keys(FN_NAME_MAP).join(", ")}, dataPick, dataMap, dataFilter, dataSort, dataTemplate, workflowContinuationGet`,
      );
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
      action: isTransform ? step.fn : FN_NAME_MAP[resolvedFn],
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
    },
  };
}
