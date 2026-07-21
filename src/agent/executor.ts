import type {
  // =============================================================================
  // agent/executor.ts — Autopilot Executor: drives the 4-rung context ladder.
  //
  // Public exports (LLM-cost cheat sheet):
  //   Class:
  //     - Executor — state machine: card → skeleton → hotPath → raw rungs;
  //                  emits Action[] + Evidence[] + ExecutionMetrics
  //   Identifier-extraction helpers (pure; stateless):
  //     - extractIdentifiersFromText(text, queryContext?)
  //     - generateCompoundIdentifiers(text)
  //     - buildContextAwareStopWords(queryText)
  //     - MAX_IDENTIFIERS, IDENTIFIER_STOP_WORDS
  //   Types:
  //     - GateEvaluator (= signature of defaultGateEvaluator: decide → enforce)
  //
  // Internal-only constants: ALWAYS_STOP_WORDS, DOMAIN_STOP_WORDS,
  // COMPOUND_STOP_WORDS, RUNG_ESCALATION_ORDER, RUNG_TO_ACTION_TYPE, MAX_ESCALATIONS.
  // =============================================================================

  Action,
  AgentTask,
  Evidence,
  ExecutionMetrics,
  RungType,
  ContextSeedCandidate,
} from "./types.js";
import { EvidenceCapture } from "./evidence.js";
import type { PolicyRequestContext } from "../policy/types.js";
import {
  decideCodeAccess,
  type CodeAccessDecision,
} from "../policy/code-access.js";
import { IndexError } from "../domain/errors.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import {
  searchSymbolsLiteQueriesInPool,
  type SearchSymbolLiteCandidate,
  type SymbolRow,
} from "../db/ladybug-symbols.js";
import { generateSkeletonIR, generateFileSkeleton } from "../code/skeleton.js";
import { extractHotPath } from "../code/hotpath.js";
import { enforceCodeWindow } from "../code/enforce.js";
import { LadybugWindowLoader } from "../code/window-loader.js";
import type {
  CodeWindowRequest,
  CodeWindowResponse,
  GraphSlice,
} from "../domain/types.js";
import { logger } from "../util/logger.js";
import { isHybridRetrievalAvailable } from "../retrieval/fallback.js";
import { hybridSearch } from "../retrieval/orchestrator.js";
import { queryFeedbackBoosts } from "../retrieval/feedback-boost.js";
import {
  getOverlaySnapshot,
  resolveSymbolsWithOverlay,
  type OverlaySnapshot,
  type OverlaySymbolBatchResolution,
} from "../live-index/overlay-reader.js";
import {
  rankSymbols,
  mergeContextSeedCandidates,
  selectFinalSymbols,
  computeReviewImportanceBySymbolId,
  explicitFocusPaths,
  inferEvidenceFocusPaths,
  pathMatchesFocus,
  type ReviewImportanceMetric,
} from "./context-ranking.js";
import { buildContextLexicalQueryPlan } from "./context-seeding.js";
import { randomUUID } from "node:crypto";
import {
  MAX_IDENTIFIERS,
  IDENTIFIER_STOP_WORDS,
  buildContextAwareStopWords,
  generateCompoundIdentifiers,
  extractIdentifiersFromText,
} from "./identifier-extraction.js";

export type GateEvaluator = (
  request: CodeWindowRequest,
  options?: { breakGlass?: boolean; slice?: GraphSlice },
) => Promise<CodeWindowResponse>;

export type ExecutorDbQueries = Pick<
  typeof ladybugDb,
  | "getFileByRepoPath"
  | "getSymbolIdsByFile"
  | "getFilesByPrefix"
  | "getSymbolsByFile"
  | "getClusterMembers"
  | "getProcessStepsByIds"
  | "getSymbolsByIds"
  | "getFilesByIds"
  | "searchSymbols"
> &
  Partial<
    Pick<
      typeof ladybugDb,
      "getBoundedDependencySymbolsFromSources" | "getMetricsBySymbolIds"
    >
  >;

/**
 * Default gate evaluator backing the autopilot Executor when no override is
 * supplied. Calls `decideCodeAccess` for the policy decision and chains
 * `enforceCodeWindow` (with the production `LadybugWindowLoader`) when the
 * decision permits raw access.
 */
export const defaultGateEvaluator: GateEvaluator = async (request, options) => {
  const policyContext: PolicyRequestContext = {
    requestType: "codeWindow",
    repoId: request.repoId,
    symbolId: request.symbolId,
    expectedLines: request.expectedLines,
    identifiersToFind: request.identifiersToFind,
    reason: request.reason,
  };
  const accessDecision = decideCodeAccess(policyContext);
  if (accessDecision.kind !== "approve") {
    return {
      approved: false,
      whyDenied:
        accessDecision.kind === "deny"
          ? accessDecision.deniedReasons
          : ["Policy downgrade"],
      suggestedNextRequest:
        accessDecision.kind === "deny" ? accessDecision.suggestions : undefined,
    };
  }
  const loader = new LadybugWindowLoader();
  return enforceCodeWindow(request, accessDecision, loader, options ?? {});
};

const RUNG_ESCALATION_ORDER: RungType[] = [
  "card",
  "skeleton",
  "hotPath",
  "raw",
];

const MAX_CARD_SYMBOLS = 20;
const MAX_PRECISE_CARD_SYMBOLS = 10;
const MAX_SKELETON_SYMBOLS = 5;
const MAX_HOTPATH_SYMBOLS = 5;
const MAX_RAW_SYMBOLS = 3;
const MAX_SEARCH_FALLBACK = 10;
const MAX_ESCALATIONS = 2;
const MAX_FORCED_SEMANTIC_PRECISE_CARD_SYMBOLS = 20;
const MAX_CARD_SYMBOLS_PER_FILE = 3;
const MAX_RELATED_SYMBOLS = 14;
const MAX_FORCED_SEMANTIC_RANKED_FILE_SYMBOLS = 80;
const MAX_FORCED_SEMANTIC_FILE_OUTLINE_SYMBOLS = 160;
const MAX_FORCED_SEMANTIC_OUTLINE_EDGE_SOURCES = 80;
const MAX_FORCED_SEMANTIC_OUTLINE_DEPENDENCY_CANDIDATES = 512;
const MAX_FORCED_SEMANTIC_OUTLINE_DEPENDENCIES = 24;
const GENERIC_FILE_BASENAMES = new Set(["engine", "index", "types"]);
const OUTLINE_DECLARATIVE_KINDS = new Set([
  "class",
  "interface",
  "type",
  "typeAlias",
  "enum",
]);
const REVIEW_EVIDENCE_KINDS = ["function", "method", "constructor"];

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
 * Natural-language noise words that are always filtered during extraction.
 * These never carry discriminating value for symbol search.
 */
