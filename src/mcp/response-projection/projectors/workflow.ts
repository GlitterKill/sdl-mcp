import { getActiveFnNameMap } from "../../../code-mode/manual-generator.js";
import {
  sanitizeWorkflowStepValue,
  truncateStepResult,
} from "../../../code-mode/workflow-truncation.js";
import {
  COMPATIBILITY_WORKFLOW_CHILD_ACTIONS,
  getWorkflowChildAction,
  getWorkflowProjectionAction,
} from "../../context-response-projection-registry.js";
import { resolveProjectionRequestOptions } from "../../request-normalization.js";
import { buildValidatedRecoveryAction } from "../recovery.js";
import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";

/** Workflow projection helpers keep executor state out of model-facing values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workflowStep(
  input: ModelProjectionInput,
  index: number,
): Record<string, unknown> | undefined {
  const steps = input.context.requestArgs.steps;
  const step = Array.isArray(steps) ? steps[index] : undefined;
  return isRecord(step) ? step : undefined;
}

function stepArgs(
  input: ModelProjectionInput,
  index: number,
  resultStep?: Record<string, unknown>,
): Record<string, unknown> {
  if (resultStep && isRecord(resultStep._resolvedArgs)) {
    return resultStep._resolvedArgs;
  }
  const step = workflowStep(input, index);
  return step && isRecord(step.args) ? step.args : {};
}

function effectiveChildOptions(
  input: ModelProjectionInput,
  index: number,
  resultStep?: Record<string, unknown>,
): ModelProjectionInput["options"] {
  return resolveProjectionRequestOptions({
    child: workflowStep(input, index),
    workflow: input.options,
    direct: stepArgs(input, index, resultStep),
    profileDefault: input.options.detail,
  });
}

function projectChildValue(
  input: ModelProjectionInput,
  step: Record<string, unknown>,
  index: number,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  if (typeof step.fn !== "string") return step.result;
  const options = effectiveChildOptions(input, index, step);
  const action =
    getWorkflowProjectionAction(step.fn)
    ?? COMPATIBILITY_WORKFLOW_CHILD_ACTIONS[step.fn];
  if (!action) return step.result;
  return projectCompatibilityValue({
    ...input,
    canonicalResult: step.result,
    action,
    options,
    context: {
      ...input.context,
      toolName: action.startsWith("sdl.") ? action : `sdl.${action}`,
      requestArgs: {
        ...input.context.requestArgs,
        ...stepArgs(input, index, step),
        detail: options.detail,
        includeDiagnostics: options.includeDiagnostics,
      },
    },
  });
}

function errorValue(step: Record<string, unknown>): unknown {
  if (typeof step.error === "string") return step.error;
  if (
    isRecord(step.error)
    && typeof step.error.message === "string"
    && typeof step.error.code === "string"
    && typeof step.error.classification === "string"
    && typeof step.error.retryable === "boolean"
  ) {
    // Preserve only the stable generic error fields; recovery remains once-only
    // at the workflow-step level.
    return {
      message: step.error.message,
      code: step.error.code,
      classification: step.error.classification,
      retryable: step.error.retryable,
    };
  }
  if (isRecord(step.result)) {
    if (typeof step.result.error === "string") return step.result.error;
    if (isRecord(step.result.error) && typeof step.result.error.message === "string") {
      return step.result.error.message;
    }
  }
  return isRecord(step.failureTrace) && typeof step.failureTrace.message === "string"
    ? step.failureTrace.message
    : undefined;
}

function candidate(step: Record<string, unknown>): unknown {
  if (step.nextAction !== undefined) return step.nextAction;
  if (isRecord(step.result)) {
    if (step.result.nextAction !== undefined) return step.result.nextAction;
    if (
      isRecord(step.result.error)
      && step.result.error.nextAction !== undefined
    ) {
      return step.result.error.nextAction;
    }
  }
  const trace = isRecord(step.failureTrace) ? step.failureTrace : undefined;
  const details = trace && isRecord(trace.details) ? trace.details : undefined;
  const nextCalls = details?.nextCalls;
  return Array.isArray(nextCalls) ? nextCalls[0] : undefined;
}

function recovery(
  input: ModelProjectionInput,
  step: Record<string, unknown>,
  index: number,
  value: unknown,
): unknown {
  if (value === undefined) return undefined;
  const trace = isRecord(step.failureTrace) ? step.failureTrace : undefined;
  const action = typeof trace?.action === "string" ? trace.action : undefined;
  return buildValidatedRecoveryAction(value, {
    repoId: typeof input.context.requestArgs.repoId === "string"
      ? input.context.requestArgs.repoId
      : undefined,
    advertisedTools: ["sdl.workflow"],
    activeWorkflowFunctions: [...new Set([...Object.keys(getActiveFnNameMap()), "workflowContinuationGet"])].sort(),
    ...(action ? { failedCall: { action, args: stepArgs(input, index, step) } } : {}),
  }).nextAction;
}

/**
 * A workflow's step envelope already communicates success by omitting a failure
 * status. Keep direct runtime results intact, but expose only explicitly
 * requested runtime output inside successful workflow steps.
 */
function projectWorkflowSuccessResult(
  fn: unknown,
  result: unknown,
): unknown {
  if (
    typeof fn !== "string"
    || getWorkflowChildAction(fn) !== "runtime.execute"
    || !isRecord(result)
  ) {
    return result;
  }
  const { status: _status, ...requestedOutput } = result;
  return Object.keys(requestedOutput).length > 0 ? requestedOutput : undefined;
}

