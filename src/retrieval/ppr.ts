/**
 * Personalized PageRank (PPR) over the repo dependency graph.
 *
 * Implements the Andersen-Chung-Lang (ACL) forward-push algorithm: starts
 * residue at the seed vector, repeatedly pushes residue from the highest-error
 * node into its neighbors, and stops when residue falls below `epsilon` or
 * the touched-node budget is exhausted. Output is a sparse map from symbolId
 * to a normalized score (max = 1).
 *
 * Two backends are supported:
 *   - Native Rust (preferred when the addon is loaded) via
 *     `computePersonalizedPageRankRust`.
 *   - Pure-JS fallback (`pushPpr`) — identical algorithm to within 1e-3.
 *
 * The boost helper (`applyPprBoost`) re-ranks an existing fused result list
 * by multiplying each score by `1 + pprWeight * pprScore`, capped at 2× the
 * original score.
 *
 * @module retrieval/ppr
 */

import type { Graph } from "../graph/buildGraph.js";
import type { EdgeRow } from "../db/schema.js";
import type { HybridSearchResultItem } from "./types.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Tuning knobs (kept in module scope for test override)
// ---------------------------------------------------------------------------

/** Teleport probability — lower = longer walks, more global influence. */
export const DEFAULT_ALPHA = 0.15;
/** Residual threshold; when no node has residual ≥ epsilon the walk stops. */
export const DEFAULT_EPSILON = 1e-4;
/** Hard cap on touched nodes to bound worst-case latency. */
export const DEFAULT_MAX_NODES_TOUCHED = 2000;
/** Reverse-edge scaling factor for `pprDirection: "both"`. */
const REVERSE_EDGE_SCALE = 0.5;
/** Multiplier ceiling applied per-result by `applyPprBoost`. */
export const PPR_BOOST_CAP = 2.0;
/**
 * Default `pprWeight` when caller does not override.
 *
 * Tuned via A/B sweep (devdocs/ppr-weight-tune-results.md, 2026-04-27): on a
 * 20-query fixture × 3 mention configs, weight=2.0 produced 85% NDCG@10 lift
 * over RRF-only baseline with no recall regression and zero effect on the
 * `none` / `far` mention configs. Per-call cap (`PPR_BOOST_CAP = 2`) limits
 * the multiplier to 2× regardless of how high `pprWeight × pprScore` climbs.
 */
export const DEFAULT_PPR_WEIGHT = 2.0;
/** Minimum pprScore to count a result as "boosted" in evidence. */
const PPR_BOOST_VISIBILITY_THRESHOLD = 1e-6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PprDirection = "out" | "in" | "both";

export interface PprOptions {
  /** symbolId -> seed weight (must be normalized so values sum to 1). */
  seeds: ReadonlyMap<string, number>;
  /** Walk direction across `DEPENDS_ON` edges. Default: `"both"`. */
  direction?: PprDirection;
  /** Teleport probability. Default: 0.15. */
  alpha?: number;
  /** Residual threshold. Default: 1e-4. */
  epsilon?: number;
  /** Max touched nodes before bailing into BFS fallback. Default: 2000. */
  maxNodesTouched?: number;
}

export interface PprResult {
  /** symbolId -> normalized score (max = 1). Empty when no seed reached the graph. */
  scores: Map<string, number>;
  /** Backend that produced the scores. */
  backend: "native" | "js" | "fallback-bfs";
  /** Number of distinct nodes that received a non-zero score. */
  touched: number;
  /** Wall-clock ms for the underlying compute (excludes adjacency build). */
  computeMs: number;
}

// ---------------------------------------------------------------------------
// Adjacency construction (TS-side; fed into native or JS backend)
// ---------------------------------------------------------------------------

interface CsrAdjacency {
  /** Index → outgoing (neighborIndex, edgeWeight) tuples for the chosen direction. */
  rows: Array<Array<[number, number]>>;
  /** symbolId → numeric index. */
  idToIndex: Map<string, number>;
  /** Numeric index → symbolId. */
  indexToId: string[];
}

