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
    // Precise mode: card + hotPath only (skip skeleton — hotpath gives the code).
    if (options.contextMode === 'precise') {
      return this.buildRungPath(['card', 'hotPath'], task, 'Precise debug: card + hotPath');
    }

    const rungs: RungType[] = ["card", "skeleton", "hotPath"];

    if (options.requireDiagnostics) {
      rungs.push("raw");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Debug task prioritizes detailed code analysis",
    );
  }

  private planReview(task: AgentTask, options: TaskOptions): RungPath {
    if (options.contextMode === 'precise') {
      return this.buildRungPath(['card'], task, 'Precise review: card only');
    }

    const rungs: RungType[] = ["card", "skeleton"];

    if (
      (options.focusSymbols && options.focusSymbols.length > 0) ||
      (options.focusPaths && options.focusPaths.length > 0)
    ) {
      rungs.push("hotPath");
    }

    if (options.includeTests) {
      if (!rungs.includes("hotPath")) rungs.push("hotPath");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Review task focuses on structure and hot paths",
    );
  }

  private planImplement(task: AgentTask, options: TaskOptions): RungPath {
    if (options.contextMode === 'precise') {
      return this.buildRungPath(['card', 'skeleton'], task, 'Precise implement: card + skeleton');
    }

    const rungs: RungType[] = ["card", "skeleton"];

    if (
      (options.focusPaths && options.focusPaths.length > 0) ||
      (options.focusSymbols && options.focusSymbols.length > 0)
    ) {
      rungs.push("hotPath");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Implement task requires structure and context",
    );
  }

  private planExplain(task: AgentTask, options: TaskOptions): RungPath {
    // Precise mode: card + skeleton — skeleton shows control flow which is
    // essential for understanding how a symbol works.
    if (options.contextMode === 'precise') {
      return this.buildRungPath(['card', 'skeleton'], task, 'Precise explain: card + skeleton');
    }

    const rungs: RungType[] = ["card"];

    if (
      (options.focusSymbols && options.focusSymbols.length > 0) ||
      (options.focusPaths && options.focusPaths.length > 0)
    ) {
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
    const path: RungPath = {
      rungs,
      estimatedTokens: this.estimateTokens(rungs),
      estimatedDurationMs: this.estimateDuration(rungs),
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
    budget: NonNullable<AgentTask["budget"]>,
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
    const originalRungs = [...path.rungs];
    while (path.estimatedTokens > maxTokens && path.rungs.length > 1) {
      path.rungs.pop();
      path.estimatedTokens = this.estimateTokens(path.rungs);
      path.estimatedDurationMs = this.estimateDuration(path.rungs);
    }
    const removed = originalRungs.filter((r) => !path.rungs.includes(r));
    if (removed.length > 0) {
      path.reasoning += `; Trimmed rung(s) ${removed.join(", ")} to meet token budget (${maxTokens})`;
    }
  }

  private reducePathForDurationLimit(
    path: RungPath,
    maxDurationMs: number,
  ): void {
    const originalRungs = [...path.rungs];
    while (path.estimatedDurationMs > maxDurationMs && path.rungs.length > 1) {
      path.rungs.pop();
      path.estimatedTokens = this.estimateTokens(path.rungs);
      path.estimatedDurationMs = this.estimateDuration(path.rungs);
    }
    const removed = originalRungs.filter((r) => !path.rungs.includes(r));
    if (removed.length > 0) {
      path.reasoning += `; Trimmed rung(s) ${removed.join(", ")} to meet duration budget (${maxDurationMs}ms)`;
    }
  }

  selectContext(task: AgentTask): string[] {
    const options = task.options ?? {};
    const context: string[] = [];

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      context.push(
        ...options.focusSymbols.map((symbolId) => `symbol:${symbolId}`),
      );
    }

    if (options.focusPaths && options.focusPaths.length > 0) {
      context.push(
        ...options.focusPaths.map((filePath) => `file:${filePath}`),
      );
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
      if (task.budget.maxTokens != null && task.budget.maxTokens <= 0) {
        return { valid: false, error: "maxTokens must be positive" };
      }
      if (task.budget.maxDurationMs != null && task.budget.maxDurationMs <= 0) {
        return { valid: false, error: "maxDurationMs must be positive" };
      }
      if (task.budget.maxActions != null && task.budget.maxActions <= 0) {
        return { valid: false, error: "maxActions must be positive" };
      }
    }

    return { valid: true };
  }
}
