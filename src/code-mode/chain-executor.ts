import { routeGatewayCall, type ActionMap } from "../gateway/router.js";
import type { ToolContext } from "../server.js";
import { resolveRefs } from "./ref-resolver.js";
import { RefResolutionError } from "./ref-resolver.js";
import { ChainBudgetTracker } from "./chain-budget.js";
import { validateLadder } from "./ladder-validator.js";
import { ChainEtagCache } from "./etag-cache.js";
import type { ChainResponse, ChainStepResult } from "./types.js";
import type { ParsedChainRequest } from "./chain-parser.js";
import type { CodeModeConfig } from "../config/types.js";

/**
 * Execute a parsed chain request sequentially, resolving $N references,
 * tracking budget, validating the context ladder, and caching ETags.
 */
export async function executeChain(
  request: ParsedChainRequest,
  actionMap: ActionMap,
  config: CodeModeConfig,
  context?: ToolContext,
): Promise<ChainResponse> {
  const budget = new ChainBudgetTracker(request.budget, {
    maxSteps: config.maxChainSteps,
    maxTokens: config.maxChainTokens,
    maxDurationMs: config.maxChainDurationMs,
  });

  const etagCache = config.etagCaching ? new ChainEtagCache() : null;
  const priorResults: unknown[] = [];
  const stepResults: ChainStepResult[] = [];
  const startTime = Date.now();

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

    // Inject ETags for card requests
    if (etagCache) {
      etagCache.injectEtags(step.action, resolvedArgs);
    }

    // Build gateway args: merge repoId + action into resolved args
    const gatewayArgs = {
      repoId: request.repoId,
      action: step.action,
      ...resolvedArgs,
    };

    // Execute the step
    const stepStart = Date.now();
    try {
      const result = await routeGatewayCall(gatewayArgs, actionMap, context);
      const stepDuration = Date.now() - stepStart;
      const tokens = ChainBudgetTracker.estimateResultTokens(result);

      budget.record(tokens, stepDuration);

      // Extract ETags from result
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

  return {
    results: stepResults,
    totalTokens: budgetState.tokensUsed,
    durationMs: Date.now() - startTime,
    truncated: budgetState.truncated,
    ladderWarnings: ladderWarnings.length > 0 ? ladderWarnings : undefined,
    etagCache: hasEtags ? etagCacheState : undefined,
  };
}
