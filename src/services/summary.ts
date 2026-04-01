import type { SymbolKind } from "../domain/types.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { ValidationError } from "../domain/errors.js";
import { estimateTokens, tokenize } from "../util/tokenize.js";
import { TASK_TEXT_STOP_WORDS } from "../graph/slice/start-node-resolver.js";
import { logger } from "../util/logger.js";
import { SYMBOL_CARD_MAX_PROCESSES } from "../config/constants.js";
import { entitySearch } from "../retrieval/index.js";
import type { EntitySearchResultItem } from "../retrieval/index.js";
import { compareTaskScopedCandidates } from "../retrieval/task-query-ranking.js";
import type {
  ContextSummary,
  ContextSummaryDependency,
  ContextSummaryFileTouch,
  ContextSummaryFormat,
  ContextSummaryRiskArea,
  ContextSummaryScope,
  ContextSummarySymbol,
} from "../mcp/types.js";

const DEFAULT_SUMMARY_BUDGET = 2000;
const SUMMARY_MAX_RESULTS = 60;
const SUMMARY_EXPANSION_DEPTH = 20;
const SUMMARY_CACHE_MAX = 128;

type SummarySeed = {
  keySymbols: ContextSummarySymbol[];
  dependencyGraph: ContextSummaryDependency[];
  riskAreas: ContextSummaryRiskArea[];
  filesTouched: ContextSummaryFileTouch[];
};

const summarySeedCache = new Map<string, SummarySeed>();
/** Tracks the last-seen indexVersion per repoId to invalidate stale cache entries. */
const summarySeedVersions = new Map<string, string>();

function toSignature(
  signatureJson: string | null,
  fallbackName: string,
): string {
  if (!signatureJson) {
    return `${fallbackName}()`;
  }
  try {
    const parsed = JSON.parse(signatureJson) as {
      name?: string;
      params?: Array<{ name?: string }>;
      returns?: string;
    };
    const name = parsed.name ?? fallbackName;
    const params = (parsed.params ?? []).map((p) => p.name ?? "arg").join(", ");
    const returns = parsed.returns ? `: ${parsed.returns}` : "";
    return `${name}(${params})${returns}`;
  } catch (err) {
    logger.debug("Failed to parse signature JSON for summary", {
      fallbackName,
      error: err instanceof Error ? err.message : String(err),
    });
    return `${fallbackName}()`;
  }
}

function estimateSummaryTokens(data: {
  query: string;
  scope: ContextSummaryScope;
  keySymbols: ContextSummarySymbol[];
  dependencyGraph: ContextSummaryDependency[];
  riskAreas: ContextSummaryRiskArea[];
  filesTouched: ContextSummaryFileTouch[];
}): number {
  return estimateTokens(JSON.stringify(data));
}

function evictSummaryCache(): void {
  while (summarySeedCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summarySeedCache.keys().next().value;
    if (!oldest) break;
    summarySeedCache.delete(oldest);
  }
}

export function detectSummaryScope(query: string): ContextSummaryScope {
  const repoTerms = ["overview", "architecture", "project", "codebase", "repo", "repository", "structure", "summary"];
  const q = query.trim().toLowerCase();
  if (!q) return "task";

  if (
    q.includes("/") ||
    q.includes("\\") ||
    /\.(ts|tsx|js|jsx|py|go|java|cs|c|cpp|php|rs|kt|sh|json|md)$/.test(q)
  ) {
    return "file";
  }

  // Repo-level scope for broad project queries
  if (repoTerms.some((t) => q.split(/[^a-z0-9]+/).includes(t))) return "repo";

  const tokens = tokenize(q);
  const taskHints = new Set([
    "fix",
    "debug",
    "analyze",
    "review",
    "implement",
    "refactor",
    "issue",
    "error",
    "failure",
    "task",
  ]);
  if (tokens.length >= 3 || tokens.some((token) => taskHints.has(token))) {
    return "task";
  }

  return "symbol";
}