/** Pull the structural weight for an edge: `weight × confidence` (defaults 1.0). */
function edgeStrength(edge: EdgeRow): number {
  const weight = edge.weight ?? 1.0;
  const confidence = edge.confidence ?? 1.0;
  // Guard against negative / NaN values from stale rows.
  if (!Number.isFinite(weight) || !Number.isFinite(confidence)) return 0;
  return Math.max(0, weight) * Math.max(0, Math.min(1, confidence));
}

/**
 * Build a CSR-style adjacency view over the snapshot.
 *
 * - direction "out": adjacencyOut[u] → list of (v, w)
 * - direction "in":  adjacencyIn[u]  → list of (v, w) where v is the source
 * - direction "both": union of both, with reverse direction scaled by REVERSE_EDGE_SCALE
 *
 * Self-loops are dropped. Multi-edges are summed.
 */
function buildAdjacency(graph: Graph, direction: PprDirection): CsrAdjacency {
  const idToIndex = new Map<string, number>();
  const indexToId: string[] = [];

  for (const id of graph.symbols.keys()) {
    idToIndex.set(id, indexToId.length);
    indexToId.push(id);
  }

  const rows: Array<Map<number, number>> = indexToId.map(() => new Map());

  const addEdge = (
    fromId: string,
    toId: string,
    strength: number,
    scale: number,
  ): void => {
    if (strength <= 0 || scale <= 0) return;
    const fromIdx = idToIndex.get(fromId);
    const toIdx = idToIndex.get(toId);
    if (fromIdx === undefined || toIdx === undefined) return;
    if (fromIdx === toIdx) return;
    const row = rows[fromIdx];
    row.set(toIdx, (row.get(toIdx) ?? 0) + strength * scale);
  };

  if (direction === "out" || direction === "both") {
    for (const [fromId, edges] of graph.adjacencyOut) {
      for (const e of edges) {
        addEdge(fromId, e.to_symbol_id, edgeStrength(e), 1.0);
      }
    }
  }
  if (direction === "in" || direction === "both") {
    const reverseScale = direction === "both" ? REVERSE_EDGE_SCALE : 1.0;
    for (const [toId, edges] of graph.adjacencyIn) {
      for (const e of edges) {
        // adjacencyIn maps `to` -> incoming edges. To walk "incoming edges as
        // outgoing", we treat the original `to` as the new source.
        addEdge(toId, e.from_symbol_id, edgeStrength(e), reverseScale);
      }
    }
  }

  // Convert to arrays. (Native side prefers Vec<Vec<(u32, f32)>>.)
  const compactRows = rows.map((m) => {
    const arr: Array<[number, number]> = [];
    for (const [idx, w] of m) arr.push([idx, w]);
    return arr;
  });

  return { rows: compactRows, idToIndex, indexToId };
}

// ---------------------------------------------------------------------------
// JS backend: Andersen-Chung-Lang forward-push
// ---------------------------------------------------------------------------

/**
 * Pure-JS push-PPR. Mirrors the native implementation byte-for-byte (within
 * 1e-3) so the property test in `ppr-property.test.ts` passes regardless of
 * which backend ran.
 */
