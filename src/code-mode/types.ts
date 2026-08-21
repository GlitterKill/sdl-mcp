import { z } from "zod";

import type { McpErrorDetail } from "../mcp/errors.js";
import {
  ProjectionRequestOptionShape,
  withProjectionRequestOptions,
} from "../mcp/response-projection/request-options.js";

// --- Zod Schemas ---

export const WorkflowStepSchema = z.object({
  /** Function name in camelCase (e.g., "symbolSearch", "codeSkeleton") */
  fn: z.string().min(1),
  /** Arguments for the function. May contain $N references as string values. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Max tokens for this step's response. Truncates with continuation handle if exceeded. */
  maxResponseTokens: z.number().int().min(50).max(100_000).optional(),
  /** Step-level projection fields never enter handler args. */
  ...ProjectionRequestOptionShape,
});

export const WorkflowBudgetSchema = z.object({
  /** Maximum total estimated tokens across all step results */
  maxTotalTokens: z.number().int().min(100).max(500_000).optional(),
  /** Alias for maxTotalTokens; accepted for compatibility with sdl.context budgets. */
  maxTokens: z.number().int().min(100).max(500_000).optional(),
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

export const WorkflowRequestSchema = withProjectionRequestOptions(z.object({
  /** Repository ID shared across all steps */
  repoId: z.string().min(1),
  /** Ordered list of function calls to execute */
  steps: z.array(WorkflowStepSchema).min(1).max(50),
  /** Optional budget envelope for the entire workflow */
  budget: WorkflowBudgetSchema.optional(),
  /** Error handling policy: dependency-aware continue, legacy continueAll, or stop workflow */
  onError: z.enum(["continue", "continueAll", "stop"]).default("continue"),
  /** Default max tokens per step response (overridden by per-step maxResponseTokens) */
  defaultMaxResponseTokens: z.number().int().min(50).max(100_000).optional(),
  /** When true, intermediate step results are stripped to save tokens */
  onlyFinalResult: z.boolean().optional(),
  /** Opt-in execution trace for debugging */
  trace: WorkflowTraceOptionsSchema.optional(),
  /** When true, validate steps and $N references without executing. Returns validation result only. */
  dryRun: z.boolean().optional(),
  /** Include phase timing diagnostics for performance investigation. */
  includeDiagnostics: ProjectionRequestOptionShape.includeDiagnostics,
  /** Include successful step timing/token telemetry in agent-visible responses. */
  includeTelemetry: z.boolean().optional().default(false),
  /** Response detail for agent-visible workflow projection. */
  detail: ProjectionRequestOptionShape.detail,
}));

// --- TypeScript Types ---

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;
export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export type WorkflowStepStatus = "ok" | "error" | "skipped" | "budget_exceeded";

export interface WorkflowFailureTrace {
  stepIndex: number;
  fn: string;
  action?: string;
  kind?: "gateway" | "internal";
  status: WorkflowStepStatus;
  message: string;
  resolvedArgKeys?: string[];
  fallbackTools?: string[];
  details?: Record<string, unknown>;
}

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
  /** Error message or canonical typed MCP detail if status is "error" */
  error?: string | McpErrorDetail;
  /** Suggested fallback action names from catalog when this step failed */
  fallbackTools?: string[];
  /** Failed/skipped prior step that blocked this step under onError:"continue" */
  blockedByStep?: number;
  /** Function name for blockedByStep */
  blockedByFn?: string;
  /** Upstream error text from blockedByStep */
  blockedByError?: string;
  /** Compact failure context, present on failed and dependency-skipped steps */
  failureTrace?: WorkflowFailureTrace;
  /** Present when step result was truncated due to maxResponseTokens */
  truncatedResponse?: {
    originalTokens: number;
    keptTokens: number;
    continuationHandle: string;
    /** Internal truncation limit used to rebuild a sanitized public continuation. */
    maxTokens?: number;
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
    /** Count of successfully executed steps */
    stepsExecuted: number;
    /** Count of attempted steps (includes failed) */
    stepsAttempted?: number;
  };
}

const WorkflowTruncatedResponseOutputSchema = z
  .object({
    originalTokens: z.number().nonnegative(),
    keptTokens: z.number().nonnegative(),
    continuationHandle: z.string(),
  })
  .strict();

const WorkflowFailureTraceOutputSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    fn: z.string(),
    action: z.string().optional(),
    kind: z.enum(["gateway", "internal"]).optional(),
    status: z.enum(["ok", "error", "skipped", "budget_exceeded"]),
    message: z.string(),
    resolvedArgKeys: z.array(z.string()).optional(),
    fallbackTools: z.array(z.string()).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const WorkflowErrorDetailOutputSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    details: z.array(z.string()).optional(),
    nextBestAction: z
      .enum([
        "requestSkeleton",
        "requestHotPath",
        "requestRaw",
        "refreshSlice",
        "buildSlice",
        "provideIdentifiersToFind",
        "provideErrorCodeRefs",
        "provideFrontierJustification",
        "increaseBudget",
        "narrowScope",
        "retryWithSameInputs",
      ])
      .optional(),
    requiredFieldsForNext: z.record(z.string(), z.unknown()).optional(),
    classification: z.string().optional(),
    retryable: z.boolean().optional(),
    suggestedRetryDelayMs: z.number().nonnegative().optional(),
    fallbackTools: z.array(z.string()).optional(),
    nextCalls: z
      .array(
        z
          .object({
            action: z.string(),
            args: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .optional(),
    fallbackRationale: z.string().optional(),
    candidates: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

const WorkflowCallableActionOutputSchema = z
  .object({
    action: z.string(),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

const WorkflowSuccessStepOutputSchema = z
  .object({
    fn: z.string(),
    result: z.unknown().optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    tokens: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    status: z.literal("ok").optional(),
    truncatedResponse: WorkflowTruncatedResponseOutputSchema.optional(),
    nextAction: WorkflowCallableActionOutputSchema.optional(),
  })
  .strict();

const WorkflowFailureStepOutputSchema = z
  .object({
    stepIndex: z.number().int().nonnegative().optional(),
    fn: z.string(),
    status: z.enum(["error", "skipped", "budget_exceeded"]),
    error: z
      .union([z.string(), WorkflowErrorDetailOutputSchema])
      .optional(),
    fallbackTools: z.array(z.string()).optional(),
    blockedByStep: z.number().int().nonnegative().optional(),
    blockedByFn: z.string().optional(),
    blockedByError: z.string().optional(),
    failureTrace: WorkflowFailureTraceOutputSchema.optional(),
    nextAction: WorkflowCallableActionOutputSchema.optional(),
    result: z
      .union([z.string(), WorkflowErrorDetailOutputSchema])
      .optional(),
  })
  .strict();

const WorkflowTraceOutputSchema = z
  .object({
    steps: z.array(
      z
        .object({
          stepIndex: z.number().int().nonnegative(),
          fn: z.string(),
          action: z.string(),
          kind: z.enum(["gateway", "internal"]),
          status: z.string(),
          durationMs: z.number().nonnegative(),
          tokens: z.number().nonnegative(),
          summary: z.string(),
          schemaSummary: z.record(z.string(), z.unknown()).optional(),
          example: z.record(z.string(), z.unknown()).optional(),
          resolvedArgsPreview: z.string().optional(),
          resultPreview: z.string().optional(),
        })
        .strict(),
    ),
    totals: z
      .object({
        durationMs: z.number().nonnegative(),
        tokens: z.number().nonnegative(),
        stepsExecuted: z.number().int().nonnegative(),
        stepsAttempted: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

// Child result payloads retain their action-specific schema; the workflow-owned
// outer and per-step envelopes are closed independently of canonical priorResults.
export const WorkflowOutputSchema = z
  .object({
    results: z.array(
      z.union([
        WorkflowSuccessStepOutputSchema,
        WorkflowFailureStepOutputSchema,
      ]),
    ),
    intermediateResultsSuppressed: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
    truncated: z.literal(true).optional(),
    trace: WorkflowTraceOutputSchema.optional(),
    dryRun: z
      .object({
        valid: z.boolean(),
        validation: z.array(
          z
            .object({
              stepIndex: z.number().int().nonnegative(),
              fn: z.string(),
              action: z.string(),
              valid: z.boolean(),
              issues: z.array(z.string()),
              pendingSchemaValidation: z.boolean().optional(),
              fixHint: z.string().optional(),
            })
            .strict(),
        ),
        stepCount: z.number().int().nonnegative(),
        budgetLimits: WorkflowBudgetSchema.strict(),
      })
      .strict()
      .optional(),
    diagnostics: z
      .object({
        timings: z
          .object({
            totalMs: z.number(),
            phases: z.record(z.string(), z.number()),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Compose the public workflow envelope from the active fn-to-action bindings.
 * Canonical workflow state remains unconstrained internally; only emitted step
 * results are checked against their bound action's public success contract.
 */
export function buildWorkflowPublicOutputSchema(
  successOutputSchemaByFn: Readonly<Record<string, z.ZodType>>,
): z.ZodType {
  const fnNamesBySchema = new Map<z.ZodType, string[]>();
  for (const [fn, resultSchema] of Object.entries(successOutputSchemaByFn)) {
    const aliases = fnNamesBySchema.get(resultSchema);
    if (aliases) {
      aliases.push(fn);
    } else {
      fnNamesBySchema.set(resultSchema, [fn]);
    }
  }
  const successStepSchemas = [...fnNamesBySchema.entries()].map(
    ([resultSchema, fnNames]) => {
      const [firstFn, ...remainingFns] = fnNames;
      if (firstFn === undefined) {
        throw new Error("Workflow result schema requires at least one function");
      }
      const fnSchema =
        remainingFns.length === 0
          ? z.literal(firstFn)
          : z.enum([firstFn, ...remainingFns]);
      return WorkflowSuccessStepOutputSchema.safeExtend({
        fn: fnSchema,
        result: resultSchema.optional(),
      });
    },
  );
  const [firstSuccessStepSchema, ...remainingSuccessStepSchemas] =
    successStepSchemas;
  if (firstSuccessStepSchema === undefined) {
    throw new Error("Workflow output schema requires at least one active function");
  }
  const nonEmptySuccessStepSchemas: [
    (typeof successStepSchemas)[number],
    ...(typeof successStepSchemas)[number][],
  ] = [firstSuccessStepSchema, ...remainingSuccessStepSchemas];

  const successStepSchema = z.discriminatedUnion(
    "fn",
    nonEmptySuccessStepSchemas,
  );
  return WorkflowOutputSchema.safeExtend({
    results: z.array(
      z.union([successStepSchema, WorkflowFailureStepOutputSchema]),
    ),
  });
}

export interface WorkflowResponse {
  /** Step results; onlyFinalResult omits successful intermediate envelopes. */
  results: WorkflowStepResult[];
  /** Total estimated tokens across all step results */
  totalTokens: number;
  /** Total wall-clock duration in milliseconds */
  durationMs: number;
  /** True if the workflow was truncated due to budget exhaustion */
  truncated: boolean;
  /** Context ladder warnings (e.g., "Step 3 skips skeleton rung for symbol X") */
  ladderWarnings?: string[];
  /** Present when dryRun was requested - validation results without execution */
  dryRun?: {
    valid: boolean;
    validation: {
      stepIndex: number;
      fn: string;
      action: string;
      valid: boolean;
      issues: string[];
      pendingSchemaValidation?: boolean;
      fixHint?: string;
    }[];
    stepCount: number;
    budgetLimits: object;
  };
  /** Execution trace (only present when trace options are provided) */
  trace?: WorkflowTrace;
  /** Count of intermediate step results suppressed due to onlyFinalResult */
  intermediateResultsSuppressed?: number;
  /** Opt-in phase timing diagnostics for latency investigations. */
  diagnostics?: import("../mcp/timing-diagnostics.js").ToolTimingDiagnostics;
}
