import { normalizePath } from "../util/paths.js";

import type {
  AgentTask,
  ConfidenceTier,
  RungPath,
  RungType,
  TaskOptions,
} from "./types.js";
import { getLadybugConn } from "../db/ladybug.js";
import {
  getFileByRepoPath,
  getFilesByPrefix,
  searchSymbols,
} from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import { buildContextAwareStopWords } from "./identifier-extraction.js";

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

const DIRECTORY_FALLBACK_LIMIT = 20;
const DIRECTORY_FALLBACK_CANDIDATE_LIMIT = 200;

function directoryFallbackTerms(taskText: string): string[] {
  const stopWords = buildContextAwareStopWords(taskText);
  return [
    ...new Set(taskText.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []),
  ].filter(
    (term) =>
      term !== "test" && term !== "tests" && !stopWords.has(term),
  );
}

function normalizedFocusPaths(task: AgentTask): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of task.options?.focusPaths ?? []) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const normalized = normalizePath(trimmed);
    const focusPath =
      normalized === "./" ? "." : normalized.replace(/\/+$/, "");
    if (!seen.has(focusPath)) {
      paths.push(focusPath);
      seen.add(focusPath);
    }
  }

  return paths;
}

export class Planner {
  plan(task: AgentTask, confidence?: ConfidenceTier): RungPath {
    const taskType = task.taskType;
    const options = task.options ?? {};

    switch (taskType) {
      case "debug":
        return this.planDebug(task, options, confidence);
      case "review":
        return this.planReview(task, options, confidence);
      case "implement":
        return this.planImplement(task, options, confidence);
      case "explain":
        return this.planExplain(task, options, confidence);
      default:
        return this.planDefault(task, options, confidence);
    }
  }