export function pushPpr(
  adjacency: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  seeds: ReadonlyArray<readonly [number, number]>,
  alpha: number,
  epsilon: number,
  maxNodesTouched: number,
): Float64Array {
  const n = adjacency.length;
  const p = new Float64Array(n);
  const r = new Float64Array(n);

  // Out-degree-weighted thresholds for "is this node above epsilon?" checks.
  const rowSums = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const row = adjacency[i];
    for (let j = 0; j < row.length; j++) sum += row[j][1];
    rowSums[i] = sum;
  }

  const queue: number[] = [];
  const inQueue = new Uint8Array(n);
  const touched = new Uint8Array(n);
  let touchedCount = 0;

  const enqueueIfAbove = (node: number): void => {
    if (inQueue[node] === 1) return;
    const deg = rowSums[node];
    // For sink nodes (degree 0), no push possible — skip queueing.
    if (deg === 0) return;
    if (r[node] / deg < epsilon) return;
    queue.push(node);
    inQueue[node] = 1;
  };

  for (const [idx, weight] of seeds) {
    if (idx < 0 || idx >= n) continue;
    r[idx] += weight;
    if (touched[idx] === 0) {
      touched[idx] = 1;
      touchedCount++;
    }
    enqueueIfAbove(idx);
  }

  let pushed = 0;
  while (queue.length > 0) {
    if (touchedCount >= maxNodesTouched) break;

    const u = queue.shift() as number;
    inQueue[u] = 0;
    const ru = r[u];
    if (ru === 0) continue;
    const deg = rowSums[u];
    if (deg === 0) continue;
    if (ru / deg < epsilon) continue;

    // Push step: reserve alpha to p[u], spread (1-alpha) across out-neighbors.
    p[u] += alpha * ru;
    const remaining = (1 - alpha) * ru;
    r[u] = 0;

    const row = adjacency[u];
    for (let i = 0; i < row.length; i++) {
      const [v, w] = row[i];
      const delta = remaining * (w / deg);
      r[v] += delta;
      if (touched[v] === 0) {
        touched[v] = 1;
        touchedCount++;
      }
      enqueueIfAbove(v);
    }
    pushed++;
    // Loose safety net against pathological queues.
    if (pushed > maxNodesTouched * 32) break;
  }

  return p;
}

// ---------------------------------------------------------------------------
// BFS fallback (used when seed has zero outgoing edges in chosen direction)
// ---------------------------------------------------------------------------

