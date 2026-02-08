import type { AgentTask, RungPath, RungType, TaskOptions } from "./types.js";

const DEFAULT_TOKEN_ESTIMATES: Record<string, number> = {
  card: 50,
  skeleton: 200,
  hotPath: 500,
  raw: 2000,
};

const DEFAULT_DURATION_ESTIMATES_MS: Record<string, number> = {
  card: 10,
  skeleton: 50,
  hotPath: 100,
  raw: 500,
};

export class Planner {
  plan(task: AgentTask): RungPath {
    const taskType = task.taskType;
    const options = task.options ?? {};

    switch (taskType) {
      case "debug":
        return this.planDebug(task, options);
      case "review":
        return this.planReview(task, options);
      case "implement":
        return this.planImplement(task, options);
      case "explain":
        return this.planExplain(task, options);
      default:
        return this.planDefault(task, options);
    }
  }

  private planDebug(task: AgentTask, options: TaskOptions): RungPath {
    const rungs: RungType[] = [];

    if (options.requireDiagnostics) {
      rungs.push("card", "skeleton", "hotPath", "raw");
    } else if (options.focusSymbols && options.focusSymbols.length > 0) {
      rungs.push("card", "skeleton", "hotPath");
    } else {
      rungs.push("card", "skeleton");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Debug task prioritizes detailed code analysis",
    );
  }

  private planReview(task: AgentTask, options: TaskOptions): RungPath {
    const rungs: RungType[] = [];

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      rungs.push("card", "skeleton", "hotPath");
    } else {
      rungs.push("card", "skeleton");
    }

    if (options.includeTests) {
      rungs.push("hotPath");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Review task focuses on structure and hot paths",
    );
  }

  private planImplement(task: AgentTask, options: TaskOptions): RungPath {
    const rungs: RungType[] = ["card", "skeleton"];

    if (options.focusPaths && options.focusPaths.length > 0) {
      rungs.push("hotPath");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Implement task requires structure and context",
    );
  }

  private planExplain(task: AgentTask, options: TaskOptions): RungPath {
    const rungs: RungType[] = ["card"];

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      rungs.push("skeleton");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Explain task starts with high-level summaries",
    );
  }

  private planDefault(_task: AgentTask, _options: TaskOptions): RungPath {
    const rungs: RungType[] = ["card", "skeleton"];
    return this.buildRungPath(rungs, _task, "Default balanced approach");
  }

  private buildRungPath(
    rungs: RungType[],
    task: AgentTask,
    reasoning: string,
  ): RungPath {
    const estimatedTokens = this.estimateTokens(rungs);
    const estimatedDurationMs = this.estimateDuration(rungs);

    const path: RungPath = {
      rungs,
      estimatedTokens,
      estimatedDurationMs,
      reasoning,
    };

    if (task.budget) {
      this.adjustForBudget(path, task.budget);
    }

    return path;
  }

  private estimateTokens(rungs: RungType[]): number {
    return rungs.reduce(
      (sum, rung) => sum + (DEFAULT_TOKEN_ESTIMATES[rung] ?? 0),
      0,
    );
  }

  private estimateDuration(rungs: RungType[]): number {
    return rungs.reduce(
      (sum, rung) => sum + (DEFAULT_DURATION_ESTIMATES_MS[rung] ?? 0),
      0,
    );
  }

  private adjustForBudget(
    path: RungPath,
    budget: { maxTokens?: number; maxDurationMs?: number },
  ): void {
    if (budget.maxTokens && path.estimatedTokens > budget.maxTokens) {
      this.reducePathForTokenLimit(path, budget.maxTokens);
    }

    if (
      budget.maxDurationMs &&
      path.estimatedDurationMs > budget.maxDurationMs
    ) {
      this.reducePathForDurationLimit(path, budget.maxDurationMs);
    }
  }

  private reducePathForTokenLimit(path: RungPath, maxTokens: number): void {
    while (path.estimatedTokens > maxTokens && path.rungs.length > 1) {
      const removedRung = path.rungs.pop()!;
      path.estimatedTokens -= DEFAULT_TOKEN_ESTIMATES[removedRung] ?? 0;
      path.estimatedDurationMs -=
        DEFAULT_DURATION_ESTIMATES_MS[removedRung] ?? 0;
      path.reasoning += `; Reduced rung ${removedRung} to meet token budget`;
    }
  }

  private reducePathForDurationLimit(
    path: RungPath,
    maxDurationMs: number,
  ): void {
    while (path.estimatedDurationMs > maxDurationMs && path.rungs.length > 1) {
      const removedRung = path.rungs.pop()!;
      path.estimatedTokens -= DEFAULT_TOKEN_ESTIMATES[removedRung] ?? 0;
      path.estimatedDurationMs -=
        DEFAULT_DURATION_ESTIMATES_MS[removedRung] ?? 0;
      path.reasoning += `; Reduced rung ${removedRung} to meet duration budget`;
    }
  }

  selectContext(task: AgentTask): string[] {
    const options = task.options ?? {};
    const context: string[] = [];

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      context.push(...options.focusSymbols);
    }

    if (options.focusPaths && options.focusPaths.length > 0) {
      context.push(...options.focusPaths);
    }

    return context;
  }

  validateTask(task: AgentTask): { valid: boolean; error?: string } {
    if (!task.taskText || task.taskText.trim().length === 0) {
      return { valid: false, error: "Task text cannot be empty" };
    }

    if (!task.repoId || task.repoId.trim().length === 0) {
      return { valid: false, error: "Repo ID cannot be empty" };
    }

    if (task.budget) {
      if (task.budget.maxTokens && task.budget.maxTokens < 0) {
        return { valid: false, error: "Max tokens cannot be negative" };
      }
      if (task.budget.maxDurationMs && task.budget.maxDurationMs < 0) {
        return { valid: false, error: "Max duration cannot be negative" };
      }
      if (task.budget.maxActions && task.budget.maxActions < 0) {
        return { valid: false, error: "Max actions cannot be negative" };
      }
    }

    return { valid: true };
  }
}
