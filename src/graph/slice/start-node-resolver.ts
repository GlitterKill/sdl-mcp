/**
 * Start Node Resolution Module
 *
 * Responsible for resolving entry point symbols from various sources:
 * - Explicit entry symbols
 * - First-hop dependencies of entry symbols
 * - Sibling symbols in the same file
 * - Stack trace extraction
 * - Failing test file paths
 * - Edited files
 * - Task text semantic search
 *
 * @module graph/slice/start-node-resolver
 */

import type { RepoId, SymbolId } from "../../db/schema.js";
import type { Graph } from "../buildGraph.js";
import * as db from "../../db/queries.js";
import { tokenize } from "../../util/tokenize.js";
import {
  TASK_TEXT_START_NODE_MAX,
  TASK_TEXT_TOKEN_MAX,
  TASK_TEXT_TOKEN_QUERY_LIMIT,
  TASK_TEXT_MIN_TOKEN_LENGTH,
  ENTRY_FIRST_HOP_MAX_PER_SYMBOL,
  ENTRY_SIBLING_MAX_PER_SYMBOL,
  ENTRY_SIBLING_MIN_SHARED_PREFIX,
  DEFAULT_MAX_CARDS,
  DB_QUERY_LIMIT_DEFAULT,
} from "../../config/constants.js";

export type StartNodeSource =
  | "entrySymbol"
  | "entryFirstHop"
  | "entrySibling"
  | "stackTrace"
  | "failingTestPath"
  | "editedFile"
  | "taskText";

export interface ResolvedStartNode {
  symbolId: SymbolId;
  source: StartNodeSource;
}

export interface StartNodeLimits {
  maxTotalStartNodes: number;
  maxTaskTextStartNodes: number;
  maxFirstHopPerEntry: number;
  maxSiblingPerEntry: number;
}

export const START_NODE_SOURCE_PRIORITY: Record<StartNodeSource, number> = {
  entrySymbol: 0,
  entrySibling: 1,
  entryFirstHop: 2,
  stackTrace: 3,
  failingTestPath: 4,
  editedFile: 5,
  taskText: 6,
};

export const START_NODE_SOURCE_SCORE: Record<StartNodeSource, number> = {
  entrySymbol: -1.4,
  entrySibling: -1.22,
  entryFirstHop: -1.18,
  stackTrace: -1.2,
  failingTestPath: -1.1,
  editedFile: -1.0,
  taskText: -0.6,
};

export const TASK_TEXT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "id",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "please",
  "task",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

export interface SliceBuildRequestBase {
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  budget?: { maxCards?: number };
}