/** Depth-3 BFS, scoring nodes inversely with hop distance. */
function bfsFallback(
  adjacency: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  seedIndices: ReadonlyArray<number>,
  maxNodesTouched: number,
): Float64Array {
  const n = adjacency.length;
  const p = new Float64Array(n);
  const dist = new Int32Array(n);
  for (let i = 0; i < n; i++) dist[i] = -1;

  const frontier: number[] = [];
  for (const s of seedIndices) {
    if (s < 0 || s >= n) continue;
    if (dist[s] === -1) {
      dist[s] = 0;
      p[s] = 1.0;
      frontier.push(s);
    }
  }

  let head = 0;
  let touched = frontier.length;
  while (head < frontier.length) {
    const u = frontier[head++];
    const d = dist[u];
    if (d >= 3) continue;
    const score = 1 / (1 + d + 1);
    const row = adjacency[u];
    for (let i = 0; i < row.length; i++) {
      const [v] = row[i];
      if (dist[v] === -1) {
        dist[v] = d + 1;
        p[v] = score;
        frontier.push(v);
        touched++;
        if (touched >= maxNodesTouched) return p;
      }
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Native dispatch (lazy import to avoid loader at module-eval time)
// ---------------------------------------------------------------------------

interface NativePprBinding {
  (
    adjacencyOut: Array<Array<[number, number]>>,
    seeds: Array<[number, number]>,
    alpha: number,
    epsilon: number,
    maxNodesTouched: number,
  ): Array<[number, number]>;
}

let cachedNativeBinding: NativePprBinding | null | undefined = undefined;

async function loadNativeBinding(): Promise<NativePprBinding | null> {
  if (cachedNativeBinding !== undefined) return cachedNativeBinding;
  try {
    const mod = await import("../indexer/rustIndexer.js");
    const fn = mod.computePersonalizedPageRankRust;
    if (typeof fn === "function") {
      cachedNativeBinding = fn as NativePprBinding;
      return cachedNativeBinding;
    }
  } catch (err) {
    logger.debug(
      `[ppr] native binding unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  cachedNativeBinding = null;
  return null;
}

/** Test-only hook: clear the cached binding so the next call re-resolves it. */
export function _resetNativeBindingCache(): void {
  cachedNativeBinding = undefined;
}

// ---------------------------------------------------------------------------
// LRU cache (per repoId/snapshotCreatedAt/seedHash/alpha/direction)
// ---------------------------------------------------------------------------

const PPR_CACHE_CAP = 64;
const PPR_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  result: PprResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(parts: {
  repoId: string;
  snapshotCreatedAt: number;
  seedHash: string;
  alpha: number;
  direction: PprDirection;
}): string {
  return [
    parts.repoId,
    parts.snapshotCreatedAt,
    parts.seedHash,
    parts.alpha.toFixed(4),
    parts.direction,
  ].join("|");
}

function seedHash(seeds: ReadonlyMap<string, number>): string {
  // Sort for deterministic hashing. SHA-1 would be nicer but the cost of an
  // import for ~64-entry cache keys isn't worth it; concatenated tuples are
  // unique enough.
  const entries = Array.from(seeds.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return entries.map(([id, w]) => `${id}:${w.toFixed(4)}`).join("|");
}

function cacheGet(key: string): PprResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Touch for LRU ordering.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function cacheSet(key: string, result: PprResult): void {
  if (cache.size >= PPR_CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, expiresAt: Date.now() + PPR_CACHE_TTL_MS });
}

/** Test-only: clear the cache so unit tests don't observe each other's state. */
export function _clearPprCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ComputePprInput {
  graph: Graph;
  /** Snapshot creation timestamp (used as cache invalidation key). */
  snapshotCreatedAt: number;
  /** repoId for cache scoping. */
  repoId: string;
  options: PprOptions;
}

/**
 * Compute personalized PageRank scores for the given seeds over `graph`.
 *
 * Returns an empty result (no scores, backend = "js") when seeds is empty
 * or no seed maps to a node in the graph.
 */
export async function computePpr(input: ComputePprInput): Promise<PprResult> {
  const { graph, snapshotCreatedAt, repoId, options } = input;
  const direction: PprDirection = options.direction ?? "both";
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxNodes = options.maxNodesTouched ?? DEFAULT_MAX_NODES_TOUCHED;

  if (options.seeds.size === 0) {
    return {
      scores: new Map(),
      backend: "js",
      touched: 0,
      computeMs: 0,
    };
  }

  const key = cacheKey({
    repoId,
    snapshotCreatedAt,
    seedHash: seedHash(options.seeds),
    alpha,
    direction,
  });
  const cached = cacheGet(key);
  if (cached) return cached;

  const adjacency = buildAdjacency(graph, direction);

  // Map seeds to indices, dropping mentions absent from the graph.
  const seedIndices: Array<[number, number]> = [];
  for (const [id, weight] of options.seeds) {
    const idx = adjacency.idToIndex.get(id);
    if (idx === undefined) continue;
    seedIndices.push([idx, weight]);
  }

  if (seedIndices.length === 0) {
    const empty: PprResult = {
      scores: new Map(),
      backend: "js",
      touched: 0,
      computeMs: 0,
    };
    cacheSet(key, empty);
    return empty;
  }

  const sinkOnly = seedIndices.every(
    ([idx]) => adjacency.rows[idx].length === 0,
  );

  let backend: PprResult["backend"];
  let scoresVec: Float64Array | Array<[number, number]>;
  const computeStart = performance.now();

  if (sinkOnly) {
    backend = "fallback-bfs";
    scoresVec = bfsFallback(
      adjacency.rows,
      seedIndices.map(([idx]) => idx),
      maxNodes,
    );
  } else {
    const native = await loadNativeBinding();
    let nativeScores: Array<[number, number]> | null = null;
    if (native) {
      try {
        nativeScores = native(
          adjacency.rows,
          seedIndices,
          alpha,
          epsilon,
          maxNodes,
        );
      } catch (err) {
        logger.debug(
          `[ppr] native call failed, falling back to JS: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        nativeScores = null;
      }
    }
    if (nativeScores !== null) {
      backend = "native";
      scoresVec = nativeScores;
    } else {
      backend = "js";
      scoresVec = pushPpr(
        adjacency.rows,
        seedIndices,
        alpha,
        epsilon,
        maxNodes,
      );
    }
  }

  // Flatten to symbolId -> raw score, then normalize so max = 1 to make the
  // boost knob (`pprWeight`) interpretable as a fraction of the strongest hit.
  const scores = new Map<string, number>();
  let maxScore = 0;

  if (Array.isArray(scoresVec)) {
    // Native path returns sparse array of (idx, score).
    for (const [idx, score] of scoresVec) {
      if (idx < 0 || idx >= adjacency.indexToId.length) continue;
      if (!Number.isFinite(score) || score <= 0) continue;
      const id = adjacency.indexToId[idx];
      scores.set(id, score);
      if (score > maxScore) maxScore = score;
    }
  } else {
    for (let i = 0; i < scoresVec.length; i++) {
      const score = scoresVec[i];
      if (!Number.isFinite(score) || score <= 0) continue;
      scores.set(adjacency.indexToId[i], score);
      if (score > maxScore) maxScore = score;
    }
  }

  if (maxScore > 0 && maxScore !== 1) {
    for (const [id, s] of scores) scores.set(id, s / maxScore);
  }

  const result: PprResult = {
    scores,
    backend,
    touched: scores.size,
    computeMs: Math.round(performance.now() - computeStart),
  };
  cacheSet(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Boost composition
// ---------------------------------------------------------------------------

export interface ApplyPprBoostOptions {
  /** Weight knob — 0 disables boost; default 0.5. Caller-supplied. */
  pprWeight?: number;
  /**
   * Maximum allowed final-score / original-score ratio across the *full*
   * boost stack (feedback + ppr). When provided, callers are responsible
   * for passing the original RRF score in `originalScores`.
   */
  combinedCap?: number;
  /**
   * Optional map of symbolId → original RRF score; used together with
   * `combinedCap` to keep stacked boosts (feedback × ppr) from compounding
   * past `combinedCap × originalScore`. Without this map only the per-call
   * cap (`PPR_BOOST_CAP`) is enforced.
   */
  originalScores?: ReadonlyMap<string, number>;
}

export interface ApplyPprBoostResult {
  items: HybridSearchResultItem[];
  /** Number of items whose final multiplier was meaningfully > 1. */
  symbolsBoosted: number;
}

/**
 * Multiply each item's score by `1 + pprWeight * pprScore`, capped at
 * `PPR_BOOST_CAP`× the per-call score. Optionally enforces `combinedCap` ×
 * the original RRF score across stacked boosts.
 *
 * Re-sorts by final score and returns the new ordering. The set of items is
 * unchanged.
 */
export function applyPprBoost(
  items: ReadonlyArray<HybridSearchResultItem>,
  pprScores: ReadonlyMap<string, number>,
  options: ApplyPprBoostOptions = {},
): ApplyPprBoostResult {
  const pprWeight = options.pprWeight ?? DEFAULT_PPR_WEIGHT;
  const combinedCap = options.combinedCap;
  const originalScores = options.originalScores;

  if (pprWeight <= 0 || pprScores.size === 0 || items.length === 0) {
    return { items: items.slice(), symbolsBoosted: 0 };
  }

  let boosted = 0;
  const updated: HybridSearchResultItem[] = items.map((item) => {
    const ppr = pprScores.get(item.symbolId) ?? 0;
    if (ppr <= 0) return { ...item };
    const raw = 1 + pprWeight * ppr;
    const perCallCapped = Math.min(raw, PPR_BOOST_CAP);
    let nextScore = item.score * perCallCapped;
    if (
      combinedCap !== undefined &&
      originalScores !== undefined &&
      combinedCap > 0
    ) {
      const orig = originalScores.get(item.symbolId);
      if (orig !== undefined && orig > 0) {
        const ceiling = combinedCap * orig;
        if (nextScore > ceiling) nextScore = ceiling;
      }
    }
    if (nextScore > item.score && ppr > PPR_BOOST_VISIBILITY_THRESHOLD) {
      boosted++;
    }
    return { ...item, score: nextScore };
  });

  updated.sort((a, b) => b.score - a.score);
  return { items: updated, symbolsBoosted: boosted };
}
