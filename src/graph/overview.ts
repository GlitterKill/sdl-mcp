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

import type { RepoId, SymbolKind } from "../db/schema.js";
import type {
  RepoOverview,
  RepoOverviewRequest,
  RepoStats,
  DirectorySummary,
  CodebaseHotspots,
  CompactSymbolRef,
  SymbolCountsByKind,
} from "../mcp/types.js";
import * as db from "../db/queries.js";
import { SYMBOL_TOKEN_MAX } from "../config/constants.js";

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
 * Converts a TopSymbolRow to CompactSymbolRef.
 */
function toCompactRef(row: db.TopSymbolRow): CompactSymbolRef {
  let signature: string | undefined;
  if (row.signature_json) {
    try {
      const sig = JSON.parse(row.signature_json);
      if (sig.name) {
        const params = sig.params
          ? `(${sig.params.map((p: { name: string; type?: string }) => p.name).join(", ")})`
          : "()";
        const ret = sig.returns ? `: ${sig.returns}` : "";
        signature = `${sig.name}${params}${ret}`;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return {
    symbolId: row.symbol_id,
    name: row.name,
    kind: row.kind as SymbolKind,
    exported: row.exported === 1,
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
// Main Builder
// ============================================================================

/**
 * Builds a repository overview with configurable detail level.
 *
 * @param request - Overview request parameters
 * @returns Repository overview with stats, directories, and optionally hotspots
 */
export function buildRepoOverview(request: RepoOverviewRequest): RepoOverview {
  const {
    repoId,
    level,
    includeHotspots = level === "full",
    directories: directoryFilter,
    maxDirectories = DEFAULT_MAX_DIRECTORIES,
    maxExportsPerDirectory = DEFAULT_MAX_EXPORTS_PER_DIRECTORY,
  } = request;

  // Get current version
  const latestVersion = db.getLatestVersion(repoId);
  const versionId = latestVersion?.version_id ?? "0";

  // Always build stats
  const stats = buildRepoStats(repoId);

  // Build directory summaries if requested
  const directorySummaries: DirectorySummary[] = [];
  if (level === "directories" || level === "full") {
    const summaries = buildDirectorySummaries(
      repoId,
      maxDirectories,
      maxExportsPerDirectory,
      directoryFilter,
    );
    directorySummaries.push(...summaries);
  }

  // Build hotspots if requested
  let hotspots: CodebaseHotspots | undefined;
  if (includeHotspots || level === "full") {
    hotspots = buildCodebaseHotspots(repoId);
  }

  // Identify architectural layers from directory structure
  const layers = identifyArchitecturalLayers(directorySummaries);

  // Find entry points
  const entryPoints = findEntryPoints(repoId);

  // Calculate token metrics
  const fullCardsEstimate = stats.symbolCount * SYMBOL_TOKEN_MAX;
  const overviewTokens = calculateOverviewTokens(
    stats,
    directorySummaries,
    hotspots,
  );
  const compressionRatio =
    fullCardsEstimate > 0 ? fullCardsEstimate / overviewTokens : 1;

  return {
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
}

/**
 * Builds high-level repository statistics.
 */
function buildRepoStats(repoId: RepoId): RepoStats {
  const totals = db.getRepoTotals(repoId);
  const edgesByType = db.getEdgeCountsByType(repoId);
  const dirAggregates = db.getDirectoryAggregates(repoId);

  // Aggregate symbol counts by kind across all directories
  const byKind = emptySymbolCounts();
  for (const dir of dirAggregates) {
    byKind.function += dir.function_count;
    byKind.class += dir.class_count;
    byKind.interface += dir.interface_count;
    byKind.type += dir.type_count;
    byKind.method += dir.method_count;
    byKind.variable += dir.variable_count;
    byKind.module += dir.module_count;
    byKind.constructor += dir.constructor_count;
  }

  return {
    fileCount: totals.fileCount,
    symbolCount: totals.symbolCount,
    edgeCount: totals.edgeCount,
    exportedSymbolCount: totals.exportedCount,
    byKind,
    byEdgeType: edgesByType,
    avgSymbolsPerFile:
      totals.fileCount > 0
        ? Math.round((totals.symbolCount / totals.fileCount) * 10) / 10
        : 0,
    avgEdgesPerSymbol:
      totals.symbolCount > 0
        ? Math.round((totals.edgeCount / totals.symbolCount) * 10) / 10
        : 0,
  };
}

/**
 * Builds directory-level summaries.
 */
function buildDirectorySummaries(
  repoId: RepoId,
  maxDirectories: number,
  maxExportsPerDirectory: number,
  directoryFilter?: string[],
): DirectorySummary[] {
  const dirAggregates = db.getDirectoryAggregates(repoId);
  const exportedSymbols = db.getExportedSymbolsByDirectory(
    repoId,
    maxExportsPerDirectory,
  );
  const topByFanIn = db.getTopSymbolsByFanIn(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS * 2);
  const topByChurn = db.getTopSymbolsByChurn(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS * 2);

  // Group exported symbols by directory
  const exportsByDir = new Map<string, string[]>();
  for (const exp of exportedSymbols) {
    const dir = exp.directory;
    if (!exportsByDir.has(dir)) {
      exportsByDir.set(dir, []);
    }
    exportsByDir.get(dir)!.push(exp.name);
  }

  // Group top symbols by directory
  const topFanInByDir = new Map<string, CompactSymbolRef[]>();
  for (const sym of topByFanIn) {
    const dir = sym.directory;
    if (!topFanInByDir.has(dir)) {
      topFanInByDir.set(dir, []);
    }
    const refs = topFanInByDir.get(dir)!;
    if (refs.length < 3) {
      refs.push(toCompactRef(sym));
    }
  }

  const topChurnByDir = new Map<string, CompactSymbolRef[]>();
  for (const sym of topByChurn) {
    const dir = sym.directory;
    if (!topChurnByDir.has(dir)) {
      topChurnByDir.set(dir, []);
    }
    const refs = topChurnByDir.get(dir)!;
    if (refs.length < 3) {
      refs.push(toCompactRef(sym));
    }
  }

  // Build summaries
  const summaries: DirectorySummary[] = [];
  const allDirectories = new Set<string>();

  for (const agg of dirAggregates) {
    // Apply directory filter if specified
    if (directoryFilter && directoryFilter.length > 0) {
      const matches = directoryFilter.some((pattern) => {
        if (pattern.includes("*")) {
          const regex = new RegExp(
            "^" + pattern.replace(/\*/g, ".*") + "$",
          );
          return regex.test(agg.directory);
        }
        return agg.directory.startsWith(pattern);
      });
      if (!matches) continue;
    }

    allDirectories.add(agg.directory);

    const summary: DirectorySummary = {
      path: agg.directory || "(root)",
      fileCount: agg.file_count,
      symbolCount: agg.symbol_count,
      exportedCount: agg.exported_count,
      byKind: {
        function: agg.function_count,
        class: agg.class_count,
        interface: agg.interface_count,
        type: agg.type_count,
        method: agg.method_count,
        variable: agg.variable_count,
        module: agg.module_count,
        constructor: agg.constructor_count,
      },
      exports: exportsByDir.get(agg.directory) ?? [],
      topByFanIn: topFanInByDir.get(agg.directory) ?? [],
      topByChurn: topChurnByDir.get(agg.directory) ?? [],
      estimatedFullTokens: agg.symbol_count * SYMBOL_TOKEN_MAX,
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
function buildCodebaseHotspots(repoId: RepoId): CodebaseHotspots {
  const topByFanIn = db.getTopSymbolsByFanIn(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS);
  const topByChurn = db.getTopSymbolsByChurn(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS);
  const largestFiles = db.getFilesBySymbolCount(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS);
  const mostConnected = db.getFilesByEdgeCount(repoId, DEFAULT_MAX_HOTSPOT_SYMBOLS);

  return {
    mostDepended: topByFanIn.map(toCompactRef),
    mostChanged: topByChurn.map(toCompactRef),
    largestFiles: largestFiles.map((f) => ({
      file: f.rel_path,
      symbolCount: f.symbol_count,
    })),
    mostConnected: mostConnected.map((f) => ({
      file: f.rel_path,
      edgeCount: f.edge_count,
    })),
  };
}

/**
 * Identifies architectural layers from directory structure.
 */
function identifyArchitecturalLayers(
  directories: DirectorySummary[],
): string[] {
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
function findEntryPoints(repoId: RepoId): string[] {
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

  const files = db.getFilesByRepo(repoId);
  const entryPoints: string[] = [];

  for (const file of files) {
    const fileName = file.rel_path.split("/").pop() ?? "";
    if (entryPatterns.includes(fileName)) {
      entryPoints.push(file.rel_path);
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