export function resolveStartNodes(
  graph: Graph,
  request: SliceBuildRequestBase,
): ResolvedStartNode[] {
  const startNodes = new Map<SymbolId, StartNodeSource>();
  const explicitEntrySymbols: SymbolId[] = [];

  const addStartNode = (symbolId: SymbolId, source: StartNodeSource): void => {
    if (!graph.symbols.has(symbolId)) return;
    const existingSource = startNodes.get(symbolId);
    if (
      existingSource &&
      START_NODE_SOURCE_PRIORITY[existingSource] <=
        START_NODE_SOURCE_PRIORITY[source]
    ) {
      return;
    }
    startNodes.set(symbolId, source);
  };

  if (request.entrySymbols) {
    for (const symbolId of request.entrySymbols) {
      if (!graph.symbols.has(symbolId)) continue;
      explicitEntrySymbols.push(symbolId);
      addStartNode(symbolId, "entrySymbol");
    }
  }

  const limits = computeStartNodeLimits(request, explicitEntrySymbols.length);

  for (const symbolId of explicitEntrySymbols) {
    if (startNodes.size >= limits.maxTotalStartNodes) break;
    const firstHopSymbols = collectEntryFirstHopSymbols(
      graph,
      symbolId,
      limits.maxFirstHopPerEntry,
    );
    for (const firstHopSymbolId of firstHopSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(firstHopSymbolId, "entryFirstHop");
    }
  }

  if (explicitEntrySymbols.length > 0) {
    const symbolsByFile = buildSymbolsByFile(graph);
    for (const symbolId of explicitEntrySymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      const siblingSymbols = collectEntrySiblingSymbols(
        graph,
        symbolId,
        symbolsByFile,
        limits.maxSiblingPerEntry,
      );
      for (const siblingSymbolId of siblingSymbols) {
        if (startNodes.size >= limits.maxTotalStartNodes) break;
        addStartNode(siblingSymbolId, "entrySibling");
      }
    }
  }

  if (request.stackTrace) {
    const stackSymbols = extractSymbolsFromStackTrace(
      request.stackTrace,
      graph.repoId,
    );
    for (const symbolId of stackSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(symbolId, "stackTrace");
    }
  }

  if (request.failingTestPath) {
    const fileSymbols = getSymbolsByPath(graph.repoId, request.failingTestPath);
    for (const symbolId of fileSymbols) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      addStartNode(symbolId, "failingTestPath");
    }
  }

  if (request.editedFiles) {
    for (const filePath of request.editedFiles) {
      if (startNodes.size >= limits.maxTotalStartNodes) break;
      const fileSymbols = getSymbolsByPath(graph.repoId, filePath);
      for (const symbolId of fileSymbols) {
        if (startNodes.size >= limits.maxTotalStartNodes) break;
        addStartNode(symbolId, "editedFile");
      }
    }
  }

  if (request.taskText) {
    const taskTokens = collectTaskTextSeedTokens(request.taskText);
    let taskTextSeedCount = 0;
    for (const token of taskTokens) {
      if (
        taskTextSeedCount >= limits.maxTaskTextStartNodes ||
        startNodes.size >= limits.maxTotalStartNodes
      ) {
        break;
      }
      const remaining = limits.maxTaskTextStartNodes - taskTextSeedCount;
      const perTokenLimit = Math.max(
        1,
        Math.min(
          DB_QUERY_LIMIT_DEFAULT,
          TASK_TEXT_TOKEN_QUERY_LIMIT,
          remaining,
        ),
      );
      const results = db.searchSymbolsLite(graph.repoId, token, perTokenLimit);
      for (const result of results) {
        if (
          taskTextSeedCount >= limits.maxTaskTextStartNodes ||
          startNodes.size >= limits.maxTotalStartNodes
        ) {
          break;
        }
        const symbolId = result.symbol_id;
        if (startNodes.has(symbolId)) continue;
        addStartNode(symbolId, "taskText");
        if (startNodes.has(symbolId)) {
          taskTextSeedCount++;
        }
      }
    }
  }

  return Array.from(startNodes.entries())
    .sort(
      ([, sourceA], [, sourceB]) =>
        START_NODE_SOURCE_PRIORITY[sourceA] -
        START_NODE_SOURCE_PRIORITY[sourceB],
    )
    .map(([symbolId, source]) => ({ symbolId, source }));
}

export function collectTaskTextSeedTokens(taskText: string): string[] {
  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const token of tokenize(taskText)) {
    if (token.length < TASK_TEXT_MIN_TOKEN_LENGTH) continue;
    if (TASK_TEXT_STOP_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (!/[a-z]/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    filtered.push(token);
  }

  filtered.sort((a, b) => {
    const rankDiff = getTaskTextTokenRank(b) - getTaskTextTokenRank(a);
    if (rankDiff !== 0) return rankDiff;
    return b.length - a.length;
  });

  return filtered.slice(0, TASK_TEXT_TOKEN_MAX);
}

export function getTaskTextTokenRank(token: string): number {
  let rank = 0;
  if (token.includes("/") || token.includes("\\")) rank += 4;
  if (token.includes(".") || token.includes("_") || token.includes("-"))
    rank += 3;
  if (/[0-9]/.test(token)) rank += 2;
  if (token.length >= 8) rank += 1;
  return rank;
}

export function buildSymbolsByFile(graph: Graph): Map<number, SymbolId[]> {
  const symbolsByFile = new Map<number, SymbolId[]>();
  for (const [symbolId, symbol] of graph.symbols) {
    const current = symbolsByFile.get(symbol.file_id);
    if (current) {
      current.push(symbolId);
      continue;
    }
    symbolsByFile.set(symbol.file_id, [symbolId]);
  }
  return symbolsByFile;
}

export function collectEntryFirstHopSymbols(
  graph: Graph,
  entrySymbolId: SymbolId,
  maxPerSymbol: number,
): SymbolId[] {
  const outgoing = graph.adjacencyOut.get(entrySymbolId) ?? [];
  if (outgoing.length === 0) return [];

  const ranked = new Map<SymbolId, number>();
  for (const edge of outgoing) {
    if (edge.type !== "call" && edge.type !== "import") continue;
    const target = graph.symbols.get(edge.to_symbol_id);
    if (!target) continue;

    let rank = edge.type === "call" ? 4 : 2;
    if (target.exported === 1) rank += 1;
    if (target.kind === "function" || target.kind === "method") rank += 1;

    const previous = ranked.get(edge.to_symbol_id);
    if (previous === undefined || rank > previous) {
      ranked.set(edge.to_symbol_id, rank);
    }
  }

  return Array.from(ranked.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const nameA = graph.symbols.get(a[0])?.name ?? "";
      const nameB = graph.symbols.get(b[0])?.name ?? "";
      return nameA.localeCompare(nameB);
    })
    .slice(0, maxPerSymbol)
    .map(([symbolId]) => symbolId);
}