export function buildContextSummary(input: {
  repoId: string;
  query: string;
  scope: ContextSummaryScope;
  budget?: number;
  indexVersion: string;
  keySymbols: ContextSummarySymbol[];
  dependencyGraph: ContextSummaryDependency[];
  riskAreas: ContextSummaryRiskArea[];
  filesTouched: ContextSummaryFileTouch[];
}): ContextSummary {
  const budget = Math.max(1, input.budget ?? DEFAULT_SUMMARY_BUDGET);
  const maxTokens = Math.ceil(budget * 1.05);

  const keySymbols = [...input.keySymbols];
  const dependencyGraph = [...input.dependencyGraph];
  const riskAreas = [...input.riskAreas];
  const filesTouched = [...input.filesTouched];

  let truncated = false;
  let tokens = estimateSummaryTokens({
    query: input.query,
    scope: input.scope,
    keySymbols,
    dependencyGraph,
    riskAreas,
    filesTouched,
  });

  while (tokens > maxTokens) {
    truncated = true;
    if (dependencyGraph.length > 0) {
      dependencyGraph.pop();
    } else if (riskAreas.length > 0) {
      riskAreas.pop();
    } else if (filesTouched.length > 0) {
      filesTouched.pop();
    } else if (keySymbols.length > 0) {
      keySymbols.pop();
    } else {
      break;
    }

    tokens = estimateSummaryTokens({
      query: input.query,
      scope: input.scope,
      keySymbols,
      dependencyGraph,
      riskAreas,
      filesTouched,
    });
  }

  return {
    repoId: input.repoId,
    query: input.query,
    scope: input.scope,
    keySymbols,
    dependencyGraph,
    riskAreas,
    filesTouched,
    metadata: {
      query: input.query,
      summaryTokens: tokens,
      budget,
      truncated,
      indexVersion: input.indexVersion,
    },
  };
}

