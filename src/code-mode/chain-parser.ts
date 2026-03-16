import { ChainRequestSchema, type ChainBudget } from "./types.js";
import { FN_NAME_MAP } from "./manual-generator.js";

export interface ParsedChainStep {
  fn: string; // original camelCase name
  action: string; // dot-notation action name (e.g., "symbol.search")
  args: Record<string, unknown>;
}

export interface ParsedChainRequest {
  repoId: string;
  steps: ParsedChainStep[];
  budget?: ChainBudget;
  onError: "continue" | "stop";
}

/**
 * Recursively walks an args object and extracts all $N step reference indices.
 * Returns a deduplicated, sorted array of referenced step indices.
 */
function findRefsInArgs(args: Record<string, unknown>): number[] {
  const refs = new Set<number>();
  const REF_RE = /\$(\d+)/g;

  function walkValue(value: unknown): void {
    if (typeof value === "string") {
      let match: RegExpExecArray | null;
      REF_RE.lastIndex = 0;
      while ((match = REF_RE.exec(value)) !== null) {
        refs.add(parseInt(match[1], 10));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walkValue(item);
      }
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        walkValue(v);
      }
    }
  }

  walkValue(args);
  return Array.from(refs).sort((a, b) => a - b);
}

/**
 * Parses and validates a raw chain request.
 *
 * Returns `{ ok: true; request }` on success, or `{ ok: false; errors }` if
 * Zod validation fails or any step references an out-of-range $N index.
 */
export function parseChainRequest(
  raw: unknown,
): { ok: true; request: ParsedChainRequest } | { ok: false; errors: string[] } {
  const parsed = ChainRequestSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
      return `${path}${issue.message}`;
    });
    return { ok: false, errors };
  }

  const { repoId, steps, budget, onError } = parsed.data;
  const errors: string[] = [];
  const parsedSteps: ParsedChainStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Validate fn exists in FN_NAME_MAP
    if (!(step.fn in FN_NAME_MAP)) {
      errors.push(
        `Unknown function '${step.fn}' in step ${i}. Available: ${Object.keys(FN_NAME_MAP).join(", ")}`,
      );
      continue;
    }

    // Validate all $N references refer to already-executed steps
    const refs = findRefsInArgs(step.args);
    for (const ref of refs) {
      if (ref >= i) {
        errors.push(`Step ${i} references $${ref} which hasn't executed yet`);
      }
    }

    parsedSteps.push({
      fn: step.fn,
      action: FN_NAME_MAP[step.fn],
      args: step.args,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    request: { repoId, steps: parsedSteps, budget, onError },
  };
}