export function collectEntrySiblingSymbols(
  graph: Graph,
  entrySymbolId: SymbolId,
  symbolsByFile: Map<number, SymbolId[]>,
  maxPerSymbol: number,
): SymbolId[] {
  const entrySymbol = graph.symbols.get(entrySymbolId);
  if (!entrySymbol) return [];

  const symbolIdsInFile = symbolsByFile.get(entrySymbol.file_id) ?? [];
  if (symbolIdsInFile.length <= 1) return [];

  const entryName = entrySymbol.name.toLowerCase();
  const ranked: Array<{ symbolId: SymbolId; rank: number; name: string }> = [];

  for (const candidateId of symbolIdsInFile) {
    if (candidateId === entrySymbolId) continue;
    const candidate = graph.symbols.get(candidateId);
    if (!candidate) continue;
    if (candidate.kind !== entrySymbol.kind) continue;

    const sharedPrefix = commonPrefixLength(
      entryName,
      candidate.name.toLowerCase(),
    );
    if (sharedPrefix < ENTRY_SIBLING_MIN_SHARED_PREFIX) continue;

    let rank = sharedPrefix;
    if (candidate.exported === 1) rank += 2;
    ranked.push({ symbolId: candidateId, rank, name: candidate.name });
  }

  return ranked
    .sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxPerSymbol)
    .map((item) => item.symbolId);
}

export function computeStartNodeLimits(
  request: SliceBuildRequestBase,
  explicitEntryCount: number,
): StartNodeLimits {
  const budgetMaxCards = Math.max(
    1,
    request.budget?.maxCards ?? DEFAULT_MAX_CARDS,
  );
  const maxTotalStartNodes = Math.max(12, Math.min(96, budgetMaxCards * 2));

  if (explicitEntryCount === 0) {
    return {
      maxTotalStartNodes,
      maxTaskTextStartNodes: TASK_TEXT_START_NODE_MAX,
      maxFirstHopPerEntry: ENTRY_FIRST_HOP_MAX_PER_SYMBOL,
      maxSiblingPerEntry: ENTRY_SIBLING_MAX_PER_SYMBOL,
    };
  }

  const hasStrongSignals = Boolean(
    request.stackTrace ||
    request.failingTestPath ||
    (request.editedFiles && request.editedFiles.length > 0),
  );
  const adaptiveTaskBudget = Math.max(2, Math.floor(budgetMaxCards / 5));
  const maxTaskTextStartNodes = hasStrongSignals
    ? Math.min(TASK_TEXT_START_NODE_MAX, Math.min(4, adaptiveTaskBudget))
    : Math.min(TASK_TEXT_START_NODE_MAX, Math.min(8, adaptiveTaskBudget));

  return {
    maxTotalStartNodes,
    maxTaskTextStartNodes,
    maxFirstHopPerEntry: Math.min(ENTRY_FIRST_HOP_MAX_PER_SYMBOL, 2),
    maxSiblingPerEntry: Math.min(ENTRY_SIBLING_MAX_PER_SYMBOL, 1),
  };
}

export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i++;
  }
  return i;
}

export function extractSymbolsFromStackTrace(
  stackTrace: string,
  repoId: RepoId,
): SymbolId[] {
  const symbols = new Set<SymbolId>();
  const lines = stackTrace.split("\n");

  const filesByRepo = db.getFilesByRepoLite(repoId);
  const filePaths = new Map<string, number>();

  for (const file of filesByRepo) {
    filePaths.set(file.rel_path, file.file_id);
  }

  for (const [path, fileId] of filePaths.entries()) {
    for (const line of lines) {
      if (line.includes(path)) {
        const symbolIds = db.getSymbolIdsByFile(fileId);
        for (const symbolId of symbolIds) {
          symbols.add(symbolId);
        }
        break;
      }
    }
  }

  return Array.from(symbols);
}

export function getSymbolsByPath(repoId: RepoId, filePath: string): SymbolId[] {
  const filesByRepo = db.getFilesByRepoLite(repoId);
  const file = filesByRepo.find((f) => f.rel_path === filePath);

  if (!file) return [];

  const symbolIds = db.getSymbolIdsByFile(file.file_id);
  return symbolIds;
}

export function getStartNodeWhy(source: StartNodeSource): string {
  switch (source) {
    case "entrySymbol":
      return "entry symbol";
    case "entrySibling":
      return "entry sibling";
    case "entryFirstHop":
      return "entry dependency";
    case "stackTrace":
      return "stack trace";
    case "failingTestPath":
      return "failing test";
    case "editedFile":
      return "edited file";
    case "taskText":
      return "task text";
  }
}
