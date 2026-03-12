import type { SymbolKind } from "../db/schema.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { ValidationError } from "../domain/errors.js";
import { estimateTokens, tokenize } from "../util/tokenize.js";
import { SYMBOL_CARD_MAX_PROCESSES } from "../config/constants.js";
import type {
  ContextSummary,
  ContextSummaryDependency,
  ContextSummaryFileTouch,
  ContextSummaryFormat,
  ContextSummaryRiskArea,
  ContextSummaryScope,
  ContextSummarySymbol,
} from "./types.js";

const DEFAULT_SUMMARY_BUDGET = 2000;
const SUMMARY_MAX_RESULTS = 60;
const SUMMARY_CACHE_MAX = 128;

type SummarySeed = {
  keySymbols: ContextSummarySymbol[];
  dependencyGraph: ContextSummaryDependency[];
  riskAreas: ContextSummaryRiskArea[];
  filesTouched: ContextSummaryFileTouch[];
};

const summarySeedCache = new Map<string, SummarySeed>();

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
  } catch {
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
  const q = query.trim().toLowerCase();
  if (!q) return "task";

  if (
    q.includes("/") ||
    q.includes("\\") ||
    /\.(ts|tsx|js|jsx|py|go|java|cs|c|cpp|php|rs|kt|sh|json|md)$/.test(q)
  ) {
    return "file";
  }

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
  const results = await ladybugDb.searchSymbolsLite(
    conn,
    repoId,
    query,
    SUMMARY_MAX_RESULTS,
  );
  if (results.length === 0) {
    const tokenResults: ladybugDb.SearchSymbolLiteRow[] = [];
    const seen = new Set<string>();
    const tokens = tokenize(query).filter((token) => token.length >= 2);
    const perTokenLimit = Math.max(
      5,
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
        if (seen.has(row.symbolId)) continue;
        seen.add(row.symbolId);
        tokenResults.push(row);
      }
    }
    results.push(...tokenResults.slice(0, SUMMARY_MAX_RESULTS));
  }
  const symbolIds = results.map((row) => row.symbolId);
  const symbolIdSet = new Set(symbolIds);
  const symbolsMap = await ladybugDb.getSymbolsByIds(conn, symbolIds);

  const fileIds = new Set<string>();
  for (const symbol of symbolsMap.values()) {
    fileIds.add(symbol.fileId);
  }
  const filesMap = await ladybugDb.getFilesByIds(conn, [...fileIds]);
  const metricsMap = await ladybugDb.getMetricsBySymbolIds(conn, symbolIds);
  const edgesMap = await ladybugDb.getEdgesFromSymbolsForSlice(conn, symbolIds);
  const clustersMap = await ladybugDb.getClustersForSymbols(conn, symbolIds);
  const processesMap = await ladybugDb.getProcessesForSymbols(conn, symbolIds);

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
      cluster: clustersMap.get(symbol.symbolId)
        ? {
            clusterId: clustersMap.get(symbol.symbolId)!.clusterId,
            label: clustersMap.get(symbol.symbolId)!.label,
            memberCount: clustersMap.get(symbol.symbolId)!.symbolCount,
          }
        : undefined,
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
    if (metrics && metrics.fanIn >= 15) {
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

  let seed = summarySeedCache.get(cacheKey);
  if (!seed) {
    seed = await buildSeed(args.repoId, query);
    summarySeedCache.set(cacheKey, seed);
    evictSummaryCache();
  }

  return buildContextSummary({
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
