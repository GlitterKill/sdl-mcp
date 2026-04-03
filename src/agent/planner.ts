import type { AgentTask, RungPath, RungType, TaskOptions } from "./types.js";
import { getLadybugConn } from "../db/ladybug.js";
import { searchSymbols, getFilesByPrefix } from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

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
    if (options.contextMode === "precise") {
      return this.buildRungPath(
        ["card", "hotPath"],
        task,
        "Precise debug: card + hotPath",
      );
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
    if (options.contextMode === "precise") {
      return this.buildRungPath(["card"], task, "Precise review: card only");
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
    if (options.contextMode === "precise") {
      return this.buildRungPath(
        ["card", "skeleton"],
        task,
        "Precise implement: card + skeleton",
      );
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
    // Precise mode: card only — minimal tokens for quick lookups.
    if (options.contextMode === "precise") {
      return this.buildRungPath(["card"], task, "Precise explain: card only");
    }

    // Broad (default): card + skeleton for structural understanding;
    // add hotPath when explicit focus narrows the scope.
    const rungs: RungType[] = ["card", "skeleton"];

    if (
      (options.focusSymbols && options.focusSymbols.length > 0) ||
      (options.focusPaths && options.focusPaths.length > 0)
    ) {
      rungs.push("hotPath");
    }

    return this.buildRungPath(
      rungs,
      task,
      "Explain task: cards + skeletons for structural understanding",
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

  async selectContext(task: AgentTask): Promise<string[]> {
    const options = task.options ?? {};
    const context: string[] = [];

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      for (const sym of options.focusSymbols) {
        // Detect whether the value looks like a symbolId (hex hash, >= 16 chars)
        // or a human-readable symbol name that needs resolution.
        if (/^[0-9a-f]{16,}$/i.test(sym)) {
          context.push(`symbol:${sym}`);
        } else {
          // Resolve name to symbolId via search
          try {
            const conn = await getLadybugConn();
            const results = await searchSymbols(conn, task.repoId, sym, 1);
            if (results.length > 0) {
              context.push(`symbol:${results[0].symbolId}`);
            } else {
              logger.debug("focusSymbol name resolution found no match", {
                name: sym,
                repoId: task.repoId,
              });
            }
          } catch {
            // If resolution fails, skip this symbol silently
          }
        }
      }
    }

    if (options.focusPaths && options.focusPaths.length > 0) {
      // Expand directory paths to their constituent files so the executor
      // processes multiple symbols instead of treating a directory as a single
      // opaque file reference (which would yield only ~1 symbol card).
      for (const filePath of options.focusPaths) {
        const normalizedPath = filePath.replace(/\\/g, "/");
        const isDirectory =
          normalizedPath.endsWith("/") ||
          !normalizedPath.split("/").pop()?.includes(".");
        if (isDirectory) {
          try {
            const dirConn = await getLadybugConn();
            const dirPrefix = normalizedPath.endsWith("/")
              ? normalizedPath
              : normalizedPath + "/";
            const filesInDir = await getFilesByPrefix(
              dirConn,
              task.repoId,
              dirPrefix,
              20,
            );
            if (filesInDir.length > 0) {
              context.push(...filesInDir.map((f) => `file:${f.relPath}`));
            } else {
              // Fallback: pass as-is and let the executor try
              context.push(`file:${filePath}`);
            }
          } catch {
            context.push(`file:${filePath}`);
          }
        } else {
          context.push(`file:${filePath}`);
        }
      }
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
