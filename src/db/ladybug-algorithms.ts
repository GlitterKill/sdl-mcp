import type { Connection } from "kuzu";
import { exec, queryAll, querySingle, toNumber } from "./ladybug-core.js";
import { getExtensionCapabilities } from "./extension-caps.js";
import { logger } from "../util/logger.js";

/**
 * LadybugDB Algorithm Adapter
 *
 * Single entry point for graph algorithm execution that:
 *   - Detects whether the `algo` extension is available (per-connection cache)
 *   - Projects a deterministic graph name per repo
 *   - Runs PageRank, K-core, and Louvain community detection (shadow mode)
 *   - Issues shortest-path queries via native Cypher path syntax
 *
 * Design goals:
 *   - Capability-safe: missing `algo` extension logs a warning and returns
 *     empty arrays instead of throwing.
 *   - Shortest path uses native Cypher variable-length path syntax, so it
 *     works without the `algo` extension.
 *   - All other modules should route algorithm calls through this adapter
 *     instead of issuing raw `INSTALL algo`/`LOAD algo` Cypher.
 */

export interface AlgoCapability {
  supported: boolean;
  reason?: string;
}

export interface PageRankResult {
  symbolId: string;
  score: number;
}

export interface KCoreResult {
  symbolId: string;
  coreness: number;
}

export interface LouvainCommunityResult {
  symbolId: string;
  communityId: number;
}

export interface PageRankOptions {
  /** Maximum iterations (default 20) */
  maxIterations?: number;
  /** Damping factor (default 0.85) */
  dampingFactor?: number;
  /** Convergence tolerance (default 1e-6) */
  tolerance?: number;
}

export interface KCoreOptions {
  /** Optional lower-bound k value to filter */
  minK?: number;
}

export interface LouvainOptions {
  /** Maximum iterations (default 10) */
  maxIterations?: number;
}

interface RepoProjectionPredicates {
  nodePredicate: string;
  relPredicate: string;
}

/**
 * Cache capability detection per-connection. Uses a WeakMap so that
 * the cache is automatically cleared when a connection is garbage collected.
 */
const capabilityCacheByConn = new WeakMap<Connection, AlgoCapability>();

/**
 * Cache whether a given repo already has a projected graph.
 * Key format: `${repoId}` (the projected graph name is deterministic).
 */
const projectedGraphsByConn = new WeakMap<Connection, Set<string>>();

/**
 * Deterministic graph projection name for a given repo.
 * LadybugDB graph projection names must be valid identifiers, so we
 * sanitize the repoId conservatively.
 */
export function graphProjectionName(repoId: string): string {
  const sanitized = repoId.replace(/[^A-Za-z0-9_]/g, "_");
  return `sdl_graph_${sanitized}`;
}

/**
 * Detect whether the `algo` extension is available on this connection.
 *
 * Fast path: pool init runs INSTALL+LOAD for `algo` once on the write conn
 * and per-conn LOAD on every read conn (see ladybug.ts MANAGED_EXTENSIONS).
 * If that succeeded, this returns supported without further DDL.
 *
 * Fallback: when pool init didn't run (legacy tests, partial init), lazily
 * INSTALL+LOAD on the caller's connection. Lazy DDL on a read conn races
 * with the indexer's active write txn, so prefer the pool-init path.
 *
 * Caches per connection.
 */
export async function detectAlgoCapability(
  conn: Connection,
): Promise<AlgoCapability> {
  const cached = capabilityCacheByConn.get(conn);
  if (cached) return cached;

  // Fast path: pool init (ladybug.ts MANAGED_EXTENSIONS) runs INSTALL+LOAD
  // for `algo` once on the write conn and per-conn LOAD on every read conn.
  // If that succeeded, the extension is already loaded on this conn — skip
  // the lazy INSTALL/LOAD that would otherwise race the indexer's write txn
  // and emit "Cannot start a new write transaction" warnings.
  if (getExtensionCapabilities().algo) {
    const capability: AlgoCapability = { supported: true };
    capabilityCacheByConn.set(conn, capability);
    return capability;
  }

  // Fallback: pool init didn't run (legacy tests, partial init). Lazy
  // INSTALL/LOAD on the caller's connection. Best-effort.
  try {
    try {
      await exec(conn, "INSTALL algo");
    } catch (installErr) {
      logger.debug(
        "ladybug-algorithms: lazy INSTALL algo failed (may be benign)",
        {
          error:
            installErr instanceof Error
              ? installErr.message
              : String(installErr),
        },
      );
    }

    await exec(conn, "LOAD algo");
    const capability: AlgoCapability = { supported: true };
    capabilityCacheByConn.set(conn, capability);
    logger.debug(
      "ladybug-algorithms: algo extension loaded successfully (lazy)",
    );
    return capability;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const capability: AlgoCapability = { supported: false, reason };
    capabilityCacheByConn.set(conn, capability);
    logger.warn(
      "ladybug-algorithms: algo extension unavailable, algorithm runs will return empty arrays",
      { reason },
    );
    return capability;
  }
}


function escapeCypherStringLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSingleQuotedLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildRepoProjectionPredicates(repoId: string): RepoProjectionPredicates {
  return {
    nodePredicate: `n.repoId = "${escapeCypherStringLiteral(repoId)}"`,
    // Keep the projected graph aligned with the canonical cluster/process
    // graph, which deliberately excludes import/config hubs.
    relPredicate: `r.edgeType = "call"`,
  };
}

/**
 * Ensure a deterministic graph projection exists for the given repo.
 * Projections are connection-local and lazy-evaluated by Kuzu, so we only
 * need to register them once per connection.
 */
async function ensureGraphProjection(
  conn: Connection,
  repoId: string,
): Promise<boolean> {
  let projections = projectedGraphsByConn.get(conn);
  if (!projections) {
    projections = new Set<string>();
    projectedGraphsByConn.set(conn, projections);
  }

  const name = graphProjectionName(repoId);
  if (projections.has(name)) return true;
  const { nodePredicate, relPredicate } = buildRepoProjectionPredicates(repoId);

  try {
    // PROJECT_GRAPH currently requires literal strings rather than query
    // parameters for the graph name / predicate map values. Keep the
    // interpolation tightly scoped to sanitized internal values.
    await exec(
      conn,
      `CALL PROJECT_GRAPH(
         '${escapeSingleQuotedLiteral(name)}',
         { 'Symbol': '${escapeSingleQuotedLiteral(nodePredicate)}' },
         { 'DEPENDS_ON': '${escapeSingleQuotedLiteral(relPredicate)}' }
       )`,
      {},
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (
      !lower.includes("already exists") &&
      !lower.includes("already been created") &&
      !lower.includes("duplicate")
    ) {
      throw err;
    }
  }

  projections.add(name);
  logger.debug("ladybug-algorithms: projected repo graph", {
    repoId,
    name,
  });
  return true;
}

/**
 * Clear the cached capability for a given connection. Primarily used by
 * tests that want to re-detect capability after faking availability.
 */
export function clearAlgoCapabilityCache(conn: Connection): void {
  capabilityCacheByConn.delete(conn);
  projectedGraphsByConn.delete(conn);
}

/**
 * Run PageRank centrality over the repo's symbol graph.
 * Returns an empty array when the `algo` extension is unavailable.
 */
export async function runPageRank(
  conn: Connection,
  repoId: string,
  opts: PageRankOptions = {},
): Promise<PageRankResult[]> {
  const capability = await detectAlgoCapability(conn);
  if (!capability.supported) {
    logger.warn("ladybug-algorithms: runPageRank skipped (algo unavailable)", {
      repoId,
      reason: capability.reason ?? "unknown",
    });
    return [];
  }

  const ready = await ensureGraphProjection(conn, repoId);
  if (!ready) return [];

  const maxIterations = opts.maxIterations ?? 20;
  const dampingFactor = opts.dampingFactor ?? 0.85;
  const tolerance = opts.tolerance ?? 1e-6;
  const rows = await queryAll<{ symbolId: string; score: unknown }>(
    conn,
    `CALL page_rank(
       '${escapeSingleQuotedLiteral(graphProjectionName(repoId))}',
       maxIterations := $maxIterations,
       dampingFactor := $dampingFactor,
       tolerance := $tolerance
     )
     RETURN node.symbolId AS symbolId, rank AS score`,
    {
      maxIterations,
      dampingFactor,
      tolerance,
    },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    score: toNumber(row.score),
  }));
}

/**
 * Run K-core decomposition to compute coreness per symbol.
 * Returns an empty array when the `algo` extension is unavailable.
 */
export async function runKCore(
  conn: Connection,
  repoId: string,
  opts: KCoreOptions = {},
): Promise<KCoreResult[]> {
  const capability = await detectAlgoCapability(conn);
  if (!capability.supported) {
    logger.warn("ladybug-algorithms: runKCore skipped (algo unavailable)", {
      repoId,
      reason: capability.reason ?? "unknown",
    });
    return [];
  }

  const ready = await ensureGraphProjection(conn, repoId);
  if (!ready) return [];

  const minK = opts.minK ?? 0;
  const rows = await queryAll<{ symbolId: string; coreness: unknown }>(
    conn,
    `CALL k_core_decomposition('${escapeSingleQuotedLiteral(graphProjectionName(repoId))}')
     RETURN node.symbolId AS symbolId, k_degree AS coreness
     ORDER BY coreness DESC`,
    {},
  );

  return rows
    .map((row) => ({
      symbolId: row.symbolId,
      coreness: toNumber(row.coreness),
    }))
    .filter((row) => row.coreness >= minK);
}

