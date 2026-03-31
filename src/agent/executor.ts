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
import { isHybridRetrievalAvailable } from "../retrieval/fallback.js";
import { hybridSearch } from "../retrieval/orchestrator.js";
import { queryFeedbackBoosts } from "../retrieval/feedback-boost.js";
import { randomUUID } from "node:crypto";


const BEHAVIORAL_KINDS = new Set(['function', 'method', 'class', 'constructor']);
/** Injectable gate evaluator for testability. */
export type GateEvaluator = typeof evaluateRequest;

const RUNG_ESCALATION_ORDER: RungType[] = ["card", "skeleton", "hotPath", "raw"];

const MAX_CARD_SYMBOLS = 20;
const MAX_SKELETON_SYMBOLS = 5;
const MAX_HOTPATH_SYMBOLS = 5;
const MAX_RAW_SYMBOLS = 3;
const MAX_SEARCH_FALLBACK = 10;
export const MAX_IDENTIFIERS = 10;
const MAX_ESCALATIONS = 2;

/** Map rung types to action type strings for error reporting. */
const RUNG_TO_ACTION_TYPE: Record<RungType, Action["type"]> = {
  card: "getCard",
  skeleton: "getSkeleton",
  hotPath: "getHotPath",
  raw: "needWindow",
};

/**
 * Per-rung token estimates used as fallback when actual token counting
 * is unavailable. Actual evidence-based tokens are preferred (see execute()).
 */
const RUNG_TOKEN_FALLBACK_ESTIMATES: Record<RungType, number> = {
  card: 50,
  skeleton: 200,
  hotPath: 500,
  raw: 2000,
};


/**
 * Common English words and SDL-MCP domain terms filtered out during
 * identifier extraction. Includes both natural-language noise words and
 * tool-specific jargon that would produce low-value hot-path matches.
 */
