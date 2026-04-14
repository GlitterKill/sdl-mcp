import * as crypto from "crypto";
import type { Connection } from "kuzu";
import type { RepoId, SymbolId } from "../domain/types.js";
import {
  batchComputeFanInOut,
  batchGetFanInAtVersion,
  getEdgesToSymbols,
  getFilesByIds,
  getProcessStepsAfterSymbol,
  getProcessesForSymbol,
  getSymbolsByIds,
} from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";
import { DatabaseError } from "../domain/errors.js";
import { shortestPath } from "../db/ladybug-algorithms.js";
import type {
  BlastRadiusItem,
  DiagnosticSuspect,
  TrimmedSet,
  SpilloverHandle,
  SliceBudget,
} from "../domain/types.js";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
  FAN_IN_AMPLIFIER_THRESHOLD,
} from "../config/constants.js";

// --- Blast Radius Cache ---
// Cache blast radius results for repeated queries (e.g., during PR review iterations)
interface BlastRadiusCacheEntry {
  result: BlastRadiusItem[];
  timestamp: number;
}

const blastRadiusCache = new Map<string, BlastRadiusCacheEntry>();
const BLAST_RADIUS_CACHE_TTL_MS = 60_000; // 1 minute TTL
const BLAST_RADIUS_CACHE_MAX_ENTRIES = 50;

function computeBlastRadiusCacheKey(
  repoId: RepoId,
  changedSymbols: SymbolId[],
  options: BlastRadiusOptions,
): string {
  const sortedSymbols = [...changedSymbols].sort().join(",");
  const optionsKey = `${options.maxHops ?? 3}-${options.maxResults ?? 20}-${options.fromVersionId ?? ""}-${options.toVersionId ?? ""}`;
  return crypto.createHash("sha256").update(`${repoId}:${sortedSymbols}:${optionsKey}`).digest("hex").slice(0, 16);
}

function getCachedBlastRadius(key: string): BlastRadiusItem[] | null {
  const entry = blastRadiusCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > BLAST_RADIUS_CACHE_TTL_MS) {
    blastRadiusCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedBlastRadius(key: string, result: BlastRadiusItem[]): void {
  // Evict oldest entries if cache is full
  if (blastRadiusCache.size >= BLAST_RADIUS_CACHE_MAX_ENTRIES) {
    const oldestKey = blastRadiusCache.keys().next().value;
    if (oldestKey) blastRadiusCache.delete(oldestKey);
  }
  blastRadiusCache.set(key, { result, timestamp: Date.now() });
}

export interface BlastRadiusOptions {
  maxHops?: number;
  maxResults?: number;
  repoId?: RepoId;
  fromVersionId?: string;
  toVersionId?: string;
}

export interface GovernorLoopOptions {
  repoId: RepoId;
  budget?: SliceBudget;
  maxHops?: number;
  runDiagnostics?: boolean;
  diagnosticsTimeoutMs?: number;
  fromVersionId?: string;
  toVersionId?: string;
}

export interface GovernorLoopResult {
  blastRadius: BlastRadiusItem[];
  trimmedSet: TrimmedSet;
  spilloverHandle: SpilloverHandle | null;
}

interface DependentMetrics {
  distance: number;
}

interface ProcessDependentMetrics {
  distance: number;
  rank: number;
  reason: string;
}

function assertSafeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DatabaseError(`${name} must be a safe integer, got: ${String(value)}`);
  }
}

/**
 * Task 5: internal cap on how many top-ranked blast-radius items
 * receive minimal dependency-chain explanations. Kept small so
 * shortest-path lookups cannot dominate delta.get / pr.risk.analyze
 * latency on large impact sets.
 */
export const BLAST_RADIUS_PATH_TOP_N = 10;