function compactStep(
  input: ModelProjectionInput,
  raw: unknown,
  visible: unknown,
  index: number,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  if (!isRecord(raw) || !isRecord(visible)) return visible;
  const status = typeof raw.status === "string" ? raw.status : "ok";
  const stepIndex = typeof raw.stepIndex === "number" ? raw.stepIndex : index;
  const options = effectiveChildOptions(input, stepIndex, raw);
  const resolvedArgs = stepArgs(input, stepIndex, raw);
  const usesChildOptions = options.detail !== input.options.detail
    || options.includeDiagnostics !== input.options.includeDiagnostics;
  const childAction = typeof raw.fn === "string"
    ? getWorkflowChildAction(raw.fn)
    : undefined;
  // These families have volatile fields beyond the generic workflow sanitizer.
  const usesFamilyProjection =
    childAction === "repo.status"
    || childAction === "semantic.enrichment.status"
    || childAction === "usage.stats";
  const visibleResult = status === "ok" && usesChildOptions
    ? projectChildValue(input, raw, stepIndex, projectCompatibilityValue)
    : status === "ok" && usesFamilyProjection
      ? projectChildValue(input, raw, stepIndex, projectCompatibilityValue)
      : status === "ok"
        ? raw.result
        : visible.result;
  let result = sanitizeWorkflowStepValue(
    visibleResult,
    options.includeDiagnostics,
    resolvedArgs.includeTelemetry === true
      || input.context.requestArgs.includeTelemetry === true,
  );
  let nextAction = recovery(input, raw, stepIndex, candidate(raw));

  if (status === "ok" && isRecord(raw.truncatedResponse)) {
    const maxTokens = raw.truncatedResponse.maxTokens;
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
      const continuationHandle =
        typeof raw.truncatedResponse.continuationHandle === "string"
          ? raw.truncatedResponse.continuationHandle
          : undefined;
      const truncation = truncateStepResult(
        result,
        maxTokens,
        continuationHandle,
      );
      result = truncation.truncated;
      if (truncation.handle) {
        nextAction = recovery(input, raw, stepIndex, {
          action: "workflow",
          args: {
            repoId: input.context.requestArgs.repoId,
            steps: [{
              fn: "workflowContinuationGet",
              args: { handle: truncation.handle },
            }],
          },
        });
      }
    }
  }

  const out: Record<string, unknown> = {};
  if (
    status === "error"
    || input.options.detail === "full"
    || nextAction !== undefined
  ) {
    out.stepIndex = stepIndex;
  }
  out.fn = raw.fn;
  if (status !== "ok") out.status = status;
  if (status === "ok" && "result" in raw) {
    const successResult = projectWorkflowSuccessResult(raw.fn, result);
    if (successResult !== undefined) out.result = successResult;
  }
  if (status === "ok" && isRecord(raw.truncatedResponse)) {
    out.truncatedResponse = {
      originalTokens: raw.truncatedResponse.originalTokens,
      keptTokens: raw.truncatedResponse.keptTokens,
      continuationHandle: raw.truncatedResponse.continuationHandle,
    };
  }
  const error = status === "ok" ? undefined : errorValue(raw);
  if (error !== undefined) out.error = error;
  if (status !== "ok" && typeof raw.blockedByStep === "number") {
    out.blockedByStep = raw.blockedByStep;
  }
  if (nextAction !== undefined) out.nextAction = nextAction;
  return out;
}

/** Project workflow results at the public boundary while retaining raw executor state. */
export function projectWorkflowValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const compatibility = projectCompatibilityValue(input);
  const action = input.action.startsWith("sdl.")
    ? input.action.slice("sdl.".length)
    : input.action;
  if (action !== "workflow") return compatibility;
  if (
    !isRecord(input.canonicalResult)
    || !isRecord(compatibility)
    || !Array.isArray(input.canonicalResult.results)
  ) {
    return compatibility;
  }

  const raw = Array.isArray(input.canonicalResult.results)
    ? input.canonicalResult.results
    : [];
  const visible = Array.isArray(compatibility.results)
    ? compatibility.results
    : [];
  const projected: Record<string, unknown> = {
    results: raw.map((step, index) =>
      compactStep(
        input,
        step,
        visible[index],
        index,
        projectCompatibilityValue,
      )
    ),
  };
  const suppressed = input.canonicalResult.intermediateResultsSuppressed;
  if (typeof suppressed === "number" && suppressed > 0) {
    projected.intermediateResultsSuppressed = suppressed;
  }
  if (input.canonicalResult.truncated === true) projected.truncated = true;
  if (input.context.requestArgs.includeTelemetry === true) {
    if (typeof input.canonicalResult.durationMs === "number") {
      projected.durationMs = input.canonicalResult.durationMs;
    }
    if (typeof input.canonicalResult.totalTokens === "number") {
      projected.totalTokens = input.canonicalResult.totalTokens;
    }
  }
  if (input.canonicalResult.dryRun !== undefined) {
    projected.dryRun = input.canonicalResult.dryRun;
  }
  if (input.options.includeDiagnostics) {
    if (compatibility.trace !== undefined) projected.trace = compatibility.trace;
    if (compatibility.diagnostics !== undefined) {
      projected.diagnostics = compatibility.diagnostics;
    }
  }
  return projected;
}
