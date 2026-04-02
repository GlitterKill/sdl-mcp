import { z } from "zod";

// --- Zod Schemas ---

export const WorkflowStepSchema = z.object({
  /** Function name in camelCase (e.g., "symbolSearch", "codeSkeleton") */
  fn: z.string().min(1),
  /** Arguments for the function. May contain $N references as string values. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Max tokens for this step's response. Truncates with continuation handle if exceeded. */
  maxResponseTokens: z.number().int().min(50).max(100_000).optional(),
});

export const WorkflowBudgetSchema = z.object({
  /** Maximum total estimated tokens across all step results */
  maxTotalTokens: z.number().int().min(100).max(500_000).optional(),
  /** Maximum number of steps to execute */
  maxSteps: z.number().int().min(1).max(50).optional(),
  /** Maximum total wall-clock duration in milliseconds */
  maxDurationMs: z.number().int().min(1000).max(300_000).optional(),
});

export const WorkflowTraceOptionsSchema = z.object({
  /** Trace detail level */
  level: z.enum(["summary", "verbose"]).default("summary"),
  /** Include resolved args after $N substitution */
  includeResolvedArgs: z.boolean().default(false),
  /** Include schema summaries per step */
  includeSchemas: z.boolean().default(false),
  /** Include example args per step */
  includeExamples: z.boolean().default(false),
  /** Max tokens per preview (resolved args, result) */
  maxPreviewTokens: z.number().int().min(10).max(2000).default(200),
});

export const WorkflowRequestSchema = z.object({
  /** Repository ID shared across all steps */
  repoId: z.string().min(1),
  /** Ordered list of function calls to execute */
  steps: z.array(WorkflowStepSchema).min(1).max(50),
  /** Optional budget envelope for the entire workflow */
  budget: WorkflowBudgetSchema.optional(),
  /** Error handling policy: continue to next step or stop workflow */
  onError: z.enum(["continue", "stop"]).default("continue"),
  /** Default max tokens per step response (overridden by per-step maxResponseTokens) */
  defaultMaxResponseTokens: z.number().int().min(50).max(100_000).optional(),
  /** When true, intermediate step results are stripped to save tokens */
  onlyFinalResult: z.boolean().optional(),
  /** Opt-in execution trace for debugging */
  trace: WorkflowTraceOptionsSchema.optional(),
});

// --- TypeScript Types ---

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export type WorkflowStepStatus =
  | "ok"
  | "error"
  | "skipped"
  | "budget_exceeded";

export interface WorkflowStepResult {
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
  status: WorkflowStepStatus;
  /** Error message if status is "error" */
  error?: string;
  /** Suggested fallback action names from catalog when this step failed */
  fallbackTools?: string[];
  /** Present when step result was truncated due to maxResponseTokens */
  truncatedResponse?: {
    originalTokens: number;
    keptTokens: number;
    continuationHandle: string;
  };
}

export type WorkflowTraceOptions = z.infer<typeof WorkflowTraceOptionsSchema>;

export interface WorkflowTraceStep {
  stepIndex: number;
  fn: string;
  action: string;
  kind: "gateway" | "internal";
  status: string;
  durationMs: number;
  tokens: number;
  summary: string;
  schemaSummary?: import("./action-catalog.js").SchemaSummary;
  example?: Record<string, unknown>;
  resolvedArgsPreview?: string;
  resultPreview?: string;
}

export interface WorkflowTrace {
  steps: WorkflowTraceStep[];
  totals: {
    durationMs: number;
    tokens: number;
    stepsExecuted: number;
  };
}

export interface WorkflowResponse {
  /** Results for each step (always same length as input steps) */
  results: WorkflowStepResult[];
  /** Total estimated tokens across all step results */
  totalTokens: number;
  /** Total wall-clock duration in milliseconds */
  durationMs: number;
  /** True if the workflow was truncated due to budget exhaustion */
  truncated: boolean;
  /** Context ladder warnings (e.g., "Step 3 skips skeleton rung for symbol X") */
  ladderWarnings?: string[];
  /** ETag cache state at end of workflow - pass back in next workflow for savings */
  etagCache?: Record<string, string>;
  /** Execution trace (only present when trace options are provided) */
  trace?: WorkflowTrace;
}