/**
 * Run Louvain community detection (shadow mode — does not overwrite
 * canonical clusters).
 * Returns an empty array when the `algo` extension is unavailable.
 */
export async function runLouvain(
  conn: Connection,
  repoId: string,
  opts: LouvainOptions = {},
): Promise<LouvainCommunityResult[]> {
  const capability = await detectAlgoCapability(conn);
  if (!capability.supported) {
    logger.warn("ladybug-algorithms: runLouvain skipped (algo unavailable)", {
      repoId,
      reason: capability.reason ?? "unknown",
    });
    return [];
  }

  const ready = await ensureGraphProjection(conn, repoId);
  if (!ready) return [];

  const maxIterations = opts.maxIterations ?? 10;
  const rows = await queryAll<{
    symbolId: string;
    communityId: unknown;
  }>(
    conn,
    `CALL louvain(
       '${escapeSingleQuotedLiteral(graphProjectionName(repoId))}',
       maxIterations := $maxIterations
     )
     RETURN node.symbolId AS symbolId, louvain_id AS communityId`,
    {
      maxIterations,
    },
  );

  return rows.map((row) => ({
    symbolId: row.symbolId,
    communityId: toNumber(row.communityId),
  }));
}

/**
 * Build a Cypher variable-length path clause like `-[:REL_TYPE*min..max]->`.
 *
 * Kuzu does not support parameterized values inside variable-length path
 * bounds (`*min..max`), so we validate and clamp the integers here before
 * interpolating.
 */
function buildVarLenPathClause(
  minHops: number,
  maxHops: number,
  relType: string,
): string {
  if (!Number.isSafeInteger(minHops) || minHops < 0) {
    throw new Error(`Invalid minHops: ${minHops}`);
  }
  if (!Number.isSafeInteger(maxHops) || maxHops < 1) {
    throw new Error(`Invalid maxHops: ${maxHops}`);
  }
  if (maxHops < minHops) {
    throw new Error(`maxHops (${maxHops}) must be >= minHops (${minHops})`);
  }
  // Kuzu/LadybugDB relation types are uppercase-only by convention in
  // this codebase; reject lowercase even though the parser would accept it.
  if (!/^[A-Z_][A-Z0-9_]*$/.test(relType)) {
    throw new Error(`Invalid relType: ${relType}`);
  }
  return `-[:${relType}*${minHops}..${maxHops}]->`;
}

/**
 * Shortest-path query between two symbols in the same repo.
 * Uses native Cypher variable-length path syntax, so it does NOT require
 * the `algo` extension.
 *
 * Contract:
 *   - Returns `[fromSymbol]` when `fromSymbol === toSymbol`.
 *   - Returns `null` when no path exists within `maxHops`.
 *   - Returns an ordered array of symbolIds `[fromSymbol, ..., toSymbol]`
 *     for the shortest path found.
 */
export async function shortestPath(
  conn: Connection,
  repoId: string,
  fromSymbol: string,
  toSymbol: string,
  maxHops: number,
): Promise<string[] | null> {
  if (fromSymbol === toSymbol) {
    return [fromSymbol];
  }

  const pathClause = buildVarLenPathClause(1, maxHops, "DEPENDS_ON");

  const row = await querySingle<{ pathNodes: unknown }>(
    conn,
    `MATCH (r:Repo {repoId: $repoId})<-[:SYMBOL_IN_REPO]-(a:Symbol {symbolId: $fromSymbol})
     MATCH (r)<-[:SYMBOL_IN_REPO]-(b:Symbol {symbolId: $toSymbol})
     MATCH p = (a)${pathClause}(b)
     RETURN nodes(p) AS pathNodes
     ORDER BY length(p)
     LIMIT 1`,
    { repoId, fromSymbol, toSymbol },
  );

  if (!row) return null;

  const rawNodes = row.pathNodes;
  if (!Array.isArray(rawNodes)) {
    return null;
  }

  const symbolIds: string[] = [];
  for (const node of rawNodes) {
    if (typeof node === "string") {
      symbolIds.push(node);
      continue;
    }
    if (node && typeof node === "object" && "symbolId" in node) {
      const value = (node as { symbolId?: unknown }).symbolId;
      if (typeof value === "string") {
        symbolIds.push(value);
      }
    }
  }

  return symbolIds.length > 0 ? symbolIds : null;
}