async function buildSeed(repoId: string, query: string): Promise<SummarySeed> {
  const conn = await getLadybugConn();

  // Always perform both full-phrase and per-token searches, then merge.
  // Full-phrase search alone often fails for natural-language queries
  // (e.g. "How does the indexing pipeline work?") because the full string
  // rarely appears as a substring in symbol names or summaries.
  const seen = new Set<string>();
  const merged: ladybugDb.SearchSymbolLiteRow[] = [];

  // Phase 1: full-phrase search (exact hits rank highest)
  const phraseResults = await ladybugDb.searchSymbolsLite(
    conn,
    repoId,
    query,
    SUMMARY_MAX_RESULTS,
  );
  for (const row of phraseResults) {
    if (!seen.has(row.symbolId)) {
      seen.add(row.symbolId);
      merged.push(row);
    }
  }

  // Phase 2: per-token search (catches relevant symbols the phrase missed)
  const tokens = tokenize(query).filter(
    (token) => token.length >= 3 && !TASK_TEXT_STOP_WORDS.has(token),
  );
  if (tokens.length > 0) {
    const perTokenLimit = Math.max(
      10,
      Math.floor(SUMMARY_MAX_RESULTS / Math.max(1, tokens.length)),
    );
    for (const token of tokens) {
      const partial = await ladybugDb.searchSymbolsLite(
        conn,
        repoId,
        token,
        perTokenLimit,
      );
      for (const row of partial) {
        if (!seen.has(row.symbolId)) {
          seen.add(row.symbolId);
          merged.push(row);
        }
      }
    }
  }

  // Phase 2a: compound token search — adjacent query words often form
  // camelCase identifiers (e.g. "beam search" -> "beamSearch")
  if (tokens.length >= 2) {
    const compoundTokens: string[] = [];
    for (let i = 0; i < Math.min(tokens.length - 1, 4); i++) {
      // camelCase: "beam" + "search" -> "beamSearch"
      const camel = tokens[i] + tokens[i + 1].charAt(0).toUpperCase() + tokens[i + 1].slice(1);
      compoundTokens.push(camel);
      // Also try 3-word compounds
      if (i < tokens.length - 2) {
        const camel3 = camel + tokens[i + 2].charAt(0).toUpperCase() + tokens[i + 2].slice(1);
        compoundTokens.push(camel3);
      }
    }
    for (const compound of compoundTokens) {
      if (compound.length >= 5) {
        const partial = await ladybugDb.searchSymbolsLite(conn, repoId, compound, 5);
        for (const row of partial) {
          if (!seen.has(row.symbolId)) {
            seen.add(row.symbolId);
            merged.push(row);
          }
        }
      }
    }
  }

  // Phase 2b: file-path keyword matching — find files whose names contain
  // query tokens, then add exported symbols from those files.
  if (merged.length < 10) {
    try {
      const allFiles = await ladybugDb.getFilesByRepoLite(conn, repoId);
      const pathTokens = tokenize(query).filter((t) => t.length >= 3);
      const matchingFiles = allFiles.filter((f) =>
        pathTokens.some((token) => {
          const pathLower = f.relPath.toLowerCase();
          const fileName = pathLower.split("/").pop() ?? "";
          return fileName.includes(token) || token.includes(fileName.replace(/\.[^.]+$/, ""));
        }),
      ).slice(0, 5);
      if (matchingFiles.length > 0) {
        const fileIds = matchingFiles.map((f) => f.fileId);
        for (const fileId of fileIds) {
          const syms = await ladybugDb.getSymbolIdsByFile(conn, fileId);
          for (const symId of syms) {
            if (!seen.has(symId) && merged.length < SUMMARY_MAX_RESULTS) {
              seen.add(symId);
              merged.push({ symbolId: symId, name: "", filePath: "", kind: "function", fileId: "" } as unknown as ladybugDb.SearchSymbolLiteRow);
            }
          }
        }
      }
    } catch { /* graceful degradation */ }
  }

  const mergedSymbolsMap = await ladybugDb.getSymbolsByIds(
    conn,
    merged.map((row) => row.symbolId),
  );
  const mergedFilesMap = await ladybugDb.getFilesByIds(
    conn,
    Array.from(new Set(
      Array.from(mergedSymbolsMap.values()).map((symbol) => symbol.fileId),
    )),
  );
  merged.sort((a, b) => {
    const symbolA = mergedSymbolsMap.get(a.symbolId);
    const symbolB = mergedSymbolsMap.get(b.symbolId);
    const fileA = symbolA ? mergedFilesMap.get(symbolA.fileId) : undefined;
    const fileB = symbolB ? mergedFilesMap.get(symbolB.fileId) : undefined;

    if (symbolA && symbolB && fileA && fileB) {
      const scoped = compareTaskScopedCandidates(
        query,
        {
          filePath: fileA.relPath,
          kind: symbolA.kind,
          exported: symbolA.exported,
          name: symbolA.name,
        },
        {
          filePath: fileB.relPath,
          kind: symbolB.kind,
          exported: symbolB.exported,
          name: symbolB.name,
        },
      );
      if (scoped !== 0) {
        return scoped;
      }
    }

    return a.symbolId.localeCompare(b.symbolId);
  });
  const results = merged.slice(0, SUMMARY_MAX_RESULTS);
  const symbolIds = results.map((row) => row.symbolId);
  const symbolIdSet = new Set(symbolIds);

  // Phase 3: 1-hop edge expansion — follow outbound edges from search hits
  // to discover closely-related symbols that the text search missed.
  // This populates the dependency graph with meaningful connections.
  const searchEdges = await ladybugDb.getEdgesFromSymbolsForSlice(conn, symbolIds);
  const expansionIds: string[] = [];
  for (const edges of searchEdges.values()) {
    for (const edge of edges) {
      if (!symbolIdSet.has(edge.toSymbolId) && expansionIds.length < SUMMARY_EXPANSION_DEPTH) {
        expansionIds.push(edge.toSymbolId);
        symbolIdSet.add(edge.toSymbolId);
      }
    }
  }
  const allSymbolIds = [...symbolIds, ...expansionIds];

  const symbolsMap = await ladybugDb.getSymbolsByIds(conn, allSymbolIds);

  const fileIds = new Set<string>();
  for (const symbol of symbolsMap.values()) {
    fileIds.add(symbol.fileId);
  }
  const filesMap = await ladybugDb.getFilesByIds(conn, [...fileIds]);
  const metricsMap = await ladybugDb.getMetricsBySymbolIds(conn, allSymbolIds);
  const edgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(conn, allSymbolIds);
  const clustersMap = await ladybugDb.getClustersForSymbols(conn, allSymbolIds);
  const processesMap = await ladybugDb.getProcessesForSymbols(conn, allSymbolIds);

  const keySymbols: ContextSummarySymbol[] = [];
  const fileCounts = new Map<string, number>();
  const riskAreas: ContextSummaryRiskArea[] = [];
  const dependencyGraph: ContextSummaryDependency[] = [];

  for (const row of results) {
    const symbol = symbolsMap.get(row.symbolId);
    if (!symbol) continue;
    const file = filesMap.get(symbol.fileId);
    if (!file) continue;

    keySymbols.push({
      symbolId: symbol.symbolId,
      name: symbol.name,
      kind: symbol.kind as SymbolKind,
      signature: toSignature(symbol.signatureJson, symbol.name),
      summary: symbol.summary ?? `${symbol.kind} ${symbol.name}`,
      cluster: (() => {          const ci = clustersMap.get(symbol.symbolId);          return ci ? { clusterId: ci.clusterId, label: ci.label, memberCount: ci.symbolCount } : undefined;        })(),
      processes: processesMap.get(symbol.symbolId)?.length
        ? processesMap
            .get(symbol.symbolId)!
            .slice(0, SYMBOL_CARD_MAX_PROCESSES)
            .map((row) => ({
              processId: row.processId,
              label: row.label,
              role:
                row.role === "entry" ||
                row.role === "exit" ||
                row.role === "intermediate"
                  ? row.role
                  : "intermediate",
              depth: row.depth,
            }))
        : undefined,
    });

    fileCounts.set(file.relPath, (fileCounts.get(file.relPath) ?? 0) + 1);

    const metrics = metricsMap.get(symbol.symbolId);
    const reasons: string[] = [];
    if (metrics && metrics.fanIn >= 3) {
      reasons.push("high fan-in");
    }
    if (metrics && metrics.churn30d > 0) {
      reasons.push("recent churn");
    }
    if (reasons.length > 0) {
      riskAreas.push({
        symbolId: symbol.symbolId,
        name: symbol.name,
        reasons,
      });
    }

    const outgoing = edgesMap.get(symbol.symbolId) ?? [];
    const toSymbolIds = outgoing
      .filter((edge) => symbolIdSet.has(edge.toSymbolId))
      .map((edge) => edge.toSymbolId);

    if (toSymbolIds.length > 0) {
      const uniqueSorted = [...new Set(toSymbolIds)].sort();
      dependencyGraph.push({
        fromSymbolId: symbol.symbolId,
        toSymbolIds: uniqueSorted,
      });
    }
  }

  // Sort keySymbols by query relevance (primary) then structural importance (secondary).
  // This ensures symbols matching the query rank above high-fan-in but irrelevant symbols.
  const queryTokensLower = tokenize(query)
    .filter((t) => t.length >= 3 && !TASK_TEXT_STOP_WORDS.has(t))
    .map((t) => t.toLowerCase());
  keySymbols.sort((a, b) => {
    // Query relevance: name/summary match against query tokens
    const nameLowerA = a.name.toLowerCase();
    const nameLowerB = b.name.toLowerCase();
    const summaryLowerA = (a.summary ?? "").toLowerCase();
    const summaryLowerB = (b.summary ?? "").toLowerCase();
    let relevanceA = 0;
    let relevanceB = 0;
    for (const token of queryTokensLower) {
      if (nameLowerA.includes(token)) relevanceA += 10;
      else if (summaryLowerA.includes(token)) relevanceA += 3;
      if (nameLowerB.includes(token)) relevanceB += 10;
      else if (summaryLowerB.includes(token)) relevanceB += 3;
    }
    // Structural importance: fan-in + edge count
    const metricsA = metricsMap.get(a.symbolId);
    const metricsB = metricsMap.get(b.symbolId);
    const fanInA = metricsA?.fanIn ?? 0;
    const fanInB = metricsB?.fanIn ?? 0;
    const edgesA = (edgesMap.get(a.symbolId) ?? []).length;
    const edgesB = (edgesMap.get(b.symbolId) ?? []).length;
    const structuralA = fanInA * 3 + edgesA;
    const structuralB = fanInB * 3 + edgesB;
    // Combined: relevance is primary (weighted 5x), structural is secondary
    const scoreA = relevanceA * 5 + structuralA;
    const scoreB = relevanceB * 5 + structuralB;
    return scoreB - scoreA || a.name.localeCompare(b.name);
  });

  const filesTouched = [...fileCounts.entries()]
    .map(([file, symbolCount]) => ({ file, symbolCount }))
    .sort(
      (a, b) => b.symbolCount - a.symbolCount || a.file.localeCompare(b.file),
    );

  riskAreas.sort(
    (a, b) =>
      b.reasons.length - a.reasons.length || a.name.localeCompare(b.name),
  );

  dependencyGraph.sort((a, b) => a.fromSymbolId.localeCompare(b.fromSymbolId));

  return {
    keySymbols,
    dependencyGraph,
    riskAreas,
    filesTouched,
  };
}

