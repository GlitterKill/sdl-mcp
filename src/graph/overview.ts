/**
 * Repository Overview Builder
 *
 * Generates token-efficient codebase overviews by aggregating symbol data
 * at the directory level. This provides 10-50x token reduction compared to
 * rendering all symbols as full cards.
 *
 * Key features:
 * - Progressive detail levels (stats, directories, full)
 * - Directory-level symbol aggregation
 * - Hotspot analysis (most depended, most changed)
 * - Token efficiency metrics
 */

import type { RepoId, SymbolKind } from "../domain/types.js";
import type {
  RepoOverview,
  RepoOverviewRequest,
  RepoStats,
  DirectorySummary,
  CodebaseHotspots,
  CompactSymbolRef,
  SymbolCountsByKind,
} from "../domain/types.js";
import { SYMBOL_TOKEN_MAX } from "../config/constants.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { safeJsonParseOptional, SignatureSchema } from "../util/safeJson.js";
import { globToSafeRegex } from "../util/safeRegex.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Estimated tokens for a compact symbol reference.
 * Much smaller than full SymbolCard (~135 tokens).
 */
const COMPACT_SYMBOL_REF_TOKENS = 15;

/**
 * Estimated tokens for directory summary header.
 */
const DIRECTORY_SUMMARY_HEADER_TOKENS = 25;

/**
 * Estimated tokens per export name in directory summary.
 */
const EXPORT_NAME_TOKENS = 2;

/**
 * Default maximum directories to include in overview.
 */
const DEFAULT_MAX_DIRECTORIES = 50;

/**
 * Default maximum exports to list per directory.
 */
const DEFAULT_MAX_EXPORTS_PER_DIRECTORY = 10;

/**
 * Default maximum top symbols to include in hotspots.
 */
const DEFAULT_MAX_HOTSPOT_SYMBOLS = 10;

const SYMBOL_KINDS: SymbolKind[] = [
  "function",
  "class",
  "interface",
  "type",
  "method",
  "variable",
  "module",
  "constructor",
];