/**
 * Task 5 internal helper: select the minimal dependency chain from
 * a target impacted symbol back to any changed/entry symbol.
 *
 * Blast radius is built by reverse-edge traversal, so the explanatory
 * dependency chain is naturally `impacted -> ... -> changed`, not the
 * other way around. Picks the SHORTEST path across all sources and respects the
 * provided hop cap. Returns null when no path is found within the
 * hop budget — callers must treat absence as a soft signal, never
 * as a failure.
 *
 * Protected: all errors from the adapter are caught so that the
 * main blast-radius computation cannot be impacted by path-lookup
 * failures (see Task 5 acceptance criteria).
 */
export async function selectMinimalPathExplanation(
  conn: Connection,
  repoId: RepoId,
  sources: SymbolId[],
  target: SymbolId,
  maxHops: number,
): Promise<SymbolId[] | null> {
  if (sources.length === 0) return null;
  if (sources.includes(target)) return [target];
  let best: SymbolId[] | null = null;
  for (const source of sources) {
    try {
      const path = await shortestPath(conn, repoId, target, source, maxHops);
      if (!path || path.length === 0) continue;
      if (path.length > maxHops + 1) continue;
      if (!best || path.length < best.length) {
        best = path as SymbolId[];
      }
    } catch (err) {
      logger.debug("blastRadius: path explanation lookup failed", {
        source,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }
  return best;
}

/**
 * Task 5 internal helper: attach minimal dependency-chain
 * explanations to the top-ranked blast-radius items plus all
 * "must"-priority items. Bounded by BLAST_RADIUS_PATH_TOP_N to
 * keep latency stable on large impact sets.
 *
 * Mutates the passed items in place for token efficiency. Errors
 * are swallowed — explanation attachment is strictly additive.
 */
export async function attachPathExplanations(
  conn: Connection,
  repoId: RepoId,
  changedSymbols: SymbolId[],
  items: BlastRadiusItem[],
  maxHops: number,
): Promise<void> {
  try {
    const mustPriority = items.filter((i) => i.signal === "directDependent");
    const topN = items.slice(0, BLAST_RADIUS_PATH_TOP_N);
    const seen = new Set<string>();
    const targets: BlastRadiusItem[] = [];
    for (const item of [...mustPriority, ...topN]) {
      if (seen.has(item.symbolId)) continue;
      seen.add(item.symbolId);
      targets.push(item);
    }
    for (const item of targets) {
      const path = await selectMinimalPathExplanation(
        conn,
        repoId,
        changedSymbols,
        item.symbolId,
        maxHops,
      );
      if (path && path.length > 0) {
        item.explanationPath = path;
      }
    }
  } catch (err) {
    logger.debug("blastRadius: attachPathExplanations bailed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
export async function computeBlastRadius(
  conn: Connection,
  changedSymbols: SymbolId[],
  options?: BlastRadiusOptions,
): Promise<BlastRadiusItem[]> {
  const startTime = Date.now();
  let maxHops = options?.maxHops ?? 3;
  const maxResults = options?.maxResults ?? 20;
  const repoId = options?.repoId;

  if (!repoId) {
    throw new Error("repoId is required for blast radius computation");
  }

  if (maxHops <= 0) {
    logger.warn("Invalid maxHops value, using default of 3", { maxHops });
    maxHops = 3;
  }

  if (changedSymbols.length === 0) {
    return [];
  }

  // Check cache first
  const cacheKey = computeBlastRadiusCacheKey(repoId, changedSymbols, options ?? {});
  const cached = getCachedBlastRadius(cacheKey);
  if (cached) {
    logger.debug("Blast radius cache hit", {
      repoId,
      changedSymbols: changedSymbols.length,
      resultCount: cached.length,
      durationMs: Date.now() - startTime,
    });
    return cached;
  }

  logger.debug("Computing blast radius", {
    repoId,
    changedSymbols: changedSymbols.length,
    maxHops,
    maxResults,
  });

  assertSafeInt(maxHops, "maxHops");
  assertSafeInt(maxResults, "maxResults");

  const safeMaxHops = Math.max(1, Math.min(maxHops, 10));
  const safeMaxResults = Math.max(0, Math.min(maxResults, 5000));

  const changedSet = new Set(changedSymbols);
  const visited = new Set<SymbolId>(changedSet);
  const distanceBySymbol = new Map<SymbolId, DependentMetrics>();

  let frontier: SymbolId[] = Array.from(changedSet);

  for (let distance = 1; distance <= safeMaxHops; distance++) {
    if (frontier.length === 0) break;

    const incoming = await getEdgesToSymbols(conn, frontier);
    const nextFrontier: SymbolId[] = [];

    for (const edges of incoming.values()) {
      for (const edge of edges) {
        if (repoId && edge.repoId !== repoId) continue;

        const dependentId = edge.fromSymbolId;
        if (changedSet.has(dependentId)) continue;
        if (visited.has(dependentId)) continue;

        visited.add(dependentId);
        distanceBySymbol.set(dependentId, { distance });
        nextFrontier.push(dependentId);
      }
    }

    frontier = nextFrontier;
  }

  const dependentIds = Array.from(distanceBySymbol.keys());
  const graphDependents: BlastRadiusItem[] = [];

  if (dependentIds.length > 0) {
    const fanInOutMap = await batchComputeFanInOut(conn, dependentIds);
    const symbolsMap = await getSymbolsByIds(conn, dependentIds);

    const fileIds = new Set<string>();
    for (const symbol of symbolsMap.values()) {
      fileIds.add(symbol.fileId);
    }
    const filesMap = await getFilesByIds(conn, Array.from(fileIds));

    for (const [symbolId, { distance }] of distanceBySymbol) {
      const fanIn = fanInOutMap.get(symbolId)?.fanIn ?? 0;
      const symbol = symbolsMap.get(symbolId);
      // External symbols (from SCIP) cannot be impacted by local changes
      if (symbol?.external) continue;
      const relPath = symbol ? filesMap.get(symbol.fileId)?.relPath : null;
      const testProximity = relPath && isTestFile(relPath) ? 1 : 0;

      const normalizedDistance = Math.max(0, 1 - distance / safeMaxHops);
      const normalizedFanIn = Math.min(1, Math.log(fanIn + 1) / Math.log(100));
      const rank =
        0.6 * normalizedDistance +
        0.3 * normalizedFanIn +
        0.1 * testProximity;

      const reason =
        distance === 1 ? "calls changed symbol" : "dependency of changed symbol";

      const signal: BlastRadiusItem["signal"] =
        distance === 1 ? "directDependent" : "graph";

      graphDependents.push({
        symbolId,
        reason,
        distance,
        rank: Math.max(0, Math.min(1, rank)),
        signal,
      });
    }
  }

  const processDependentsBySymbol = new Map<SymbolId, ProcessDependentMetrics>();

  // TODO: Batch process lookups for all changed symbols in a single query
  // to reduce O(N) sequential DB round trips per changed symbol.
  try {
    for (const changedSymbolId of changedSet) {
      const processes = await getProcessesForSymbol(conn, changedSymbolId);
      for (const proc of processes) {
        const downstream = await getProcessStepsAfterSymbol(
          conn,
          proc.processId,
          changedSymbolId,
        );

        for (const step of downstream) {
          const symbolId = step.symbolId;
          if (changedSet.has(symbolId)) continue;

          const stepDistance = step.stepOrder - proc.stepOrder;
          if (stepDistance <= 0) continue;

          const existing = processDependentsBySymbol.get(symbolId);
          if (existing && existing.distance <= stepDistance) continue;

          const rank = Math.max(0, Math.min(1, 1 - stepDistance / 20));
          processDependentsBySymbol.set(symbolId, {
            distance: stepDistance,
            rank,
            reason: `downstream in ${proc.label}`,
          });
        }
      }
    }
  } catch (error) {
    logger.debug("Process-based dependency expansion unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const processDependents: BlastRadiusItem[] = Array.from(
    processDependentsBySymbol.entries(),
  ).map(([symbolId, info]) => ({
    symbolId,
    reason: info.reason,
    distance: info.distance,
    rank: info.rank,
    signal: "process" as const,
  }));

  const mergedBySymbol = new Map<SymbolId, BlastRadiusItem>();
  for (const item of [...processDependents, ...graphDependents]) {
    const existing = mergedBySymbol.get(item.symbolId);
    if (!existing || item.rank > existing.rank) {
      mergedBySymbol.set(item.symbolId, item);
    }
  }

  const mergedDependents = Array.from(mergedBySymbol.values());
  if (mergedDependents.length === 0) {
    return [];
  }

  let filteredDependents = mergedDependents;
  if (repoId) {
    const dependentSymbols = await getSymbolsByIds(
      conn,
      mergedDependents.map((item) => item.symbolId),
    );
    filteredDependents = mergedDependents.filter(
      (item) => dependentSymbols.get(item.symbolId)?.repoId === repoId,
    );
  }
  if (filteredDependents.length === 0) {
    return [];
  }

  const ranked = rankDependents(filteredDependents).slice(0, safeMaxResults);

  // Attach fan-in trend data when version IDs are provided
  const { fromVersionId, toVersionId } = options ?? {};
  if (fromVersionId && toVersionId && repoId) {
    const rankedSymbolIds = ranked.map((item) => item.symbolId);
    const [previousMap, currentMap] = await Promise.all([
      batchGetFanInAtVersion(conn, repoId, rankedSymbolIds, fromVersionId),
      batchGetFanInAtVersion(conn, repoId, rankedSymbolIds, toVersionId),
    ]);

    for (const item of ranked) {
      const previous = previousMap.get(item.symbolId) ?? 0;
      const current = currentMap.get(item.symbolId) ?? 0;
      const growthRate = (current - previous) / Math.max(previous, 1);

      if (growthRate !== 0) {
        item.fanInTrend = {
          previous,
          current,
          growthRate,
          isAmplifier: growthRate > FAN_IN_AMPLIFIER_THRESHOLD,
        };
      }
    }

    // Re-sort: amplifiers first within same distance tier, then existing order
    ranked.sort((a, b) => {
      if (a.distance !== b.distance) {
        return a.distance - b.distance;
      }
      const aAmplifier = a.fanInTrend?.isAmplifier ? 1 : 0;
      const bAmplifier = b.fanInTrend?.isAmplifier ? 1 : 0;
      if (aAmplifier !== bAmplifier) {
        return bAmplifier - aAmplifier; // amplifiers first
      }
      return b.rank - a.rank;
    });
  }

  // Task 5: attach minimal dependency-chain explanations to the
  // top-ranked items. Strictly additive; errors are swallowed by
  // attachPathExplanations so this cannot regress the main flow.
  if (repoId) {
    await attachPathExplanations(
      conn,
      repoId,
      changedSymbols,
      ranked,
      Math.max(2, Math.min(maxHops, 6)),
    );
  }

  // Cache and log timing before returning
  setCachedBlastRadius(cacheKey, ranked);
  const durationMs = Date.now() - startTime;
  if (durationMs > 5000) {
    logger.warn("Slow blast radius computation", {
      repoId,
      changedSymbols: changedSymbols.length,
      resultCount: ranked.length,
      durationMs,
      hint: "Consider using preview mode or skipBlastRadius for large deltas",
    });
  } else {
    logger.debug("Blast radius computed", {
      repoId,
      changedSymbols: changedSymbols.length,
      resultCount: ranked.length,
      durationMs,
    });
  }

  return ranked;
}

export function rankDependents(
  dependents: BlastRadiusItem[],
): BlastRadiusItem[] {
  return dependents.sort((a, b) => b.rank - a.rank || a.symbolId.localeCompare(b.symbolId));
}

export function mergeBlastRadiusWithDiagnostics(
  graphBlastRadius: BlastRadiusItem[],
  diagnosticSuspects: DiagnosticSuspect[],
  maxResults: number = 20,
): BlastRadiusItem[] {
  const suspectSymbolIds = new Set(diagnosticSuspects.map((d) => d.symbolId));

  const diagnosticItems: BlastRadiusItem[] = diagnosticSuspects.map(
    (suspect) => ({
      symbolId: suspect.symbolId,
      reason: `TypeScript ${suspect.code}: ${suspect.messageShort}`,
      distance: 0,
      rank: 1.0,
      signal: "diagnostic" as const,
    }),
  );

  const graphItems = graphBlastRadius.filter(
    (item) => !suspectSymbolIds.has(item.symbolId),
  );

  const merged = [...diagnosticItems, ...graphItems];

  return merged.slice(0, maxResults);
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.tsx") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.tsx") ||
    filePath.includes("__tests__")
  );
}

function generateSpilloverHandle(): SpilloverHandle {
  return crypto.randomBytes(16).toString("hex");
}

export async function runGovernorLoop(
  conn: Connection,
  changedSymbols: SymbolId[],
  options: GovernorLoopOptions,
): Promise<GovernorLoopResult> {
  const budget = options.budget ?? {
    maxCards: DEFAULT_MAX_CARDS,
    maxEstimatedTokens: DEFAULT_MAX_TOKENS_SLICE,
  };
  const maxHops = options.maxHops ?? 3;
  const maxBlastRadius = budget.maxCards ?? DEFAULT_MAX_CARDS;

  const candidateBlastRadius = await computeBlastRadius(conn, changedSymbols, {
    maxHops,
    maxResults: maxBlastRadius * 2,
    repoId: options.repoId,
    fromVersionId: options.fromVersionId,
    toVersionId: options.toVersionId,
  });

  let diagnosticSuspects: DiagnosticSuspect[] = [];

  if (
    options.runDiagnostics !== false &&
    candidateBlastRadius.length > maxBlastRadius * 0.8
  ) {
    try {
      const timeoutMs = options.diagnosticsTimeoutMs ?? 5000;

      const { suspects } = await runDiagnosticsWithTimeout(options.repoId, timeoutMs);
      diagnosticSuspects = suspects;
    } catch (error) {
      logger.warn("Failed to run diagnostics with timeout", {
        repoId: options.repoId,
        error: String(error),
      });
    }
  }

  const mergedBlastRadius = mergeBlastRadiusWithDiagnostics(
    candidateBlastRadius,
    diagnosticSuspects,
    maxBlastRadius * 2,
  );

  const symbolIdsForBudget = Array.from(
    new Set(mergedBlastRadius.map((item) => item.symbolId)),
  );
  const symbolsById = await getSymbolsByIds(conn, symbolIdsForBudget);

  const { trimmedSet, spilloverHandle } = applyBudgetedSelection(
    mergedBlastRadius,
    budget,
    symbolsById,
  );

  const finalBlastRadius = trimmedBlastRadius(mergedBlastRadius, trimmedSet);

  return {
    blastRadius: finalBlastRadius,
    trimmedSet,
    spilloverHandle,
  };
}

async function runDiagnosticsWithTimeout(
  repoId: RepoId,
  timeoutMs: number,
): Promise<{ suspects: DiagnosticSuspect[] }> {
  const { getDiagnosticsWithSuspects } = await import("../ts/mapping.js");
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      getDiagnosticsWithSuspects(repoId),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Diagnostics timeout")),
          timeoutMs,
        );
        timeoutHandle.unref();
      }),
    ]);
    return { suspects: result.suspects };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function applyBudgetedSelection(
  blastRadius: BlastRadiusItem[],
  budget: SliceBudget,
  symbolsById: Map<string, { name: string; signatureJson: string | null; summary: string | null }>,
  _depth = 0,
): { trimmedSet: TrimmedSet; spilloverHandle: SpilloverHandle | null } {
  const maxCards = budget.maxCards ?? DEFAULT_MAX_CARDS;
  const maxTokens = budget.maxEstimatedTokens ?? DEFAULT_MAX_TOKENS_SLICE;

  if (maxCards <= 0 || maxTokens <= 0) {
    const effectiveMaxCards = maxCards <= 0 ? DEFAULT_MAX_CARDS : maxCards;
    const effectiveMaxTokens = maxTokens <= 0 ? DEFAULT_MAX_TOKENS_SLICE : maxTokens;
    logger.warn("Invalid budget values detected, using defaults", {
      providedMaxCards: budget.maxCards,
      providedMaxTokens: budget.maxEstimatedTokens,
      usingMaxCards: effectiveMaxCards,
      usingMaxTokens: effectiveMaxTokens,
    });
    if (_depth > 0) {
      throw new Error("Budget defaults also invalid");
    }
    return applyBudgetedSelection(
      blastRadius,
      { maxCards: effectiveMaxCards, maxEstimatedTokens: effectiveMaxTokens },
      symbolsById,
      _depth + 1,
    );
  }

  const prioritized = prioritizeBlastRadius(blastRadius);

  let currentTokens = 0;
  const keptSymbols: SymbolId[] = [];
  const droppedSymbols: Array<{
    symbolId: SymbolId;
    reason: string;
    priority: "must" | "should" | "optional";
  }> = [];

  for (const item of prioritized) {
    const symbol = symbolsById.get(item.symbolId);
    const estimatedTokens = symbol ? estimateSymbolTokens(symbol) : 50;

    if (
      keptSymbols.length >= maxCards ||
      currentTokens + estimatedTokens > maxTokens
    ) {
      droppedSymbols.push({
        symbolId: item.symbolId,
        reason: item.reason ?? "",
        priority: item.priority,
      });
    } else {
      keptSymbols.push(item.symbolId);
      currentTokens += estimatedTokens;
    }
  }

  const trimmed = droppedSymbols.length > 0;
  let spilloverHandle: SpilloverHandle | null = null;

  if (trimmed && droppedSymbols.length > 0) {
    spilloverHandle = generateSpilloverHandle();
  }

  const trimmedSet: TrimmedSet = {
    trimmed,
    keptSymbols,
    droppedSymbols,
    spilloverHandle,
  };

  return { trimmedSet, spilloverHandle };
}

function estimateSymbolTokens(symbol: {
  name: string;
  signatureJson: string | null;
  summary: string | null;
}): number {
  let tokens = 50;
  tokens += symbol.name.length / 4;

  if (symbol.signatureJson) {
    tokens += symbol.signatureJson.length / 4;
  }

  if (symbol.summary) {
    tokens += Math.min(symbol.summary.length / 4, 150);
  }

  return Math.ceil(tokens);
}

interface PrioritizedBlastRadiusItem extends BlastRadiusItem {
  priority: "must" | "should" | "optional";
}

function prioritizeBlastRadius(
  items: BlastRadiusItem[],
): PrioritizedBlastRadiusItem[] {
  const prioritized: PrioritizedBlastRadiusItem[] = [];

  for (const item of items) {
    let priority: "must" | "should" | "optional";

    if (item.signal === "diagnostic") {
      priority = "must";
    } else if (item.distance === 1 && item.signal === "directDependent") {
      priority = "must";
    } else if (item.signal === "process") {
      priority = "should";
    } else if (item.distance === 2) {
      priority = "should";
    } else {
      priority = "optional";
    }

    prioritized.push({
      ...item,
      priority,
    });
  }

  const priorityWeight = { must: 3, should: 2, optional: 1 };

  return prioritized.sort((a, b) => {
    const priorityDiff = priorityWeight[b.priority] - priorityWeight[a.priority];
    if (priorityDiff !== 0) return priorityDiff;

    const rankDiff = b.rank - a.rank;
    if (rankDiff !== 0) return rankDiff;

    const distanceDiff = a.distance - b.distance;
    if (distanceDiff !== 0) return distanceDiff;

    return a.symbolId.localeCompare(b.symbolId);
  });
}

function trimmedBlastRadius(
  blastRadius: BlastRadiusItem[],
  trimmedSet: TrimmedSet,
): BlastRadiusItem[] {
  const keptSet = new Set(trimmedSet.keptSymbols);
  return blastRadius.filter((item) => keptSet.has(item.symbolId));
}
