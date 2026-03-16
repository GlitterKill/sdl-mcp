import { z } from "zod";

// --- Zod Schemas ---

export const ChainStepSchema = z.object({
  /** Function name in camelCase (e.g., "symbolSearch", "codeSkeleton") */
  fn: z.string().min(1),
  /** Arguments for the function. May contain $N references as string values. */
  args: z.record(z.unknown()).default({}),
});

export const ChainBudgetSchema = z.object({
  /** Maximum total estimated tokens across all step results */
  maxTotalTokens: z.number().int().min(100).max(500_000).optional(),
  /** Maximum number of steps to execute */
  maxSteps: z.number().int().min(1).max(50).optional(),
  /** Maximum total wall-clock duration in milliseconds */
  maxDurationMs: z.number().int().min(1000).max(300_000).optional(),
});

export const ChainRequestSchema = z.object({
  /** Repository ID — shared across all steps */
  repoId: z.string().min(1),
  /** Ordered list of function calls to execute */
  steps: z.array(ChainStepSchema).min(1).max(50),
  /** Optional budget envelope for the entire chain */
  budget: ChainBudgetSchema.optional(),
  /** Error handling policy: continue to next step or stop chain */
  onError: z.enum(["continue", "stop"]).default("continue"),
});

// --- TypeScript Types ---

export type ChainStep = z.infer<typeof ChainStepSchema>;
export type ChainBudget = z.infer<typeof ChainBudgetSchema>;
export type ChainRequest = z.infer<typeof ChainRequestSchema>;

export type ChainStepStatus = "ok" | "error" | "skipped" | "budget_exceeded";

export interface ChainStepResult {
  /** Zero-based step index */
  stepIndex: number;
  /** Function name that was called */
  fn: string;
  /** The result payload from the tool handler (null on error/skip) */
  result: unknown;
  /** Estimated token count of this step's result */
  tokens: number;
  /** Wall-clock duration of this step in milliseconds */
  durationMs: number;
  /** Outcome status */
  status: ChainStepStatus;
  /** Error message if status is "error" */
  error?: string;
}

export interface ChainResponse {
  /** Results for each step (always same length as input steps) */
  results: ChainStepResult[];
  /** Total estimated tokens across all step results */
  totalTokens: number;
  /** Total wall-clock duration in milliseconds */
  durationMs: number;
  /** True if chain was truncated due to budget exhaustion */
  truncated: boolean;
  /** Context ladder warnings (e.g., "Step 3 skips skeleton rung for symbol X") */
  ladderWarnings?: string[];
  /** ETag cache state at end of chain — pass back in next chain for savings */
  etagCache?: Record<string, string>;
}
