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
import { classifySymptomType } from "../retrieval/evidence.js";
import { estimateTokens } from "../util/tokenize.js";
import { BROAD_VISIBLE_FIELDS } from "../mcp/context-response-projection.js";
import {
  buildSeedContext,
  seedResultToContext,
  inferFocusPathsFromTaskText,
} from "./context-seeding.js";
import { randomUUID } from "node:crypto";

const HANDLED_EVIDENCE_TYPES = new Set([
  "symbolCard",
  "skeleton",
  "hotPath",
  "codeWindow",
  "diagnostic",
  "searchResult",
]);

/** Hard safety cap for broad-mode responses regardless of budget. */
const MAX_CONTEXT_RESPONSE_TOKENS = 50_000;

/** Behavioral symbol kinds that get a scoring bonus in cluster expansion. */
const BEHAVIORAL_KINDS = new Set([
  "function",
  "method",
  "class",
  "constructor",
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
      // Infer focus paths from task text when none are explicitly provided.
      // This dramatically improves symbol discovery for natural language queries
      // like "how does beam search work" or "debug skeleton IR parameters".
      const hasExplicitScope = !!(
        task.options?.focusPaths?.length || task.options?.focusSymbols?.length
      );
      if (!hasExplicitScope && task.taskText) {
        const inferred = inferFocusPathsFromTaskText(task.taskText);
        if (inferred.length > 0) {
          task = {
            ...task,
            options: {
              ...task.options,
              focusPaths: inferred,
            },
          };
          logger.debug("Inferred focus paths from task text", {
            repoId: task.repoId,
            inferredPaths: inferred,
            taskText: task.taskText.slice(0, 100),
          });
        }
      }

      // Plan WITHOUT inferred paths — inferred paths should only affect
      // context selection, not rung escalation. Otherwise broad-mode tasks
      // silently get extra rungs (hotPath) just because keywords matched.
      // NOTE: This means broad-mode review tasks with inferred scope get
      // ["card", "skeleton"] instead of ["card", "skeleton", "hotPath"]
      // because planReview only adds hotPath when focusPaths are present.
      // This is intentional: phantom rung escalation from keyword matching
      // is worse than occasionally missing hotPath for inferred scopes.
      const planTask = hasExplicitScope
        ? task
        : {
            ...task,
            options: {
              ...task.options,
              focusPaths: undefined,
              focusSymbols: undefined,
            },
          };
      const path = this.planner.plan(planTask);
      let context = await this.planner.selectContext(task);

      // If selectContext returned context (from user-provided or inferred
      // paths), seeding is unnecessary — the context is already populated.
      const hasExplicitContext = context.length > 0;
      if (!hasExplicitContext && task.taskText) {
        try {
          const seedResult = await this.seedContext(task);
          context = seedResultToContext(seedResult);
          logger.debug("Semantic-first seeding completed", {
            repoId: task.repoId,
            semantic: seedResult.sources.semantic,
            lexical: seedResult.sources.lexical,
            feedback: seedResult.sources.feedback,
            total: context.length,
          });
        } catch (err) {
          logger.debug("Context seeding failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const { expandedContext, clusterExpandedCount } =
        await this.expandContextForClusters(
          context,
          task.taskText,
          task.options?.contextMode,
        );

      // Graph neighbor expansion: follow call/import edges from top-seeded
      // symbols to discover closely related code that keyword search misses.
      const finalContext = await this.expandContextByEdges(
        expandedContext,
        task.options?.contextMode,
      );

      const executor = new Executor(this.policyEngine);
      const { actions, evidence, success } = await executor.execute(
        task,
        path.rungs,
        finalContext,
      );

      const metrics = executor.getMetrics();
      const nextBestAction = executor.getNextBestAction();

      // Precise mode: return evidence + lightweight metadata.
      // actionsTaken and summary are always populated — they are the most
      // useful fields for agent consumers.  Only answer, nextBestAction,
      // and retrievalEvidence are stripped in precise mode.
      const isPrecise = task.options?.contextMode === "precise";

      if (isPrecise) {
        return {
          taskId,
          taskType: task.taskType,
          actionsTaken: actions.map((a) => ({
            ...a,
            evidence: [],
            evidenceCount: a.evidence?.length ?? 0,
          })),
          path,
          contextModeHint:
            "precise: Returns focused evidence with minimal metadata. Use for targeted lookups when you know what you're looking for.",
          finalEvidence: evidence,
          summary: this.generateSummary(task, actions, evidence, success, {
            clusterExpandedCount,
          }),
          success,
          metrics,
        };
      }

      const result: ContextResult = {
        taskId,
        taskType: task.taskType,
        actionsTaken: actions.map((a) => ({
          ...a,
          evidence: [],
          evidenceCount: a.evidence?.length ?? 0,
        })),
        path,
        contextModeHint:
          "broad: Expands context via cluster relationships and graph edges. Returns answer, nextBestAction, and retrievalEvidence. Use for exploratory tasks.",
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

      // Guard against oversized broad-mode responses that can overflow
      // MCP response limits (observed 136K+ chars in production).
      return this.truncateIfOverBudget(result, task.budget?.maxTokens);
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
        const sym =
          typeof a.input?.context === "object" && Array.isArray(a.input.context)
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

    return parts.join("\n\n");
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

    const taskLabel =
      task.taskType.charAt(0).toUpperCase() + task.taskType.slice(1);
    const sections: string[] = [`# ${taskLabel} Results`];

    // Add task question as context
    if (task.taskText) {
      sections.push(`> **Query:** ${task.taskText}`);
    }

    // Synthesize brief intro
    const cardCount = evidence.filter((e) => e.type === "symbolCard").length;
    const skeletonCount = evidence.filter((e) => e.type === "skeleton").length;
    const hotPathCount = evidence.filter((e) => e.type === "hotPath").length;
    const introParts: string[] = [];
    if (cardCount > 0) introParts.push(`${cardCount} symbol(s)`);
    if (skeletonCount > 0) introParts.push(`${skeletonCount} skeleton(s)`);
    if (hotPathCount > 0) introParts.push(`${hotPathCount} hot path(s)`);
    if (introParts.length > 0) {
      sections.push(
        `Found ${introParts.join(", ")} relevant to this ${task.taskType} task.`,
      );
    }

    if (!success) {
      sections.push(
        "> **Note:** Task completed with errors. Some rungs failed \u2014 see Diagnostics below.",
      );
    }

    // Symbol cards section — concise: count + top 5 only
    const cards = byType.get("symbolCard");
    if (cards && cards.length > 0) {
      const topCards = cards.slice(0, 5);
      const overflow =
        cards.length > 5
          ? "\n- ... and " + (cards.length - 5) + " more (see finalEvidence)"
          : "";
      sections.push(
        `## Symbols (${cards.length})\n` +
          topCards.map((c) => `- ${c.summary}`).join("\n") +
          overflow,
      );
    }

    // Skeleton section — reference only, full content is in finalEvidence
    const skeletons = byType.get("skeleton");
    if (skeletons && skeletons.length > 0) {
      sections.push(
        "Includes " +
          skeletons.length +
          " skeleton(s) — see finalEvidence for details.",
      );
    }

    // Hot path section — reference only, full content is in finalEvidence
    const hotPaths = byType.get("hotPath");
    if (hotPaths && hotPaths.length > 0) {
      sections.push(
        "Includes " +
          hotPaths.length +
          " hot path(s) — see finalEvidence for details.",
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

  /**
   * Compact a broad-mode result to only model-visible fields.
   * Uses the same allowlist as server-side projection so the projection
   * becomes a no-op for already-compact payloads.
   */
  private compactBroadResult(result: ContextResult): ContextResult {
    const compact: Record<string, unknown> = {};
    const source = result as unknown as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (BROAD_VISIBLE_FIELDS.has(key)) {
        compact[key] = source[key];
      }
    }
    return compact as unknown as ContextResult;
  }

  /**
   * Enforce token budget on broad-mode responses.
   *
   * 1. Compact to model-visible fields first (drops actionsTaken, path, metrics, etc.).
   * 2. Progressively trim finalEvidence, then actionsTaken, then answer length.
   * 3. **Never fully remove `answer` on a successful result** — the answer is the
   *    primary value of a broad-mode response.
   */
  private truncateIfOverBudget(
    result: ContextResult,
    budgetMaxTokens?: number,
  ): ContextResult {
    const effectiveCap = Math.min(
      budgetMaxTokens ?? MAX_CONTEXT_RESPONSE_TOKENS,
      MAX_CONTEXT_RESPONSE_TOKENS,
    );

    // Phase 0: Compact to model-visible fields before measuring tokens.
    // This runs on both success and error results — error results also
    // carry an answer field that should be preserved in compact form.
    result = this.compactBroadResult(result);

    const serialized = JSON.stringify(result);
    const originalTokens = estimateTokens(serialized);

    if (originalTokens <= effectiveCap) {
      return result;
    }

    logger.debug("Broad-mode response exceeds token budget; truncating", {
      originalTokens,
      effectiveCap,
    });

    const fieldsAffected: string[] = [];

    // Phase 1: Trim finalEvidence — keep first N items that fit
    let currentTokens = originalTokens;
    if (result.finalEvidence.length > 0) {
      const targetEvidenceCount = Math.max(
        1,
        Math.floor(
          result.finalEvidence.length * (effectiveCap / currentTokens),
        ),
      );
      if (targetEvidenceCount < result.finalEvidence.length) {
        result = {
          ...result,
          finalEvidence: result.finalEvidence.slice(0, targetEvidenceCount),
        };
        fieldsAffected.push("finalEvidence");
      }
    }

    // Check after phase 1
    currentTokens = estimateTokens(JSON.stringify(result));
    if (currentTokens <= effectiveCap) {
      result.truncation = {
        originalTokens,
        truncatedTokens: currentTokens,
        fieldsAffected,
      };
      return result;
    }

    // Phase 2: Trim actionsTaken — keep first N items
    if (result.actionsTaken && result.actionsTaken.length > 0) {
      const targetActionCount = Math.max(
        1,
        Math.floor(result.actionsTaken.length * (effectiveCap / currentTokens)),
      );
      if (targetActionCount < result.actionsTaken.length) {
        result = {
          ...result,
          actionsTaken: result.actionsTaken.slice(0, targetActionCount),
        };
        fieldsAffected.push("actionsTaken");
      }
    }

    // Check after phase 2
    currentTokens = estimateTokens(JSON.stringify(result));
    if (currentTokens <= effectiveCap) {
      result.truncation = {
        originalTokens,
        truncatedTokens: currentTokens,
        fieldsAffected,
      };
      return result;
    }

    // Phase 3: Truncate answer length but NEVER remove it on successful results.
    // The answer is the primary value of a broad-mode response.
    if (result.answer) {
      const halfBudgetChars = Math.floor((effectiveCap / 2) * 3.5); // rough token-to-char
      if (result.answer.length > halfBudgetChars) {
        result = {
          ...result,
          answer:
            result.answer.slice(0, halfBudgetChars) + "\n\n[answer truncated]",
        };
        if (!fieldsAffected.includes("answer")) fieldsAffected.push("answer");
      }
    }

    const truncatedTokens = estimateTokens(JSON.stringify(result));
    result.truncation = { originalTokens, truncatedTokens, fieldsAffected };
    return result;
  }

  /**
   * Delegate to the seeding pipeline.
   * Extracted as a private method so tests can mock it via prototype.
   */
  private async seedContext(task: AgentTask) {
    return buildSeedContext(task);
  }

  /**
   * Expand context with graph-guided cluster member selection.
   *
   * Instead of keyword-filtering cluster members by name overlap, this
   * scores candidates by graph proximity to the already-selected context
   * symbols and applies a diversity pass so broad mode covers distinct
   * neighborhoods rather than near-duplicates.
   *
   * Caps:
   * - precise: max 4 added symbols total
   * - broad:   max 10 added symbols total
   * - per cluster: max 3
   */
  private async expandContextForClusters(
    context: string[],
    _taskText?: string, // kept for call-site compat; keyword filtering replaced by graph scoring
    contextMode?: string,
  ): Promise<{ expandedContext: string[]; clusterExpandedCount: number }> {
    const symbolIds = context
      .filter((c) => c.startsWith("symbol:"))
      .map((s) => s.slice("symbol:".length))
      .filter(Boolean);

    if (symbolIds.length === 0) {
      return { expandedContext: context, clusterExpandedCount: 0 };
    }

    const isPrecise = contextMode === "precise";
    const MAX_TOTAL = isPrecise ? 4 : 10;
    const MAX_PER_CLUSTER = 3;

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
      const memberLists = [];
      for (const clusterId of cappedClusterIds) {
        memberLists.push(await ladybugDb.getClusterMembers(conn, clusterId));
      }

      // Collect candidate IDs (not already in context)
      const already = new Set(context);
      const candidateIds: string[] = [];
      const candidateCluster = new Map<string, string>(); // symbolId -> clusterId
      for (let ci = 0; ci < memberLists.length; ci++) {
        const clusterId = cappedClusterIds[ci]!;
        for (const m of memberLists[ci]!) {
          const ref = `symbol:${m.symbolId}`;
          if (already.has(ref)) continue;
          if (!candidateCluster.has(m.symbolId)) {
            candidateIds.push(m.symbolId);
            candidateCluster.set(m.symbolId, clusterId);
          }
        }
      }

      if (candidateIds.length === 0) {
        return { expandedContext: context, clusterExpandedCount: 0 };
      }

      // Score candidates by graph proximity: count edges connecting to
      // already-selected context symbols.
      const anchorSet = new Set(symbolIds);
      const edgeMap = await ladybugDb.getEdgesFromSymbolsLite(
        conn,
        candidateIds,
      );

      // Also fetch name/kind for behavioral-kind bonus
      const nameMap = await ladybugDb.getSymbolsByIdsLite(conn, candidateIds);

      const scored: Array<{
        symbolId: string;
        clusterId: string;
        score: number;
      }> = [];
      for (const cid of candidateIds) {
        const edges = edgeMap.get(cid) ?? [];
        let score = 0;

        // Graph proximity: +3 for each edge connecting to an anchor symbol
        for (const e of edges) {
          if (anchorSet.has(e.toSymbolId)) {
            score += e.edgeType === "call" ? 3 : 2;
          }
        }

        // Behavioral kind bonus
        const info = nameMap.get(cid);
        if (info) {
          if (BEHAVIORAL_KINDS.has(info.kind)) score += 1;
        }

        scored.push({
          symbolId: cid,
          clusterId: candidateCluster.get(cid) ?? "",
          score,
        });
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      // Diversity pass: cap per cluster, deduplicate by name within each
      // cluster, and skip duplicate file neighborhoods across clusters.
      const additional: string[] = [];
      const clusterCounts = new Map<string, number>();
      const seenNeighborhoods = new Set<string>();
      // Per-cluster name dedup: avoids dropping legitimately distinct symbols
      // with common names (handle, parse, init) across different clusters.
      const seenNamesPerCluster = new Map<string, Set<string>>();

      for (const candidate of scored) {
        if (additional.length >= MAX_TOTAL) break;

        const clCount = clusterCounts.get(candidate.clusterId) ?? 0;
        if (clCount >= MAX_PER_CLUSTER) continue;

        const info = nameMap.get(candidate.symbolId);

        // Name dedup within the same cluster only
        if (info) {
          const clusterNames =
            seenNamesPerCluster.get(candidate.clusterId) ?? new Set<string>();
          if (clusterNames.has(info.name)) continue;
          clusterNames.add(info.name);
          seenNamesPerCluster.set(candidate.clusterId, clusterNames);
        }

        // Diversity: extract a neighborhood key from the symbol's file
        if (info) {
          const relPath = info.fileId?.includes(":")
            ? info.fileId.slice(info.fileId.indexOf(":") + 1)
            : undefined;
          const neighborhood = relPath
            ? relPath.split("/").slice(0, 3).join("/")
            : candidate.symbolId;
          if (seenNeighborhoods.has(neighborhood) && additional.length > 0) {
            continue;
          }
          seenNeighborhoods.add(neighborhood);
        }

        additional.push(`symbol:${candidate.symbolId}`);
        already.add(`symbol:${candidate.symbolId}`);
        clusterCounts.set(candidate.clusterId, clCount + 1);
      }

      logger.debug("Graph-guided cluster expansion", {
        candidates: candidateIds.length,
        selected: additional.length,
        clusters: cappedClusterIds.length,
        maxTotal: MAX_TOTAL,
      });

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

  /**
   * Follow outgoing call/import edges from the top N context symbols to
   * discover closely related code that keyword/semantic search missed.
   *
   * This addresses the "follow graph edges" gap: when `buildSlice` is found
   * by search, its call edge to `beamSearch` should pull that symbol in.
   *
   * Caps: max 5 symbols from edges, only follows top 5 context symbols.
   */
  private async expandContextByEdges(
    context: string[],
    contextMode?: string,
  ): Promise<string[]> {
    const symbolIds = context
      .filter((c) => c.startsWith("symbol:"))
      .map((s) => s.slice("symbol:".length))
      .filter(Boolean);

    if (symbolIds.length === 0) return context;

    const MAX_EDGE_EXPANSION = contextMode === "precise" ? 3 : 5;
    const TOP_N_SOURCES = 5;

    try {
      const conn = await getLadybugConn();
      const topSources = symbolIds.slice(0, TOP_N_SOURCES);
      const edgeMap = await ladybugDb.getEdgesFromSymbolsLite(conn, topSources);

      const already = new Set(context);
      const candidateIds: string[] = [];

      for (const sourceId of topSources) {
        const edges = edgeMap.get(sourceId) ?? [];
        for (const e of edges) {
          const ref = `symbol:${e.toSymbolId}`;
          if (already.has(ref)) continue;
          candidateIds.push(e.toSymbolId);
          already.add(ref); // dedup across sources
        }
      }

      if (candidateIds.length === 0) return context;

      // Fetch metadata to filter and score
      const nameMap = await ladybugDb.getSymbolsByIdsLite(conn, candidateIds);

      // Collect existing context symbol names for cross-dedup
      const existingNames = new Set<string>();
      const existingLite = await ladybugDb.getSymbolsByIdsLite(conn, symbolIds);
      for (const info of existingLite.values()) {
        existingNames.add(info.name);
      }

      // Filter: skip variables/unknowns (utility noise) and name duplicates
      const EDGE_EXPANSION_KINDS = new Set([
        "function",
        "method",
        "class",
        "constructor",
        "type",
        "interface",
        "enum",
        "typeAlias",
      ]);
      const scored: Array<{ symbolId: string; weight: number }> = [];
      for (const cid of candidateIds) {
        const info = nameMap.get(cid);
        if (!info) continue;
        // Skip non-behavioral/non-declarative kinds (variables, constants, etc.)
        if (!EDGE_EXPANSION_KINDS.has(info.kind)) continue;
        // Skip if a symbol with this name is already in context
        if (existingNames.has(info.name)) continue;

        // Weight: call edges are stronger signals than import edges.
        // Look up this symbol's edge type from the source edges.
        let weight = 1;
        for (const sourceId of topSources) {
          const edges = edgeMap.get(sourceId) ?? [];
          for (const e of edges) {
            if (e.toSymbolId === cid && e.edgeType === "call") {
              weight = 3;
            }
          }
        }
        scored.push({ symbolId: cid, weight });
        existingNames.add(info.name); // prevent name dupes among candidates
      }

      if (scored.length === 0) return context;

      // Sort by weight descending, take top N
      scored.sort((a, b) => b.weight - a.weight);
      const selected = scored
        .slice(0, MAX_EDGE_EXPANSION)
        .map((c) => `symbol:${c.symbolId}`);

      logger.debug("Graph neighbor expansion", {
        sources: topSources.length,
        candidates: scored.length,
        selected: selected.length,
      });

      return [...context, ...selected];
    } catch (err) {
      logger.debug("Graph neighbor expansion failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return context;
    }
  }
}

export const contextEngine = new ContextEngine();
