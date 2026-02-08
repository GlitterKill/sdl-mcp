import type {
  Action,
  AgentTask,
  Evidence,
  ExecutionMetrics,
  RungType,
} from "./types.js";
import { EvidenceCapture } from "./evidence.js";

export class Executor {
  private evidenceCapture: EvidenceCapture;
  private actions: Action[] = [];
  private metrics: ExecutionMetrics;
  private startTime: number;

  constructor() {
    this.evidenceCapture = new EvidenceCapture();
    this.metrics = {
      totalDurationMs: 0,
      totalTokens: 0,
      totalActions: 0,
      successfulActions: 0,
      failedActions: 0,
      cacheHits: 0,
    };
    this.startTime = Date.now();
  }

  async execute(
    task: AgentTask,
    rungs: RungType[],
    context: string[],
  ): Promise<{ actions: Action[]; evidence: Evidence[]; success: boolean }> {
    for (const rung of rungs) {
      await this.executeRung(task, rung, context);
    }

    return {
      actions: this.actions,
      evidence: this.evidenceCapture.getAllEvidence(),
      success: this.metrics.failedActions === 0,
    };
  }

  private async executeRung(
    task: AgentTask,
    rung: RungType,
    context: string[],
  ): Promise<void> {
    try {
      switch (rung) {
        case "card":
          await this.executeCardRung(task, context);
          break;
        case "skeleton":
          await this.executeSkeletonRung(task, context);
          break;
        case "hotPath":
          await this.executeHotPathRung(task, context);
          break;
        case "raw":
          await this.executeRawRung(task, context);
          break;
        default:
          throw new Error(`Unknown rung type: ${rung}`);
      }
    } catch (error) {
      const action: Action = {
        id: this.generateActionId(),
        type: "analyze",
        status: "failed",
        input: { rung, context },
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        durationMs: 0,
        evidence: [],
      };
      this.actions.push(action);
      this.metrics.failedActions++;
      throw error;
    }
  }

  private async executeCardRung(
    _task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const symbols = context
        .filter((c) => c.startsWith("symbol:"))
        .map((s) => s.replace("symbol:", ""));

      for (const symbolId of symbols.slice(0, 10)) {
        this.evidenceCapture.captureSymbolCard(
          symbolId,
          `Card for symbol ${symbolId}`,
        );
      }

      if (symbols.length === 0) {
        this.evidenceCapture.captureSearchResult("initial context", 0);
      }

      const action: Action = {
        id: actionId,
        type: "getCard",
        status: "completed",
        input: { context },
        output: { cardsProcessed: symbols.length },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("symbolCard"),
      };
      this.actions.push(action);
      this.metrics.successfulActions++;
    } catch (error) {
      throw new Error(
        `Card rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeSkeletonRung(
    _task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const filePaths = context
        .filter((c) => c.startsWith("file:"))
        .map((f) => f.replace("file:", ""));

      for (const filePath of filePaths.slice(0, 5)) {
        this.evidenceCapture.captureSkeleton(
          filePath,
          `Skeleton for ${filePath}`,
        );
      }

      const action: Action = {
        id: actionId,
        type: "getSkeleton",
        status: "completed",
        input: { context },
        output: { filesProcessed: filePaths.length },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("skeleton"),
      };
      this.actions.push(action);
      this.metrics.successfulActions++;
    } catch (error) {
      throw new Error(
        `Skeleton rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeHotPathRung(
    _task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const symbols = context
        .filter((c) => c.startsWith("symbol:"))
        .map((s) => s.replace("symbol:", ""));

      for (const symbolId of symbols.slice(0, 5)) {
        this.evidenceCapture.captureHotPath(
          symbolId,
          `Hot path for ${symbolId}`,
        );
      }

      const action: Action = {
        id: actionId,
        type: "getHotPath",
        status: "completed",
        input: { context },
        output: { symbolsProcessed: symbols.length },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("hotPath"),
      };
      this.actions.push(action);
      this.metrics.successfulActions++;
    } catch (error) {
      throw new Error(
        `HotPath rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeRawRung(
    _task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const action: Action = {
        id: actionId,
        type: "needWindow",
        status: "completed",
        input: { context },
        output: { message: "Raw rung would need code window access" },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: [],
      };
      this.actions.push(action);
      this.metrics.successfulActions++;
    } catch (error) {
      throw new Error(
        `Raw rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private generateActionId(): string {
    return `action-${this.actions.length}-${Date.now()}`;
  }

  getMetrics(): ExecutionMetrics {
    this.metrics.totalDurationMs = Date.now() - this.startTime;
    this.metrics.totalActions = this.actions.length;
    return this.metrics;
  }

  getActions(): Action[] {
    return this.actions;
  }

  getEvidence(): Evidence[] {
    return this.evidenceCapture.getAllEvidence();
  }

  reset(): void {
    this.evidenceCapture.reset();
    this.actions = [];
    this.metrics = {
      totalDurationMs: 0,
      totalTokens: 0,
      totalActions: 0,
      successfulActions: 0,
      failedActions: 0,
      cacheHits: 0,
    };
    this.startTime = Date.now();
  }
}
