import * as crypto from "crypto";
import type { Connection } from "kuzu";
import type { RepoId, SymbolId } from "../db/schema.js";
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

export async function computeBlastRadius(
  conn: Connection,
  changedSymbols: SymbolId[],
  options?: BlastRadiusOptions,
): Promise<BlastRadiusItem[]> {
  const maxHops = options?.maxHops ?? 3;
  const maxResults = options?.maxResults ?? 20;
  const repoId = options?.repoId;

  if (maxHops <= 0) {
    logger.warn("Invalid maxHops value, using default of 3", { maxHops });
    return [];
  }

  if (changedSymbols.length === 0) {
    return [];
  }

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
      const relPath = symbol ? filesMap.get(symbol.fileId)?.relPath : null;
      const testProximity = relPath && isTestFile(relPath) ? 1 : 0;

      const normalizedDistance = 1 - distance / safeMaxHops;
      const normalizedFanIn = Math.log(fanIn + 1) / Math.log(100);
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
  } catch {
    // graceful degradation without process data
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
  for (const item of processDependents) {
    mergedBySymbol.set(item.symbolId, item);
  }
  for (const item of graphDependents) {
    mergedBySymbol.set(item.symbolId, item);
  }

  const mergedDependents = Array.from(mergedBySymbol.values());
  if (mergedDependents.length === 0) {
    return [];
  }

  const ranked = rankDependents(mergedDependents).slice(0, safeMaxResults);

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

  return ranked;
}

export function rankDependents(
  dependents: BlastRadiusItem[],
): BlastRadiusItem[] {
  return dependents.sort((a, b) => b.rank - a.rank);
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
      const startTime = Date.now();

      const { suspects } = await runDiagnosticsWithTimeout(options.repoId, timeoutMs);

      if (Date.now() - startTime <= timeoutMs) {
        diagnosticSuspects = suspects;
      }
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
  _timeoutMs: number,
): Promise<{ suspects: DiagnosticSuspect[] }> {
  const { getDiagnosticsWithSuspects } = await import("../ts/mapping.js");
  const { suspects } = await getDiagnosticsWithSuspects(repoId);
  return { suspects };
}

function applyBudgetedSelection(
  blastRadius: BlastRadiusItem[],
  budget: SliceBudget,
  symbolsById: Map<string, { name: string; signatureJson: string | null; summary: string | null }>,
): { trimmedSet: TrimmedSet; spilloverHandle: SpilloverHandle | null } {
  const maxCards = budget.maxCards ?? DEFAULT_MAX_CARDS;
  const maxTokens = budget.maxEstimatedTokens ?? DEFAULT_MAX_TOKENS_SLICE;

  if (maxCards <= 0 || maxTokens <= 0) {
    logger.warn("Invalid budget values detected, using defaults", {
      providedMaxCards: budget.maxCards,
      providedMaxTokens: budget.maxEstimatedTokens,
      usingMaxCards: maxCards,
      usingMaxTokens: maxTokens,
    });
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