function isSymbolKind(value: string): value is SymbolKind {
  return (SYMBOL_KINDS as string[]).includes(value);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates empty SymbolCountsByKind object.
 */
function emptySymbolCounts(): SymbolCountsByKind {
  return {
    function: 0,
    class: 0,
    interface: 0,
    type: 0,
    method: 0,
    variable: 0,
    module: 0,
    constructor: 0,
  };
}

/**
 * Converts a SymbolRow-like object to CompactSymbolRef.
 */
function toCompactRef(row: {
  symbolId: string;
  name: string;
  kind: string;
  exported: boolean;
  signatureJson: string | null;
}): CompactSymbolRef {
  let signature: string | undefined;
  if (row.signatureJson) {
    const sig = safeJsonParseOptional(row.signatureJson, SignatureSchema) as {
      name?: string;
      params?: Array<{ name: string; type?: string }>;
      returns?: string;
    } | undefined;
    if (sig?.name) {
      const params = sig.params
        ? `(${sig.params.map((p) => p.name).join(", ")})`
        : "()";
      const ret = sig.returns ? `: ${sig.returns}` : "";
      signature = `${sig.name}${params}${ret}`;
    }
  }

  return {
    symbolId: row.symbolId,
    name: row.name,
    kind: (isSymbolKind(row.kind) ? row.kind : "function"),
    exported: row.exported,
    signature,
  };
}

/**
 * Estimates token count for a directory summary.
 */
function estimateDirectorySummaryTokens(summary: DirectorySummary): number {
  let tokens = DIRECTORY_SUMMARY_HEADER_TOKENS;
  tokens += summary.exports.length * EXPORT_NAME_TOKENS;
  tokens += summary.topByFanIn.length * COMPACT_SYMBOL_REF_TOKENS;
  tokens += summary.topByChurn.length * COMPACT_SYMBOL_REF_TOKENS;
  return tokens;
}

// ============================================================================
// Overview Cache (singleflight + TTL)
// ============================================================================

/**
 * TTL for cached overview results. Short enough to catch version changes,
 * long enough to coalesce concurrent bursts of identical requests.
 */
const OVERVIEW_CACHE_TTL_MS = 5_000;
const MAX_OVERVIEW_CACHE_ENTRIES = 20;

interface OverviewCacheEntry {
  result: RepoOverview;
  expiresAt: number;
}

const overviewCache = new Map<string, OverviewCacheEntry>();
const overviewInflight = new Map<string, Promise<RepoOverview>>();

function makeOverviewCacheKey(request: RepoOverviewRequest): string {
  const hotspots = request.includeHotspots ?? (request.level === "full");
  return `${request.repoId}:${request.level}:${hotspots}:${JSON.stringify([...(request.directories ?? [])].sort())}:${request.maxDirectories ?? ""}:${request.maxExportsPerDirectory ?? ""}`;
}

/**
 * Clear the overview singleflight + TTL cache.
 * Called on version changes / index refresh.
 */
export function clearOverviewCache(): void {
  overviewCache.clear();
  overviewInflight.clear();
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Builds a repository overview with configurable detail level.
 * Uses singleflight dedup + short TTL cache to avoid redundant DB work
 * under concurrent load.
 *
 * @param request - Overview request parameters
 * @returns Repository overview with stats, directories, and optionally hotspots
 */
export async function buildRepoOverview(
  request: RepoOverviewRequest,
): Promise<RepoOverview> {
  const cacheKey = makeOverviewCacheKey(request);

  // 1. Check TTL cache
  const cached = overviewCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  // 2. Singleflight: if the same request is already in-flight, share its promise
  const inflight = overviewInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  // 3. Execute and cache
  const promise = buildRepoOverviewImpl(request);
  overviewInflight.set(cacheKey, promise);

  try {
    const result = await promise;
    overviewCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS,
    });
    // Evict oldest entry if cache exceeds limit
    if (overviewCache.size > MAX_OVERVIEW_CACHE_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestExpiry = Infinity;
      for (const [key, entry] of overviewCache) {
        if (key !== cacheKey && entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) overviewCache.delete(oldestKey);
    }
    return result;
  } finally {
    overviewInflight.delete(cacheKey);
  }
}

async function buildRepoOverviewImpl(
  request: RepoOverviewRequest,
): Promise<RepoOverview> {
  const conn = await getLadybugConn();
  const {
    repoId,
    level,
    includeHotspots = level === "full",
    directories: directoryFilter,
    maxDirectories = DEFAULT_MAX_DIRECTORIES,
    maxExportsPerDirectory = DEFAULT_MAX_EXPORTS_PER_DIRECTORY,
  } = request;

  // Get current version
  const latestVersion = await ladybugDb.getLatestVersion(conn, repoId);
  const versionId = latestVersion?.versionId ?? "0";

  // Fetch core rows once
  const [files, symbols, edgeCount, edgeCountsByType, clusterStats, processStats] =
    await Promise.all([
    ladybugDb.getFilesByRepo(conn, repoId),
    ladybugDb.getSymbolsByRepo(conn, repoId),
    ladybugDb.getEdgeCount(conn, repoId),
    ladybugDb.getEdgeCountsByType(conn, repoId),
    ladybugDb.getClusterOverviewStats(conn, repoId),
    ladybugDb.getProcessOverviewStats(conn, repoId),
  ]);

  // Always build stats
  const stats = buildRepoStats(files, symbols, edgeCount, edgeCountsByType);

  // Build directory summaries if requested
  const directorySummaries: DirectorySummary[] = [];
  if (level === "directories" || level === "full") {
    const summaries = await buildDirectorySummaries(
      repoId,
      files,
      symbols,
      maxDirectories,
      maxExportsPerDirectory,
      directoryFilter,
    );
    directorySummaries.push(...summaries);
  }

  // Build hotspots if requested
  let hotspots: CodebaseHotspots | undefined;
  if (includeHotspots || level === "full") {
    hotspots = await buildCodebaseHotspots(repoId, files, symbols);
  }

  // Identify architectural layers from directory structure
  const layers = identifyArchitecturalLayers(directorySummaries);

  // Find entry points (scoped to directoryFilter when set)
  const allEntryPoints = findEntryPoints(files);
  const entryPoints = directoryFilter?.length
    ? allEntryPoints.filter(ep => directoryFilter.some(d => { const nd = d.endsWith("/") ? d.slice(0, -1) : d; return ep === nd || ep.startsWith(nd + "/"); }))
    : allEntryPoints;

  // Calculate token metrics
  const fullCardsEstimate = stats.symbolCount * SYMBOL_TOKEN_MAX;
  const overviewTokens = calculateOverviewTokens(
    stats,
    directorySummaries,
    hotspots,
  );
  const compressionRatio =
    fullCardsEstimate > 0 ? fullCardsEstimate / overviewTokens : 1;

  const overview: RepoOverview = {
    repoId,
    versionId,
    generatedAt: new Date().toISOString(),
    stats,
    directories: directorySummaries,
    hotspots,
    layers: layers.length > 0 ? layers : undefined,
    entryPoints: entryPoints.length > 0 ? entryPoints : undefined,
    tokenMetrics: {
      fullCardsEstimate,
      overviewTokens,
      compressionRatio,
    },
  };

  // Skip global cluster/process stats when scoped to specific directories
  if (clusterStats.totalClusters > 0 && !directoryFilter?.length) {
    overview.clusters = {
      totalClusters: clusterStats.totalClusters,
      averageClusterSize:
        Math.round(clusterStats.averageClusterSize * 10) / 10,
      largestClusters: clusterStats.largestClusters,
    };
  }

  if (processStats.totalProcesses > 0 && !directoryFilter?.length) {
    overview.processes = {
      totalProcesses: processStats.totalProcesses,
      averageDepth: Math.round(processStats.averageDepth * 10) / 10,
      entryPoints: processStats.entryPoints,
      longestProcesses: processStats.longestProcesses,
    };
  }

  return overview;
}

/**
 * Builds high-level repository statistics.
 */
function buildRepoStats(
  files: ladybugDb.FileRow[],
  symbols: ladybugDb.SymbolRow[],
  edgeCount: number,
  edgesByType: Record<string, number>,
): RepoStats {
  const byKind = emptySymbolCounts();
  let exportedCount = 0;

  for (const sym of symbols) {
    if (sym.exported) exportedCount += 1;
    if (isSymbolKind(sym.kind)) {
      byKind[sym.kind] += 1;
    }
  }

  return {
    fileCount: files.length,
    symbolCount: symbols.length,
    edgeCount,
    exportedSymbolCount: exportedCount,
    byKind,
    byEdgeType: {
      call: edgesByType.call ?? 0,
      import: edgesByType.import ?? 0,
      config: edgesByType.config ?? 0,
    },
    avgSymbolsPerFile:
      files.length > 0 ? Math.round((symbols.length / files.length) * 10) / 10 : 0,
    avgEdgesPerSymbol:
      symbols.length > 0
        ? Math.round((edgeCount / symbols.length) * 10) / 10
        : 0,
  };
}

/**
 * Builds directory-level summaries.
 */
async function buildDirectorySummaries(
  repoId: RepoId,
  files: ladybugDb.FileRow[],
  symbols: ladybugDb.SymbolRow[],
  maxDirectories: number,
  maxExportsPerDirectory: number,
  directoryFilter?: string[],
): Promise<DirectorySummary[]> {
  const conn = await getLadybugConn();

  const fileById = new Map(files.map((f) => [f.fileId, f]));
  const symbolById = new Map(symbols.map((s) => [s.symbolId, s]));

  interface DirAgg {
    directory: string;
    fileCount: number;
    symbolCount: number;
    exportedCount: number;
    byKind: SymbolCountsByKind;
  }

  const aggregates = new Map<string, DirAgg>();

  for (const file of files) {
    const dir = file.directory ?? "";
    const agg =
      aggregates.get(dir) ??
      ({
        directory: dir,
        fileCount: 0,
        symbolCount: 0,
        exportedCount: 0,
        byKind: emptySymbolCounts(),
      } satisfies DirAgg);
    agg.fileCount += 1;
    aggregates.set(dir, agg);
  }

  const exportsByDir = new Map<string, string[]>();

  for (const symbol of symbols) {
    const file = fileById.get(symbol.fileId);
    const dir = file?.directory ?? "";
    const agg =
      aggregates.get(dir) ??
      ({
        directory: dir,
        fileCount: 0,
        symbolCount: 0,
        exportedCount: 0,
        byKind: emptySymbolCounts(),
      } satisfies DirAgg);

    agg.symbolCount += 1;
    if (symbol.exported) {
      agg.exportedCount += 1;
      const list = exportsByDir.get(dir) ?? [];
      list.push(symbol.name);
      exportsByDir.set(dir, list);
    }
    if (isSymbolKind(symbol.kind)) {
      agg.byKind[symbol.kind] += 1;
    }
    aggregates.set(dir, agg);
  }

  const topByFanIn = await ladybugDb.getTopSymbolsByFanIn(
    conn,
    repoId,
    DEFAULT_MAX_HOTSPOT_SYMBOLS * 2,
  );
  const topByChurn = await ladybugDb.getTopSymbolsByChurn(
    conn,
    repoId,
    DEFAULT_MAX_HOTSPOT_SYMBOLS * 2,
  );

  // Group top symbols by directory
  const topFanInByDir = new Map<string, CompactSymbolRef[]>();
  for (const row of topByFanIn) {
    const symbol = symbolById.get(row.symbolId);
    if (!symbol) continue;
    const file = fileById.get(symbol.fileId);
    const dir = file?.directory ?? "";
    const refs = topFanInByDir.get(dir) ?? [];
    if (refs.length < 3) {
      refs.push(toCompactRef(symbol));
      topFanInByDir.set(dir, refs);
    }
  }

  const topChurnByDir = new Map<string, CompactSymbolRef[]>();
  for (const row of topByChurn) {
    const symbol = symbolById.get(row.symbolId);
    if (!symbol) continue;
    const file = fileById.get(symbol.fileId);
    const dir = file?.directory ?? "";
    const refs = topChurnByDir.get(dir) ?? [];
    if (refs.length < 3) {
      refs.push(toCompactRef(symbol));
      topChurnByDir.set(dir, refs);
    }
  }

  // Build summaries
  const summaries: DirectorySummary[] = [];
  const allDirectories = new Set(Array.from(aggregates.keys()));

  const sortedAggregates = Array.from(aggregates.values()).sort(
    (a, b) => {
      // Primary: source directories before tests/scripts/other
      const pathPriority = (dir: string): number => {
        if (dir.startsWith("src/")) return 3;
        if (dir.startsWith("packages/")) return 2;
        if (dir.startsWith("native/")) return 2;
        if (dir.startsWith("scripts/")) return 1;
        if (dir.startsWith("tests/")) return 0;
        return 1;
      };
      const priA = pathPriority(a.directory);
      const priB = pathPriority(b.directory);
      if (priA !== priB) return priB - priA;
      // Secondary: by symbol count
      return b.symbolCount - a.symbolCount;
    },
  );

  for (const agg of sortedAggregates) {
    // Apply directory filter if specified
    if (directoryFilter && directoryFilter.length > 0) {
      const matches = directoryFilter.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = globToSafeRegex(pattern);
          return regex.test(agg.directory);
        }
        const normalizedPattern = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
        return agg.directory === normalizedPattern || agg.directory.startsWith(normalizedPattern + "/");
      });
      if (!matches) continue;
    }

    const exportNames = exportsByDir.get(agg.directory) ?? [];
    exportNames.sort((a, b) => a.localeCompare(b));

    const summary: DirectorySummary = {
      path: agg.directory || "(root)",
      fileCount: agg.fileCount,
      symbolCount: agg.symbolCount,
      exportedCount: agg.exportedCount,
      byKind: agg.byKind,
      exports: exportNames.slice(0, maxExportsPerDirectory),
      topByFanIn: topFanInByDir.get(agg.directory) ?? [],
      topByChurn: topChurnByDir.get(agg.directory) ?? [],
      estimatedFullTokens: agg.symbolCount * SYMBOL_TOKEN_MAX,
      summaryTokens: 0, // Will be calculated below
    };

    summary.summaryTokens = estimateDirectorySummaryTokens(summary);
    summaries.push(summary);

    if (summaries.length >= maxDirectories) break;
  }

  // Add subdirectories info
  for (const summary of summaries) {
    const subdirs = Array.from(allDirectories).filter((d) => {
      if (d === summary.path) return false;
      const parent = summary.path === "(root)" ? "" : summary.path;
      if (!d.startsWith(parent)) return false;
      const remainder = d.slice(parent.length);
      // Only immediate children
      const parts = remainder.split("/").filter(Boolean);
      return parts.length === 1;
    });
    if (subdirs.length > 0) {
      summary.subdirectories = subdirs;
    }
  }

  return summaries;
}