export {
  MAX_IDENTIFIERS,
  IDENTIFIER_STOP_WORDS,
  buildContextAwareStopWords,
  generateCompoundIdentifiers,
  extractIdentifiersFromText,
};

const LOW_SIGNAL_SKELETON_IMPORTS = new Set([
  "after",
  "assert",
  "before",
  "describe",
  "dirname",
  "fileURLToPath",
  "it",
  "join",
  "mkdir",
  "mkdtemp",
  "readFile",
  "resolve",
  "rm",
  "spawnSync",
  "strict",
  "test",
  "tmpdir",
  "writeFile",
]);

const MAX_SKELETON_EVIDENCE_EXCERPT_CHARS = 480;

function uniqueBoundedIdentifiers(
  matches: IterableIterator<RegExpMatchArray>,
  limit: number,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const identifier = match[1];
    if (!identifier || excluded.has(identifier) || seen.has(identifier)) {
      continue;
    }
    seen.add(identifier);
    identifiers.push(identifier);
    if (identifiers.length >= limit) break;
  }
  return identifiers;
}

/**
 * Build a compact structural excerpt instead of returning an arbitrary source
 * prefix. Imports expose test targets, while declarations retain late helpers
 * without expanding every skeleton response to its full source text.
 */
export function buildSkeletonEvidenceExcerpt(
  skeletonText: string,
  taskText = "",
): string {
  const structuralPrefix = skeletonText
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const importIdentifiers: string[] = [];
  const seenImports = new Set<string>();
  for (const importMatch of skeletonText.matchAll(
    /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["'];?/g,
  )) {
    const clause = importMatch[1] ?? "";
    for (const identifierMatch of clause.matchAll(
      /\b([A-Za-z_$][\w$]*)\b/g,
    )) {
      const identifier = identifierMatch[1];
      if (
        !identifier ||
        identifier === "as" ||
        identifier === "type" ||
        LOW_SIGNAL_SKELETON_IMPORTS.has(identifier) ||
        seenImports.has(identifier)
      ) {
        continue;
      }
      seenImports.add(identifier);
      importIdentifiers.push(identifier);
      if (importIdentifiers.length >= 8) break;
    }
    if (importIdentifiers.length >= 8) break;
  }

  const allDeclarations = uniqueBoundedIdentifiers(
    skeletonText.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    ),
    256,
  );
  const taskTerms =
    taskText.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const taskAcronyms = taskText.match(/\b[A-Z][A-Z0-9]{1,}\b/g) ?? [];
  const acronymAffineDeclarations = allDeclarations.filter((identifier) => {
    const normalized = identifier.toLowerCase();
    return taskAcronyms.some((acronym) =>
      normalized.includes(acronym.toLowerCase()),
    );
  });
  const taskAffineDeclarations = allDeclarations.filter((identifier) => {
    const normalized = identifier.toLowerCase();
    return taskTerms.some((term) => normalized.includes(term));
  });
  const declarations = [
    ...new Set([
      ...acronymAffineDeclarations,
      ...taskAffineDeclarations,
      ...allDeclarations,
    ]),
  ]
    .filter((identifier) => !structuralPrefix.includes(identifier))
    .slice(0, 14);
  const lateImports = importIdentifiers.filter(
    (identifier) => !structuralPrefix.includes(identifier),
  );
  const parts = structuralPrefix ? [structuralPrefix] : [];
  if (lateImports.length > 0) {
    parts.push(`imports: ${lateImports.join(", ")}`);
  }
  if (declarations.length > 0) {
    parts.push(`declarations: ${declarations.join(", ")}`);
  }
  return parts.join(" | ").slice(0, MAX_SKELETON_EVIDENCE_EXCERPT_CHARS);
}

function highConfidenceNamedSymbolIds(
  seedCandidates: ContextSeedCandidate[],
): Set<string> {
  return new Set(
    seedCandidates
      .filter(
        (candidate) =>
          (candidate.expansionReason === "namedConcept" ||
            candidate.expansionReason === "actionCatalog" ||
            candidate.expansionReason === "inferredFocus") &&
          candidate.contextRef.startsWith("symbol:"),
      )
      .map((candidate) => candidate.contextRef.slice("symbol:".length)),
  );
}

function countHighConfidenceNamedSymbolSeeds(
  seedCandidates: ContextSeedCandidate[],
): number {
  return highConfidenceNamedSymbolIds(seedCandidates).size;
}

/** Keep named/action representatives inside a hard repeated-file evidence cap. */
export function selectBoundedCardEvidenceItems<
  T extends { symbolId: string; fileId?: string },
>(
  items: T[],
  preservedSymbolIds: ReadonlySet<string>,
  perFileLimit: number,
): T[] {
  if (perFileLimit <= 0) return [];
  const itemsByFile = new Map<string, T[]>();
  for (const item of items) {
    const fileKey = item.fileId ?? `symbol:${item.symbolId}`;
    const group = itemsByFile.get(fileKey) ?? [];
    group.push(item);
    itemsByFile.set(fileKey, group);
  }

  const selectedIds = new Set<string>();
  for (const group of itemsByFile.values()) {
    const prioritized = [
      ...group.filter((item) => preservedSymbolIds.has(item.symbolId)),
      ...group.filter((item) => !preservedSymbolIds.has(item.symbolId)),
    ];
    for (const item of prioritized.slice(0, perFileLimit)) {
      selectedIds.add(item.symbolId);
    }
  }

  // Preserve the original global rank after choosing each file's bounded set.
  return items.filter((item) => selectedIds.has(item.symbolId));
}

/** Bound multi-topic precise cards once scoped lexical coverage is complete. */
export function computeCardRungSymbolLimit(
  task: AgentTask,
  seedCandidates: ContextSeedCandidate[],
): number {
  if (task.options?.contextMode !== "precise") return MAX_CARD_SYMBOLS;
  if (task.options.semantic !== true) return MAX_PRECISE_CARD_SYMBOLS;

  const hasExplicitScope = !!(
    task.options.focusPaths?.length || task.options.focusSymbols?.length
  );
  const highConfidenceCount = countHighConfidenceNamedSymbolSeeds(
    seedCandidates,
  );
  if (hasExplicitScope && highConfidenceCount >= 5) {
    // Two semantic complements retain useful adjacency without letting generic
    // benchmark/support symbols crowd a complete named-subsystem result.
    return Math.min(
      MAX_FORCED_SEMANTIC_PRECISE_CARD_SYMBOLS,
      highConfidenceCount + 2,
    );
  }
  return MAX_FORCED_SEMANTIC_PRECISE_CARD_SYMBOLS;
}

