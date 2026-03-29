import { estimateTokens } from "../util/tokenize.js";
import type { WorkflowBudget } from "./types.js";

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export class WorkflowBudgetTracker {
  private tokensUsed = 0;
  private stepsExecuted = 0;
  private readonly startTime: number;
  private readonly maxTokens: number | null;
  private readonly maxSteps: number | null;
  private readonly maxDurationMs: number | null;

  constructor(
    budget?: WorkflowBudget,
    configDefaults?: {
      maxSteps: number;
      maxTokens: number;
      maxDurationMs: number;
    },
  ) {
    this.startTime = Date.now();

    // Request budget can only tighten the configured workflow limits.
    const requestTokens = budget?.maxTotalTokens ?? null;
    const requestSteps = budget?.maxSteps ?? null;
    const requestDuration = budget?.maxDurationMs ?? null;
    const configTokens = configDefaults?.maxTokens ?? null;
    const configSteps = configDefaults?.maxSteps ?? null;
    const configDuration = configDefaults?.maxDurationMs ?? null;

    this.maxTokens = minNullable(requestTokens, configTokens);
    this.maxSteps = minNullable(requestSteps, configSteps);
    this.maxDurationMs = minNullable(requestDuration, configDuration);
  }

  record(stepTokens: number, _stepDurationMs: number): void {
    this.tokensUsed += stepTokens;
    this.stepsExecuted += 1;
  }

  shouldContinue(): boolean {
    if (this.maxTokens !== null && this.tokensUsed >= this.maxTokens) {
      return false;
    }
    if (this.maxSteps !== null && this.stepsExecuted >= this.maxSteps) {
      return false;
    }
    if (
      this.maxDurationMs !== null
      && Date.now() - this.startTime >= this.maxDurationMs
    ) {
      return false;
    }
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