/**
 * Builds codebase hotspot analysis.
 */
async function buildCodebaseHotspots(
  repoId: RepoId,
  files: ladybugDb.FileRow[],
  symbols: ladybugDb.SymbolRow[],
): Promise<CodebaseHotspots> {
  const conn = await getLadybugConn();

  const symbolById = new Map(symbols.map((s) => [s.symbolId, s]));
  const fileById = new Map(files.map((f) => [f.fileId, f]));

  const [topByFanIn, topByChurn] = await Promise.all([
    ladybugDb.getTopSymbolsByFanIn(conn, repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS),
    ladybugDb.getTopSymbolsByChurn(conn, repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS),
  ]);

  const mostDepended: CompactSymbolRef[] = [];
  for (const row of topByFanIn) {
    const sym = symbolById.get(row.symbolId);
    if (!sym) continue;
    mostDepended.push(toCompactRef(sym));
  }

  const mostChanged: CompactSymbolRef[] = [];
  for (const row of topByChurn) {
    const sym = symbolById.get(row.symbolId);
    if (!sym) continue;
    mostChanged.push(toCompactRef(sym));
  }

  // Largest files by symbol count
  const symbolCountByFile = new Map<string, number>();
  for (const sym of symbols) {
    symbolCountByFile.set(sym.fileId, (symbolCountByFile.get(sym.fileId) ?? 0) + 1);
  }

  const largestFiles = Array.from(symbolCountByFile.entries())
    .map(([fileId, symbolCount]) => ({
      file: fileById.get(fileId)?.relPath ?? "",
      symbolCount,
    }))
    .filter((f) => Boolean(f.file))
    .sort((a, b) => b.symbolCount - a.symbolCount)
    .slice(0, DEFAULT_MAX_HOTSPOT_SYMBOLS);

  // Most connected files by estimated edge endpoints (fanIn+fanOut per symbol)
  const metricsMap = await ladybugDb.getMetricsBySymbolIds(
    conn,
    symbols.map((s) => s.symbolId),
  );
  const edgeCountByFile = new Map<string, number>();
  for (const sym of symbols) {
    const metrics = metricsMap.get(sym.symbolId);
    const endpoints = (metrics?.fanIn ?? 0) + (metrics?.fanOut ?? 0);
    edgeCountByFile.set(sym.fileId, (edgeCountByFile.get(sym.fileId) ?? 0) + endpoints);
  }

  const mostConnected = Array.from(edgeCountByFile.entries())
    .map(([fileId, edgeCount]) => ({
      file: fileById.get(fileId)?.relPath ?? "",
      edgeCount,
    }))
    .filter((f) => Boolean(f.file))
    .sort((a, b) => b.edgeCount - a.edgeCount)
    .slice(0, DEFAULT_MAX_HOTSPOT_SYMBOLS);

  return {
    mostDepended,
    mostChanged,
    largestFiles,
    mostConnected,
  };
}

