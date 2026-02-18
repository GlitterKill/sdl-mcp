import type { SymbolKind } from "../db/schema.js";
import * as db from "../db/queries.js";
import {
  estimateTokens,
  tokenize,
} from "../util/tokenize.js";
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

function toSignature(signatureJson: string | null, fallbackName: string): string {
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
    const params = (parsed.params ?? [])
      .map((p) => p.name ?? "arg")
      .join(", ");
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

function buildSeed(repoId: string, query: string): SummarySeed {
  const results = db.searchSymbolsLite(repoId, query, SUMMARY_MAX_RESULTS);
  if (results.length === 0) {
    const tokenResults: Array<
      Pick<ReturnType<typeof db.searchSymbolsLite>[number], "symbol_id" | "name" | "file_id" | "kind">
    > = [];
    const seen = new Set<string>();
    const tokens = tokenize(query).filter((token) => token.length >= 2);
    const perTokenLimit = Math.max(5, Math.floor(SUMMARY_MAX_RESULTS / Math.max(1, tokens.length)));
    for (const token of tokens) {
      const partial = db.searchSymbolsLite(repoId, token, perTokenLimit);
      for (const row of partial) {
        if (seen.has(row.symbol_id)) continue;
        seen.add(row.symbol_id);
        tokenResults.push(row);
      }
    }
    results.push(...tokenResults.slice(0, SUMMARY_MAX_RESULTS));
  }
  const symbolIds = results.map((row) => row.symbol_id);
  const symbolIdSet = new Set(symbolIds);
  const symbolsMap = db.getSymbolsByIds(symbolIds);

  const fileIds = new Set<number>();
  for (const symbol of symbolsMap.values()) {
    fileIds.add(symbol.file_id);
  }
  const filesMap = db.getFilesByIds([...fileIds]);
  const metricsMap = db.getMetricsBySymbolIds(symbolIds);
  const edgesMap = db.getEdgesFromSymbolsForSlice(symbolIds);

  const keySymbols: ContextSummarySymbol[] = [];
  const fileCounts = new Map<string, number>();
  const riskAreas: ContextSummaryRiskArea[] = [];
  const dependencyGraph: ContextSummaryDependency[] = [];

  for (const row of results) {
    const symbol = symbolsMap.get(row.symbol_id);
    if (!symbol) continue;
    const file = filesMap.get(symbol.file_id);
    if (!file) continue;

    keySymbols.push({
      symbolId: symbol.symbol_id,
      name: symbol.name,
      kind: symbol.kind as SymbolKind,
      signature: toSignature(symbol.signature_json, symbol.name),
      summary: symbol.summary ?? `${symbol.kind} ${symbol.name}`,
    });

    fileCounts.set(file.rel_path, (fileCounts.get(file.rel_path) ?? 0) + 1);

    const metrics = metricsMap.get(symbol.symbol_id);
    const reasons: string[] = [];
    if (metrics && metrics.fan_in >= 15) {
      reasons.push("high fan-in");
    }
    if (metrics && metrics.churn_30d > 0) {
      reasons.push("recent churn");
    }
    if (reasons.length > 0) {
      riskAreas.push({
        symbolId: symbol.symbol_id,
        name: symbol.name,
        reasons,
      });
    }

    const outgoing = edgesMap.get(symbol.symbol_id) ?? [];
    const toSymbolIds = outgoing
      .filter((edge) => symbolIdSet.has(edge.to_symbol_id))
      .map((edge) => edge.to_symbol_id);

    if (toSymbolIds.length > 0) {
      const uniqueSorted = [...new Set(toSymbolIds)].sort();
      dependencyGraph.push({
        fromSymbolId: symbol.symbol_id,
        toSymbolIds: uniqueSorted,
      });
    }
  }

  const filesTouched = [...fileCounts.entries()]
    .map(([file, symbolCount]) => ({ file, symbolCount }))
    .sort((a, b) => b.symbolCount - a.symbolCount || a.file.localeCompare(b.file));

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

export function generateContextSummary(args: {
  repoId: string;
  query: string;
  budget?: number;
  scope?: ContextSummaryScope;
}): ContextSummary {
  const query = args.query.trim();
  if (!query) {
    throw new Error("query must be a non-empty string");
  }

  const latestVersion = db.getLatestVersion(args.repoId);
  const indexVersion = latestVersion?.version_id ?? "0";
  const scope = args.scope ?? detectSummaryScope(query);
  const cacheKey = `${args.repoId}:${indexVersion}:${query.toLowerCase()}`;

  let seed = summarySeedCache.get(cacheKey);
  if (!seed) {
    seed = buildSeed(args.repoId, query);
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
      lines.push(
        `- ${symbol.name} [${symbol.kind}] ${symbol.signature ?? ""} - ${symbol.summary}`.trim(),
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
