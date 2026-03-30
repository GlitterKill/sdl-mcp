import type {
  AgentTask,
  Evidence,
  Action,
  ContextResult,
  PlannedExecution,
} from "./types.js";
import { Planner } from "./planner.js";
import { Executor } from "./executor.js";
import { PolicyEngine } from "../policy/engine.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { ValidationError } from "../domain/errors.js";
import { logger } from "../util/logger.js";
import { entitySearch } from "../retrieval/index.js";
import { extractIdentifiersFromText } from "./executor.js";
import { searchSymbols } from "../db/ladybug-queries.js";
import { queryFeedbackBoosts } from "../retrieval/feedback-boost.js";
import { classifySymptomType } from "../retrieval/evidence.js";
import { randomUUID } from "node:crypto";

const HANDLED_EVIDENCE_TYPES = new Set([
  "symbolCard", "skeleton", "hotPath", "codeWindow", "diagnostic", "searchResult",
]);

export class ContextEngine {
  private planner: Planner;
  private policyEngine: PolicyEngine;

  constructor() {
    this.planner = new Planner();
    this.policyEngine = new PolicyEngine();
  }

  async buildContext(task: AgentTask): Promise<ContextResult> {
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
      let context = await this.planner.selectContext(task);

      // When no explicit focusSymbols/focusPaths were provided, use entity retrieval
      // to seed the context with relevant symbols, clusters, and processes.
      const hasExplicitContext = context.length > 0;
      if (!hasExplicitContext && task.taskText) {
        try {
          const entityResult = await entitySearch({
            repoId: task.repoId,
            query: task.taskText,
            limit: 20,
            entityTypes: ["symbol", "cluster", "process"],
            includeEvidence: false,
          });
          if (entityResult.results.length > 0) {
            const symbolIds = entityResult.results
              .filter((r) => r.entityType === "symbol")
              .map((r) => `symbol:${r.entityId}`);
            const clusterIds = entityResult.results
              .filter((r) => r.entityType === "cluster")
              .map((r) => `cluster:${r.entityId}`);
            const processIds = entityResult.results
              .filter((r) => r.entityType === "process")
              .map((r) => `process:${r.entityId}`);
            context = [...symbolIds, ...clusterIds, ...processIds];
            logger.debug("Entity retrieval seeded task context", {
              repoId: task.repoId,
              symbolCount: symbolIds.length,
              clusterCount: clusterIds.length,
              processCount: processIds.length,
            });
          }
        } catch (err) {
          logger.debug(
            "Entity retrieval for task context failed; proceeding with empty context",
            { repoId: task.repoId, error: err },
          );
        }

        // FP1: Keyword fallback when entity search returns empty context
        if (context.length === 0) {
          try {
            const conn = await getLadybugConn();
            const terms = extractIdentifiersFromText(task.taskText);
            const seen = new Set();
            for (const term of terms.slice(0, 5)) {
              const results = await searchSymbols(conn, task.repoId, term, 5);
              for (const r of results) {
                if (!seen.has(r.symbolId)) {
                  seen.add(r.symbolId);
                  context.push(`symbol:${r.symbolId}`);
                }
              }
            }
            if (context.length > 0) {
              logger.debug("Keyword fallback seeded task context", {
                repoId: task.repoId,
                terms: terms.slice(0, 5),
                symbolCount: context.length,
              });
            }
          } catch (err) {
            logger.debug("Keyword fallback for context seeding failed (non-fatal)", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Feedback-aware boosting: query prior feedback for similar tasks
      // and add historically useful symbols to the context.
      if (task.taskText) {
        try {
          const conn = await getLadybugConn();
          const { boosts } = await queryFeedbackBoosts(conn, {
            repoId: task.repoId,
            query: task.taskText,
            limit: 10,
          });

          if (boosts.size > 0) {
            // Add boosted symbols not already in context
            for (const [symbolId] of boosts) {
              const contextKey = `symbol:${symbolId}`;
              if (!context.includes(contextKey)) {
                context.push(contextKey);
              }
            }
            logger.debug("Feedback boost added symbols to task context", {
              repoId: task.repoId,
              symbolsBoosted: boosts.size,
            });
          }
        } catch (err) {
          logger.debug(
            `[context-engine] Feedback boost failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const { expandedContext, clusterExpandedCount } =
        await this.expandContextForClusters(context, task.taskText);

      const executor = new Executor(this.policyEngine);
      const { actions, evidence, success } = await executor.execute(
        task,
        path.rungs,
        expandedContext,
      );

      const metrics = executor.getMetrics();
      const nextBestAction = executor.getNextBestAction();

      // Precise mode: return evidence + lightweight metadata.
      // actionsTaken and summary are always populated — they are the most
      // useful fields for agent consumers.  Only answer, nextBestAction,
      // and retrievalEvidence are stripped in precise mode.
      const isPrecise = task.options?.contextMode === 'precise';

      if (isPrecise) {
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
        };
      }

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
        retrievalEvidence: {
          // The context tool only has taskText available (no stackTrace,
          // failingTestPath, or editedFiles), so symptomType will always be
          // "taskText" here. This is by design — richer classification is
          // available in slice.build where all input fields exist.
          symptomType: classifySymptomType({
            taskText: task.taskText,
          }),
        },
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
    return `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }

  private generateSummary(
    task: AgentTask,
    actions: Action[],
    evidence: Evidence[],
    success: boolean,
    extra: { clusterExpandedCount: number } = { clusterExpandedCount: 0 },
  ): string {
    const status = success ? "completed successfully" : "completed with errors";
    const clusterNote =
      extra.clusterExpandedCount > 0
        ? ` (expanded ${extra.clusterExpandedCount} symbols via cluster analysis)`
        : "";

    const parts: string[] = [
      `Task "${task.taskType}" ${status}. Executed ${actions.length} action(s), collected ${evidence.length} evidence item(s).${clusterNote}`,
    ];

    // Append per-action details: rung, symbol/file, tokens, duration
    if (actions.length > 0) {
      const actionLines = actions.map((a) => {
        const sym = typeof a.input?.context === "object" && Array.isArray(a.input.context)
          ? (a.input.context as string[]).slice(0, 3).join(", ")
          : undefined;
        const ref = sym ? ` [${sym}]` : "";
        return `- ${a.type} (${a.status}, ${a.durationMs}ms)${ref}`;
      });
      parts.push("Actions: " + actionLines.join("; "));
    }

    // Build a readable paragraph from evidence summaries
    if (evidence.length > 0) {
      const seen = new Set<string>();
      const snippets: string[] = [];
      for (const e of evidence) {
        if (!e.summary || seen.has(e.summary)) continue;
        seen.add(e.summary);
        snippets.push(e.summary);
      }
      if (snippets.length > 0) {
        parts.push("Findings: " + snippets.join(". "));
      }
    }

    return parts.join(" ");
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

    // Add task question as context
    if (task.taskText) {
      sections.push(`> **Query:** ${task.taskText}`);
    }

    // Synthesize brief intro
    const cardCount = evidence.filter(e => e.type === "symbolCard").length;
    const skeletonCount = evidence.filter(e => e.type === "skeleton").length;
    const hotPathCount = evidence.filter(e => e.type === "hotPath").length;
    const introParts: string[] = [];
    if (cardCount > 0) introParts.push(`${cardCount} symbol(s)`);
    if (skeletonCount > 0) introParts.push(`${skeletonCount} skeleton(s)`);
    if (hotPathCount > 0) introParts.push(`${hotPathCount} hot path(s)`);
    if (introParts.length > 0) {
      sections.push(`Found ${introParts.join(", ")} relevant to this ${task.taskType} task.`);
    }

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
  ): ContextResult {
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
    taskText?: string,
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

      const cappedClusterIds = Array.from(clusterIds).slice(0, 10);
      const memberLists = await Promise.all(
        cappedClusterIds.map((clusterId) =>
          ladybugDb.getClusterMembers(conn, clusterId),
        ),
      );

      // Build task keyword set for relevance filtering
      const taskKeywords = new Set<string>();
      if (taskText) {
        for (const word of taskText.toLowerCase().split(/\W+/)) {
          if (word.length >= 3) taskKeywords.add(word);
        }
      }

      // Collect all candidate member symbolIds to fetch names for filtering
      const candidateIds: string[] = [];
      const already = new Set(context);
      for (const members of memberLists) {
        for (const m of members) {
          const ref = `symbol:${m.symbolId}`;
          if (already.has(ref)) continue;
          candidateIds.push(m.symbolId);
        }
      }

      // If we have task keywords, fetch symbol names for relevance filtering
      let nameMap: Map<string, { name: string; kind: string }> | null = null;
      if (taskKeywords.size > 0 && candidateIds.length > 0) {
        nameMap = await ladybugDb.getSymbolsByIdsLite(conn, candidateIds);
      }

      const additional: string[] = [];

      for (const members of memberLists) {
        for (const m of members) {
          const ref = `symbol:${m.symbolId}`;
          if (already.has(ref)) continue;

          // When task keywords are available, only add members whose name
          // has at least one overlapping keyword with the task text.
          if (nameMap && taskKeywords.size > 0) {
            const info = nameMap.get(m.symbolId);
            if (info) {
              const nameLower = info.name.toLowerCase();
              const isRelevant = Array.from(taskKeywords).some(
                (kw) => nameLower.includes(kw) || kw.includes(nameLower),
              );
              if (!isRelevant) continue;
            } else {
              // Symbol not in nameMap and keywords exist — skip (relevance unknown)
              continue;
            }
          }

          additional.push(ref);
          already.add(ref);
        }
        if (additional.length >= 10) break;
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

export const contextEngine = new ContextEngine();
