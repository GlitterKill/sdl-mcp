import { routeGatewayCall, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import type { CodeModeConfig } from "../config/types.js";
import { estimateTokens } from "../util/tokenize.js";
import { buildCatalog, type ActionDescriptor } from "./action-catalog.js";
import { WorkflowEtagCache } from "./etag-cache.js";
import { validateLadder } from "./ladder-validator.js";
import {
  resolveRefs,
  RefResolutionError,
} from "./ref-resolver.js";
import {
  executeTransform,
  TransformError,
} from "./transforms.js";
import { truncateStepResult } from "./workflow-truncation.js";
import {
  type WorkflowResponse,
  type WorkflowStepResult,
  type WorkflowTraceOptions,
  type WorkflowTraceStep,
} from "./types.js";
import type { ParsedWorkflowRequest } from "./workflow-parser.js";
import { WorkflowBudgetTracker } from "./workflow-budget.js";
import { tokenAccumulator } from "../mcp/token-accumulator.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { z } from "zod";

/**
 * Apply per-step token truncation if configured.
 * Mutates stepResult in place if truncation occurs.
 */
function applyStepTruncation(
  stepResult: WorkflowStepResult,
  step: { maxResponseTokens?: number },
  defaultMaxResponseTokens: number | undefined,
): void {
  const maxResponseTokens = step.maxResponseTokens ?? defaultMaxResponseTokens;
  if (
    maxResponseTokens != null
    && stepResult.status === "ok"
    && stepResult.result != null
  ) {
    const truncation = truncateStepResult(stepResult.result, maxResponseTokens);
    if (truncation.handle) {
      stepResult.result = truncation.truncated;
      stepResult.tokens = truncation.keptTokens;
      stepResult.truncatedResponse = {
        originalTokens: truncation.originalTokens,
        keptTokens: truncation.keptTokens,
        continuationHandle: truncation.handle,
      };
    }
  }
}

/**
 * Execute a parsed workflow request sequentially, resolving $N references,
 * tracking budget, validating the context ladder, and caching ETags.
 */
export async function executeWorkflow(
  request: ParsedWorkflowRequest,
  actionMap: ActionMap,
  config: CodeModeConfig,
  context?: ToolContext,
  traceOpts?: WorkflowTraceOptions,
): Promise<WorkflowResponse> {
  const actionCatalog = buildCatalog();
  const budget = new WorkflowBudgetTracker(request.budget, {
    maxSteps: config.maxWorkflowSteps,
    maxTokens: config.maxWorkflowTokens,
    maxDurationMs: config.maxWorkflowDurationMs,
  });

  const etagCache = config.etagCaching ? new WorkflowEtagCache() : null;
  const priorResults: unknown[] = [];
  const stepResults: WorkflowStepResult[] = [];
  const traceSteps: WorkflowTraceStep[] = [];
  const startTime = Date.now();

  const traceCatalog = traceOpts
    && (traceOpts.includeSchemas || traceOpts.includeExamples)
    ? buildCatalog({
      includeSchemas: traceOpts.includeSchemas,
      includeExamples: traceOpts.includeExamples,
    })
    : null;

  for (let i = 0; i < request.steps.length; i++) {
    const step = request.steps[i];

    if (context?.signal?.aborted) {
      for (let j = i; j < request.steps.length; j++) {
        stepResults.push({
          stepIndex: j,
          fn: request.steps[j].fn,
          result: null,
          tokens: 0,
          durationMs: 0,
          status: "skipped",
          error: "Workflow aborted: client disconnected",
        });
        priorResults.push(null);
      }
      break;
    }

    if (!budget.shouldContinue()) {
      for (let j = i; j < request.steps.length; j++) {
        stepResults.push({
          stepIndex: j,
          fn: request.steps[j].fn,
          result: null,
          tokens: 0,
          durationMs: 0,
          status: "budget_exceeded",
        });
        priorResults.push(null);
      }
      break;
    }

    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveRefs(step.args, priorResults);
    } catch (error) {
      const errorMessage = error instanceof RefResolutionError
        ? error.message
        : `Ref resolution failed: ${String(error)}`;
      stepResults.push({
        stepIndex: i,
        fn: step.fn,
        result: null,
        tokens: 0,
        durationMs: 0,
        status: "error",
        error: errorMessage,
      });
      priorResults.push(null);

      if (request.onError === "stop") {
        for (let j = i + 1; j < request.steps.length; j++) {
          stepResults.push({
            stepIndex: j,
            fn: request.steps[j].fn,
            result: null,
            tokens: 0,
            durationMs: 0,
            status: "skipped",
          });
          priorResults.push(null);
        }
        break;
      }
      continue;
    }

    const stepStart = Date.now();

    if (step.internal) {
      try {
        const result = executeTransform(step.fn, resolvedArgs);
        const stepDuration = Date.now() - stepStart;
        const tokens = WorkflowBudgetTracker.estimateResultTokens(result);

        budget.record(tokens, stepDuration);
        priorResults.push(result);

        const stepResult: WorkflowStepResult = {
          stepIndex: i,
          fn: step.fn,
          result,
          tokens,
          durationMs: stepDuration,
          status: "ok",
        };
        applyStepTruncation(
          stepResult,
          step,
          request.defaultMaxResponseTokens,
        );
        stepResults.push(stepResult);

        if (traceOpts) {
          traceSteps.push(
            buildTraceStep(
              i,
              step.fn,
              step.fn,
              "internal",
              "ok",
              stepDuration,
              tokens,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              result,
            ),
          );
        }
      } catch (error) {
        const stepDuration = Date.now() - stepStart;
        budget.record(0, stepDuration);
        const errorMessage = error instanceof TransformError
          ? error.message
          : `Transform failed: ${String(error)}`;

        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: stepDuration,
          status: "error",
          error: errorMessage,
        });
        priorResults.push(null);

        if (traceOpts) {
          traceSteps.push(
            buildTraceStep(
              i,
              step.fn,
              step.fn,
              "internal",
              "error",
              stepDuration,
              0,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              null,
              errorMessage,
            ),
          );
        }

        if (request.onError === "stop") {
          for (let j = i + 1; j < request.steps.length; j++) {
            stepResults.push({
              stepIndex: j,
              fn: request.steps[j].fn,
              result: null,
              tokens: 0,
              durationMs: 0,
              status: "skipped",
            });
            priorResults.push(null);
          }
          break;
        }
      }
    } else {
      if (etagCache) {
        etagCache.injectEtags(step.action, resolvedArgs);
      }

      const gatewayArgs = {
        repoId: request.repoId,
        action: step.action,
        ...resolvedArgs,
      };

      try {
        const result = await routeGatewayCall(gatewayArgs, actionMap, context);
        const stepDuration = Date.now() - stepStart;
        const tokens = WorkflowBudgetTracker.estimateResultTokens(result);

        budget.record(tokens, stepDuration);
        // Record usage for session-level token tracking (per-step attribution)
        const rawCtx = (result && typeof result === "object")
          ? (result as Record<string, unknown>)._rawContext as { fileIds?: string[]; rawTokens?: number } | undefined
          : undefined;
        let rawEquivalent = rawCtx?.rawTokens ?? tokens;
        // When rawTokens is not explicitly set but fileIds are available,
        // estimate raw equivalent from file byte sizes so per-step
        // savings are correctly attributed (not just to the workflow envelope).
        if (!rawCtx?.rawTokens && rawCtx?.fileIds && rawCtx.fileIds.length > 0) {
          try {
            const usageConn = await getLadybugConn();
            const files = await ladybugDb.getFilesByIds(usageConn, rawCtx.fileIds);
            let estimatedRaw = 0;
            for (const file of files.values()) {
              estimatedRaw += Math.ceil(file.byteSize / 4); // ~4 bytes per token
            }
            if (estimatedRaw > tokens) {
              rawEquivalent = estimatedRaw;
            }
          } catch { /* graceful degradation: keep rawEquivalent = tokens */ }
        }
        tokenAccumulator.recordUsage(step.fn, tokens, rawEquivalent);

        if (etagCache) {
          etagCache.extractEtags(step.action, result);
        }

        priorResults.push(result);
        const stepResult: WorkflowStepResult = {
          stepIndex: i,
          fn: step.fn,
          result,
          tokens,
          durationMs: stepDuration,
          status: "ok",
        };
        applyStepTruncation(
          stepResult,
          step,
          request.defaultMaxResponseTokens,
        );
        stepResults.push(stepResult);

        if (traceOpts) {
          traceSteps.push(
            buildTraceStep(
              i,
              step.fn,
              step.action,
              "gateway",
              "ok",
              stepDuration,
              tokens,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              result,
            ),
          );
        }
      } catch (error) {
        const stepDuration = Date.now() - stepStart;
        budget.record(0, stepDuration);
        let errorMessage: string;
        if (error instanceof z.ZodError) {
          const lines = error.issues.map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
            return path + issue.message;
          });
          errorMessage = `Invalid arguments: ${lines.join("; ")}`;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        } else {
          errorMessage = `Step execution failed: ${String(error)}`;
        }

        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: stepDuration,
          status: "error",
          error: errorMessage,
          ...((() => {
            const meta = actionCatalog.find(a => a.action === step.action);
            return meta?.fallbacks?.length ? { fallbackTools: meta.fallbacks } : {};
          })()),
        });
        priorResults.push(null);

        if (traceOpts) {
          traceSteps.push(
            buildTraceStep(
              i,
              step.fn,
              step.action,
              "gateway",
              "error",
              stepDuration,
              0,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              null,
              errorMessage,
            ),
          );
        }

        if (request.onError === "stop") {
          for (let j = i + 1; j < request.steps.length; j++) {
            stepResults.push({
              stepIndex: j,
              fn: request.steps[j].fn,
              result: null,
              tokens: 0,
              durationMs: 0,
              status: "skipped",
            });
            priorResults.push(null);
          }
          break;
        }
      }
    }
  }

  const ladderWarnings = validateLadder(
    request.steps,
    priorResults,
    config.ladderValidation,
  );

  const budgetState = budget.state();
  const etagCacheState = etagCache?.getCache();
  const hasEtags = etagCacheState !== undefined
    && Object.keys(etagCacheState).length > 0;
  const totalDurationMs = Date.now() - startTime;

  const aggregatedFileIds = new Set<string>();
  let aggregatedRawTokens = 0;
  for (const priorResult of priorResults) {
    if (priorResult && typeof priorResult === "object") {
      const rawContext = (priorResult as Record<string, unknown>)._rawContext as
        | { fileIds?: string[]; rawTokens?: number }
        | undefined;
      if (rawContext) {
        if (rawContext.fileIds) {
          for (const fileId of rawContext.fileIds) {
            aggregatedFileIds.add(fileId);
          }
        }
        if (rawContext.rawTokens) {
          aggregatedRawTokens += rawContext.rawTokens;
        }
      }
    }
  }

  const response: WorkflowResponse = {
    results: stepResults,
    totalTokens: budgetState.tokensUsed,
    durationMs: totalDurationMs,
    truncated: budgetState.truncated,
    // Filter out ladder warnings for steps that failed (e.g., "symbol not found")
    ladderWarnings: (() => {
      const filtered = ladderWarnings.filter(w => {
        const match = w.match(/^Step (\d+)/);
        if (!match) return true;
        const stepIdx = parseInt(match[1], 10);
        return stepResults[stepIdx]?.status !== "error";
      });
      return filtered.length > 0 ? filtered : undefined;
    })(),
    etagCache: hasEtags ? etagCacheState : undefined,
  };

  if (aggregatedFileIds.size > 0 || aggregatedRawTokens > 0) {
    (response as unknown as Record<string, unknown>)._rawContext = {
      ...(aggregatedFileIds.size > 0
        ? { fileIds: Array.from(aggregatedFileIds) }
        : {}),
      ...(aggregatedRawTokens > 0 ? { rawTokens: aggregatedRawTokens } : {}),
    };
  }

  if (traceOpts && traceSteps.length > 0) {
    response.trace = {
      steps: traceSteps,
      totals: {
        durationMs: totalDurationMs,
        tokens: budgetState.tokensUsed,
        stepsExecuted: stepResults.filter(
          (stepResult) =>
            stepResult.status === "ok" || stepResult.status === "error",
        ).length,
      },
    };
  }

  
  // Strip intermediate step results if onlyFinalResult is requested
  if (request.onlyFinalResult && response.results.length > 1) {
    const lastIdx = response.results.length - 1;
    let strippedTokens = 0;
    response.results = response.results.map((r, i) => {
      if (i < lastIdx) {
        strippedTokens += r.tokens;
        return { stepIndex: r.stepIndex, fn: r.fn, status: r.status, tokens: 0, durationMs: r.durationMs, result: null };
      }
      return r;
    });
    // Adjust totalTokens to reflect what's actually in the response
    response.totalTokens = response.totalTokens - strippedTokens;
  }

