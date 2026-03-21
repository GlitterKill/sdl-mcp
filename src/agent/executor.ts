import type {
  Action,
  AgentTask,
  Evidence,
  ExecutionMetrics,
  RungType,
} from "./types.js";
import { EvidenceCapture } from "./evidence.js";
import type {
  PolicyEngine,
  PolicyRequestContext,
  PolicyDecision,
} from "../policy/engine.js";
import { IndexError } from "../domain/errors.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { generateSkeletonIR, generateFileSkeleton } from "../code/skeleton.js";
import { extractHotPath } from "../code/hotpath.js";
import { evaluateRequest } from "../code/gate.js";
import type { CodeWindowRequest } from "../domain/types.js";
import { logger } from "../util/logger.js";

/** Injectable gate evaluator for testability. */
export type GateEvaluator = typeof evaluateRequest;

const RUNG_ESCALATION_ORDER: RungType[] = ["card", "skeleton", "hotPath", "raw"];

const MAX_CARD_SYMBOLS = 20;
const MAX_SKELETON_SYMBOLS = 5;
const MAX_HOTPATH_SYMBOLS = 5;
const MAX_RAW_SYMBOLS = 3;
const MAX_SEARCH_FALLBACK = 10;
const MAX_IDENTIFIERS = 10;
const MAX_ESCALATIONS = 2;

/** Map rung types to action type strings for error reporting. */
const RUNG_TO_ACTION_TYPE: Record<RungType, Action["type"]> = {
  card: "getCard",
  skeleton: "getSkeleton",
  hotPath: "getHotPath",
  raw: "needWindow",
};