/**
 * Identifies architectural layers from directory structure.
 */
function identifyArchitecturalLayers(directories: DirectorySummary[]): string[] {
  const layers: string[] = [];
  const layerPatterns = [
    { pattern: /^src\/?(api|routes|controllers|handlers)\/?/, layer: "API" },
    { pattern: /^src\/?(services|domain|core)\/?/, layer: "Service" },
    { pattern: /^src\/?(db|data|models|entities|repositories)\/?/, layer: "Data" },
    { pattern: /^src\/?(utils?|helpers?|lib|common)\/?/, layer: "Utilities" },
    { pattern: /^src\/?(cli|commands)\/?/, layer: "CLI" },
    { pattern: /^src\/?(config|settings)\/?/, layer: "Configuration" },
    { pattern: /^src\/?(mcp|protocol)\/?/, layer: "Protocol" },
    { pattern: /^src\/?(indexer|parser|analyzer)\/?/, layer: "Indexer" },
    { pattern: /^src\/?(graph|slice)\/?/, layer: "Graph" },
    { pattern: /^tests?\/?/, layer: "Tests" },
  ];

  for (const dir of directories) {
    for (const { pattern, layer } of layerPatterns) {
      if (pattern.test(dir.path) && !layers.includes(layer)) {
        layers.push(layer);
      }
    }
  }

  return layers;
}

