import type {
  AgentTask,
  OrchestrationResult,
  PlannedExecution,
} from "./types.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";

export class Orchestrator {
  private planner: Planner;

  constructor() {
    this.planner = new Planner();
  }

  async orchestrate(task: AgentTask): Promise<OrchestrationResult> {
    const taskId = this.generateTaskId();

    const validation = this.planner.validateTask(task);
    if (!validation.valid) {
      return this.createErrorResult(
        taskId,
        task,
        validation.error ?? "Invalid task",
      );
    }

    try {
      const path = this.planner.plan(task);
      const context = this.planner.selectContext(task);

      const executor = new Executor();
      const { actions, evidence, success } = await executor.execute(
        task,
        path.rungs,
        context,
      );

      const metrics = executor.getMetrics();

      return {
        taskId,
        taskType: task.taskType,
        actionsTaken: actions,
        path,
        finalEvidence: evidence,
        summary: this.generateSummary(task, actions, evidence, success),
        success,
        metrics,
      };
    } catch (error) {
      return this.createErrorResult(
        taskId,
        task,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async plan(task: AgentTask): Promise<PlannedExecution> {
    const validation = this.planner.validateTask(task);
    if (!validation.valid) {
      throw new Error(`Task validation failed: ${validation.error}`);
    }

    const path = this.planner.plan(task);

    return {
      task,
      path,
      sequence: [],
    };
  }

  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateSummary(
    task: AgentTask,
    actions: unknown[],
    evidence: unknown[],
    success: boolean,
  ): string {
    const status = success ? "completed successfully" : "failed";
    const actionCount = actions.length;
    const evidenceCount = evidence.length;

    return `Task "${task.taskType}" ${status}. Executed ${actionCount} action(s), collected ${evidenceCount} evidence item(s).`;
  }

  private createErrorResult(
    taskId: string,
    task: AgentTask,
    error: string,
  ): OrchestrationResult {
    return {
      taskId,
      taskType: task.taskType,
      actionsTaken: [],
      path: {
        rungs: [],
        estimatedTokens: 0,
        estimatedDurationMs: 0,
        reasoning: "Error occurred before planning",
      },
      finalEvidence: [],
      summary: `Task failed: ${error}`,
      success: false,
      error,
      metrics: {
        totalDurationMs: 0,
        totalTokens: 0,
        totalActions: 0,
        successfulActions: 0,
        failedActions: 0,
        cacheHits: 0,
      },
    };
  }
}

export const orchestrator = new Orchestrator();