export async function generateContextSummary(args: {
  repoId: string;
  query: string;
  budget?: number;
  scope?: ContextSummaryScope;
}): Promise<ContextSummary> {
  const query = args.query.trim();
  if (!query) {
    throw new ValidationError("query must be a non-empty string");
  }

  const conn = await getLadybugConn();
  const latestVersion = await ladybugDb.getLatestVersion(conn, args.repoId);
  const indexVersion = latestVersion?.versionId ?? "0";
  const scope = args.scope ?? detectSummaryScope(query);
  const cacheKey = `${args.repoId}:${indexVersion}:${query.toLowerCase()}`;

  // Invalidate cache when index version changes for this repo
  const lastVersion = summarySeedVersions.get(args.repoId);
  if (lastVersion && lastVersion !== indexVersion) {
    // Invalidate only entries for this repo (not all repos)
    for (const key of summarySeedCache.keys()) {
      if (key.startsWith(args.repoId + ":")) {
        summarySeedCache.delete(key);
      }
    }
  }
  summarySeedVersions.set(args.repoId, indexVersion);

  let seed = summarySeedCache.get(cacheKey);
  if (!seed) {
    seed = await Promise.race([
      buildSeed(args.repoId, query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("buildSeed timed out after 30s")), 30_000).unref(),
      ),
    ]);
    summarySeedCache.set(cacheKey, seed);
    evictSummaryCache();
  }

  const summary = buildContextSummary({
    repoId: args.repoId,
    query,
    scope,
    budget: args.budget,
    indexVersion,
    keySymbols: seed.keySymbols,
    dependencyGraph: seed.dependencyGraph,
    riskAreas: seed.riskAreas,
    filesTouched: seed.filesTouched,
  });

  // Enrich summary with entity retrieval results for clusters, processes, and files
  try {
    const entityResult = await entitySearch({
      repoId: args.repoId,
      query,
      limit: 15,
      entityTypes: ["cluster", "process", "fileSummary"],
      includeEvidence: false,
    });
    if (entityResult.results.length > 0) {
      const clusterIds = entityResult.results
        .filter((r: EntitySearchResultItem) => r.entityType === "cluster")
        .map((r: EntitySearchResultItem) => r.entityId);
      const processIds = entityResult.results
        .filter((r: EntitySearchResultItem) => r.entityType === "process")
        .map((r: EntitySearchResultItem) => r.entityId);
      const fileIds = entityResult.results
        .filter((r: EntitySearchResultItem) => r.entityType === "fileSummary")
        .map((r: EntitySearchResultItem) => r.entityId);
      if (clusterIds.length > 0) {
        summary.relatedClusterIds = clusterIds;
      }
      if (processIds.length > 0) {
        summary.relatedProcessIds = processIds;
      }
      if (fileIds.length > 0) {
        summary.relatedFileIds = fileIds;
      }
    }
  } catch (err) {
    logger.debug(
      "Entity retrieval enrichment for context summary failed; continuing without it",
      { repoId: args.repoId, error: err },
    );
  }

  return summary;
}