/**
 * Finds entry point files.
 */
function findEntryPoints(files: ladybugDb.FileRow[]): string[] {
  const entryPatterns = [
    "main.ts",
    "index.ts",
    "server.ts",
    "app.ts",
    "cli.ts",
    "main.js",
    "index.js",
    "server.js",
    "app.js",
    "cli.js",
  ];

  const entryPoints: string[] = [];
  for (const file of files) {
    const fileName = file.relPath.split("/").pop() ?? "";
    if (entryPatterns.includes(fileName)) {
      entryPoints.push(file.relPath);
    }
  }
  return entryPoints;
}

/**
 * Calculates total token count for overview.
 */
function calculateOverviewTokens(
  _stats: RepoStats,
  directories: DirectorySummary[],
  hotspots?: CodebaseHotspots,
): number {
  // Base stats section (stats overhead is fixed)
  let tokens = 50;

  // Directory summaries
  for (const dir of directories) {
    tokens += dir.summaryTokens;
  }

  // Hotspots
  if (hotspots) {
    tokens += hotspots.mostDepended.length * COMPACT_SYMBOL_REF_TOKENS;
    tokens += hotspots.mostChanged.length * COMPACT_SYMBOL_REF_TOKENS;
    tokens += hotspots.largestFiles.length * 5;
    tokens += hotspots.mostConnected.length * 5;
  }

  return tokens;
}