/** Keep one bounded skeleton item per high-confidence named lexical seed. */
export function computeEvidenceRungSymbolLimit(
  task: AgentTask,
  seedCandidates: ContextSeedCandidate[],
  defaultMax: number,
): number {
  const hasExplicitScope = !!(
    task.options?.focusPaths?.length || task.options?.focusSymbols?.length
  );
  if (
    task.options?.contextMode !== "precise" ||
    task.options?.semantic !== true ||
    !hasExplicitScope
  ) {
    return defaultMax;
  }
  const highConfidenceCount = countHighConfidenceNamedSymbolSeeds(
    seedCandidates,
  );
  const adaptiveCap = Math.max(defaultMax, 8);
  return Math.min(
    adaptiveCap,
    Math.max(defaultMax, highConfidenceCount),
  );
}

export class Executor {
  private evidenceCapture: EvidenceCapture;
  private actions: Action[] = [];
  private metrics: ExecutionMetrics;
  private startTime = 0;

  private policyDecisions: Map<string, CodeAccessDecision> = new Map();
  private gateEvaluator: GateEvaluator;
  private connPromise: ReturnType<typeof getLadybugConn> | null = null;
  private dbQueries: ExecutorDbQueries;
  private overlaySnapshots = new Map<string, OverlaySnapshot>();

  private cardCache = new Set<string>();

