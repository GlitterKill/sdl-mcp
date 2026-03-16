import { estimateTokens } from "../util/tokenize.js";
import type { ChainBudget } from "./types.js";

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export class ChainBudgetTracker {
  private tokensUsed = 0;
  private stepsExecuted = 0;
  private readonly startTime: number;
  private readonly maxTokens: number | null;
  private readonly maxSteps: number | null;
  private readonly maxDurationMs: number | null;

  constructor(
    budget?: ChainBudget,
    configDefaults?: {
      maxSteps: number;
      maxTokens: number;
      maxDurationMs: number;
    },
  ) {
    this.startTime = Date.now();

    // Resolve budget: request budget can only be MORE restrictive than config
    // Take the minimum of request and config for each limit
    const reqTokens = budget?.maxTotalTokens ?? null;
    const reqSteps = budget?.maxSteps ?? null;
    const reqDuration = budget?.maxDurationMs ?? null;
    const cfgTokens = configDefaults?.maxTokens ?? null;
    const cfgSteps = configDefaults?.maxSteps ?? null;
    const cfgDuration = configDefaults?.maxDurationMs ?? null;

    this.maxTokens = minNullable(reqTokens, cfgTokens);
    this.maxSteps = minNullable(reqSteps, cfgSteps);
    this.maxDurationMs = minNullable(reqDuration, cfgDuration);
  }

  record(stepTokens: number, _stepDurationMs: number): void {
    this.tokensUsed += stepTokens;
    this.stepsExecuted += 1;
    // _stepDurationMs is tracked per-step but total is derived from wall clock
  }

  shouldContinue(): boolean {
    if (this.maxTokens !== null && this.tokensUsed >= this.maxTokens)
      return false;
    if (this.maxSteps !== null && this.stepsExecuted >= this.maxSteps)
      return false;
    if (
      this.maxDurationMs !== null &&
      Date.now() - this.startTime >= this.maxDurationMs
    )
      return false;
    return true;
  }

  state(): {
    tokensUsed: number;
    tokensRemaining: number | null;
    stepsExecuted: number;
    stepsRemaining: number | null;
    elapsedMs: number;
    durationRemaining: number | null;
    truncated: boolean;
  } {
    const elapsed = Date.now() - this.startTime;
    return {
      tokensUsed: this.tokensUsed,
      tokensRemaining:
        this.maxTokens !== null
          ? Math.max(0, this.maxTokens - this.tokensUsed)
          : null,
      stepsExecuted: this.stepsExecuted,
      stepsRemaining:
        this.maxSteps !== null
          ? Math.max(0, this.maxSteps - this.stepsExecuted)
          : null,
      elapsedMs: elapsed,
      durationRemaining:
        this.maxDurationMs !== null
          ? Math.max(0, this.maxDurationMs - elapsed)
          : null,
      truncated: !this.shouldContinue(),
    };
  }

  static estimateResultTokens(result: unknown): number {
    return estimateTokens(JSON.stringify(result));
  }
}