  private planDebug(
    task: AgentTask,
    options: TaskOptions,
    confidence?: ConfidenceTier,
  ): RungPath {
    if (options.contextMode === "precise") {
      return this.buildRungPath(
        ["card", "hotPath"],
        task,
        "Precise debug: card + hotPath",
        confidence,
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
      confidence,
    );
  }

  private planReview(
    task: AgentTask,
    options: TaskOptions,
    confidence?: ConfidenceTier,
  ): RungPath {
    if (options.contextMode === "precise") {
      // Review requires seeing actual code structure, not just card summaries.
      // Always include skeleton + hotPath so reviewers can inspect logic.
      return this.buildRungPath(
        ["card", "skeleton", "hotPath"],
        task,
        "Precise review: card + skeleton + hotPath for code inspection",
        confidence,
      );
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
      confidence,
    );
  }

  private planImplement(
    task: AgentTask,
    options: TaskOptions,
    confidence?: ConfidenceTier,
  ): RungPath {
    if (options.contextMode === "precise") {
      return this.buildRungPath(
        ["card", "skeleton"],
        task,
        "Precise implement: card + skeleton",
        confidence,
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
      confidence,
    );
  }

  private planExplain(
    task: AgentTask,
    options: TaskOptions,
    confidence?: ConfidenceTier,
  ): RungPath {
    if (options.contextMode === "precise") {
      // Explain tasks need at least skeleton to show code structure.
      // Card-only is never enough to understand how something works.
      return this.buildRungPath(
        ["card", "skeleton"],
        task,
        "Precise explain: card + skeleton for structural understanding",
        confidence,
      );
    }

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
      confidence,
    );
  }

  private planDefault(
    _task: AgentTask,
    _options: TaskOptions,
    confidence?: ConfidenceTier,
  ): RungPath {
    const rungs: RungType[] = ["card", "skeleton"];
    return this.buildRungPath(
      rungs,
      _task,
      "Default balanced approach",
      confidence,
    );
  }

  private buildRungPath(
    rungs: RungType[],
    task: AgentTask,
    reasoning: string,
    confidence?: ConfidenceTier,
  ): RungPath {
    const path: RungPath = {
      rungs,
      estimatedTokens: this.estimateTokens(rungs),
      estimatedDurationMs: this.estimateDuration(rungs),
      reasoning,
    };

    if (task.budget) {
      this.adjustForBudget(
        path,
        task.budget,
        task.options?.contextMode,
        confidence,
      );
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

  /**
   * Confidence-aware budget adjustment.
   *
   * - high confidence: cheapest plan (pop expensive rungs first, same as before).
   * - medium confidence: preserve one diagnostic rung (skeleton for precise,
   *   hotPath for broad) if budget allows card + that rung.
   * - low confidence: escalate — try to keep the richer of skeleton or hotPath
   *   to compensate for uncertain ranking.
   * - Falls back to tail-pop when the confidence-aware minimum still exceeds budget.
   */
  private adjustForBudget(
    path: RungPath,
    budget: NonNullable<AgentTask["budget"]>,
    contextMode?: string,
    confidence?: ConfidenceTier,
  ): void {
    const overTokens =
      budget.maxTokens && path.estimatedTokens > budget.maxTokens;
    const overDuration =
      budget.maxDurationMs && path.estimatedDurationMs > budget.maxDurationMs;

    if (!overTokens && !overDuration) return;

    const tier = confidence ?? "high";
    const isPrecise = contextMode === "precise";

    // Determine the minimum rungs we want to preserve based on confidence.
    // "card" is always the floor.
    let minRungs: RungType[];
    if (tier === "low") {
      // Low confidence: preserve one disambiguating rung beyond card
      const prefer: RungType = path.rungs.includes("hotPath")
        ? "hotPath"
        : "skeleton";
      minRungs = path.rungs.includes(prefer) ? ["card", prefer] : ["card"];
    } else if (tier === "medium") {
      // Medium: keep card + one diagnostic
      const diagnosticRung: RungType = isPrecise ? "skeleton" : "hotPath";
      minRungs = path.rungs.includes(diagnosticRung)
        ? ["card", diagnosticRung]
        : ["card"];
    } else {
      // High confidence: cheapest plan, just card if needed
      minRungs = ["card"];
    }

    // Check if the minimum set fits within budget
    const minTokens = this.estimateTokens(minRungs);
    const minDuration = this.estimateDuration(minRungs);
    const minFitsTokens = !budget.maxTokens || minTokens <= budget.maxTokens;
    const minFitsDuration =
      !budget.maxDurationMs || minDuration <= budget.maxDurationMs;

    if (!minFitsTokens || !minFitsDuration) {
      // Even the minimum doesn't fit — fall back to simple tail-pop
      this.reducePathSimple(path, budget);
      return;
    }

    // Pop rungs that are NOT in the minimum set first, then pop minimum rungs
    // only as a last resort. This avoids tail-pop ordering problems where a
    // preserved rung (e.g. hotPath) is at the end and would be popped first.
    const originalRungs = [...path.rungs];
    const minRungSet = new Set(minRungs);

    // Phase 1: remove non-minimum rungs from the tail
    while (path.rungs.length > minRungs.length) {
      const fitsTokens =
        !budget.maxTokens || path.estimatedTokens <= budget.maxTokens;
      const fitsDuration =
        !budget.maxDurationMs ||
        path.estimatedDurationMs <= budget.maxDurationMs;
      if (fitsTokens && fitsDuration) break;

      // Find the last rung that is NOT in the minimum set
      let popped = false;
      for (let i = path.rungs.length - 1; i >= 0; i--) {
        if (!minRungSet.has(path.rungs[i]!)) {
          path.rungs.splice(i, 1);
          popped = true;
          break;
        }
      }
      if (!popped) break; // Only minimum rungs remain

      path.estimatedTokens = this.estimateTokens(path.rungs);
      path.estimatedDurationMs = this.estimateDuration(path.rungs);
    }

    // Phase 2: if still over, fall back to exactly the minimum set
    const stillOverTokens =
      budget.maxTokens && path.estimatedTokens > budget.maxTokens;
    const stillOverDuration =
      budget.maxDurationMs && path.estimatedDurationMs > budget.maxDurationMs;
    if (stillOverTokens || stillOverDuration) {
      path.rungs = [...minRungs];
      path.estimatedTokens = this.estimateTokens(path.rungs);
      path.estimatedDurationMs = this.estimateDuration(path.rungs);
    }

    const removed = originalRungs.filter((r) => !path.rungs.includes(r));
    if (removed.length > 0) {
      const budgetParts: string[] = [];
      if (budget.maxTokens)
        budgetParts.push(`token budget (${budget.maxTokens})`);
      if (budget.maxDurationMs)
        budgetParts.push(`duration budget (${budget.maxDurationMs}ms)`);
      const budgetDesc = budgetParts.join(" and ");

      const reason =
        tier !== "high"
          ? `; Confidence-aware (${tier}) trim: removed ${removed.join(", ")}, preserved ${path.rungs.join(", ")} to meet ${budgetDesc}`
          : `; Trimmed rung(s) ${removed.join(", ")} to meet ${budgetDesc}`;
      path.reasoning += reason;
    }
  }

  /** Simple tail-pop reduction when confidence-aware minimum doesn't fit. */
  private reducePathSimple(
    path: RungPath,
    budget: NonNullable<AgentTask["budget"]>,
  ): void {
    const originalRungs = [...path.rungs];
    while (path.rungs.length > 1) {
      const fitsTokens =
        !budget.maxTokens || path.estimatedTokens <= budget.maxTokens;
      const fitsDuration =
        !budget.maxDurationMs ||
        path.estimatedDurationMs <= budget.maxDurationMs;
      if (fitsTokens && fitsDuration) break;

      path.rungs.pop();
      path.estimatedTokens = this.estimateTokens(path.rungs);
      path.estimatedDurationMs = this.estimateDuration(path.rungs);
    }
    const removed = originalRungs.filter((r) => !path.rungs.includes(r));
    if (removed.length > 0) {
      const budgetParts: string[] = [];
      if (budget.maxTokens)
        budgetParts.push(`token budget (${budget.maxTokens})`);
      if (budget.maxDurationMs)
        budgetParts.push(`duration budget (${budget.maxDurationMs}ms)`);
      path.reasoning += `; Trimmed rung(s) ${removed.join(", ")} to meet ${budgetParts.join(" and ")}`;
    }
  }

  async selectContext(task: AgentTask): Promise<string[]> {
    const options = task.options ?? {};
    const context: string[] = [];
    const focusPaths = normalizedFocusPaths(task);
    const needsConnection =
      focusPaths.length > 0 ||
      options.focusSymbols?.some((symbol) => !/^[0-9a-f]{16,}$/i.test(symbol));
    let conn: Awaited<ReturnType<typeof getLadybugConn>> | undefined;
    if (needsConnection) {
      try {
        conn = await getLadybugConn();
      } catch {
        // Name and file resolution are best effort.
      }
    }

    if (options.focusSymbols && options.focusSymbols.length > 0) {
      for (const sym of options.focusSymbols) {
        // Detect whether the value looks like a symbolId (hex hash, >= 16 chars)
        // or a human-readable symbol name that needs resolution.
        if (/^[0-9a-f]{16,}$/i.test(sym)) {
          context.push(`symbol:${sym}`);
        } else if (conn) {
          // Resolve name to symbolId via search
          try {
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

    if (conn) {
      for (const focusPath of focusPaths) {
        if (focusPath === ".") continue;
        try {
          const file = await getFileByRepoPath(conn, task.repoId, focusPath);
          if (file) context.push(`file:${file.relPath}`);
        } catch {
          // Missing or unreadable paths remain eligible for directory fallback.
        }
      }
    }

    return context;
  }

  /** Expand directory focus paths for the scoped zero-seed fallback. */
  async expandDirectoryFocusPaths(task: AgentTask): Promise<string[]> {
    const candidates = new Map<string, Awaited<ReturnType<typeof getFilesByPrefix>>[number]>();
    const focusPaths = normalizedFocusPaths(task);
    const taskTerms = directoryFallbackTerms(task.taskText);
    let conn: Awaited<ReturnType<typeof getLadybugConn>>;

    try {
      conn = await getLadybugConn();
    } catch {
      return [];
    }

    for (const focusPath of focusPaths) {
      try {
        if (
          focusPath !== "." &&
          (await getFileByRepoPath(conn, task.repoId, focusPath))
        ) {
          continue;
        }
        const prefix = focusPath === "." ? "" : `${focusPath}/`;
        const files = await getFilesByPrefix(
          conn,
          task.repoId,
          prefix,
          DIRECTORY_FALLBACK_CANDIDATE_LIMIT,
        );
        // Each directory query has a 200-row recall ceiling. If wider scopes
        // miss relevant files, move relevance ranking into the DB query.
        for (const file of files) {
          if (!candidates.has(file.relPath)) candidates.set(file.relPath, file);
        }
      } catch {
        // Directory expansion is a best-effort fallback.
      }
    }

    return [...candidates.values()]
      .map((file) => {
        const normalized = normalizePath(file.relPath).toLowerCase();
        return {
          file,
          score: taskTerms.reduce(
            (total, term) => total + Number(normalized.includes(term)),
            0,
          ),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, DIRECTORY_FALLBACK_LIMIT)
      .map(({ file }) => `file:${file.relPath}`);
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