export function renderContextSummary(
  summary: ContextSummary,
  format: ContextSummaryFormat,
): string {
  if (format === "json") {
    return JSON.stringify(summary, null, 2);
  }

  const lines: string[] = [];
  lines.push(`# Context: ${summary.query}`);
  lines.push("");
  lines.push(
    `## Key Symbols (${summary.keySymbols.length} symbols, ~${summary.metadata.summaryTokens} tokens)`,
  );
  if (summary.keySymbols.length === 0) {
    lines.push("- None");
  } else {
    for (const symbol of summary.keySymbols) {
      const extras: string[] = [];
      if (symbol.cluster) {
        extras.push(
          `cluster: ${symbol.cluster.label} (${symbol.cluster.memberCount})`,
        );
      }
      if (symbol.processes && symbol.processes.length > 0) {
        const procLabels = symbol.processes
          .slice(0, SYMBOL_CARD_MAX_PROCESSES)
          .map((p) => `${p.label} [${p.role}]`);
        extras.push(`processes: ${procLabels.join(", ")}`);
      }

      const extraText = extras.length > 0 ? ` (${extras.join("; ")})` : "";
      lines.push(
        `${`- ${symbol.name} [${symbol.kind}] ${symbol.signature ?? ""} - ${symbol.summary}`.trim()}${extraText}`,
      );
    }
  }
  lines.push("");
  lines.push("## Dependency Graph");
  if (summary.dependencyGraph.length === 0) {
    lines.push("- None");
  } else {
    for (const edge of summary.dependencyGraph) {
      lines.push(`- ${edge.fromSymbolId}: ${edge.toSymbolIds.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Risk Areas");
  if (summary.riskAreas.length === 0) {
    lines.push("- None");
  } else {
    for (const risk of summary.riskAreas) {
      lines.push(`- ${risk.name}: ${risk.reasons.join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Files Touched");
  if (summary.filesTouched.length === 0) {
    lines.push("- None");
  } else {
    for (const file of summary.filesTouched) {
      lines.push(`- ${file.file} (${file.symbolCount})`);
    }
  }

  if (summary.metadata.truncated) {
    lines.push("");
    lines.push(
      `> Output truncated to budget ${summary.metadata.budget} tokens (indexVersion=${summary.metadata.indexVersion}).`,
    );
  }

  const markdown = `${lines.join("\n")}\n`;
  if (format === "clipboard") {
    return markdown;
  }
  return markdown;
}
