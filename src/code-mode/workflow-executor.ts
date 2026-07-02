import { routeGatewayCall, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import type { CodeModeConfig } from "../config/types.js";
import { estimateTokens } from "../util/tokenize.js";
import { buildCatalog, type ActionDescriptor } from "./action-catalog.js";
import { getWorkflowEtagCache } from "./etag-cache.js";
import { validateLadder } from "./ladder-validator.js";
import {
  attachRefMetadata,
  resolveRefs,
  RefResolutionError,
} from "./ref-resolver.js";
import {
  executeTransform,
  INTERNAL_TRANSFORMS,
  TransformError,
} from "./transforms.js";
import { truncateStepResult } from "./workflow-truncation.js";
import {
  type WorkflowResponse,
  type WorkflowFailureTrace,
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
import { getActiveFnNameMap, getActiveActionToFn } from "./manual-generator.js";
import { findRefsInArgs, type ParsedWorkflowStep } from "./workflow-parser.js";
import {
  ToolPhaseTimer,
} from "../mcp/timing-diagnostics.js";

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
    maxResponseTokens != null &&
    stepResult.status === "ok" &&
    stepResult.result != null
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

function getGatewayFailureMessage(action: string, result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (record.status !== "failure") return null;
  const detail =
    typeof record.stderrSummary === "string" && record.stderrSummary.trim()
      ? record.stderrSummary.trim()
      : typeof record.error === "string" && record.error.trim()
        ? record.error.trim()
        : typeof record.message === "string" && record.message.trim()
          ? record.message.trim()
          : typeof record.exitCode === "number"
            ? "exit code " + record.exitCode
            : "returned failure status";
  return action + " failed: " + detail;
}

function attachStepMetadataToPriorResult(
  priorResults: unknown[],
  stepIndex: number,
  rawResult: unknown,
  stepResult: WorkflowStepResult,
): void {
  if (!stepResult.truncatedResponse) {
    return;
  }

  attachRefMetadata(priorResults, stepIndex, {
    truncatedResponse: stepResult.truncatedResponse,
  });

  if (rawResult === null || typeof rawResult !== "object") {
    return;
  }

  // Keep response metadata addressable by later $N refs without exposing it in
  // normal JSON serialization of the raw step result. Non-extensible objects
  // still work through the sidecar metadata above.
  try {
    Object.defineProperty(rawResult, "truncatedResponse", {
      value: stepResult.truncatedResponse,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // The sidecar metadata on priorResults remains authoritative for refs.
  }
}

function stripTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, "");
}
const JSON_REFERENCEABLE_WIRE_ACTIONS = new Set([
  "symbol.search",
  "slice.build",
  "sdl.context",
]);

function findReferencedStepIndexes(steps: ParsedWorkflowStep[]): Set<number> {
  const referenced = new Set<number>();
  for (const step of steps) {
    for (const ref of findRefsInArgs(step.args)) {
      referenced.add(ref);
    }
  }
  return referenced;
}

function needsJsonForLaterReference(
  step: ParsedWorkflowStep,
  stepIndex: number,
  referencedStepIndexes: Set<number>,
): boolean {
  return (
    !step.internal &&
    referencedStepIndexes.has(stepIndex) &&
    JSON_REFERENCEABLE_WIRE_ACTIONS.has(step.action)
  );
}

function failureTrace(params: {
  stepIndex: number;
  step: ParsedWorkflowStep;
  status: WorkflowStepResult["status"];
  message: string;
  resolvedArgs?: Record<string, unknown>;
  fallbackTools?: string[];
  details?: Record<string, unknown>;
}): WorkflowFailureTrace {
  return {
    stepIndex: params.stepIndex,
    fn: params.step.fn,
    action: params.step.action,
    kind: params.step.internal ? "internal" : "gateway",
    status: params.status,
    message: params.message,
    ...(params.resolvedArgs
      ? { resolvedArgKeys: Object.keys(params.resolvedArgs).sort() }
      : {}),
    ...(params.fallbackTools?.length
      ? { fallbackTools: params.fallbackTools }
      : {}),
    ...(params.details && Object.keys(params.details).length > 0
      ? { details: params.details }
      : {}),
  };
}

function failureDetailsFrom(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of [
    "classification",
    "retryable",
    "fallbackRationale",
    "candidates",
    "runtimeHints",
    "quotingWarnings",
    "nextCalls",
  ]) {
    if (source[key] !== undefined) details[key] = source[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function fallbackToolsFrom(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const fallbackTools = (value as Record<string, unknown>).fallbackTools;
  return Array.isArray(fallbackTools) && fallbackTools.every((tool) => typeof tool === "string")
    ? fallbackTools
    : undefined;
}

function findBlockingDependency(
  step: ParsedWorkflowStep,
  stepResults: WorkflowStepResult[],
): WorkflowStepResult | null {
  for (const ref of findRefsInArgs(step.args)) {
    const prior = stepResults[ref];
    if (prior && prior.status !== "ok") {
      return prior;
    }
  }
  return null;
}

function zodIssueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
    return `${path}${issue.message}`;
  });
}

function dryRunFixHint(action: string, issues: string[]): string {
  const missing = issues
    .map((issue) => issue.match(/^([A-Za-z_]\w*):/)?.[1])
    .filter((field): field is string => Boolean(field));
  const shape =
    missing.length > 0
      ? `{"${missing[0]}":"<value>"}`
      : '{"<field>":"<value>"}';
  return `Fix args like ${shape}; see sdl.manual({ actions: ["${action}"], includeSchemas: true }).`;
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
  const timer = new ToolPhaseTimer();
  const setupStartedAt = timer.start();
  const actionCatalog = buildCatalog();
  const budget = new WorkflowBudgetTracker(request.budget, {
    maxSteps: config.maxWorkflowSteps,
    maxTokens: config.maxWorkflowTokens,
    maxDurationMs: config.maxWorkflowDurationMs,
  });

  const etagCache = config.etagCaching
    ? getWorkflowEtagCache({
        repoId: request.repoId,
        sessionId: context?.sessionId,
        clientKey: context?.clientKey,
      })
    : null;
  if (etagCache && request.etagCache) {
    etagCache.seed(request.etagCache);
  }
  const priorResults: unknown[] = [];
  const stepResults: WorkflowStepResult[] = [];
  const traceSteps: WorkflowTraceStep[] = [];
  const startTime = Date.now();
  const referencedStepIndexes = findReferencedStepIndexes(request.steps);

  const traceCatalog =
    traceOpts && (traceOpts.includeSchemas || traceOpts.includeExamples)
      ? buildCatalog({
          includeSchemas: traceOpts.includeSchemas,
          includeExamples: traceOpts.includeExamples,
        })
      : null;
  timer.record("workflow.setup", setupStartedAt);

  // Handle dryRun mode - validate steps and references without executing
  if (request.dryRun) {
    const validation: {
      stepIndex: number;
      fn: string;
      action: string;
      valid: boolean;
      issues: string[];
      pendingSchemaValidation?: boolean;
      fixHint?: string;
    }[] = [];
    const fnNameMap = getActiveFnNameMap();
    const actionToFn = getActiveActionToFn();

    const dryRunStartedAt = timer.start();
    for (let i = 0; i < request.steps.length; i++) {
      const step = request.steps[i];
      const issues: string[] = [];

      // Check if function exists
      const fnExists =
        step.fn in fnNameMap ||
        step.fn in actionToFn ||
        step.action in actionMap ||
        step.fn in actionMap ||
        step.internal;
      if (!fnExists) {
        issues.push(`Unknown function: ${step.fn}`);
      }

      // Validate references point to valid steps
      const refs = findRefsInArgs(step.args);
      for (const ref of refs) {
        if (ref >= i) {
          issues.push(
            `Reference ${"$"}${ref} points to step that hasn't executed yet`,
          );
        }
      }
      const pendingSchemaValidation = refs.length > 0;
      let fixHint: string | undefined;

      if (!pendingSchemaValidation && fnExists && issues.length === 0) {
        const schema = step.internal
          ? INTERNAL_TRANSFORMS[step.fn]?.schema
          : (actionMap[step.action] ?? actionMap[step.fn])?.schema;
        const parsed = schema?.safeParse(step.args);
        if (parsed && !parsed.success) {
          const schemaIssues = zodIssueLines(parsed.error);
          issues.push(...schemaIssues);
          fixHint = dryRunFixHint(step.action, schemaIssues);
        }
      }

      validation.push({
        stepIndex: i,
        fn: step.fn,
        action: step.action,
        valid: issues.length === 0,
        issues,
        ...(pendingSchemaValidation ? { pendingSchemaValidation } : {}),
        ...(fixHint ? { fixHint } : {}),
      });
    }

    const allValid = validation.every((v) => v.valid);
    timer.record("workflow.dryRunValidate", dryRunStartedAt);
    const response = {
      results: [],
      totalTokens: 0,
      durationMs: Date.now() - startTime,
      truncated: false,
      dryRun: {
        valid: allValid,
        validation,
        stepCount: request.steps.length,
        budgetLimits: request.budget ?? {},
      },
    } as WorkflowResponse;
    return response;
  }

  for (let i = 0; i < request.steps.length; i++) {
    const step = request.steps[i];

    // Soft-skip: parser flagged this step as unknown/disabled while
    // `onError: "continue"` was set. Emit an error result and let sibling
    // steps proceed.
    if (step.skip) {
      const message = step.skipReason ?? `Step ${i}: skipped (validation failure).`;
      stepResults.push({
        stepIndex: i,
        fn: step.fn,
        result: null,
        tokens: 0,
        durationMs: 0,
        status: "error",
        error: message,
        failureTrace: failureTrace({
          stepIndex: i,
          step,
          status: "error",
          message,
        }),
      });
      priorResults.push(null);
      continue;
    }

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
      // Fix #6: explain which budget dimension was exceeded and on which
      // step, so callers can act on the feedback instead of seeing an
      // opaque budget_exceeded status for every remaining step.
      const explanation =
        budget.exceededExplanation() ?? "Workflow budget exhausted.";
      for (let j = i; j < request.steps.length; j++) {
        stepResults.push({
          stepIndex: j,
          fn: request.steps[j].fn,
          result: null,
          tokens: 0,
          durationMs: 0,
          status: "budget_exceeded",
          error:
            j === i
              ? explanation
              : `Skipped: ${explanation} First affected step: ${request.steps[i].fn} (index ${i}).`,
        });
        priorResults.push(null);
      }
      break;
    }

    if (request.onError === "continue") {
      const blocker = findBlockingDependency(step, stepResults);
      if (blocker) {
        const blockedByError =
          blocker.error ??
          blocker.failureTrace?.message ??
          `Step ${blocker.stepIndex} ended with status ${blocker.status}`;
        const message = `Skipped: step ${i} depends on failed step ${blocker.stepIndex} (${blocker.fn}).`;
        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: 0,
          status: "skipped",
          error: message,
          blockedByStep: blocker.stepIndex,
          blockedByFn: blocker.fn,
          blockedByError,
          failureTrace: failureTrace({
            stepIndex: i,
            step,
            status: "skipped",
            message: `${message} Upstream error: ${blockedByError}`,
          }),
        });
        priorResults.push(null);
        continue;
      }
    }

    let resolvedArgs: Record<string, unknown>;
    const resolveRefsStartedAt = timer.start();
    try {
      resolvedArgs = resolveRefs(step.args, priorResults);
      if (
        needsJsonForLaterReference(step, i, referencedStepIndexes) &&
        resolvedArgs.wireFormat === undefined
      ) {
        resolvedArgs = { ...resolvedArgs, wireFormat: "json" };
      }
      timer.record("workflow.resolveRefs", resolveRefsStartedAt);
    } catch (error) {
      timer.record("workflow.resolveRefs", resolveRefsStartedAt);
      const errorMessage =
        error instanceof RefResolutionError
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
        failureTrace: failureTrace({
          stepIndex: i,
          step,
          status: "error",
          message: errorMessage,
        }),
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
        const internalStartedAt = timer.start();
        const result = executeTransform(step.fn, resolvedArgs);
        timer.record("workflow.internal", internalStartedAt);

        const stepDuration = Date.now() - stepStart;
        priorResults.push(result);
        let resultForResponse: unknown = result;
        if (Array.isArray(result) && result.length > 3) {
          resultForResponse = {
            _type: "array",
            length: result.length,
            sample: result.slice(0, 3),
            hint:
              "Full data available via $" +
              i +
              " reference in subsequent steps",
          };
        }
        const tokens =
          WorkflowBudgetTracker.estimateResultTokens(resultForResponse);

        const stepResult: WorkflowStepResult = {
          stepIndex: i,
          fn: step.fn,
          result: resultForResponse,
          tokens,
          durationMs: stepDuration,
          status: "ok",
        };
        applyStepTruncation(stepResult, step, request.defaultMaxResponseTokens);
        budget.record(stepResult.tokens, stepDuration);
        attachStepMetadataToPriorResult(priorResults, i, result, stepResult);
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
              stepResult.tokens,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              stepResult.result,
            ),
          );
        }
      } catch (error) {
        const stepDuration = Date.now() - stepStart;
        budget.record(0, stepDuration);
        const errorMessage =
          error instanceof TransformError
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
          failureTrace: failureTrace({
            stepIndex: i,
            step,
            status: "error",
            message: errorMessage,
            resolvedArgs,
          }),
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
        const etagInjectStartedAt = timer.start();
        etagCache.injectEtags(step.action, resolvedArgs);
        timer.record("workflow.etagInject", etagInjectStartedAt);
      }

      const gatewayArgs = {
        repoId: request.repoId,
        action: step.action,
        ...resolvedArgs,
      };

      try {
        const gatewayStartedAt = timer.start();
        const result = await routeGatewayCall(gatewayArgs, actionMap, context);
        timer.record("workflow.gateway", gatewayStartedAt);
        const stepDuration = Date.now() - stepStart;
        const tokens = WorkflowBudgetTracker.estimateResultTokens(result);

        // Record usage for session-level token tracking (per-step attribution)
        const rawCtx =
          result && typeof result === "object"
            ? ((result as Record<string, unknown>)._rawContext as
                | { fileIds?: string[]; rawTokens?: number }
                | undefined)
            : undefined;
        let rawEquivalent = rawCtx?.rawTokens ?? tokens;
        // When rawTokens is not explicitly set but fileIds are available,
        // estimate raw equivalent from file byte sizes so per-step
        // savings are correctly attributed (not just to the workflow envelope).
        if (
          !rawCtx?.rawTokens &&
          rawCtx?.fileIds &&
          rawCtx.fileIds.length > 0
        ) {
          try {
            const rawUsageStartedAt = timer.start();
            const usageConn = await getLadybugConn();
            const files = await ladybugDb.getFilesByIds(
              usageConn,
              rawCtx.fileIds,
            );
            let estimatedRaw = 0;
            for (const file of files.values()) {
              estimatedRaw += Math.ceil(file.byteSize / 4); // ~4 bytes per token
            }
            if (estimatedRaw > tokens) {
              rawEquivalent = estimatedRaw;
            }
            timer.record("workflow.rawUsageEstimateDb", rawUsageStartedAt);
          } catch {
            /* graceful degradation: keep rawEquivalent = tokens */
          }
        }
        if (etagCache) {
          const etagExtractStartedAt = timer.start();
          etagCache.extractEtags(step.action, result);
          timer.record("workflow.etagExtract", etagExtractStartedAt);
        }

        const gatewayFailureMessage = getGatewayFailureMessage(step.action, result);
        const gatewayFailureDetails = gatewayFailureMessage
          ? failureDetailsFrom(result)
          : undefined;
        priorResults.push(gatewayFailureMessage ? null : result);
        const stepResult: WorkflowStepResult = {
          stepIndex: i,
          fn: step.fn,
          result,
          tokens,
          durationMs: stepDuration,
          status: gatewayFailureMessage ? "error" : "ok",
          ...(gatewayFailureMessage
            ? {
                error: gatewayFailureMessage,
                failureTrace: failureTrace({
                  stepIndex: i,
                  step,
                  status: "error",
                  message: gatewayFailureMessage,
                  resolvedArgs,
                  details: gatewayFailureDetails,
                }),
              }
            : {}),
        };
        applyStepTruncation(stepResult, step, request.defaultMaxResponseTokens);
        budget.record(stepResult.tokens, stepDuration);
        tokenAccumulator.recordUsage(step.fn, stepResult.tokens, rawEquivalent);
        attachStepMetadataToPriorResult(priorResults, i, result, stepResult);
        stepResults.push(stepResult);

        if (traceOpts) {
          traceSteps.push(
            buildTraceStep(
              i,
              step.fn,
              step.action,
              "gateway",
              gatewayFailureMessage ? "error" : "ok",
              stepDuration,
              stepResult.tokens,
              traceOpts,
              traceCatalog,
              resolvedArgs,
              stepResult.result,
              gatewayFailureMessage ?? undefined,
            ),
          );
        }

        if (gatewayFailureMessage && request.onError === "stop") {
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
      } catch (error) {
        const stepDuration = Date.now() - stepStart;
        budget.record(0, stepDuration);
        let errorMessage: string;
        if (error instanceof z.ZodError) {
          const lines = error.issues.map((issue) => {
            const path =
              issue.path.length > 0 ? issue.path.join(".") + ": " : "";
            return path + issue.message;
          });
          const validationSummary = stripTrailingSentencePunctuation(
            lines.join("; "),
          );
          errorMessage = `Invalid arguments: ${validationSummary}. Use sdl.manual({ actions: ["${step.action}"] }) to see expected params.`;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        } else {
          errorMessage = `Step execution failed: ${String(error)}`;
        }

        const meta = actionCatalog.find((a) => a.action === step.action);
        const fallbackTools = fallbackToolsFrom(error) ?? (meta?.fallbacks?.length
          ? meta.fallbacks
          : undefined);
        const errorDetails = failureDetailsFrom(error);
        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: stepDuration,
          status: "error",
          error: errorMessage,
          ...(fallbackTools ? { fallbackTools } : {}),
          failureTrace: failureTrace({
            stepIndex: i,
            step,
            status: "error",
            message: errorMessage,
            resolvedArgs,
            fallbackTools,
            details: errorDetails,
          }),
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

  const ladderStartedAt = timer.start();
  const ladderWarnings = validateLadder(
    request.steps,
    priorResults,
    config.ladderValidation,
  );
  timer.record("workflow.ladderValidation", ladderStartedAt);

  const responseStartedAt = timer.start();
  const budgetState = budget.state();
  const totalDurationMs = Date.now() - startTime;
  const responseWasTruncated = stepResults.some(
    (result) =>
      result.status === "budget_exceeded" ||
      result.truncatedResponse !== undefined,
  );

  const aggregatedFileIds = new Set<string>();
  let aggregatedRawTokens = 0;
  for (const priorResult of priorResults) {
    if (priorResult && typeof priorResult === "object") {
      const rawContext = (priorResult as Record<string, unknown>)
        ._rawContext as { fileIds?: string[]; rawTokens?: number } | undefined;
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
    truncated: responseWasTruncated,
    // Filter out ladder warnings for steps that failed (e.g., "symbol not found")
    ladderWarnings: (() => {
      const filtered = ladderWarnings.filter((w) => {
        const match = w.match(/^Step (\d+)/);
        if (!match) return true;
        const stepIdx = parseInt(match[1], 10);
        return stepResults[stepIdx]?.status !== "error";
      });
      return filtered.length > 0 ? filtered : undefined;
    })(),
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
    const successCount = stepResults.filter((r) => r.status === "ok").length;
    const attemptCount = stepResults.filter(
      (r) => r.status === "ok" || r.status === "error",
    ).length;
    response.trace = {
      steps: traceSteps,
      totals: {
        durationMs: totalDurationMs,
        tokens: budgetState.tokensUsed,
        stepsExecuted: successCount,
        stepsAttempted: attemptCount,
      },
    };
  }

  // Strip intermediate step results if onlyFinalResult is requested
  if (request.onlyFinalResult && response.results.length > 1) {
    const lastIdx = response.results.length - 1;
    const suppressedCount = lastIdx; // All steps except the last
    response.results = response.results.map((r, i) => {
      if (i < lastIdx) {
        return {
          stepIndex: r.stepIndex,
          fn: r.fn,
          status: r.status,
          tokens: 0,
          durationMs: r.durationMs,
          result: null,
          ...(r.error ? { error: r.error } : {}),
          ...(r.fallbackTools ? { fallbackTools: r.fallbackTools } : {}),
          ...(r.blockedByStep !== undefined
            ? { blockedByStep: r.blockedByStep }
            : {}),
          ...(r.blockedByFn ? { blockedByFn: r.blockedByFn } : {}),
          ...(r.blockedByError ? { blockedByError: r.blockedByError } : {}),
          ...(r.failureTrace ? { failureTrace: r.failureTrace } : {}),
        };
      }
      return r;
    });
    // Recalculate totalTokens as sum of kept tokens (avoids mixing pre/post truncation values)
    response.totalTokens = response.results.reduce(
      (sum, r) => sum + r.tokens,
      0,
    );
    // Signal that intermediate results were suppressed
    response.intermediateResultsSuppressed = suppressedCount;
    if (response.trace) {
      response.trace.steps = response.trace.steps.map((step) => {
        if (step.stepIndex >= lastIdx) {
          return step;
        }
        const redactedStep = { ...step };
        delete redactedStep.resultPreview;
        return {
          ...redactedStep,
          tokens: 0,
          summary: `${step.fn}: intermediate result suppressed by onlyFinalResult`,
        };
      });
      response.trace.totals.tokens = response.totalTokens;
    }
  }
  timer.record("workflow.responseAssembly", responseStartedAt);

  return response;
}

// --- Trace Helpers ---

const DEFAULT_MAX_PREVIEW_TOKENS = 200;
const TRACE_PREVIEW_INTERNAL_FIELDS = new Set([
  "etag",
  "etagCache",
  "sliceEtag",
  "ifNoneMatch",
  "knownEtags",
  "knownCardEtags",
  "knownSliceEtag",
]);

function scrubTracePreviewValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubTracePreviewValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!TRACE_PREVIEW_INTERNAL_FIELDS.has(key)) {
      projected[key] = scrubTracePreviewValue(item);
    }
  }
  return projected;
}

function truncatePreview(value: unknown, maxTokens: number): string {
  const json = JSON.stringify(scrubTracePreviewValue(value));
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
