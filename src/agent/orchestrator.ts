import type {
  AgentTask,
  Evidence,
  Action,
  OrchestrationResult,
  PlannedExecution,
} from "./types.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { PolicyEngine } from "../policy/engine.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { ValidationError } from "../domain/errors.js";
import { logger } from "../util/logger.js";

const HANDLED_EVIDENCE_TYPES = new Set([
  "symbolCard", "skeleton", "hotPath", "codeWindow", "diagnostic", "searchResult",
]);

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
      const { expandedContext, clusterExpandedCount } =
        await this.expandContextForClusters(context);

      const executor = new Executor(this.policyEngine);
      const { actions, evidence, success } = await executor.execute(
        task,
        path.rungs,
        expandedContext,
      );

      const metrics = executor.getMetrics();
      const nextBestAction = executor.getNextBestAction();

      return {
        taskId,
        taskType: task.taskType,
        actionsTaken: actions,
        path,
        finalEvidence: evidence,
        summary: this.generateSummary(task, actions, evidence, success, {
          clusterExpandedCount,
        }),
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
      throw new ValidationError(`Task validation failed: ${validation.error}`);
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
    actions: Action[],
    evidence: Evidence[],
    success: boolean,
    extra: { clusterExpandedCount: number } = { clusterExpandedCount: 0 },
  ): string {
    const status = success ? "completed successfully" : "completed with errors";
    const actionCount = actions.length;
    const evidenceCount = evidence.length;
    const clusterNote =
      extra.clusterExpandedCount > 0
        ? ` (expanded ${extra.clusterExpandedCount} symbols via cluster analysis)`
        : "";

    return `Task "${task.taskType}" ${status}. Executed ${actionCount} action(s), collected ${evidenceCount} evidence item(s).${clusterNote}`;
  }

  private generateAnswer(
    task: AgentTask,
    evidence: Evidence[],
    success: boolean,
  ): string {
    if (!success && evidence.length === 0) {
      return `Task execution failed. Review actions and errors for details.`;
    }

    if (evidence.length === 0) {
      return `No evidence was collected for task "${task.taskType}". Try providing focusSymbols or focusPaths, or broadening the task description.`;
    }

    // Group evidence by type
    const byType = new Map<string, Evidence[]>();
    for (const e of evidence) {
      const list = byType.get(e.type) ?? [];
      list.push(e);
      byType.set(e.type, list);
    }

    const taskLabel = task.taskType.charAt(0).toUpperCase() + task.taskType.slice(1);
    const sections: string[] = [`# ${taskLabel} Results`];

    if (!success) {
      sections.push(
        "> **Note:** Task completed with errors. Some rungs failed \u2014 see Diagnostics below.",
      );
    }

    // Symbol cards section
    const cards = byType.get("symbolCard");
    if (cards && cards.length > 0) {
      sections.push(
        `## Symbols Found (${cards.length})\n` +
          cards.map((c) => `- ${c.summary}`).join("\n"),
      );
    }

    // Skeleton section
    const skeletons = byType.get("skeleton");
    if (skeletons && skeletons.length > 0) {
      sections.push(
        `## Code Structure (${skeletons.length} skeleton(s))\n` +
          skeletons.map((s) => `- ${s.reference}: ${s.summary}`).join("\n"),
      );
    }

    // Hot path section
    const hotPaths = byType.get("hotPath");
    if (hotPaths && hotPaths.length > 0) {
      sections.push(
        `## Hot Paths (${hotPaths.length})\n` +
          hotPaths.map((h) => `- ${h.reference}: ${h.summary}`).join("\n"),
      );
    }

    // Code window section
    const windows = byType.get("codeWindow");
    if (windows && windows.length > 0) {
      sections.push(
        `## Code Windows (${windows.length})\n` +
          windows.map((w) => `- ${w.reference}: ${w.summary}`).join("\n"),
      );
    }

    // Diagnostics section
    const diagnostics = byType.get("diagnostic");
    if (diagnostics && diagnostics.length > 0) {
      sections.push(
        `## Diagnostics (${diagnostics.length})\n` +
          diagnostics.map((d) => `- ${d.summary}`).join("\n"),
      );
    }

    // Search results section
    const searches = byType.get("searchResult");
    if (searches && searches.length > 0) {
      sections.push(
        `## Search Results\n` +
          searches.map((s) => `- ${s.summary}`).join("\n"),
      );
    }

    // Catch-all for unhandled evidence types (e.g. delta)
    for (const [type, items] of byType) {
      if (!HANDLED_EVIDENCE_TYPES.has(type) && items.length > 0) {
        sections.push(
          `## Other (${type}) (${items.length})\n` +
            items.map((e) => `- ${e.reference}: ${e.summary}`).join("\n"),
        );
      }
    }

    return sections.join("\n\n");
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

  private async expandContextForClusters(
    context: string[],
  ): Promise<{ expandedContext: string[]; clusterExpandedCount: number }> {
    const symbolIds = context
      .filter((c) => c.startsWith("symbol:"))
      .map((s) => s.slice("symbol:".length))
      .filter(Boolean);

    if (symbolIds.length === 0) {
      return { expandedContext: context, clusterExpandedCount: 0 };
    }

    try {
      const conn = await getLadybugConn();
      const clustersBySymbol = await ladybugDb.getClustersForSymbols(
        conn,
        symbolIds,
      );
      const clusterIds = new Set<string>();
      for (const row of clustersBySymbol.values()) {
        clusterIds.add(row.clusterId);
      }
      if (clusterIds.size === 0) {
        return { expandedContext: context, clusterExpandedCount: 0 };
      }

      const memberLists = await Promise.all(
        Array.from(clusterIds).map((clusterId) =>
          ladybugDb.getClusterMembers(conn, clusterId),
        ),
      );

      const already = new Set(context);
      const additional: string[] = [];

      for (const members of memberLists) {
        for (const m of members) {
          const ref = `symbol:${m.symbolId}`;
          if (already.has(ref)) continue;
          additional.push(ref);
          already.add(ref);
        }
        // Outer loop break is sufficient — inner loop processes all members
        // of each cluster before checking the cap.
        if (additional.length >= 20) break;
      }

      return {
        expandedContext:
          additional.length > 0 ? [...context, ...additional] : context,
        clusterExpandedCount: additional.length,
      };
    } catch (err) {
      logger.debug("Cluster expansion failed, using unexpanded context", {
        error: err,
      });
      return { expandedContext: context, clusterExpandedCount: 0 };
    }
  }
}

export const orchestrator = new Orchestrator();
