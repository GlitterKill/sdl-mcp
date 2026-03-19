import { routeGatewayCall, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import { resolveRefs } from "./ref-resolver.js";
import { RefResolutionError } from "./ref-resolver.js";
import { ChainBudgetTracker } from "./chain-budget.js";
import { validateLadder } from "./ladder-validator.js";
import { ChainEtagCache } from "./etag-cache.js";
import { executeTransform, TransformError } from "./transforms.js";
import type { ChainResponse, ChainStepResult, ChainTraceOptions, ChainTraceStep } from "./types.js";
import type { ParsedChainRequest } from "./chain-parser.js";
import type { CodeModeConfig } from "../config/types.js";
import { buildCatalog, type ActionDescriptor } from "./action-catalog.js";
import { estimateTokens } from "../util/tokenize.js";

/**
 * Execute a parsed chain request sequentially, resolving $N references,
 * tracking budget, validating the context ladder, and caching ETags.
 */
export async function executeChain(
  request: ParsedChainRequest,
  actionMap: ActionMap,
  config: CodeModeConfig,
  context?: ToolContext,
  traceOpts?: ChainTraceOptions,
): Promise<ChainResponse> {
  const budget = new ChainBudgetTracker(request.budget, {
    maxSteps: config.maxChainSteps,
    maxTokens: config.maxChainTokens,
    maxDurationMs: config.maxChainDurationMs,
  });

  const etagCache = config.etagCaching ? new ChainEtagCache() : null;
  const priorResults: unknown[] = [];
  const stepResults: ChainStepResult[] = [];
  const traceSteps: ChainTraceStep[] = [];
  const startTime = Date.now();

  // Pre-build enriched catalog once if trace needs schemas/examples
  const traceCatalog = traceOpts && (traceOpts.includeSchemas || traceOpts.includeExamples)
    ? buildCatalog({ includeSchemas: traceOpts.includeSchemas, includeExamples: traceOpts.includeExamples })
    : null;

  for (let i = 0; i < request.steps.length; i++) {
    const step = request.steps[i];

    // Check for client disconnect (AbortSignal) between steps
    if (context?.signal?.aborted) {
      for (let j = i; j < request.steps.length; j++) {
        stepResults.push({
          stepIndex: j,
          fn: request.steps[j].fn,
          result: null,
          tokens: 0,
          durationMs: 0,
          status: "skipped",
          error: "Chain aborted: client disconnected",
        });
        priorResults.push(null);
      }
      break;
    }

    // Check budget before executing
    if (!budget.shouldContinue()) {
      // Mark this step and all remaining as budget_exceeded
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

    // Resolve $N refs in step args
    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveRefs(step.args, priorResults);
    } catch (err) {
      const errorMsg =
        err instanceof RefResolutionError
          ? err.message
          : `Ref resolution failed: ${String(err)}`;
      stepResults.push({
        stepIndex: i,
        fn: step.fn,
        result: null,
        tokens: 0,
        durationMs: 0,
        status: "error",
        error: errorMsg,
      });
      priorResults.push(null);

      if (request.onError === "stop") {
        // Mark remaining as skipped
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

    // Execute internal transform or gateway step
    const stepStart = Date.now();

    if (step.internal) {
      // Internal transform — execute directly, bypass gateway
      try {
        const result = executeTransform(step.fn, resolvedArgs);
        const stepDuration = Date.now() - stepStart;
        const tokens = ChainBudgetTracker.estimateResultTokens(result);

        budget.record(tokens, stepDuration);
        priorResults.push(result);

        const stepResult: ChainStepResult = {
          stepIndex: i,
          fn: step.fn,
          result,
          tokens,
          durationMs: stepDuration,
          status: "ok",
        };
        stepResults.push(stepResult);

        if (traceOpts) {
          traceSteps.push(buildTraceStep(i, step.fn, step.fn, "internal", "ok", stepDuration, tokens, traceOpts, traceCatalog, resolvedArgs, result));
        }
      } catch (err) {
        const stepDuration = Date.now() - stepStart;
        const errorMsg =
          err instanceof TransformError
            ? err.message
            : `Transform failed: ${String(err)}`;

        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: stepDuration,
          status: "error",
          error: errorMsg,
        });
        priorResults.push(null);

        if (traceOpts) {
          traceSteps.push(buildTraceStep(i, step.fn, step.fn, "internal", "error", stepDuration, 0, traceOpts, traceCatalog, resolvedArgs, null, errorMsg));
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
      // Gateway step — inject ETags, route through gateway
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
        const tokens = ChainBudgetTracker.estimateResultTokens(result);

        budget.record(tokens, stepDuration);

        if (etagCache) {
          etagCache.extractEtags(step.action, result);
        }

        priorResults.push(result);
        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result,
          tokens,
          durationMs: stepDuration,
          status: "ok",
        });

        if (traceOpts) {
          traceSteps.push(buildTraceStep(i, step.fn, step.action, "gateway", "ok", stepDuration, tokens, traceOpts, traceCatalog, resolvedArgs, result));
        }
      } catch (err) {
        const stepDuration = Date.now() - stepStart;
        const errorMsg =
          err instanceof Error
            ? err.message
            : `Step execution failed: ${String(err)}`;

        stepResults.push({
          stepIndex: i,
          fn: step.fn,
          result: null,
          tokens: 0,
          durationMs: stepDuration,
          status: "error",
          error: errorMsg,
        });
        priorResults.push(null);

        if (traceOpts) {
          traceSteps.push(buildTraceStep(i, step.fn, step.action, "gateway", "error", stepDuration, 0, traceOpts, traceCatalog, resolvedArgs, null, errorMsg));
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

  // Run ladder validation
  const ladderWarnings = validateLadder(
    request.steps,
    priorResults,
    config.ladderValidation,
  );

  const budgetState = budget.state();
  const etagCacheState = etagCache?.getCache();
  const hasEtags =
    etagCacheState !== undefined && Object.keys(etagCacheState).length > 0;

  const totalDurationMs = Date.now() - startTime;

  const response: ChainResponse = {
    results: stepResults,
    totalTokens: budgetState.tokensUsed,
    durationMs: totalDurationMs,
    truncated: budgetState.truncated,
    ladderWarnings: ladderWarnings.length > 0 ? ladderWarnings : undefined,
    etagCache: hasEtags ? etagCacheState : undefined,
  };

  // Attach trace only when requested
  if (traceOpts && traceSteps.length > 0) {
    response.trace = {
      steps: traceSteps,
      totals: {
        durationMs: totalDurationMs,
        tokens: budgetState.tokensUsed,
        stepsExecuted: stepResults.filter((s) => s.status === "ok" || s.status === "error").length,
      },
    };
  }

  return response;
}

// --- Trace Helpers ---

const DEFAULT_MAX_PREVIEW_TOKENS = 200;

function truncatePreview(value: unknown, maxTokens: number): string {
  const json = JSON.stringify(value);
  const est = estimateTokens(json);
  if (est <= maxTokens) return json;

  // Truncate deterministically by character count approximation (4 chars per token)
  const maxChars = maxTokens * 4;
  return json.slice(0, maxChars) + "…";
}

function buildTraceStep(
  stepIndex: number,
  fn: string,
  action: string,
  kind: "gateway" | "internal",
  status: string,
  durationMs: number,
  tokens: number,
  opts: ChainTraceOptions,
  catalog: ActionDescriptor[] | null,
  resolvedArgs?: Record<string, unknown>,
  result?: unknown,
  error?: string,
): ChainTraceStep {
  const maxPreview = opts.maxPreviewTokens ?? DEFAULT_MAX_PREVIEW_TOKENS;
  const level = opts.level ?? "summary";

  const step: ChainTraceStep = {
    stepIndex,
    fn,
    action,
    kind,
    status,
    durationMs,
    tokens,
    summary: error
      ? `${fn}: error — ${error}`
      : `${fn}: ${tokens} tokens in ${durationMs}ms`,
  };

  if (level === "verbose") {
    if (opts.includeResolvedArgs && resolvedArgs !== undefined) {
      step.resolvedArgsPreview = truncatePreview(resolvedArgs, maxPreview);
    }

    if (result !== undefined && result !== null) {
      step.resultPreview = truncatePreview(result, maxPreview);
    }

    if (catalog) {
      const desc = catalog.find(
        (d) => d.fn === fn || d.action === action,
      );
      if (desc) {
        if (opts.includeSchemas && desc.schemaSummary) {
          step.schemaSummary = desc.schemaSummary;
        }
        if (opts.includeExamples && desc.example) {
          step.example = desc.example;
        }
      }
    }
  }

  return step;
}