return response;
}

// --- Trace Helpers ---

const DEFAULT_MAX_PREVIEW_TOKENS = 200;

function truncatePreview(value: unknown, maxTokens: number): string {
  const json = JSON.stringify(value);
  const estimatedTokens = estimateTokens(json);
  if (estimatedTokens <= maxTokens) {
    return json;
  }

  const maxChars = maxTokens * 4;
  return json.slice(0, maxChars) + "...";
}

function buildTraceStep(
  stepIndex: number,
  fn: string,
  action: string,
  kind: "gateway" | "internal",
  status: string,
  durationMs: number,
  tokens: number,
  opts: WorkflowTraceOptions,
  catalog: ActionDescriptor[] | null,
  resolvedArgs?: Record<string, unknown>,
  result?: unknown,
  error?: string,
): WorkflowTraceStep {
  const maxPreviewTokens = opts.maxPreviewTokens ?? DEFAULT_MAX_PREVIEW_TOKENS;
  const level = opts.level ?? "summary";

  const traceStep: WorkflowTraceStep = {
    stepIndex,
    fn,
    action,
    kind,
    status,
    durationMs,
    tokens,
    summary: error
      ? `${fn}: error - ${error}`
      : `${fn}: ${tokens} tokens in ${durationMs}ms`,
  };

  if (level === "verbose") {
    if (opts.includeResolvedArgs && resolvedArgs !== undefined) {
      traceStep.resolvedArgsPreview = truncatePreview(
        resolvedArgs,
        maxPreviewTokens,
      );
    }

    if (result !== undefined && result !== null) {
      traceStep.resultPreview = truncatePreview(result, maxPreviewTokens);
    }

    if (catalog) {
      const descriptor = catalog.find(
        (entry) => entry.fn === fn || entry.action === action,
      );
      if (descriptor) {
        if (opts.includeSchemas && descriptor.schemaSummary) {
          traceStep.schemaSummary = descriptor.schemaSummary;
        }
        if (opts.includeExamples && descriptor.example) {
          traceStep.example = descriptor.example;
        }
      }
    }
  }

  return traceStep;
}