export const IDENTIFIER_STOP_WORDS = new Set([
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



/**
 * Extract potential code identifiers from free text.
 * Exported for testability; the Executor class method delegates to this
 * plus evidence-based augmentation.
 */
export function extractIdentifiersFromText(text: string): string[] {
  const bounded = text.slice(0, 2000);

  // Specific code-identifier patterns (high priority)
  const camelCase = bounded.match(/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) ?? [];
  const pascalCase = bounded.match(/[A-Z][a-z]+[A-Z][a-zA-Z0-9]*/g) ?? [];
  const singlePascal = (bounded.match(/\b[A-Z][a-z]{5,}[a-zA-Z0-9]*\b/g) ?? [])
    .filter((w) => !IDENTIFIER_STOP_WORDS.has(w.toLowerCase()));
  const snakeCase = bounded.match(/[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+/g) ?? [];

  const primary = [...new Set([...camelCase, ...pascalCase, ...singlePascal, ...snakeCase])];

  // Generic word tokens (low priority — fill remaining slots only)
  const words = (bounded.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) ?? [])
    .filter((w) => !IDENTIFIER_STOP_WORDS.has(w.toLowerCase()));
  const primarySet = new Set(primary);
  const secondary = [...new Set(words)].filter((w) => !primarySet.has(w));

  return [...primary, ...secondary].slice(0, MAX_IDENTIFIERS);
}

export class Executor {
  private evidenceCapture: EvidenceCapture;
  private actions: Action[] = [];
  private metrics: ExecutionMetrics;
  private startTime = 0;
  private policyEngine: PolicyEngine | undefined;
  private policyDecisions: Map<string, PolicyDecision> = new Map();
  private gateEvaluator: GateEvaluator;
  private connPromise: ReturnType<typeof getLadybugConn> | null = null;
  private cardCache = new Set<string>();

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

      // Track tokens: use actual evidence-based count when available,
      // fall back to static estimates otherwise
      const rungEvidence = this.evidenceCapture.getAllEvidence();
      const actualTokens = rungEvidence.length > evidenceBefore
        ? rungEvidence.slice(evidenceBefore).reduce((sum, e) => {
            const tokenMatch = e.summary.match(/~(\d+) tokens/);
            return sum + (tokenMatch ? parseInt(tokenMatch[1], 10) : RUNG_TOKEN_FALLBACK_ESTIMATES[rung] ?? 0);
          }, 0)
        : RUNG_TOKEN_FALLBACK_ESTIMATES[rung] ?? 0;
      this.metrics.totalTokens += actualTokens;

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

      // Check token budget
      if (
        task.budget?.maxTokens &&
        this.metrics.totalTokens >= task.budget.maxTokens
      ) {
        logger.debug("Token budget exhausted", {
          totalTokens: this.metrics.totalTokens,
          maxTokens: task.budget.maxTokens,
        });
        break;
      }

      // Check duration budget
      if (
        task.budget?.maxDurationMs &&
        Date.now() - this.startTime >= task.budget.maxDurationMs
      ) {
        logger.debug("Duration budget exhausted", {
          elapsedMs: Date.now() - this.startTime,
          maxDurationMs: task.budget.maxDurationMs,
        });
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
   * Supports both exact file paths and directory prefixes (e.g. "src/code/").
   */
  private async resolveFileSymbols(
    filePaths: string[],
    repoId: string,
  ): Promise<string[]> {
    const conn = await this.getConn();

    const results = await Promise.all(
      filePaths.map(async (relPath) => {
        try {
          // Try exact file match first
          const file = await ladybugDb.getFileByRepoPath(conn, repoId, relPath);
          if (file) {
            const symbols = await ladybugDb.getSymbolsByFile(conn, file.fileId);
            // Prefer behavioral symbols (functions/methods/classes) over variables for explain tasks
            const behavioral = symbols.filter((s) => BEHAVIORAL_KINDS.has(s.kind));
            const preferred = behavioral.length > 0 ? behavioral : symbols;
            return preferred.slice(0, 50).map((sym) => sym.symbolId);
          }

          // If exact match fails, treat as directory prefix and find files under it
          const normalizedPrefix = relPath.endsWith("/") ? relPath : relPath + "/";
          const filesUnderDir = await ladybugDb.getFilesByPrefix(conn, repoId, normalizedPrefix);
          if (filesUnderDir.length > 0) {
            const symbolResults = await Promise.all(
              filesUnderDir.slice(0, 20).map(async (f) => {
                const symbols = await ladybugDb.getSymbolsByFile(conn, f.fileId);
                const beh = symbols.filter((s) => BEHAVIORAL_KINDS.has(s.kind));
                return (beh.length > 0 ? beh : symbols).slice(0, 10).map((sym) => sym.symbolId);
              }),
            );
            return symbolResults.flat();
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

  /**
   * Select the top symbols based on relevance scores with adaptive cutoff.
   * For precise queries (1-2 high-scoring symbols), returns only those.
   * For broad queries (many similar scores), returns more context.
   */
  private async selectTopSymbols(
    symbolIds: string[],
    task: AgentTask,
    maxCount: number,
  ): Promise<string[]> {
    if (!task.taskText || symbolIds.length === 0) {
      return symbolIds.slice(0, maxCount);
    }

    const identifiers = this.extractIdentifiersFromTask(task);
    if (identifiers.length === 0) return symbolIds.slice(0, maxCount);

    const conn = await this.getConn();
    const symbolMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);

    const identifierSet = new Set(identifiers.map((id) => id.toLowerCase()));
    const taskTextLower = task.taskText.toLowerCase();

    const scored: Array<{ symbolId: string; score: number }> = [];
    for (const symbolId of symbolIds) {
      const sym = symbolMap.get(symbolId);
      if (!sym) { scored.push({ symbolId, score: 0 }); continue; }
      let score = 0;
      const nameLower = sym.name.toLowerCase();
      if (nameLower.length >= 3 && taskTextLower.includes(nameLower)) score += 10;
      if (identifierSet.has(nameLower)) score += 8;
      // Only check partial overlap for names 3+ chars (avoid matching 'i', 'r', etc.)
      if (nameLower.length >= 3) {
        for (const id of identifiers) {
          if (id.length < 3) continue;
          const idLower = id.toLowerCase();
          if (nameLower.includes(idLower) || idLower.includes(nameLower)) { score += 3; break; }
        }
      }
      if (sym.summary) {
        const summaryLower = sym.summary.toLowerCase();
        for (const id of identifiers) {
          if (summaryLower.includes(id.toLowerCase())) { score += 2; break; }
        }
      }
      if (sym.exported) score += 1;
      scored.push({ symbolId, score });
    }
    scored.sort((a, b) => b.score - a.score);

    const topScore = scored[0]?.score ?? 0;
    const isPrecise = task.options?.contextMode === 'precise';

    // Precise: aggressive threshold (60% of top), cap at 5 symbols.
    // Broad: generous threshold (40% of top), use caller's maxCount.
    const threshold = isPrecise
      ? Math.max(5, topScore * 0.6)
      : Math.max(3, topScore * 0.4);
    const effectiveMax = isPrecise ? Math.min(5, maxCount) : maxCount;
    const relevant = scored.filter((s) => s.score >= threshold);
    const count = Math.max(1, Math.min(relevant.length, effectiveMax));

    logger.debug('Adaptive symbol selection', { total: scored.length, topScore, threshold, selected: count, contextMode: isPrecise ? 'precise' : 'broad' });
    return scored.slice(0, count).map((s) => s.symbolId);
  }

  private async executeCardRung(
    task: AgentTask,
    context: string[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: rawSymbols } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      let allSymbols = rawSymbols.length > 0 && task.taskText
        ? await this.selectTopSymbols(rawSymbols, task, MAX_CARD_SYMBOLS)
        : rawSymbols.slice(0, MAX_CARD_SYMBOLS);

      // Fallback: identifier-based search with per-term resolution
      if (allSymbols.length === 0 && task.taskText) {
        // 1. Determine search terms: explicit searchTerms option > extracted identifiers
        const searchTerms = task.options?.searchTerms?.length
          ? task.options.searchTerms.slice(0, 5)
          : this.extractIdentifiersFromTask(task).slice(0, 5);

        const seen = new Set<string>();
        const useHybrid = await isHybridRetrievalAvailable();

        // 2. Search for each identifier individually and combine results
        for (const term of searchTerms) {
          if (useHybrid) {
            const hybridResult = await hybridSearch({
              repoId: task.repoId,
              query: term,
              limit: Math.ceil(MAX_SEARCH_FALLBACK / Math.max(searchTerms.length, 1)),
              includeEvidence: false,
            });
            for (const item of hybridResult.results) {
              if (!seen.has(item.symbolId)) {
                seen.add(item.symbolId);
                allSymbols.push(item.symbolId);
              }
            }
          } else {
            const conn = await this.getConn();
            const searchResults = await ladybugDb.searchSymbols(
              conn,
              task.repoId,
              term,
              Math.ceil(MAX_SEARCH_FALLBACK / Math.max(searchTerms.length, 1)),
            );
            for (const result of searchResults) {
              if (!seen.has(result.symbolId)) {
                seen.add(result.symbolId);
                allSymbols.push(result.symbolId);
              }
            }
          }
        }

        // 3. If individual identifier searches found nothing, fall back to full taskText
        if (allSymbols.length === 0) {
          if (useHybrid) {
            const hybridResult = await hybridSearch({
              repoId: task.repoId,
              query: task.taskText,
              limit: MAX_SEARCH_FALLBACK,
              includeEvidence: false,
            });
            for (const item of hybridResult.results) {
              allSymbols.push(item.symbolId);
            }
          } else {
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
          logger.debug("Fallback: full taskText search used (no identifier matches)", {
            taskText: task.taskText.slice(0, 100),
            resultCount: allSymbols.length,
          });
        } else {
          logger.debug("Identifier-based search resolved symbols", {
            searchTerms,
            resultCount: allSymbols.length,
          });
        }

        // Feedback-aware boosting: reorder search results by score + boost
        if (task.taskText && allSymbols.length > 0) {
          try {
            const feedbackConn = await this.getConn();
            const { boosts } = await queryFeedbackBoosts(feedbackConn, {
              repoId: task.repoId,
              query: task.taskText,
              limit: 5,
            });
            if (boosts.size > 0) {
              // Move boosted symbols to the front of allSymbols
              const boosted: string[] = [];
              const unboosted: string[] = [];
              for (const symbolId of allSymbols) {
                if (boosts.has(symbolId)) {
                  boosted.push(symbolId);
                } else {
                  unboosted.push(symbolId);
                }
              }
              // Sort boosted by boost value (descending)
              boosted.sort((a, b) => (boosts.get(b) ?? 0) - (boosts.get(a) ?? 0));
              allSymbols.length = 0;
              allSymbols.push(...boosted, ...unboosted);
              logger.debug("Feedback boost reordered executor card search results", {
                boostedCount: boosted.length,
                totalCount: allSymbols.length,
              });
            }
          } catch (err) {
            logger.debug(`[executor] Feedback boost reorder failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (allSymbols.length === 0) {
        this.evidenceCapture.captureSearchResult(task.taskText, 0);
      } else {
        // Fetch real symbol data from DB
        const conn = await this.getConn();
        const symbolMap = await ladybugDb.getSymbolsByIds(
          conn,
          allSymbols,
        );

        // Iterate in ranked order to preserve relevance in evidence
        for (const symbolId of allSymbols) {
          const sym = symbolMap.get(symbolId);
          if (!sym) continue;
          // Track cache hits for repeated symbol lookups
          if (this.cardCache.has(sym.symbolId)) {
            this.metrics.cacheHits++;
          } else {
            this.cardCache.add(sym.symbolId);
          }
          const parts: string[] = [`${sym.kind} ${sym.name}`];
          if (sym.signatureJson) {
            try {
              const sig = JSON.parse(sym.signatureJson);
              if (sig.text) parts.push(`sig: ${sig.text}`);
            } catch (err) {
              logger.debug("Failed to parse signature JSON", { error: String(err) });
            }
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
      const { symbolIds: rawSkeletonSymbols, filePaths } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      const symbolIds = rawSkeletonSymbols.length > 0 && task.taskText
        ? await this.selectTopSymbols(rawSkeletonSymbols, task, MAX_SKELETON_SYMBOLS)
        : rawSkeletonSymbols.slice(0, MAX_SKELETON_SYMBOLS);

      let processedCount = 0;

      // Generate skeletons for symbol IDs
      for (const symbolId of symbolIds) {
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

      // Precise: skip file-level skeletons (symbol skeletons suffice).
      // Broad: 1 file skeleton if symbol skeletons exist, full count otherwise.
      const isPreciseSkeleton = task.options?.contextMode === 'precise';
      const maxFileSks = isPreciseSkeleton
        ? 0
        : processedCount > 0 ? 1 : MAX_SKELETON_SYMBOLS;
      for (const filePath of filePaths.slice(0, maxFileSks)) {
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
      const { symbolIds: rawHotpathSymbols } = await this.resolveContextToSymbols(
        context,
        task.repoId,
      );

      const symbols = rawHotpathSymbols.length > 0 && task.taskText
        ? await this.selectTopSymbols(rawHotpathSymbols, task, MAX_HOTPATH_SYMBOLS)
        : rawHotpathSymbols.slice(0, MAX_HOTPATH_SYMBOLS);

      const identifiers = this.extractIdentifiersFromTask(task);

      let processedCount = 0;

      for (const symbolId of symbols) {
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
    const identifiers = extractIdentifiersFromText(task.taskText);

    // Augment with symbol names from evidence already captured (card rung runs first)
    const cardEvidence = this.evidenceCapture.getEvidenceByType("symbolCard");
    for (const e of cardEvidence.slice(0, 5)) {
      const nameMatch = e.summary.match(/^\w+\s+(\w+)/);
      if (nameMatch) {
        identifiers.push(nameMatch[1]);
      }
    }

    return [...new Set(identifiers)].slice(0, MAX_IDENTIFIERS);
  }

  private generateActionId(): string {
    return `action-${this.actions.length}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
    this.cardCache = new Set<string>();
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
