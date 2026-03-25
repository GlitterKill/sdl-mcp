/**
 * In-Memory Graph Snapshot Cache
 *
 * Maintains per-repo graph snapshots with TTL-based expiration so that
 * slice builds can use the fast in-memory beam search path instead of
 * the DB-backed beamSearchLadybug when a recent snapshot is available.
 *
 * Snapshots are populated after indexing and during the first slice build.
 * Subsequent builds within the TTL window reuse the cached graph.
 *
 * @module graph/graphSnapshotCache
 */

import type { Connection } from "kuzu";
import type { RepoId, SymbolId, EdgeType } from "../db/schema.js";
import type { Graph } from "./buildGraph.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Legacy SymbolRow / EdgeRow shapes for the in-memory Graph interface
// ---------------------------------------------------------------------------
type SymbolRow = Graph extends { symbols: Map<string, infer S> } ? S : never;
type EdgeRow = Graph extends { edges: (infer E)[] } ? E : never;
type MetricsRow = Graph extends { metrics?: Map<string, infer M> }
  ? M
  : never;
type FileRow = Graph extends { files?: Map<number, infer F> } ? F : never;

interface GraphSnapshot {
  graph: Graph;
  createdAt: number;
  symbolCount: number;
  edgeCount: number;
  clusterCount: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How long a snapshot is valid before it must be rebuilt (default 5 min). */
let snapshotTtlMs = 5 * 60_000;

/** Maximum number of symbols per repo before we skip snapshot caching. */
let maxSnapshotSymbols = 15_000;

const MAX_CACHED_REPOS = 3;
const snapshotsByRepo = new Map<RepoId, GraphSnapshot>();
const loadingPromises = new Map<RepoId, Promise<Graph | null>>();

/**
 * Configure cache settings.
 */
export function configureGraphSnapshotCache(options: {
  ttlMs?: number;
  maxSymbols?: number;
}): void {
  if (options.ttlMs !== undefined && options.ttlMs >= 1000) {
    snapshotTtlMs = options.ttlMs;
  }
  if (options.maxSymbols !== undefined && options.maxSymbols >= 100) {
    maxSnapshotSymbols = options.maxSymbols;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a cached graph snapshot for a repo, or null if expired / not present.
 */
export function getGraphSnapshot(repoId: RepoId): Graph | null {
  const entry = snapshotsByRepo.get(repoId);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > snapshotTtlMs) {
    snapshotsByRepo.delete(repoId);
    logger.debug("Graph snapshot expired", {
      repoId,
      ageMs: Date.now() - entry.createdAt,
    });
    return null;
  }

  return entry.graph;
}

/**
 * Check if a valid snapshot exists without returning it.
 */
export function hasGraphSnapshot(repoId: RepoId): boolean {
  return getGraphSnapshot(repoId) !== null;
}

/**
 * Store a graph snapshot. Called after indexing or first slice build.
 */
export function setGraphSnapshot(repoId: RepoId, graph: Graph): void {
  snapshotsByRepo.set(repoId, {
    graph,
    createdAt: Date.now(),
    symbolCount: graph.symbols.size,
    edgeCount: graph.edges.length,
    clusterCount: graph.clusters?.size ?? 0,
  });
  // Evict oldest snapshot if cache exceeds limit
  if (snapshotsByRepo.size > MAX_CACHED_REPOS) {
    let oldestKey: RepoId | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of snapshotsByRepo) {
      if (key !== repoId && entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      snapshotsByRepo.delete(oldestKey);
      logger.debug("Evicted oldest graph snapshot", { evictedRepoId: oldestKey });
    }
  }
  logger.debug("Graph snapshot cached", {
    repoId,
    symbolCount: graph.symbols.size,
    edgeCount: graph.edges.length,
    clusterCount: graph.clusters?.size ?? 0,
  });
}

/**
 * Invalidate a repo's cached snapshot (e.g., after re-indexing).
 */
export function invalidateGraphSnapshot(repoId: RepoId): void {
  snapshotsByRepo.delete(repoId);
  loadingPromises.delete(repoId);
}

/**
 * Clear all cached snapshots.
 */
export function clearGraphSnapshots(): void {
  snapshotsByRepo.clear();
  loadingPromises.clear();
}

/**
 * Get cache diagnostics.
 */
export function getGraphSnapshotStats(): {
  cachedRepos: number;
  entries: Array<{
    repoId: string;
    symbolCount: number;
    edgeCount: number;
    clusterCount: number;
    ageMs: number;
  }>;
} {
  const now = Date.now();
  const entries: Array<{ repoId: string; symbolCount: number; edgeCount: number; clusterCount: number; ageMs: number }> = [];
  for (const [repoId, entry] of snapshotsByRepo) {
    entries.push({
      repoId,
      symbolCount: entry.symbolCount,
      edgeCount: entry.edgeCount,
      clusterCount: entry.clusterCount,
      ageMs: now - entry.createdAt,
    });
  }
  return { cachedRepos: snapshotsByRepo.size, entries };
}

/**
 * Load a full-repo graph from LadybugDB and cache it as a snapshot.
 * Returns null if the repo has too many symbols (exceeds maxSnapshotSymbols).
 *
 * This builds the legacy Graph shape with adjacency maps that the in-memory
 * beamSearch function expects.
 *
 * If a load is already in-flight for this repo, the second caller awaits
 * the same promise instead of returning null.
 */
export async function loadAndCacheGraphSnapshot(
  conn: Connection,
  repoId: RepoId,
): Promise<Graph | null> {
  const inflight = loadingPromises.get(repoId);
  if (inflight) {
    return inflight;
  }

  const promise = _loadGraphSnapshot(conn, repoId);
  loadingPromises.set(repoId, promise);
  try {
    return await promise;
  } finally {
    loadingPromises.delete(repoId);
  }
}

async function _loadGraphSnapshot(
  conn: Connection,
  repoId: RepoId,
): Promise<Graph | null> {
    // Check symbol count first to avoid loading huge repos
    const symbolCount = await ladybugDb.getSymbolCount(conn, repoId);
    if (symbolCount > maxSnapshotSymbols) {
        logger.debug("Repo too large for graph snapshot cache", {
            repoId,
            symbolCount,
            maxSnapshotSymbols,
        });
        return null;
    }

    const allSymbols = await ladybugDb.getSymbolsByRepo(conn, repoId);
    if (allSymbols.length === 0) {
        return null;
    }

    // Load edges, metrics, files, and clusters in parallel (independent queries)
    const [allEdges, allMetrics, allFiles, clusterMembers] = await Promise.all([
        ladybugDb.getEdgesByRepo(conn, repoId),
        ladybugDb.getMetricsByRepo(conn, repoId),
        ladybugDb.getFilesByRepo(conn, repoId),
        ladybugDb.getClusterMembersForRepo(conn, repoId).catch((error) => {
            logger.debug("Optional clusters load failed for snapshot", { error: String(error) });
            return [] as Awaited<ReturnType<typeof ladybugDb.getClusterMembersForRepo>>;
        }),
    ]);

    const metrics = new Map<SymbolId, MetricsRow>();

    for (const [symbolId, m] of allMetrics.entries()) {
        metrics.set(symbolId, {
            symbol_id: symbolId,
            fan_in: m.fanIn,
            fan_out: m.fanOut,
            churn_30d: m.churn30d,
            test_refs_json: m.testRefsJson,
            canonical_test_json: m.canonicalTestJson,
            updated_at: m.updatedAt,
        } as MetricsRow);
    }

    // Build file maps
    const files = new Map<number, FileRow>();
    const fileIdMap = new Map<string, number>();
    let nextFileId = 1;

    for (const f of allFiles) {
        const numericId = nextFileId++;
        fileIdMap.set(f.fileId, numericId);
        files.set(numericId, {
            file_id: numericId,
            repo_id: repoId,
            rel_path: f.relPath,
            content_hash: f.contentHash,
            language: f.language,
            byte_size: f.byteSize,
            last_indexed_at: f.lastIndexedAt,
            directory: f.directory,
        } as FileRow);
    }

    // Build cluster map
    const clusters = new Map<SymbolId, string>();
    for (const m of clusterMembers) {
        clusters.set(m.symbolId, m.clusterId);
    }

    // Build symbol map (converting ladybugDb.SymbolRow -> legacy SymbolRow)
    const symbols = new Map<SymbolId, SymbolRow>();
    for (const sym of allSymbols) {
        const fileId = fileIdMap.get(sym.fileId) ?? 0;
        symbols.set(sym.symbolId, {
            symbol_id: sym.symbolId,
            repo_id: sym.repoId,
            file_id: fileId,
            kind: sym.kind as SymbolRow["kind"],
            name: sym.name,
            exported: sym.exported ? 1 : 0,
            visibility: sym.visibility as SymbolRow["visibility"],
            language: sym.language,
            range_start_line: sym.rangeStartLine,
            range_start_col: sym.rangeStartCol,
            range_end_line: sym.rangeEndLine,
            range_end_col: sym.rangeEndCol,
            ast_fingerprint: sym.astFingerprint,
            signature_json: sym.signatureJson,
            summary: sym.summary,
            invariants_json: sym.invariantsJson,
            side_effects_json: sym.sideEffectsJson,
            updated_at: sym.updatedAt,
        } as SymbolRow);
    }

    // Build edge list + adjacency maps (converting ladybugDb.EdgeRow -> legacy EdgeRow)
    const edges: EdgeRow[] = [];
    const adjacencyOut = new Map<SymbolId, EdgeRow[]>();
    const adjacencyIn = new Map<SymbolId, EdgeRow[]>();

    // Init adjacency maps for all symbols
    for (const symbolId of symbols.keys()) {
        adjacencyOut.set(symbolId, []);
        adjacencyIn.set(symbolId, []);
    }

    for (const edge of allEdges) {
        const legacyEdge = {
            from_symbol_id: edge.fromSymbolId,
            to_symbol_id: edge.toSymbolId,
            type: edge.edgeType as EdgeType,
            weight: edge.weight,
            confidence: edge.confidence,
        } as EdgeRow;

        edges.push(legacyEdge);

        const outList = adjacencyOut.get(edge.fromSymbolId);
        if (outList) outList.push(legacyEdge);

        const inList = adjacencyIn.get(edge.toSymbolId);
        if (inList) inList.push(legacyEdge);
    }

    const graph: Graph = {
        repoId,
        symbols,
        edges,
        adjacencyIn,
        adjacencyOut,
        metrics,
        files,
        clusters,
    };

    setGraphSnapshot(repoId, graph);

    logger.info("Graph snapshot loaded and cached", {
        repoId,
        symbolCount: symbols.size,
        edgeCount: edges.length,
        fileCount: files.size,
        clusterCount: clusters.size,
    });

    return graph;
}
