import type { Graph } from "../graph/buildGraph.js";
import type { SymbolId, RepoId } from "../db/schema.js";
import { logger } from "../util/logger.js";
import type {
  BlastRadiusItem,
  DiagnosticSuspect,
  TrimmedSet,
  SpilloverHandle,
  SliceBudget,
} from "../mcp/types.js";
import { getNeighbors } from "../graph/buildGraph.js";
import * as db from "../db/queries.js";
import * as crypto from "crypto";
import {
  DEFAULT_MAX_CARDS,
  DEFAULT_MAX_TOKENS_SLICE,
} from "../config/constants.js";

export interface BlastRadiusOptions {
  maxHops?: number;
  maxResults?: number;
}

export interface GovernorLoopOptions {
  repoId: RepoId;
  budget?: SliceBudget;
  maxHops?: number;
  runDiagnostics?: boolean;
  diagnosticsTimeoutMs?: number;
}

export interface GovernorLoopResult {
  blastRadius: BlastRadiusItem[];
  trimmedSet: TrimmedSet;
  spilloverHandle: SpilloverHandle | null;
}

interface DependentMetrics {
  distance: number;
  fanIn: number;
  testProximity: number;
}

export function computeBlastRadius(
  changedSymbols: SymbolId[],
  graph: Graph,
  options?: BlastRadiusOptions,
): BlastRadiusItem[] {
  const maxHops = options?.maxHops ?? 3;
  const maxResults = options?.maxResults ?? 20;

  if (maxHops <= 0) {
    logger.warn("Invalid maxHops value, using default of 3", { maxHops });
    return [];
  }

  const dependentScores = new Map<SymbolId, DependentMetrics>();
  const processedChangedSymbols = new Set<SymbolId>(changedSymbols);

  for (const changedSymbol of changedSymbols) {
    const queue: Array<{ symbolId: SymbolId; distance: number }> = [
      { symbolId: changedSymbol, distance: 0 },
    ];
    const visited = new Set<SymbolId>();

    while (queue.length > 0) {
      const { symbolId, distance } = queue.shift()!;

      if (visited.has(symbolId)) continue;
      visited.add(symbolId);

      if (distance > maxHops) continue;
      if (processedChangedSymbols.has(symbolId)) continue;

      const symbol = graph.symbols.get(symbolId);
      if (!symbol) {
        logger.warn("Symbol not found in graph, skipping", { symbolId });
        continue;
      }

      const fanIn = graph.adjacencyIn.get(symbolId)?.length ?? 0;
      const file = db.getFile(symbol.file_id);
      const testProximity = file && isTestFile(file.rel_path) ? 1 : 0;

      const existing = dependentScores.get(symbolId);
      if (!existing || distance < existing.distance) {
        dependentScores.set(symbolId, {
          distance,
          fanIn,
          testProximity,
        });
      }

      const incomingNeighbors = getNeighbors(graph, symbolId, "in");
      for (const neighbor of incomingNeighbors) {
        if (!visited.has(neighbor) && !processedChangedSymbols.has(neighbor)) {
          queue.push({ symbolId: neighbor, distance: distance + 1 });
        }
      }
    }
  }

  const dependents: BlastRadiusItem[] = [];

  Array.from(dependentScores.entries()).forEach(([symbolId, metrics]) => {
    const normalizedDistance = 1 - metrics.distance / maxHops;
    const normalizedFanIn = Math.log(metrics.fanIn + 1) / Math.log(100);
    const rank =
      0.6 * normalizedDistance +
      0.3 * normalizedFanIn +
      0.1 * metrics.testProximity;

    const reason =
      metrics.distance === 0
        ? "calls changed symbol"
        : "dependency of changed symbol";

    const signal: "diagnostic" | "directDependent" | "graph" =
      metrics.distance === 0 ? "directDependent" : "graph";

    dependents.push({
      symbolId,
      reason,
      distance: metrics.distance,
      rank: Math.max(0, Math.min(1, rank)),
      signal,
    });
  });

  return rankDependents(dependents).slice(0, maxResults);
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
  changedSymbols: SymbolId[],
  graph: Graph,
  options: GovernorLoopOptions,
): Promise<GovernorLoopResult> {
  const budget = options.budget ?? {
    maxCards: DEFAULT_MAX_CARDS,
    maxEstimatedTokens: DEFAULT_MAX_TOKENS_SLICE,
  };
  const maxHops = options.maxHops ?? 3;
  const maxBlastRadius = budget.maxCards ?? DEFAULT_MAX_CARDS;

  const candidateBlastRadius = computeBlastRadius(changedSymbols, graph, {
    maxHops,
    maxResults: maxBlastRadius * 2,
  });

  let diagnosticSuspects: DiagnosticSuspect[] = [];

  if (
    options.runDiagnostics !== false &&
    candidateBlastRadius.length > maxBlastRadius * 0.8
  ) {
    try {
      const timeoutMs = options.diagnosticsTimeoutMs ?? 5000;
      const startTime = Date.now();

      const { suspects } = await runDiagnosticsWithTimeout(
        options.repoId,
        timeoutMs,
      );

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

  const { trimmedSet, spilloverHandle } = applyBudgetedSelection(
    mergedBlastRadius,
    budget,
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
    const estimatedTokens = estimateItemTokens(item);

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
    } else if (item.distance === 0 && item.signal === "directDependent") {
      priority = "must";
    } else if (item.distance === 1) {
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
    const priorityDiff =
      priorityWeight[b.priority] - priorityWeight[a.priority];
    if (priorityDiff !== 0) return priorityDiff;

    const rankDiff = b.rank - a.rank;
    if (rankDiff !== 0) return rankDiff;

    const distanceDiff = a.distance - b.distance;
    if (distanceDiff !== 0) return distanceDiff;

    return a.symbolId.localeCompare(b.symbolId);
  });
}

function estimateItemTokens(item: BlastRadiusItem): number {
  const symbol = db.getSymbol(item.symbolId);
  if (!symbol) return 50;

  let tokens = 50;
  tokens += symbol.name.length / 4;

  if (symbol.signature_json) {
    tokens += symbol.signature_json.length / 4;
  }

  if (symbol.summary) {
    tokens += Math.min(symbol.summary.length / 4, 150);
  }

  return Math.ceil(tokens);
}

function trimmedBlastRadius(
  blastRadius: BlastRadiusItem[],
  trimmedSet: TrimmedSet,
): BlastRadiusItem[] {
  const keptSet = new Set(trimmedSet.keptSymbols);
  return blastRadius.filter((item) => keptSet.has(item.symbolId));
}