  constructor(
    gateEvaluator?: GateEvaluator,
    dbQueries: ExecutorDbQueries = ladybugDb,
  ) {
    this.evidenceCapture = new EvidenceCapture();

    this.gateEvaluator = gateEvaluator ?? defaultGateEvaluator;
    this.dbQueries = dbQueries;
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

  private async resolveVisibleSymbols(
    repoId: string,
    symbolIds: string[],
  ): Promise<OverlaySymbolBatchResolution> {
    let snapshot = this.overlaySnapshots.get(repoId);
    if (!snapshot) {
      snapshot = getOverlaySnapshot(repoId);
      this.overlaySnapshots.set(repoId, snapshot);
    }
    return resolveSymbolsWithOverlay(await this.getConn(), repoId, symbolIds, {
      snapshot,
      queries: this.dbQueries,
    });
  }

  async execute(
    task: AgentTask,
    rungs: RungType[],
    context: string[],
    seedCandidates: ContextSeedCandidate[] = [],
  ): Promise<{
    actions: Action[];
    evidence: Evidence[];
    success: boolean;
  }> {
    this.startTime = Date.now();
    this.overlaySnapshots.clear();
    const mutableRungs = [...rungs];
    let escalationCount = 0;

    for (let i = 0; i < mutableRungs.length; i++) {
      const rung = mutableRungs[i];
      const evidenceBefore = this.evidenceCapture.getAllEvidence().length;

      await this.executeRung(task, rung, context, seedCandidates);

      // Track tokens: use actual evidence-based count when available,
      // fall back to static estimates otherwise
      const rungEvidence = this.evidenceCapture.getAllEvidence();
      const actualTokens =
        rungEvidence.length > evidenceBefore
          ? rungEvidence.slice(evidenceBefore).reduce((sum, e) => {
              const tokenMatch = e.summary.match(/~(\d+) tokens/);
              return (
                sum +
                (tokenMatch
                  ? parseInt(tokenMatch[1], 10)
                  : (RUNG_TOKEN_FALLBACK_ESTIMATES[rung] ?? 0))
              );
            }, 0)
          : (RUNG_TOKEN_FALLBACK_ESTIMATES[rung] ?? 0);
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

    const evidence = this.evidenceCapture.getAllEvidence();
    return {
      actions: this.actions,
      evidence,
      success: evidence.length > 0 || this.metrics.failedActions === 0,
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
    seedCandidates: ContextSeedCandidate[],
  ): Promise<void> {
    try {
      switch (rung) {
        case "card":
          await this.executeCardRung(task, context, seedCandidates);
          break;
        case "skeleton":
          await this.executeSkeletonRung(task, context, seedCandidates);
          break;
        case "hotPath":
          await this.executeHotPathRung(task, context, seedCandidates);
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

    const results: string[][] = [];
    for (const relPath of filePaths) {
      try {
        // Try exact file match first
        const file = await this.dbQueries.getFileByRepoPath(conn, repoId, relPath);
        if (file) {
          const symbolIds = await this.dbQueries.getSymbolIdsByFile(
            conn,
            file.fileId,
          );
          // Preserve the full exact-file candidate set for the sole final selector.
          results.push(symbolIds);
          continue;
        }

        // If exact match fails, treat as directory prefix and find files under it.
        const normalizedPrefix = relPath.endsWith("/")
          ? relPath
          : relPath + "/";
        const filesUnderDir = await this.dbQueries.getFilesByPrefix(
          conn,
          repoId,
          normalizedPrefix,
        );
        if (filesUnderDir.length > 0) {
          const symbolResults: string[][] = [];
          for (const f of filesUnderDir) {
            const symbols = await this.dbQueries.getSymbolsByFile(conn, f.fileId);
            symbolResults.push(symbols.map((sym) => sym.symbolId));
          }
          // Preserve the complete directory candidate set for the sole final selector.
          results.push(symbolResults.flat());
          continue;
        }
      } catch (err) {
        logger.debug("Failed to resolve symbols for file", {
          relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      results.push([]);
    }

    return results.flat();
  }

  /**
   * Extract symbol IDs and file paths from context entries.
   *
   * Non-symbol retrieval entities are expanded into representative symbols and
   * carry their original seed score forward so final ranking can still use the
   * retrieval prior that found the entity.
   */
  private async resolveContextToSymbols(
    context: string[],
    task: AgentTask,
    seedCandidates: ContextSeedCandidate[] = [],
  ): Promise<{
    symbolIds: string[];
    filePaths: string[];
    seedCandidates: ContextSeedCandidate[];
  }> {
    const repoId = task.repoId;
    const directSymbols = context
      .filter((c) => c.startsWith("symbol:"))
      .map((s) => s.slice("symbol:".length));

    const filePaths = context
      .filter((c) => c.startsWith("file:"))
      .map((f) => f.slice("file:".length));

    const fileSummaryIds = context
      .filter((c) => c.startsWith("fileSummary:"))
      .map((f) => f.slice("fileSummary:".length));
    const clusterIds = context
      .filter((c) => c.startsWith("cluster:"))
      .map((c) => c.slice("cluster:".length));
    const processIds = context
      .filter((c) => c.startsWith("process:"))
      .map((p) => p.slice("process:".length));

    let resolvedSymbols: string[] = [];
    if (filePaths.length > 0) {
      resolvedSymbols = await this.resolveFileSymbols(filePaths, repoId);
    }

    const seedByRef = new Map<string, ContextSeedCandidate[]>();
    for (const candidate of seedCandidates) {
      const contributions = seedByRef.get(candidate.contextRef) ?? [];
      contributions.push(candidate);
      seedByRef.set(candidate.contextRef, contributions);
    }
    const expandedSeedCandidates = seedCandidates.filter((c) =>
      c.contextRef.startsWith("symbol:"),
    );
    for (const [index, symbolId] of directSymbols.entries()) {
      const symbolRef = `symbol:${symbolId}`;
      // Seeded symbols already carry their retrieval score and provenance.
      // Add a direct-context prior only for unscored refs introduced by another rung.
      if (seedByRef.has(symbolRef)) continue;
      expandedSeedCandidates.push({
        contextRef: symbolRef,
        source: "lexical",
        score: 1,
        sourceRank: -1000 + index,
        entityType: "symbol",
        expansionReason: "directContext",
      });
    }
    const addExpandedSeed = (
      symbolId: string,
      sourceRef: string,
      index: number,
      scoreScale: number,
      expansionReason: string,
    ): void => {
      const sources = seedByRef.get(sourceRef);
      if (!sources) return;
      const symbolRef = `symbol:${symbolId}`;
      for (const source of sources) {
        expandedSeedCandidates.push({
          ...source,
          contextRef: symbolRef,
          entityType: "symbol",
          expandedFrom: sourceRef,
          expansionReason,
          score: Math.max(0, Math.min(1, source.score * scoreScale)),
          sourceRank: source.sourceRank + index + 1,
        });
      }
    };

    if (fileSummaryIds.length > 0 || clusterIds.length > 0 || processIds.length > 0) {
      const conn = await this.getConn();
      for (const fileId of fileSummaryIds.slice(0, 8)) {
        const symbols = await this.dbQueries.getSymbolsByFile(conn, fileId);
        const symbolIds = symbols.map((symbol) => symbol.symbolId);
        resolvedSymbols.push(...symbolIds);
        symbolIds.forEach((symbolId, index) =>
          addExpandedSeed(
            symbolId,
            `fileSummary:${fileId}`,
            index,
            0.92,
            "fileSummary",
          ),
        );
      }

      for (const clusterId of clusterIds.slice(0, 8)) {
        const members = (await this.dbQueries.getClusterMembers(conn, clusterId))
          .sort(
            (a, b) =>
              b.membershipScore - a.membershipScore ||
              a.symbolId.localeCompare(b.symbolId),
          );
        resolvedSymbols.push(...members.map((m) => m.symbolId));
        members.forEach((member, index) =>
          addExpandedSeed(
            member.symbolId,
            `cluster:${clusterId}`,
            index,
            0.86,
            "clusterMember",
          ),
        );
      }

      if (processIds.length > 0) {
        const wantedProcesses = new Set(processIds.slice(0, 8));
        const steps = (await this.dbQueries.getProcessStepsByIds(
            conn,
            repoId,
            [...wantedProcesses],
          ))
          .filter((step) => wantedProcesses.has(step.processId))
          .sort(
            (a, b) =>
              a.processId.localeCompare(b.processId) ||
              a.stepOrder - b.stepOrder ||
              a.symbolId.localeCompare(b.symbolId),
          );
        for (const step of steps) {
          resolvedSymbols.push(step.symbolId);
          addExpandedSeed(
            step.symbolId,
            `process:${step.processId}`,
            step.stepOrder,
            0.88,
            "processStep",
          );
        }
      }
    }

    const symbolIds = [...new Set([...directSymbols, ...resolvedSymbols])];
    const mergedSeedCandidates = mergeContextSeedCandidates(expandedSeedCandidates);
    return { symbolIds, filePaths, seedCandidates: mergedSeedCandidates };
  }

  /**
   * Select the top symbols based on multi-factor ranking with adaptive cutoff.
   * Delegates scoring to context-ranking.ts for evidence-aware symbol selection.
   */
  private async selectTopSymbols(
    symbolIds: string[],
    task: AgentTask,
    maxCount: number,
    seedCandidates: ContextSeedCandidate[] = [],
    feedbackBoosts?: Map<string, number>,
  ): Promise<string[]> {
    const identifiers = this.extractIdentifiersFromTask(task);
    const directlyResolved = await this.resolveVisibleSymbols(task.repoId, symbolIds);
    const directSymbolMap = new Map<string, SymbolRow>();
    for (const item of directlyResolved.items) {
      if (item.status !== "resolved") continue;
      directSymbolMap.set(
        item.symbolId,
        item.file ? { ...item.symbol, fileId: item.file.relPath } : item.symbol,
      );
    }

    let evidencePaths: string[] = [];
    if (
      task.options?.semantic === true &&
      explicitFocusPaths(task.options).length === 0
    ) {
      const retrievalPriors = new Map<string, number>();
      for (const candidate of seedCandidates) {
        if (!candidate.contextRef.startsWith("symbol:")) continue;
        const symbolId = candidate.contextRef.slice("symbol:".length);
        retrievalPriors.set(
          symbolId,
          Math.max(retrievalPriors.get(symbolId) ?? 0, candidate.score),
        );
      }
      let directMetrics: Map<string, ReviewImportanceMetric> | undefined;
      if (this.dbQueries.getMetricsBySymbolIds) {
        try {
          directMetrics = await this.dbQueries.getMetricsBySymbolIds(
            await this.getConn(),
            [...directSymbolMap.keys()],
          );
        } catch (err) {
          logger.debug("Evidence-scope metrics lookup failed (non-fatal)", {
            repoId: task.repoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      evidencePaths = inferEvidenceFocusPaths(directSymbolMap, identifiers, task, {
        retrievalPriors,
        metrics: directMetrics,
      });
      if (evidencePaths.length > 0) {
        const conn = await this.getConn();
        const companionDirectories: string[] = [];
        for (const filePath of evidencePaths) {
          const companionPath = filePath.replace(/\.[^/.]+$/, "");
          if (companionPath === filePath) continue;
          const files = await this.dbQueries.getFilesByPrefix(
            conn,
            task.repoId,
            `${companionPath}/`,
          );
          if (files.length > 0) companionDirectories.push(`${companionPath}/`);
        }
        evidencePaths = [...new Set([...evidencePaths, ...companionDirectories])];
      }
    }

    const inferredPaths =
      evidencePaths.length > 0
        ? evidencePaths
        : task.options?.semantic === true
          ? task.options.inferredFocusPaths ?? []
          : [];
    const inferredSymbolIds =
      inferredPaths.length > 0
        ? await this.resolveFileSymbols(inferredPaths, task.repoId)
        : [];
    const candidateSymbolIds = [
      ...new Set([...symbolIds, ...inferredSymbolIds]),
    ];
    const resolved =
      inferredSymbolIds.length > 0
        ? await this.resolveVisibleSymbols(task.repoId, candidateSymbolIds)
        : directlyResolved;
    // Persisted file IDs are opaque hashes. Clone only the ranking view so
    // path affinity and explicit-scope finalization receive repo-relative paths.
    const symbolMap = new Map<string, SymbolRow>();
    for (const item of resolved.items) {
      if (item.status !== "resolved") continue;
      symbolMap.set(
        item.symbolId,
        item.file ? { ...item.symbol, fileId: item.file.relPath } : item.symbol,
      );
    }

    const rankingTask: AgentTask = {
      ...task,
      options: {
        ...task.options,
        ...(inferredPaths.length > 0 ? { inferredFocusPaths: inferredPaths } : {}),
      },
    };

    if (!task.taskText || candidateSymbolIds.length === 0) {
      return selectFinalSymbols(
        undefined,
        symbolMap,
        rankingTask,
        maxCount,
        candidateSymbolIds,
      );
    }

    if (
      identifiers.length === 0 &&
      seedCandidates.length === 0 &&
      !feedbackBoosts?.size
    ) {
      return selectFinalSymbols(
        undefined,
        symbolMap,
        rankingTask,
        maxCount,
        candidateSymbolIds,
      );
    }

    let rankingSeedCandidates = seedCandidates;
    const taskRelevantScopeIds = new Set<string>();
    if (inferredPaths.length > 0) {
      const scopedPool: SearchSymbolLiteCandidate[] = [];
      for (const [symbolId, symbol] of symbolMap) {
        const file = symbol.fileId ?? "";
        if (!pathMatchesFocus(file, inferredPaths)) continue;
        scopedPool.push({
          symbolId,
          name: symbol.name,
          fileId: file,
          file,
          kind: symbol.kind,
          exported: symbol.exported ?? false,
          summary: symbol.summary ?? "",
          searchText: symbol.searchText ?? "",
        });
      }

      const lexicalPlan = buildContextLexicalQueryPlan(
        task.taskText,
        task.options?.contextMode !== "precise",
      ).map(({ query }) => ({
        query,
        // The complete scoped pool remains available to the final selector;
        // this limit only bounds retrieval-prior assignment.
        limit: Math.max(1, scopedPool.length),
        kinds: REVIEW_EVIDENCE_KINDS,
      }));
      const scopedResults = searchSymbolsLiteQueriesInPool(scopedPool, lexicalPlan);
      const scopedSeeds: ContextSeedCandidate[] = [];
      let sourceRank = rankingSeedCandidates.length;
      for (const batch of scopedResults) {
        for (let localRank = 0; localRank < batch.length; localRank++) {
          const result = batch[localRank];
          taskRelevantScopeIds.add(result.symbolId);
          scopedSeeds.push({
            contextRef: `symbol:${result.symbolId}`,
            source: "lexical",
            score: 1 - localRank / Math.max(1, batch.length),
            sourceRank: sourceRank++,
          });
        }
      }
      rankingSeedCandidates = mergeContextSeedCandidates([
        ...rankingSeedCandidates,
        ...scopedSeeds,
      ]);
    }

    const anchorSymbolIds = rankingSeedCandidates
      .map((candidate) =>
        candidate.contextRef.startsWith("symbol:")
          ? candidate.contextRef.slice("symbol:".length)
          : undefined,
      )
      .filter((symbolId): symbolId is string => !!symbolId);

    let reviewImportance: Map<string, number> | undefined;
    if (
      task.taskType === "review" &&
      taskRelevantScopeIds.size > 0 &&
      this.dbQueries.getMetricsBySymbolIds
    ) {
      try {
        const metrics = await this.dbQueries.getMetricsBySymbolIds(
          await this.getConn(),
          [...taskRelevantScopeIds],
        );
        reviewImportance = computeReviewImportanceBySymbolId(
          [...taskRelevantScopeIds],
          metrics,
        );
      } catch (err) {
        logger.debug("Review importance lookup failed (non-fatal)", {
          repoId: task.repoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ranking = rankSymbols(candidateSymbolIds, symbolMap, identifiers, rankingTask, {
      seedCandidates: rankingSeedCandidates,
      anchorSymbolIds,
      feedbackBoosts,
      reviewImportance,
    });

    return selectFinalSymbols(ranking, symbolMap, rankingTask, maxCount);
  }

  private async buildRelatedSymbolNameMap(
    conn: Awaited<ReturnType<typeof getLadybugConn>>,
    selectedSymbols: SymbolRow[],
    task: AgentTask,
  ): Promise<Map<string, string[]>> {
    const shouldSurfaceRelated =
      task.options?.semantic === true ||
      (task.options?.inferredFocusPaths?.length ?? 0) > 0;
    if (!shouldSurfaceRelated || selectedSymbols.length === 0) {
      return new Map();
    }

    const inferredFocusPaths = task.options?.inferredFocusPaths ?? [];
    const identifiers = this.extractIdentifiersFromTask(task);
    const selectedByFile = new Map<string, Set<string>>();
    for (const symbol of selectedSymbols) {
      if (!symbol.fileId) continue;
      if (
        task.options?.semantic !== true &&
        inferredFocusPaths.length > 0 &&
        !inferredFocusPaths.some((focusPath) =>
          this.symbolMatchesFocusPath(symbol, focusPath),
        )
      ) {
        continue;
      }
      if (!selectedByFile.has(symbol.fileId)) {
        selectedByFile.set(symbol.fileId, new Set());
      }
      selectedByFile.get(symbol.fileId)!.add(symbol.symbolId);
      if (selectedByFile.size >= 6) break;
    }

    const relatedByFile = new Map<string, string[]>();
    let dependencySourceIds: string[] = [];
    let dependencyTargetFileId: string | undefined;
    for (const [fileId, selectedIds] of selectedByFile) {
      const fileSymbols = await this.dbQueries.getSymbolsByFile(conn, fileId);
      if (fileSymbols.length === 0) continue;
      const symbolIds = fileSymbols.map((symbol) => symbol.symbolId);
      const fileSymbolMap = new Map(
        fileSymbols.map((symbol) => [symbol.symbolId, symbol]),
      );
      const ranking = rankSymbols(symbolIds, fileSymbolMap, identifiers, task);
      const names: string[] = [];
      const seenNames = new Set<string>();
      const forcedSemantic = task.options?.semantic === true;
      const rankedLimit = forcedSemantic
        ? MAX_FORCED_SEMANTIC_RANKED_FILE_SYMBOLS
        : MAX_RELATED_SYMBOLS;
      for (const ranked of ranking.ranked) {
        if (selectedIds.has(ranked.symbolId)) continue;
        const symbol = fileSymbolMap.get(ranked.symbolId);
        if (!symbol || seenNames.has(symbol.name)) continue;
        seenNames.add(symbol.name);
        names.push(symbol.name);
        if (names.length >= rankedLimit) break;
      }
      if (forcedSemantic) {
        // Add source-order declarations after the query-ranked names so a
        // forced semantic card carries a compact, deterministic file outline.
        const sourceOrdered = [...fileSymbols].sort(
          (a, b) =>
            a.rangeStartLine - b.rangeStartLine ||
            a.rangeStartCol - b.rangeStartCol ||
            a.symbolId.localeCompare(b.symbolId),
        );
        for (const symbol of sourceOrdered) {
          if (
            !OUTLINE_DECLARATIVE_KINDS.has(symbol.kind) ||
            selectedIds.has(symbol.symbolId) ||
            seenNames.has(symbol.name)
          ) {
            continue;
          }
          seenNames.add(symbol.name);
          names.push(symbol.name);
          if (names.length >= MAX_FORCED_SEMANTIC_FILE_OUTLINE_SYMBOLS) break;
        }
        for (const symbol of sourceOrdered) {
          if (names.length >= MAX_FORCED_SEMANTIC_FILE_OUTLINE_SYMBOLS) break;
          if (selectedIds.has(symbol.symbolId) || seenNames.has(symbol.name)) {
            continue;
          }
          seenNames.add(symbol.name);
          names.push(symbol.name);
        }
        if (dependencySourceIds.length === 0) {
          dependencySourceIds = [
            ...new Set([
              ...selectedIds,
              ...ranking.ranked.map(({ symbolId }) => symbolId),
              ...sourceOrdered.map(({ symbolId }) => symbolId),
            ]),
          ];
          dependencyTargetFileId = fileId;
        }
      }
      if (names.length > 0) {
        relatedByFile.set(fileId, names);
      }
    }
    const getDependencies =
      this.dbQueries.getBoundedDependencySymbolsFromSources;
    if (
      getDependencies &&
      dependencyTargetFileId &&
      dependencySourceIds.length > 0
    ) {
      const edgeSources = dependencySourceIds.slice(
        0,
        MAX_FORCED_SEMANTIC_OUTLINE_EDGE_SOURCES,
      );

      try {
        const dependencySymbols = await getDependencies(
          conn,
          edgeSources,
          MAX_FORCED_SEMANTIC_OUTLINE_DEPENDENCY_CANDIDATES,
        );
        const dependencyIds = [...dependencySymbols.keys()];
        const dependencyRanking = rankSymbols(
          dependencyIds,
          dependencySymbols,
          identifiers,
          task,
        );
        const names = relatedByFile.get(dependencyTargetFileId) ?? [];
        const seenNames = new Set(names);
        let dependencyCount = 0;
        for (const ranked of dependencyRanking.ranked) {
          const symbol = dependencySymbols.get(ranked.symbolId);
          if (!symbol || seenNames.has(symbol.name)) continue;
          seenNames.add(symbol.name);
          names.push(symbol.name);
          dependencyCount++;
          if (
            dependencyCount >= MAX_FORCED_SEMANTIC_OUTLINE_DEPENDENCIES
          ) {
            break;
          }
        }
        if (names.length > 0) {
          relatedByFile.set(dependencyTargetFileId, names);
        }
      } catch (error) {
        logger.debug("Forced semantic dependency outline failed", {
          fileId: dependencyTargetFileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return relatedByFile;
  }

  private symbolMatchesFocusPath(
    symbol: SymbolRow | undefined,
    focusPath: string,
  ): boolean {
    const fileId = symbol?.fileId;
    if (!fileId) return false;
    const relPath = fileId.includes(":")
      ? fileId.slice(fileId.indexOf(":") + 1)
      : fileId;
    return pathMatchesFocus(relPath, [focusPath]);
  }

  private async executeCardRung(
    task: AgentTask,
    context: string[],
    seedCandidates: ContextSeedCandidate[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: rawSymbols, seedCandidates: expandedSeedCandidates } =
        await this.resolveContextToSymbols(
          context,
          task,
          seedCandidates,
        );
      // Precise scoped selection can contain every symbol in an exact file.
      // Keep card hydration bounded at the same moderate cap used by precise
      // adaptive ranking; broad mode retains the larger coverage cap.
      const cardSymbolLimit = computeCardRungSymbolLimit(
        task,
        expandedSeedCandidates,
      );

      let allSymbols =
        rawSymbols.length > 0 && task.taskText
          ? await this.selectTopSymbols(
              rawSymbols,
              task,
              cardSymbolLimit,
              expandedSeedCandidates,
            )
          : rawSymbols.slice(0, cardSymbolLimit);
      const strictExplicitPathScope =
        task.options?.contextMode === "precise" &&
        explicitFocusPaths(task.options).length > 0;
      let processedSymbolCount = 0;

      // Fallback: identifier-based search with per-term resolution
      if (
        allSymbols.length === 0 &&
        task.taskText &&
        !strictExplicitPathScope
      ) {
        // Broad mode gets higher limits to cover conceptual queries
        const isBroad = task.options?.contextMode !== "precise";
        const maxTerms = isBroad ? 8 : 5;
        const searchFallbackLimit = isBroad ? 20 : MAX_SEARCH_FALLBACK;

        // 1. Determine search terms: explicit searchTerms option > extracted identifiers
        const searchTerms = task.options?.searchTerms?.length
          ? task.options.searchTerms.slice(0, maxTerms)
          : this.extractIdentifiersFromTask(task).slice(0, maxTerms);

        const seen = new Set<string>();
        const useHybrid =
          task.options?.semantic !== false &&
          (await isHybridRetrievalAvailable());

        // 2. Search for each identifier individually and combine results
        for (const term of searchTerms) {
          if (useHybrid) {
            const hybridResult = await hybridSearch({
              repoId: task.repoId,
              query: term,
              limit: Math.ceil(
                searchFallbackLimit / Math.max(searchTerms.length, 1),
              ),
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
            const searchResults = await this.dbQueries.searchSymbols(
              conn,
              task.repoId,
              term,
              Math.ceil(searchFallbackLimit / Math.max(searchTerms.length, 1)),
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
              limit: searchFallbackLimit,
              includeEvidence: false,
            });
            for (const item of hybridResult.results) {
              allSymbols.push(item.symbolId);
            }
          } else {
            const conn = await this.getConn();
            const searchResults = await this.dbQueries.searchSymbols(
              conn,
              task.repoId,
              task.taskText,
              searchFallbackLimit,
            );
            for (const result of searchResults) {
              allSymbols.push(result.symbolId);
            }
          }
          logger.debug(
            "Fallback: full taskText search used (no identifier matches)",
            {
              taskText: task.taskText.slice(0, 100),
              resultCount: allSymbols.length,
            },
          );
        } else {
          logger.debug("Identifier-based search resolved symbols", {
            searchTerms,
            resultCount: allSymbols.length,
          });
        }

        // Feedback-aware boosting: reorder search results by score + boost
        let fallbackFeedbackBoosts: Map<string, number> | undefined;
        if (task.taskText && allSymbols.length > 0) {
          try {
            const feedbackConn = await this.getConn();
            const { boosts } = await queryFeedbackBoosts(feedbackConn, {
              repoId: task.repoId,
              query: task.taskText,
              limit: 5,
            });
            fallbackFeedbackBoosts = boosts;
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
              boosted.sort(
                (a, b) => (boosts.get(b) ?? 0) - (boosts.get(a) ?? 0),
              );
              allSymbols.length = 0;
              allSymbols.push(...boosted, ...unboosted);
              logger.debug(
                "Feedback boost reordered executor card search results",
                {
                  boostedCount: boosted.length,
                  totalCount: allSymbols.length,
                },
              );
            }
          } catch (err) {
            logger.debug(
              `[executor] Feedback boost reorder failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        allSymbols = await this.selectTopSymbols(
          allSymbols,
          task,
          cardSymbolLimit,
          [],
          fallbackFeedbackBoosts,
        );
      }

      if (allSymbols.length === 0) {
        if (!strictExplicitPathScope) {
          this.evidenceCapture.captureSearchResult(task.taskText, 0);
        }
      } else {
        const conn = await this.getConn();
        const resolved = await this.resolveVisibleSymbols(
          task.repoId,
          allSymbols,
        );
        const resolvedItems = selectBoundedCardEvidenceItems(
          resolved.items
            .filter((item) => item.status === "resolved")
            .map((item) => ({
              ...item,
              fileId: item.file?.fileId ?? item.symbol.fileId,
            })),
          // Preserve original named/action seeds only. Graph-expanded direct
          // context is useful ranking input but must not bypass the file cap.
          highConfidenceNamedSymbolIds(seedCandidates),
          MAX_CARD_SYMBOLS_PER_FILE,
        );
        const resolvedSymbolIds = resolvedItems.map((item) => item.symbolId);
        const symbolMap = new Map(
          resolvedItems.map((item) => [item.symbolId, item.symbol]),
        );
        const fileBySymbolId = new Map(
          resolvedItems.map((item) => [item.symbolId, item.file]),
        );
        processedSymbolCount = resolvedSymbolIds.length;
        let outlineSymbols = [...symbolMap.values()];
        if (task.options?.semantic === true) {
          // Persisted file IDs are opaque. Repository paths plus source ranges
          // provide a stable outline order without changing omitted/false mode.
          outlineSymbols = outlineSymbols.sort((a, b) => {
            const aPath = fileBySymbolId.get(a.symbolId)?.relPath ?? a.fileId;
            const bPath = fileBySymbolId.get(b.symbolId)?.relPath ?? b.fileId;
            return (
              aPath.localeCompare(bPath) ||
              a.rangeStartLine - b.rangeStartLine ||
              a.rangeStartCol - b.rangeStartCol ||
              a.symbolId.localeCompare(b.symbolId)
            );
          });
        }
        const relatedSymbolsByFile = await this.buildRelatedSymbolNameMap(
          conn,
          outlineSymbols,
          task,
        );
        const surfacedSemanticOutlines = new Set<string>();

        // Iterate in ranked order to preserve relevance in evidence
        for (const symbolId of resolvedSymbolIds) {
          const sym = symbolMap.get(symbolId);
          if (!sym) continue;
          // Track cache hits for repeated symbol lookups
          if (this.cardCache.has(sym.symbolId)) {
            this.metrics.cacheHits++;
          } else {
            this.cardCache.add(sym.symbolId);
          }
          const relPath = fileBySymbolId.get(symbolId)?.relPath;
          const parts: string[] = [`${sym.kind} ${sym.name}`];
          if (relPath) parts.push(relPath);
          const fileAlias = this.fileAliasForPath(relPath);
          if (fileAlias && fileAlias !== sym.name) {
            parts.push(`fileAlias: ${fileAlias}`);
          }
          const relatedSymbols = sym.fileId
            ? relatedSymbolsByFile.get(sym.fileId)
            : undefined;
          const shouldSurfaceRelated =
            relatedSymbols &&
            relatedSymbols.length > 0 &&
            (task.options?.semantic !== true ||
              !surfacedSemanticOutlines.has(sym.fileId));
          if (shouldSurfaceRelated) {
            parts.push(`relatedSymbols: ${relatedSymbols.join(", ")}`);
            surfacedSemanticOutlines.add(sym.fileId);
          }
          if (sym.signatureJson) {
            try {
              const sig = JSON.parse(sym.signatureJson);
              if (sig.text) parts.push(`sig: ${sig.text}`);
            } catch (err) {
              logger.debug("Failed to parse signature JSON", {
                error: String(err),
              });
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
        status: processedSymbolCount > 0 ? "completed" : "failed",
        input: { context },
        output: { cardsProcessed: processedSymbolCount },
        timestamp: startTime,
        durationMs: Date.now() - startTime,
        evidence: [
          ...this.evidenceCapture.getEvidenceByType("symbolCard"),
          ...this.evidenceCapture.getEvidenceByType("searchResult"),
        ],
      };
      this.actions.push(action);
      if (processedSymbolCount > 0) {
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
    seedCandidates: ContextSeedCandidate[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const {
        symbolIds: rawSkeletonSymbols,
        filePaths,
        seedCandidates: expandedSeedCandidates,
      } = await this.resolveContextToSymbols(
        context,
        task,
        seedCandidates,
      );

      const skeletonSymbolLimit = computeEvidenceRungSymbolLimit(
        task,
        expandedSeedCandidates,
        this.rungSymbolLimit(task, MAX_SKELETON_SYMBOLS),
      );
      const symbolIds =
        rawSkeletonSymbols.length > 0 && task.taskText
          ? await this.selectTopSymbols(
              rawSkeletonSymbols,
              task,
              skeletonSymbolLimit,
              expandedSeedCandidates,
            )
          : rawSkeletonSymbols.slice(0, skeletonSymbolLimit);

      let processedCount = 0;
      const hydrateEvidencePrefixes = this.shouldHydrateEvidencePrefixes(task);
      const resolved = await this.resolveVisibleSymbols(task.repoId, symbolIds);
      const visibleItems = resolved.items.filter(
        (item) => item.status === "resolved",
      );
      const symbolMap = hydrateEvidencePrefixes
        ? new Map(
            visibleItems.map((item) => [
              item.symbolId,
              item.file
                ? { ...item.symbol, fileId: item.file.relPath }
                : item.symbol,
            ]),
          )
        : new Map<string, SymbolRow>();

      // Generate skeletons for symbol IDs (skip degenerate < 10 tokens)
      for (const { symbolId } of visibleItems) {
        try {
          const result = await generateSkeletonIR(task.repoId, symbolId, {});
          if (result && result.estimatedTokens >= 10) {
            const prefix = this.formatSymbolEvidencePrefix(
              symbolMap.get(symbolId),
            );
            this.evidenceCapture.captureSkeleton(
              symbolId,
              `${prefix} | Skeleton (${result.originalLines} lines, ~${result.estimatedTokens} tokens): ${buildSkeletonEvidenceExcerpt(result.skeletonText, task.taskText)}`,
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
      const isPreciseSkeleton = task.options?.contextMode === "precise";
      const maxFileSks = isPreciseSkeleton
        ? 0
        : processedCount > 0
          ? 1
          : skeletonSymbolLimit;
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
              `File skeleton (${result.originalLines} lines, ~${result.estimatedTokens} tokens): ${buildSkeletonEvidenceExcerpt(result.skeleton, task.taskText)}`,
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
    seedCandidates: ContextSeedCandidate[],
  ): Promise<void> {
    const actionId = this.generateActionId();
    const startTime = Date.now();

    try {
      const { symbolIds: rawHotpathSymbols, seedCandidates: expandedSeedCandidates } =
        await this.resolveContextToSymbols(
          context,
          task,
          seedCandidates,
        );

      const hotPathSymbolLimit = this.rungSymbolLimit(
        task,
        MAX_HOTPATH_SYMBOLS,
      );
      const symbols =
        rawHotpathSymbols.length > 0 && task.taskText
          ? await this.selectTopSymbols(
              rawHotpathSymbols,
              task,
              hotPathSymbolLimit,
              expandedSeedCandidates,
            )
          : rawHotpathSymbols.slice(0, hotPathSymbolLimit);

      const identifiers = this.extractIdentifiersFromTask(task);

      let processedCount = 0;
      const hydrateEvidencePrefixes = this.shouldHydrateEvidencePrefixes(task);
      const resolved = await this.resolveVisibleSymbols(task.repoId, symbols);
      const visibleItems = resolved.items.filter(
        (item) => item.status === "resolved",
      );
      const symbolMap = hydrateEvidencePrefixes
        ? new Map(
            visibleItems.map((item) => [
              item.symbolId,
              item.file
                ? { ...item.symbol, fileId: item.file.relPath }
                : item.symbol,
            ]),
          )
        : new Map<string, SymbolRow>();

      for (const { symbolId } of visibleItems) {
        try {
          const result = await extractHotPath(
            task.repoId,
            symbolId,
            identifiers,
            {},
          );
          if (result) {
            const prefix = this.formatSymbolEvidencePrefix(
              symbolMap.get(symbolId),
            );
            this.evidenceCapture.captureHotPath(
              symbolId,
              `${prefix} | Hot path (${result.matchedIdentifiers.length} matches, ~${result.estimatedTokens} tokens): ${result.excerpt.slice(0, 200)}`,
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
      const { symbolIds: rawSymbols } = await this.resolveContextToSymbols(
        context,
        task,
      );
      // Raw access must honor the same explicit path contract as the cheaper
      // rungs. This is especially important during dynamic escalation, where
      // raw was not necessarily part of the original plan.
      const symbols =
        explicitFocusPaths(task.options).length > 0
          ? await this.selectTopSymbols(rawSymbols, task, MAX_RAW_SYMBOLS)
          : rawSymbols.slice(0, MAX_RAW_SYMBOLS);
      const identifiers = this.extractIdentifiersFromTask(task);

      let processedCount = 0;

      for (const symbolId of symbols) {
        // Check top-level policy deny. Finer-grained downgrades
        // (downgrade-to-skeleton, downgrade-to-hotpath) are enforced by
        // the gate evaluator (decide → enforce) rather than the executor,
        // so only an explicit "deny" is blocked here.
        let rawAccessAllowed = true;

        const policyContext: PolicyRequestContext = {
          requestType: "codeWindow",
          repoId: task.repoId,
          symbolId,
        };

        const policyDecision = decideCodeAccess(policyContext);
        this.policyDecisions.set(`${actionId}:${symbolId}`, policyDecision);

        if (policyDecision.kind === "deny") {
          rawAccessAllowed = false;
          this.evidenceCapture.captureDiagnostic(
            symbolId,
            0,
            `Raw code access denied by policy: ${policyDecision.deniedReasons?.join(", ") ?? "no reason"}`,
          );
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
    const identifiers = extractIdentifiersFromText(
      task.taskText,
      task.taskText,
    );

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

  private fileAliasForPath(relPath: string | undefined): string | undefined {
    if (!relPath) return undefined;
    const parts = relPath.split(/[\\/]+/).filter(Boolean);
    const fileName = parts.at(-1);
    if (!fileName) return undefined;
    const base = fileName.replace(/\.[^.]+$/, "");
    const parent = parts.length >= 2 ? parts.at(-2) : undefined;
    const aliasBase =
      parent && GENERIC_FILE_BASENAMES.has(base.toLowerCase())
        ? `${parent}-${base}`
        : base;
    const words = aliasBase
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    if (words.length === 0) return undefined;
    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  }

  private formatSymbolEvidencePrefix(
    sym:
      | {
          kind: string;
          name: string;
          fileId?: string;
        }
      | undefined,
  ): string {
    if (!sym) return "symbol";
    const relPath = sym.fileId?.includes(":")
      ? sym.fileId.slice(sym.fileId.indexOf(":") + 1)
      : sym.fileId;
    const parts = [`${sym.kind} ${sym.name}`];
    if (relPath) parts.push(relPath);
    const fileAlias = this.fileAliasForPath(relPath);
    if (fileAlias && fileAlias !== sym.name) {
      parts.push(`fileAlias: ${fileAlias}`);
    }
    return parts.join(" | ");
  }

  private shouldHydrateEvidencePrefixes(task: AgentTask): boolean {
    const hasExplicitScope = !!(
      task.options?.focusPaths?.length || task.options?.focusSymbols?.length
    );
    return task.options?.semantic === true || !hasExplicitScope;
  }

  private rungSymbolLimit(task: AgentTask, defaultMax: number): number {
    const hasExplicitScope = !!(
      task.options?.focusPaths?.length || task.options?.focusSymbols?.length
    );
    const hasInferredScope = (task.options?.inferredFocusPaths?.length ?? 0) > 0;
    if (
      task.options?.contextMode === "precise" &&
      hasExplicitScope &&
      !hasInferredScope &&
      task.options?.semantic !== true
    ) {
      return Math.min(2, defaultMax);
    }
    return defaultMax;
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
    this.overlaySnapshots.clear();
    // connPromise references a shared pool connection from getLadybugConn();
    // dropping the reference is safe — the pool manages connection lifecycle.
    this.connPromise = null;
  }
}