/**
 * Common English words and SDL-MCP domain terms filtered out during
 * identifier extraction. Includes both natural-language noise words and
 * tool-specific jargon that would produce low-value hot-path matches.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was",
  "have", "has", "had", "does", "did", "will", "would", "could",
  "should", "need", "use", "used", "using", "make", "find", "found",
  "code", "file", "function", "class", "method", "implement", "fix",
  "bug", "error", "issue", "problem", "task", "work", "check",
  "symbol", "review", "analyze", "inspect", "debug", "explain",
  "context", "skeleton", "hotpath", "window", "slice", "rung",
  "look", "into", "what", "how", "why", "when", "where", "which",
  "return", "import", "export", "const", "let", "var", "type",
  "interface", "async", "await", "new", "true", "false", "null",
]);


export class Executor {
  private evidenceCapture: EvidenceCapture;
  private actions: Action[] = [];
  private metrics: ExecutionMetrics;
  private startTime = 0;
  private policyEngine: PolicyEngine | undefined;
  private policyDecisions: Map<string, PolicyDecision> = new Map();
  private gateEvaluator: GateEvaluator;
  private connPromise: ReturnType<typeof getLadybugConn> | null = null;

  constructor(policyEngine?: PolicyEngine, gateEvaluator?: GateEvaluator) {
    this.evidenceCapture = new EvidenceCapture();
    this.policyEngine = policyEngine;
    this.gateEvaluator = gateEvaluator ?? evaluateRequest;
    this.metrics = {
      totalDurationMs: 0,
      totalTokens: 0,
      totalActions: 0,
      successfulActions: 0,
      failedActions: 0,
      cacheHits: 0,
    };
  }

  private getConn(): ReturnType<typeof getLadybugConn> {
    if (!this.connPromise) {
      this.connPromise = getLadybugConn();
    }
    return this.connPromise;
  }

  async execute(
    task: AgentTask,
    rungs: RungType[],
    context: string[],
  ): Promise<{
    actions: Action[];
    evidence: Evidence[];
    success: boolean;
  }> {
    this.startTime = Date.now();
    const mutableRungs = [...rungs];
    let escalationCount = 0;

    for (let i = 0; i < mutableRungs.length; i++) {
      const rung = mutableRungs[i];
      const evidenceBefore = this.evidenceCapture.getAllEvidence().length;

      await this.executeRung(task, rung, context);

      const evidenceAfter = this.evidenceCapture.getAllEvidence().length;

      // Escalation: if this rung produced no new evidence and it's the
      // *terminal* rung in the current plan, dynamically append the next
      // rung from the ladder. Bounded by MAX_ESCALATIONS to prevent
      // runaway expansion. Non-terminal rungs never trigger escalation —
      // only the final planned rung is checked.
      if (
        evidenceAfter === evidenceBefore &&
        i === mutableRungs.length - 1 &&
        escalationCount < MAX_ESCALATIONS
      ) {
        const nextRung = this.getNextEscalationRung(rung, mutableRungs);
        if (nextRung) {
          mutableRungs.push(nextRung);
          escalationCount++;
          logger.debug("Escalating to next rung due to empty evidence", {
            currentRung: rung,
            nextRung,
            escalationCount,
            maxEscalations: MAX_ESCALATIONS,
          });
        }
      }

      // Check budget constraints
      if (
        task.budget?.maxActions &&
        this.actions.length >= task.budget.maxActions
      ) {
        break;
      }
    }

    this.metrics.totalDurationMs = Date.now() - this.startTime;
    this.metrics.totalActions = this.actions.length;

    return {
      actions: this.actions,
      evidence: this.evidenceCapture.getAllEvidence(),
      success: this.metrics.failedActions === 0,
    };
  }

  private getNextEscalationRung(
    currentRung: RungType,
    existingRungs: RungType[],
  ): RungType | undefined {
    const currentIndex = RUNG_ESCALATION_ORDER.indexOf(currentRung);
    if (currentIndex < 0 || currentIndex >= RUNG_ESCALATION_ORDER.length - 1) {
      return undefined;
    }
    const next = RUNG_ESCALATION_ORDER[currentIndex + 1];
    return existingRungs.includes(next) ? undefined : next;
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
          throw new IndexError(`Unknown rung type: ${rung}`);
      }
    } catch (error) {
      const action: Action = {
        id: this.generateActionId(),
        type: RUNG_TO_ACTION_TYPE[rung] ?? "analyze",
        status: "failed",
        input: { rung, context },
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        durationMs: 0,
        evidence: [],
      };
      this.actions.push(action);
      this.metrics.failedActions++;
      logger.debug("Rung execution failed, continuing to next rung", {
        rung,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolve file: context entries to symbol IDs by querying the DB.
   */
  private async resolveFileSymbols(
    filePaths: string[],
    repoId: string,
  ): Promise<string[]> {
    const conn = await this.getConn();

    const results = await Promise.all(
      filePaths.map(async (relPath) => {
        try {
          const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
          if (file) {
            const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
            return symbols.slice(0, 50).map((sym) => sym.symbolId);
          }
        } catch (err) {
          logger.debug("Failed to resolve symbols for file", {
            relPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return [];
      }),
    );

    return results.flat();
  }

  /**
   * Extract symbol IDs and file paths from context entries,
   * resolving file: entries to their constituent symbol IDs.
   */
  private async resolveContextToSymbols(
    context: string[],
    repoId: string,
  ): Promise<{ symbolIds: string[]; filePaths: string[] }> {
    const directSymbols = context
      .filter((c) => c.startsWith("symbol:"))
      .map((s) => s.slice("symbol:".length));

    const filePaths = context
      .filter((c) => c.startsWith("file:"))
      .map((f) => f.slice("file:".length));

    let resolvedSymbols: string[] = [];
    if (filePaths.length > 0) {
      resolvedSymbols = await this.resolveFileSymbols(filePaths, repoId);
    }

    const symbolIds = [...new Set([...directSymbols, ...resolvedSymbols])];
    return { symbolIds, filePaths };
  }

  private async executeCardRung(
    task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: allSymbols } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      // Fallback: search by task text if no symbols found
      if (allSymbols.length === 0) {
        const conn = await this.getConn();
        const searchResults = await ladybugDb.searchSymbols(
          conn,
          task.repoId,
          task.taskText,
          MAX_SEARCH_FALLBACK,
        );
        for (const result of searchResults) {
          allSymbols.push(result.symbolId);
        }
      }

      if (allSymbols.length === 0) {
        this.evidenceCapture.captureSearchResult(task.taskText, 0);
      } else {
        // Fetch real symbol data from DB
        const conn = await this.getConn();
        const symbolMap = await ladybugDb.getSymbolsByIds(
          conn,
          allSymbols.slice(0, MAX_CARD_SYMBOLS),
        );

        for (const [, sym] of symbolMap) {
          const parts: string[] = [`${sym.kind} ${sym.name}`];
          if (sym.signatureJson) {
            try {
              const sig = JSON.parse(sym.signatureJson);
              if (sig.text) parts.push(`sig: ${sig.text}`);
            } catch { /* ignore parse errors */ }
          }
          if (sym.summary) parts.push(sym.summary);
          this.evidenceCapture.captureSymbolCard(
            sym.symbolId,
            parts.join(" | "),
          );
        }
      }

      const action: Action = {
        id: actionId,
        type: "getCard",
        status: allSymbols.length > 0 ? "completed" : "failed",
        input: { context },
        output: { cardsProcessed: allSymbols.length },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: [
          ...this.evidenceCapture.getEvidenceByType("symbolCard"),
          ...this.evidenceCapture.getEvidenceByType("searchResult"),
        ],
      };
      this.actions.push(action);
      if (allSymbols.length > 0) {
        this.metrics.successfulActions++;
      } else {
        this.metrics.failedActions++;
      }
    } catch (error) {
      throw new IndexError(
        `Card rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeSkeletonRung(
    task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds, filePaths } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      let processedCount = 0;

      // Generate skeletons for symbol IDs
      for (const symbolId of symbolIds.slice(0, MAX_SKELETON_SYMBOLS)) {
        try {
          const result = await generateSkeletonIR(
            task.repoId,
            symbolId,
            {},
          );
          if (result) {
            this.evidenceCapture.captureSkeleton(
              symbolId,
              `Skeleton (${result.originalLines} lines, ~${result.estimatedTokens} tokens): ${result.skeletonText.slice(0, 200)}`,
            );
            processedCount++;
          }
        } catch (err) {
          logger.debug("Failed to generate skeleton for symbol", {
            symbolId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Generate file-level skeletons for file paths
      for (const filePath of filePaths.slice(0, MAX_SKELETON_SYMBOLS)) {
        try {
          const result = await generateFileSkeleton(
            task.repoId,
            filePath,
            false,
            {},
          );
          if (result) {
            this.evidenceCapture.captureSkeleton(
              filePath,
              `File skeleton (${result.originalLines} lines, ~${result.estimatedTokens} tokens): ${result.skeleton.slice(0, 200)}`,
            );
            processedCount++;
          }
        } catch (err) {
          logger.debug("Failed to generate skeleton for file", {
            filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const action: Action = {
        id: actionId,
        type: "getSkeleton",
        status: processedCount > 0 ? "completed" : "failed",
        input: { context },
        output: { filesProcessed: processedCount },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("skeleton"),
      };
      this.actions.push(action);
      if (processedCount > 0) {
        this.metrics.successfulActions++;
      } else {
        this.metrics.failedActions++;
      }
    } catch (error) {
      throw new IndexError(
        `Skeleton rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeHotPathRung(
    task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: symbols } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      // Extract identifiers from task text for hot-path search
      const identifiers = this.extractIdentifiersFromTask(task);

      let processedCount = 0;

      for (const symbolId of symbols.slice(0, MAX_HOTPATH_SYMBOLS)) {
        try {
          const result = await extractHotPath(
            task.repoId,
            symbolId,
            identifiers,
            {},
          );
          if (result) {
            this.evidenceCapture.captureHotPath(
              symbolId,
              `Hot path (${result.matchedIdentifiers.length} matches, ~${result.estimatedTokens} tokens): ${result.excerpt.slice(0, 200)}`,
            );
            processedCount++;
          }
        } catch (err) {
          logger.debug("Failed to extract hot path for symbol", {
            symbolId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const action: Action = {
        id: actionId,
        type: "getHotPath",
        status: processedCount > 0 ? "completed" : "failed",
        input: { context },
        output: { symbolsProcessed: processedCount },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("hotPath"),
      };
      this.actions.push(action);
      if (processedCount > 0) {
        this.metrics.successfulActions++;
      } else {
        this.metrics.failedActions++;
      }
    } catch (error) {
      throw new IndexError(
        `HotPath rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeRawRung(
    task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: symbols } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );
      const identifiers = this.extractIdentifiersFromTask(task);

      let processedCount = 0;

      for (const symbolId of symbols.slice(0, MAX_RAW_SYMBOLS)) {
        // Check top-level policy deny. Finer-grained downgrades
        // (downgrade-to-skeleton, downgrade-to-hotpath) are enforced by
        // the gate evaluator (evaluateRequest) rather than the executor,
        // so only an explicit "deny" is blocked here.
        let rawAccessAllowed = true;

        if (this.policyEngine) {
          const policyContext: PolicyRequestContext = {
            requestType: "codeWindow",
            repoId: task.repoId,
            symbolId,
          };

          const policyDecision = this.policyEngine.evaluate(policyContext);
          this.policyDecisions.set(`${actionId}:${symbolId}`, policyDecision);

          if (policyDecision.decision === "deny") {
            rawAccessAllowed = false;
            this.evidenceCapture.captureDiagnostic(
              symbolId,
              0,
              `Raw code access denied by policy: ${policyDecision.deniedReasons?.join(", ") ?? "no reason"}`,
            );
          }
        }

        if (rawAccessAllowed) {
          try {
            const request: CodeWindowRequest = {
              repoId: task.repoId,
              symbolId,
              reason: `Raw code access for ${task.taskType} task: ${task.taskText.slice(0, 100)}`,
              expectedLines: 180,
              identifiersToFind: identifiers,
            };
            const response = await this.gateEvaluator(request, {});
            if (response.approved) {
              const lineCount =
                response.range.endLine - response.range.startLine + 1;
              this.evidenceCapture.captureCodeWindow(
                response.file,
                lineCount,
                `Code window (${lineCount} lines, ~${response.estimatedTokens} tokens): ${response.code.slice(0, 200)}`,
              );
              processedCount++;
            } else {
              this.evidenceCapture.captureDiagnostic(
                symbolId,
                0,
                `Code window denied: ${response.whyDenied.join(", ")}`,
              );
            }
          } catch (err) {
            logger.debug("Failed to extract code window", {
              symbolId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const action: Action = {
        id: actionId,
        type: "needWindow",
        status: processedCount > 0 ? "completed" : "failed",
        input: { context },
        output: {
          symbolsProcessed: processedCount,
          ...(symbols.length === 0 ? { reason: "no symbols in context" } : {}),
        },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: this.evidenceCapture.getEvidenceByType("codeWindow"),
      };
      this.actions.push(action);
      if (action.status === "completed") {
        this.metrics.successfulActions++;
      } else {
        this.metrics.failedActions++;
      }
    } catch (error) {
      throw new IndexError(
        `Raw rung execution failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Extract potential identifiers from task text for hot-path searching.
   */
  private extractIdentifiersFromTask(task: AgentTask): string[] {
    const identifiers: string[] = [];

    // Bound input length to avoid slow regex on very long task text
    const text = task.taskText.slice(0, 2000);

    // Prefer camelCase/PascalCase words (likely code identifiers).
    // camelCase regex: lowercase→uppercase transition (e.g. handleRequest).
    // Multi-segment PascalCase: Uppercase→lowercase→Uppercase (e.g. IndexError).
    const camelCase = text.match(/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) ?? [];
    const pascalCase = text.match(/[A-Z][a-z]+[A-Z][a-zA-Z0-9]*/g) ?? [];
    identifiers.push(...camelCase, ...pascalCase);

    // Single-word PascalCase names (6+ chars to reduce false positives on
    // common English words like "The", "When"). Catches class names like
    // Executor, Planner, Parser that the multi-segment regex misses.
    const singlePascal = text.match(/\b[A-Z][a-z]{5,}[a-zA-Z0-9]*\b/g) ?? [];
    identifiers.push(
      ...singlePascal.filter((w) => !STOP_WORDS.has(w.toLowerCase())),
    );

    // Also grab snake_case identifiers
    const snakeCase = text.match(/[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+/g) ?? [];
    identifiers.push(...snakeCase);

    // Use symbol names from evidence already captured (card rung runs first)
    const cardEvidence = this.evidenceCapture.getEvidenceByType("symbolCard");
    for (const e of cardEvidence.slice(0, 5)) {
      // Extract the symbol name from evidence summary (format: "kind name | ...")
      const nameMatch = e.summary.match(/^\w+\s+(\w+)/);
      if (nameMatch) {
        identifiers.push(nameMatch[1]);
      }
    }

    // Always run fallback to catch remaining identifiers (3+ chars, not common).
    // Deduplication via Set at the end ensures no bloat from overlapping passes.
    const words = text.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) ?? [];
    identifiers.push(
      ...words.filter((w) => !STOP_WORDS.has(w.toLowerCase())),
    );

    return [...new Set(identifiers)].slice(0, MAX_IDENTIFIERS);
  }

  private generateActionId(): string {
    return `action-${this.actions.length}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Returns a frozen snapshot of execution metrics computed at the end of
   * the most recent `execute()` call. Calling this during execution will
   * return stale data — use only after `execute()` resolves.
   */
  getMetrics(): ExecutionMetrics {
    return { ...this.metrics };
  }

  getNextBestAction(): string | undefined {
    const lastAction = this.actions[this.actions.length - 1];
    if (!lastAction) return undefined;

    if (lastAction.status === "failed") {
      return "retryWithDifferentInputs";
    }

    const evidenceCount = this.evidenceCapture.getAllEvidence().length;
    if (evidenceCount === 0) {
      return "expandSearchScope";
    }

    return undefined;
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
    this.startTime = 0;
    this.policyDecisions.clear();
    // connPromise references a shared pool connection from getLadybugConn();
    // dropping the reference is safe — the pool manages connection lifecycle.
    this.connPromise = null;
  }
}
