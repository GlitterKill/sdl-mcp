import type {
  AgentTask,
  OrchestrationResult,
  PlannedExecution,
} from "./types.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { PolicyEngine } from "../policy/engine.js";

export class Orchestrator {
  private planner: Planner;
  private policyEngine: PolicyEngine;

  constructor() {
    this.planner = new Planner();
    this.policyEngine = new PolicyEngine();
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

      const executor = new Executor(this.policyEngine);
      const { actions, evidence, success } = await executor.execute(
        task,
        path.rungs,
        context,
      );

      const metrics = executor.getMetrics();
      const nextBestAction = executor.getNextBestAction();

      return {
        taskId,
        taskType: task.taskType,
        actionsTaken: actions,
        path,
        finalEvidence: evidence,
        summary: this.generateSummary(task, actions, evidence, success),
        success,
        metrics,
        answer: this.generateAnswer(task, evidence, success),
        nextBestAction,
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

  private generateAnswer(
    task: AgentTask,
    evidence: unknown[],
    success: boolean,
  ): string {
    if (!success) {
      return `Task execution failed. Review actions and errors for details.`;
    }

    switch (task.taskType) {
      case "explain":
        return `Based on the collected evidence from ${evidence.length} sources, the code structure and relationships have been analyzed. Review the evidence sections for detailed information.`;
      case "debug":
        return `Debugging analysis completed with ${evidence.length} evidence items collected. Check actions taken and final evidence for specific findings.`;
      case "review":
        return `Code review completed with ${evidence.length} evidence items. Review findings include structure analysis and key symbols identified.`;
      case "implement":
        return `Implementation task completed with ${evidence.length} evidence items collected. Context gathered from the selected rungs should support the requested changes.`;
      default:
        return `Task completed successfully with ${evidence.length} evidence items collected.`;
    }
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
      answer: `Task execution failed: ${error}`,
      nextBestAction: "retryWithDifferentInputs",
    };
  }
}

export const orchestrator = new Orchestrator();
