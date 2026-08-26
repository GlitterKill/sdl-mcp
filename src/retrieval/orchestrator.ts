/**
// =============================================================================
// retrieval/orchestrator.ts — Hybrid retrieval coordinator (FTS + vector + RRF).
//
// Public exports (LLM-cost cheat sheet):
//   Functions:
//     - hybridSearch(options) — symbol-level hybrid search; returns ranked results + optional evidence
//     - entitySearch(options) — file/cluster-level hybrid search
//     - narrowFilesForQuery(...) — file-narrowing helper for retrieval pre-filtering
//
// Internal layers (kept here for now; candidates for fusion.ts / sources.ts split):
//   - Pure fusion: rrfFuse, rrfFuseEntities, buildEvidence, buildEntityEvidence, RRF constants
//   - I/O sources: assertIndexName/TableName/PositiveInt, queryFts, queryVectorIndex,
//                  vectorSourceForModel, resolveConfig, resolveEmbeddingProviderType,
//                  ENTITY_FTS_CONFIG, ENTITY_VECTOR_CONFIG
// =============================================================================

/**
 * Hybrid retrieval orchestrator.
 *
 * Combines FTS (full-text search) and vector retrieval backends, then
 * fuses results via Reciprocal Rank Fusion (RRF).  Degrades gracefully
 * when backends are unavailable.
 */

import type { Connection } from "kuzu";
import { queryStoredProcAll } from "../db/ladybug-core.js";
import { getLadybugConn } from "../db/ladybug.js";
import { IndexError } from "../domain/errors.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { loadConfig } from "../config/loadConfig.js";
import { resolveSemanticEmbeddingModelPlan } from "../config/semantic-embedding-model-plan.js";
import { SYMBOL_VECTOR_EMBEDDING_TABLE } from "./model-mapping.js";
import {
  SYMBOL_SEARCH_MAX_QUERY_TOKENS,
  SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH,
} from "../config/constants.js";
import { splitCamelSubwords } from "../util/symbol-relevance.js";
import {
  type SourceRanking,
  type EntitySourceRanking,
  DEFAULT_RRF_K,
  coverageAdjustedFusionWeights,
  rrfFuse,
  buildEvidence,
  rrfFuseEntities,
  buildEntityEvidence,
} from "./fusion.js";
import { resolveSeedSymbols } from "./seed-resolver.js";
import { applyPprBoost, computePpr } from "./ppr.js";
import {
  getGraphSnapshot,
  getGraphSnapshotCreatedAt,
  loadAndCacheGraphSnapshot,
} from "../graph/graphSnapshotCache.js";
import type {
  SemanticConfig,
  SemanticRetrievalConfig,
} from "../config/types.js";
import { logger } from "../util/logger.js";
import { getObservabilityTap } from "../observability/event-tap.js";
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
} from "../indexer/embeddings.js";
import { applyQueryPrefix } from "../indexer/model-registry.js";
import { EMBEDDING_MODELS } from "./model-mapping.js";
import { ENTITY_FTS_INDEX_NAMES } from "./index-lifecycle.js";
import { assertGraphRetrievalAvailable } from "../services/graph-retrieval-availability.js";
import { checkRetrievalHealth } from "./health.js";
import type {
  HybridSearchOptions,
  HybridSearchResult,
  RetrievalCapabilities,
  RetrievalEvidence,
  RetrievalQueryContext,
  RetrievalSource,
  EntityType,
  EntitySearchOptions,
  EntitySearchResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Raw row returned by Kuzu FTS index query. */
interface FtsRawRow {
  /** Flat format: symbolId as direct column */
  symbolId?: string;
  /** Nested format: node object with properties */
  node?: { symbolId?: string; [key: string]: unknown };
  _node?: { symbolId?: string; [key: string]: unknown };
  score?: number;
  _score?: number;
  [key: string]: unknown;
}

/** Raw row returned by Kuzu vector index query. */
interface VectorRawRow {
  symbolId?: string;
  node?: { symbolId?: string; [key: string]: unknown };
  _node?: { symbolId?: string; [key: string]: unknown };
  score?: number;
  _score?: number;
  distance?: number;
  _distance?: number;
  [key: string]: unknown;
}

/** Intermediate per-source ranked list before fusion. */
const DEFAULT_CANDIDATE_LIMIT = 100;
const DEFAULT_FTS_TOP_K = 75;
const DEFAULT_FTS_BM25_K = 1.2;
const DEFAULT_VECTOR_TOP_K = 75;
const DEFAULT_FTS_INDEX_NAME = "symbol_search_text_v1";
const FTS_SCORE_QUANTIZATION = 1_000_000_000_000;
// ---------------------------------------------------------------------------
// FTS retrieval
// ---------------------------------------------------------------------------

// LadybugDB requires table + index names to be literal expressions inside
// QUERY_FTS_INDEX / QUERY_VECTOR_INDEX, so we inline them after strict
// validation. The pattern permits the same identifier shape Ladybug itself
// accepts for index DDL — never user input.
const INDEX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIndexName(name: string): void {
  if (!INDEX_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid index name: ${JSON.stringify(name)}`);
  }
}

function assertTableName(name: string): void {
  if (!TABLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid table name: ${JSON.stringify(name)}`);
  }
}

function assertPositiveInt(n: number, label: string): number {
  if (!Number.isInteger(n) || n <= 0 || n > 10_000) {
    throw new Error(`${label} must be a positive integer ≤ 10000, got ${n}`);
  }
  return n;
}

export function buildFtsStoredProcQuery(
  tableName: string,
  indexName: string,
  query: string,
  topK: number,
  conjunctive: boolean,
): string {
  assertTableName(tableName);
  assertIndexName(indexName);
  const top = assertPositiveInt(topK, "topK");
  const queryLiteral = cypherSingleQuotedString(query);
  return `CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', ${queryLiteral}, K := ${DEFAULT_FTS_BM25_K}, TOP := ${top}, conjunctive := ${conjunctive ? "true" : "false"}) RETURN node, score`;
}

export function buildIdentifierAwareFtsQuery(
  query: string,
  conjunctive: boolean,
): string {
  const trimmed = query.trim();
  if (
    conjunctive ||
    !trimmed ||
    trimmed.includes("*") ||
    trimmed.includes("?")
  ) {
    return query;
  }

  const fragments = Array.from(new Set(splitCamelSubwords(trimmed)))
    .filter(
      (fragment) => fragment.length >= SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH,
    )
    .slice(0, SYMBOL_SEARCH_MAX_QUERY_TOKENS);
  if (fragments.length < 2) {
    return query;
  }

  // LadybugDB FTS has no boolean query syntax: every token in the query is
  // matched individually and combined by the conjunctive flag, so fragments
  // are appended as plain tokens for disjunctive matching. Conjunctive
  // queries are left untouched above because extra required tokens would
  // zero out their results.
  return `${trimmed} ${fragments.join(" ")}`;
}

// Ladybug stored-proc calls are not prepared in this path, so scalar values
// go through narrow literal serializers before entering CALL syntax.
function cypherSingleQuotedString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/'/g, "\\'")}'`;
}

function cypherNumberArray(values: readonly number[]): string {
  return `[${values
    .map((value) => {
      if (!Number.isFinite(value)) {
        throw new Error("Vector query contains a non-finite value");
      }
      return Object.is(value, -0) ? "0" : String(value);
    })
    .join(", ")}]`;
}


/** Create an isolated cache for one top-level retrieval request. */
export function createRetrievalQueryContext(
  initial: Pick<RetrievalQueryContext, "connection"> &
    Partial<Pick<RetrievalQueryContext, "embeddingPromises">> = {},
): RetrievalQueryContext {
  return {
    ...initial,
    laneOutcomes: new Map(),
    healthPromises: new Map(),
    embeddingPromises: initial.embeddingPromises ?? new Map(),
  };
}

function markLaneAttempt(
  context: RetrievalQueryContext | undefined,
  lane: string,
): void {
  if (!context) return;
  const current = context.laneOutcomes.get(lane);
  context.laneOutcomes.set(lane, {
    ...(current?.available === undefined
      ? {}
      : { available: current.available }),
    attempted: true,
    succeeded: current?.succeeded ?? false,
    failed: current?.failed ?? false,
  });
}

function markLaneResult(
  context: RetrievalQueryContext | undefined,
  lane: string,
  succeeded: boolean,
): void {
  if (!context) return;
  const current = context.laneOutcomes.get(lane);
  context.laneOutcomes.set(lane, {
    ...(current?.available === undefined
      ? {}
      : { available: current.available }),
    attempted: true,
    succeeded: (current?.succeeded ?? false) || succeeded,
    failed: (current?.failed ?? false) || !succeeded,
  });
}

function markLaneAvailability(
  context: RetrievalQueryContext | undefined,
  lane: string,
  available: boolean,
): void {
  if (!context) return;
  const current = context.laneOutcomes.get(lane);
  context.laneOutcomes.set(lane, {
    available,
    attempted: current?.attempted ?? false,
    succeeded: current?.succeeded ?? false,
    failed: current?.failed ?? false,
  });
}

/** Cache before deferred work starts so concurrent lanes share one health read. */
export function getOrCreateHealthPromise(
  context: RetrievalQueryContext,
  repoId: string,
  factory: () => Promise<RetrievalCapabilities>,
): Promise<RetrievalCapabilities> {
  const existing = context.healthPromises.get(repoId);
  if (existing) {
    return existing;
  }
  const created = Promise.resolve().then(factory);
  context.healthPromises.set(repoId, created);
  return created;
}


/** Run no retrieval work until the graph-read integrity gate admits the request. */
export async function runAfterGraphRetrievalAdmission<T>(
  conn: Connection,
  repoId: string,
  work: () => Promise<T>,
  assertAvailable: (
    conn: Connection,
    repoId: string,
  ) => Promise<void> = assertGraphRetrievalAvailable,
): Promise<T> {
  await assertAvailable(conn, repoId);
  return work();
}
/** Cache by model and fully-prefixed query so semantically distinct inputs never alias. */
export function getOrCreateEmbeddingPromise(
  context: RetrievalQueryContext,
  model: string,
  prefixedQuery: string,
  factory: () => Promise<number[]>,
): Promise<number[]> {
  const key = `${model}\u0000${prefixedQuery}`;
  const existing = context.embeddingPromises.get(key);
  if (existing) {
    return existing;
  }
  const created = Promise.resolve().then(factory);
  context.embeddingPromises.set(key, created);
  return created;
}

interface RetrievalEmbeddingPrewarmDependencies {
  loadSemanticConfig: () => SemanticConfig | undefined;
  getEmbeddingProvider: (
    provider: "api" | "local" | "mock",
    model: string,
  ) => EmbeddingProvider;
}

const DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES: RetrievalEmbeddingPrewarmDependencies =
  {
    loadSemanticConfig: () => {
      try {
        return loadConfig().semantic;
      } catch {
        return undefined;
      }
    },
    // Query vectors are contract data: isolate them from throughput-oriented
    // GPU/parallel sessions so identical requests remain byte-stable.
    getEmbeddingProvider: (provider, model) =>
      getEmbeddingProvider(provider, model, { deterministic: true }),
  };

function configuredEmbeddingModels(
  semanticConfig: SemanticConfig | undefined,
  includeFileSummary: boolean,
): string[] {
  if (
    semanticConfig?.enabled === false ||
    semanticConfig?.retrieval?.vector.enabled === false
  ) {
    return [];
  }
  const plan = resolveSemanticEmbeddingModelPlan(semanticConfig);
  return [
    ...new Set([
      ...plan.symbolEmbeddingModels,
      ...(includeFileSummary ? plan.fileSummaryEmbeddingModels : []),
    ]),
  ];
}

function embeddingFactory(
  dependencies: RetrievalEmbeddingPrewarmDependencies,
  providerType: "api" | "local" | "mock",
  modelName: string,
  prefixedQuery: string,
): () => Promise<number[]> {
  return async () => {
    const provider = dependencies.getEmbeddingProvider(
      providerType,
      modelName,
    );
    if (provider.isMockFallback?.()) {
      throw new Error(
        `Embedding provider for '${modelName}' is a mock fallback`,
      );
    }
    return (await provider.embed([prefixedQuery]))[0] ?? [];
  };
}

/**
 * Start and settle every configured query embedding after graph admission but
 * before the read transaction. The settled promises are retained so retrieval
 * lanes observe the same value or failure without running model inference in a
 * DB transaction.
 */
export async function prewarmRetrievalEmbeddingPromises(
  query: string,
  options: { includeFileSummary: boolean },
  dependencies: RetrievalEmbeddingPrewarmDependencies =
    DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES,
): Promise<Map<string, Promise<number[]>>> {
  const semanticConfig = dependencies.loadSemanticConfig();
  const providerType = semanticConfig?.provider ?? "local";
  const context = createRetrievalQueryContext();

  for (const modelName of configuredEmbeddingModels(
    semanticConfig,
    options.includeFileSummary,
  )) {
    const prefixedQuery = applyQueryPrefix(modelName, query);
    const promise = getOrCreateEmbeddingPromise(
      context,
      modelName,
      prefixedQuery,
      embeddingFactory(
        dependencies,
        providerType,
        modelName,
        prefixedQuery,
      ),
    );
    // Keep rejection observable to the consuming lane without risking an
    // unhandled rejection if graph admission fails before retrieval starts.
    void promise.catch(() => undefined);
  }

  await Promise.allSettled(context.embeddingPromises.values());
  return context.embeddingPromises;
}

/**
 * Record vector work before observing its shared embedding. Empty and rejected
 * embeddings are execution failures, not successful empty vector searches.
 */
export async function awaitVectorEmbeddingForLanes(
  context: RetrievalQueryContext | undefined,
  lanes: readonly string[],
  promise: Promise<number[]>,
): Promise<number[]> {
  for (const lane of lanes) markLaneAttempt(context, lane);
  try {
    const embedding = await promise;
    if (embedding.length === 0) {
      for (const lane of lanes) markLaneResult(context, lane, false);
    }
    return embedding;
  } catch (error) {
    for (const lane of lanes) markLaneResult(context, lane, false);
    throw error;
  }
}

function quantizedFtsScore(row: FtsRawRow): number {
  const score = Number(row.score ?? row._score);
  return Number.isFinite(score)
    ? Math.round(score * FTS_SCORE_QUANTIZATION)
    : Number.NEGATIVE_INFINITY;
}

/** Order raw FTS rows by score and logical identity before assigning ranks. */
function sortFtsRowsByScore(
  rows: readonly FtsRawRow[],
  identity: (row: FtsRawRow) => string,
): FtsRawRow[] {
  return [...rows].sort((a, b) => {
    const aScore = quantizedFtsScore(a);
    const bScore = quantizedFtsScore(b);
    if (aScore !== bScore) {
      return aScore > bScore ? -1 : 1;
    }
    const aId = identity(a);
    const bId = identity(b);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

/** Order raw HNSW results before assigning ranks; Ladybug does not guarantee order. */
export function sortVectorRowsByDistance(
  rows: readonly VectorRawRow[],
  idField = "symbolId",
): VectorRawRow[] {
  return [...rows].sort((a, b) => {
    const aDistance = vectorDistance(a);
    const bDistance = vectorDistance(b);
    if (aDistance !== bDistance) {
      return aDistance < bDistance ? -1 : 1;
    }
    const aId = vectorRowId(a, idField);
    const bId = vectorRowId(b, idField);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

function vectorDistance(row: VectorRawRow): number {
  const distance = Number(row.distance ?? row._distance);
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

function vectorRowId(row: VectorRawRow, idField = "symbolId"): string {
  const candidates = [
    row[idField],
    row.node?.[idField],
    row._node?.[idField],
    row.symbolId,
    row.node?.symbolId,
    row._node?.symbolId,
  ];
  return candidates.find((value): value is string => typeof value === "string") ?? "";
}
function timingKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function recordRetrievalTiming(
  timings: Map<string, number>,
  phase: string,
  startedAt: number,
): void {
  const durationMs = performance.now() - startedAt;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  timings.set(phase, (timings.get(phase) ?? 0) + durationMs);
}

function retrievalTimingsToRecord(
  timings: Map<string, number>,
): Record<string, number> | undefined {
  if (timings.size === 0) return undefined;
  const result: Record<string, number> = {};
  for (const [phase, durationMs] of timings.entries()) {
    result[phase] = Math.round(durationMs);
  }
  return result;
}

/**
 * Query the Kuzu FTS index for symbols matching the query text.
 *
 * Returns an empty array (never throws) when the FTS extension or index
 * is unavailable.
 */
async function queryFts(
  conn: Connection,
  indexName: string,
  query: string,
  topK: number,
  conjunctive: boolean,
  onResult?: (succeeded: boolean) => void,
): Promise<FtsRawRow[]> {
  try {
    assertIndexName(indexName);
    const ftsQuery = buildIdentifierAwareFtsQuery(query, conjunctive);
    const rows = await queryStoredProcAll<FtsRawRow>(
      conn,
      buildFtsStoredProcQuery(
        "Symbol",
        indexName,
        ftsQuery,
        topK,
        conjunctive,
      ),
    );
    onResult?.(true);
    return rows;
  } catch (err) {
    onResult?.(false);
    logger.warn(
      `[hybrid-search] FTS query failed (extension/index may be unavailable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Vector retrieval
// ---------------------------------------------------------------------------

/**
 * Map a model name to the `RetrievalSource` discriminator.
 */
function vectorSourceForModel(model: string): RetrievalSource {
  if (model.includes("jina") && model.includes("code")) {
    return "vector:jinacode";
  }
  if (model.includes("nomic")) {
    return "vector:nomic";
  }
  // Fallback -- still a vector source, use the first token of the model name.
  return "vector:jinacode"; // Unknown model → default to jinacode source label
}

/**
 * Query a single Kuzu vector index with the given embedding.
 *
 * Returns an empty array (never throws) when the vector extension or
 * index is unavailable.
 */
async function queryVectorIndex(
  conn: Connection,
  indexName: string,
  embedding: number[],
  topK: number,
  onResult?: (succeeded: boolean) => void,
): Promise<{ symbolId: string; score: number }[]> {
  try {
    assertIndexName(indexName);
    const k = assertPositiveInt(topK, "topK");
    const vectorLiteral = cypherNumberArray(embedding);
    const rows = await queryStoredProcAll<VectorRawRow>(
      conn,
      `CALL QUERY_VECTOR_INDEX('${SYMBOL_VECTOR_EMBEDDING_TABLE}', '${indexName}', ${vectorLiteral}, ${k}) RETURN node, distance`,
    );
    const results = sortVectorRowsByDistance(rows).map((r) => ({
      symbolId: vectorRowId(r),
      // Kuzu vector index returns distance; convert to a similarity score.
      // Lower distance = more similar, so score = 1 / (1 + distance).
      score:
        (r.score ?? r._score) != null
          ? Number(r.score ?? r._score)
          : (r.distance ?? r._distance) != null
            ? 1 / (1 + Number(r.distance ?? r._distance))
            : 0,
    }));
    onResult?.(true);
    return results;
  } catch (err) {
    onResult?.(false);
    logger.warn(
      `[hybrid-search] Vector query failed (extension/index may be unavailable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion.
 *
 * ```
 * RRF_score(symbol) = SUM(1 / (k + rank_in_source))
 * ```
 *
 * where `k` is a smoothing constant (default 60) and the sum runs over
 * every source that contains the symbol.
 */
function resolveConfig(): SemanticRetrievalConfig {
  try {
    const appConfig = loadConfig();
    const retrieval = appConfig.semantic?.retrieval;
    if (retrieval) {
      return retrieval;
    }
  } catch {
    // Config may not exist (e.g. in tests). Use defaults.
    logger.debug("[hybrid-search] Failed to load config; using defaults");
  }
  // Defaults matching the Zod schema defaults.
  return {
    extensionsOptional: true,
    fts: {
      enabled: true,
      indexName: DEFAULT_FTS_INDEX_NAME,
      topK: DEFAULT_FTS_TOP_K,
      conjunctive: false,
    },
    vector: {
      enabled: true,
      topK: DEFAULT_VECTOR_TOP_K,
      efc: 200,
      efs: 200,
      indexes: {
        "jina-embeddings-v2-base-code": {
          indexName: "symbol_vec_jina_code_v2",
        },
        "nomic-embed-text-v1.5": { indexName: "symbol_vec_nomic_embed_v15" },
      },
    },
    fusion: {
      strategy: "rrf",
      rrfK: DEFAULT_RRF_K,
      weights: {
        fts: 1,
        vector: 1,
        overlay: 1,
      },
      partialCoverageThresholdPermille: 1000,
    },
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
  };
}

/**
 * Resolve the embedding provider type from config.
 */
function resolveEmbeddingProviderType(): "api" | "local" | "mock" {
  try {
    const appConfig = loadConfig();
    return appConfig.semantic?.provider ?? "local";
  } catch {
    return "local";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a hybrid search combining FTS and vector retrieval with RRF fusion.
 *
 * The function is self-contained: it reads config, checks backend health,
 * runs queries against available backends, fuses results, and returns a
 * deduplicated, scored list.
 *
 * Errors from individual backends are caught and logged -- the function
 * degrades gracefully rather than throwing.  If all backends fail it
 * returns an empty result set with an explanatory fallbackReason.
 */
export async function hybridSearch(
  options: HybridSearchOptions,
  queryContext?: RetrievalQueryContext,
): Promise<HybridSearchResult> {
  const config = resolveConfig();
  let conn: Connection;
  try {
    conn = queryContext?.connection ?? (await getLadybugConn());
  } catch (err) {
    logger.warn(
      `[hybrid-search] Failed to obtain DB connection: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      results: [],
      ...(options.includeEvidence
        ? {
            evidence: buildEvidence([], [], 0, "db-connection-unavailable"),
          }
        : {}),
    };
  }

  const caps = await runAfterGraphRetrievalAdmission(
    conn,
    options.repoId,
    async () => {
      const healthFactory = () =>
        checkRetrievalHealth(conn, options.repoId, loadConfig().semantic);
      return queryContext
        ? await getOrCreateHealthPromise(
            queryContext,
            options.repoId,
            healthFactory,
          )
        : healthFactory();
    },
  );

  // Honour explicit option overrides, then fall back to config.
  const ftsEnabled = options.ftsEnabled ?? config.fts.enabled;
  const vectorEnabled = options.vectorEnabled ?? config.vector.enabled;
  const rrfK = options.rrfK ?? config.fusion.rrfK ?? DEFAULT_RRF_K;
  const candidateLimit =
    options.candidateLimit ?? config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const limit = Math.min(options.limit, candidateLimit);
  markLaneAvailability(
    queryContext,
    "symbol:fts",
    ftsEnabled && caps.fts,
  );
  if (!vectorEnabled) {
    markLaneAvailability(
      queryContext,
      "symbol:vector:configured",
      false,
    );
  }

  const rankings: SourceRanking[] = [];
  const diagnosticTimings = new Map<string, number>();

  const fusionStart = performance.now();

  // ----- FTS retrieval -----
  // TODO(Stage 1): Verify Kuzu QUERY_FTS_INDEX return columns against a live
  // instance.  The extraction below handles both flat (symbolId, score) and
  // nested (node.symbolId, _node.symbolId) formats defensively.
  if (ftsEnabled && caps.fts) {
    const ftsTopK = config.fts.topK ?? DEFAULT_FTS_TOP_K;
    const ftsIndexName = config.fts.indexName ?? DEFAULT_FTS_INDEX_NAME;
    const ftsConjunctive = config.fts.conjunctive ?? false;

    const ftsStartedAt = performance.now();
    markLaneAttempt(queryContext, "symbol:fts");
    const ftsRows = await queryFts(
      conn,
      ftsIndexName,
      options.query,
      ftsTopK,
      ftsConjunctive,
      (succeeded) =>
        markLaneResult(queryContext, "symbol:fts", succeeded),
    );
    recordRetrievalTiming(diagnosticTimings, "fts", ftsStartedAt);

    if (ftsRows.length > 0) {
      const ranks = new Map<string, number>();
      const rowIdentity = (row: FtsRawRow) => vectorRowId(row);
      const rankedRows = sortFtsRowsByScore(ftsRows, rowIdentity);
      for (let i = 0; i < rankedRows.length; i++) {
        const sid = rowIdentity(rankedRows[i]);
        if (sid && !ranks.has(sid)) {
          ranks.set(sid, i + 1); // 1-based rank
        }
      }
      rankings.push({
        source: "fts",
        ranks,
        candidateCount: ftsRows.length,
      });
    }
  }

  // ----- Vector retrieval -----
  // TODO(Stage 1): Same column-format caveat as FTS above applies to
  // QUERY_VECTOR_INDEX results. Also verify distance vs score semantics.
  if (vectorEnabled) {
    const providerType = resolveEmbeddingProviderType();
    const vectorTopK = config.vector.topK ?? DEFAULT_VECTOR_TOP_K;
    const configuredSymbolModels = new Set(
      configuredEmbeddingModels(
        DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES.loadSemanticConfig(),
        false,
      ),
    );

    // Prioritize Jina for Symbol retrieval, then Nomic
    const sortedModels = Object.entries(EMBEDDING_MODELS)
      .filter(([modelName]) => configuredSymbolModels.has(modelName))
      .sort(([a], [b]) => {
        // Jina-code first for symbol search, then nomic
        const priority = (m: string) =>
          m.includes("jina") ? 0 : m.includes("nomic") ? 1 : 2;
        return priority(a) - priority(b);
      });
    for (const [modelName, modelInfo] of sortedModels) {
      // Check capability for this specific model.
      const source = vectorSourceForModel(modelName);
      const capAvailable =
        (source === "vector:nomic" && caps.vectorNomic) ||
        (source === "vector:jinacode" && caps.vectorJinaCode);
      markLaneAvailability(
        queryContext,
        `symbol:${source}`,
        capAvailable,
      );

      if (!capAvailable) {
        logger.debug(
          `[hybrid-search] Skipping vector model '${modelName}' -- capability unavailable`,
        );
        continue;
      }

      // Resolve the index name from config override or model-mapping default.
      const configIndexEntry = config.vector.indexes?.[modelName];
      const indexName = configIndexEntry?.indexName ?? modelInfo.indexName;

      // Generate query embedding.
      let queryEmbedding: number[];
      const embedStartedAt = performance.now();
      const lane = `symbol:${vectorSourceForModel(modelName)}`;
      try {
        const prefixedQuery = applyQueryPrefix(modelName, options.query);
        const createEmbedding = embeddingFactory(
          DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES,
          providerType,
          modelName,
          prefixedQuery,
        );
        const promise = queryContext
          ? getOrCreateEmbeddingPromise(
              queryContext,
              modelName,
              prefixedQuery,
              createEmbedding,
            )
          : createEmbedding();
        queryEmbedding = await awaitVectorEmbeddingForLanes(
          queryContext,
          [lane],
          promise,
        );
        if (!queryEmbedding || queryEmbedding.length === 0) {
          logger.debug(
            `[hybrid-search] Empty embedding returned for model '${modelName}'; skipping`,
          );
          continue;
        }
      } catch (err) {
        logger.debug(
          `[hybrid-search] Embedding generation failed for '${modelName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      } finally {
        recordRetrievalTiming(diagnosticTimings, "embedding", embedStartedAt);
        recordRetrievalTiming(
          diagnosticTimings,
          `embedding.${timingKeySegment(modelName)}`,
          embedStartedAt,
        );
      }

      // Query the vector index.
      const vectorStartedAt = performance.now();
      const vecResults = await queryVectorIndex(
        conn,
        indexName,
        queryEmbedding,
        vectorTopK,
        (succeeded) => markLaneResult(queryContext, lane, succeeded),
      );
      recordRetrievalTiming(diagnosticTimings, "vector", vectorStartedAt);
      recordRetrievalTiming(
        diagnosticTimings,
        `vector.${timingKeySegment(modelName)}`,
        vectorStartedAt,
      );

      if (vecResults.length > 0) {
        const ranks = new Map<string, number>();
        for (let i = 0; i < vecResults.length; i++) {
          const sid = vecResults[i].symbolId;
          if (sid && !ranks.has(sid)) {
            ranks.set(sid, i + 1);
          }
        }
        rankings.push({
          source,
          ranks,
          candidateCount: vecResults.length,
        });
      }
    }
  }

  // NOTE: fusionLatencyMs measures total retrieval + fusion wall-clock time
  // (includes FTS queries, embedding generation, vector queries, and RRF fusion).
  const fusionLatencyMs = Math.round(performance.now() - fusionStart);

  // ----- Handle empty results -----
  if (rankings.length === 0) {
    const reason =
      !ftsEnabled && !vectorEnabled
        ? "all-backends-disabled"
        : "all-backends-returned-empty";

    logger.debug(`[hybrid-search] No results from any backend: ${reason}`);

    if (options.includeEvidence) {
      const evidence = buildEvidence([], [], fusionLatencyMs, reason);
      const timingRecord = retrievalTimingsToRecord(diagnosticTimings);
      if (timingRecord) evidence.diagnosticTimings = timingRecord;
      return { results: [], evidence };
    }
    return {
      results: [],
    };
  }

  // ----- RRF fusion -----
  const rrfStartedAt = performance.now();
  const fusedResults = rrfFuse(rankings, rrfK, limit, {
    weights: coverageAdjustedFusionWeights(
      config.fusion.weights,
      caps.coveragePermille.symbolVector,
    ),
  });
  recordRetrievalTiming(diagnosticTimings, "fusion", rrfStartedAt);

  logger.debug(
    `[hybrid-search] Fused ${rankings.length} source(s) into ${fusedResults.length} results (${fusionLatencyMs}ms)`,
  );

  // ----- Chat-aware Personalized PageRank boost (optional) -----
  let pprAdjusted = fusedResults;
  let pprBoosts: NonNullable<RetrievalEvidence["pprBoosts"]> | undefined;
  if (options.chatMentions && options.chatMentions.length > 0) {
    const pprStart = performance.now();
    try {
      const seedResolution = await resolveSeedSymbols(
        conn,
        options.repoId,
        options.chatMentions,
        options.chatMentionWeights,
      );
      const snapshotStartedAt = performance.now();
      let snapshot = getGraphSnapshot(options.repoId);
      if (!snapshot) {
        snapshot = await loadAndCacheGraphSnapshot(conn, options.repoId);
      }
      recordRetrievalTiming(diagnosticTimings, "snapshot", snapshotStartedAt);
      let backend: NonNullable<RetrievalEvidence["pprBoosts"]>["backend"] =
        "js";
      let symbolsBoosted = 0;
      if (snapshot && seedResolution.seeds.size > 0) {
        const pprComputeStartedAt = performance.now();
        const pprResult = await computePpr({
          graph: snapshot,
          snapshotCreatedAt:
            getGraphSnapshotCreatedAt(options.repoId) ?? Date.now(),
          repoId: options.repoId,
          options: {
            seeds: seedResolution.seeds,
            direction: options.pprDirection,
          },
        });
        recordRetrievalTiming(diagnosticTimings, "ppr", pprComputeStartedAt);
        recordRetrievalTiming(
          diagnosticTimings,
          "ppr.compute",
          pprComputeStartedAt,
        );
        backend = pprResult.backend;
        try {
          getObservabilityTap()?.pprResult({
            repoId: options.repoId,
            backend: pprResult.backend,
            computeMs: pprResult.computeMs,
            touched: pprResult.touched,
            seedCount: seedResolution.seeds.size,
          });
        } catch { /* swallow */ }
        const originalScores = new Map(
          fusedResults.map((r) => [r.symbolId, r.score] as const),
        );
        const pprApplyStartedAt = performance.now();
        const boost = applyPprBoost(fusedResults, pprResult.scores, {
          pprWeight: options.pprWeight,
          combinedCap: 4,
          originalScores,
        });
        recordRetrievalTiming(
          diagnosticTimings,
          "ppr.applyBoost",
          pprApplyStartedAt,
        );
        pprAdjusted = boost.items;
        symbolsBoosted = boost.symbolsBoosted;
      }
      pprBoosts = {
        resolvedSeeds: seedResolution.evidence.resolved,
        unresolvedMentions: seedResolution.evidence.unresolved,
        ambiguousMentions: seedResolution.evidence.ambiguous,
        symbolsBoosted,
        latencyMs: Math.round(performance.now() - pprStart),
        backend,
      };
    } catch (err) {
      logger.debug(
        `[hybrid-search] PPR boost failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!options.includeEvidence) {
    return { results: pprAdjusted };
  }
  const evidence = buildEvidence(rankings, pprAdjusted, fusionLatencyMs);
  if (pprBoosts) evidence.pprBoosts = pprBoosts;
  const timingRecord = retrievalTimingsToRecord(diagnosticTimings);
  if (timingRecord) evidence.diagnosticTimings = timingRecord;
  return { results: pprAdjusted, evidence };
}

// ---------------------------------------------------------------------------
// Multi-entity hybrid search (Stage 3)
// ---------------------------------------------------------------------------

/**
 * FTS entity types that have a dedicated index in the graph DB.
 * Maps EntityType -> { tableName, idField } for QUERY_FTS_INDEX calls.
 */
const ENTITY_FTS_CONFIG: Record<
  EntityType,
  { tableName: string; idField: string }
> = {
  symbol: { tableName: "Symbol", idField: "symbolId" },
  memory: { tableName: "Memory", idField: "memoryId" },
  cluster: { tableName: "Cluster", idField: "clusterId" },
  process: { tableName: "Process", idField: "processId" },
  fileSummary: { tableName: "FileSummary", idField: "fileId" },
  agentFeedback: { tableName: "AgentFeedback", idField: "feedbackId" },
};

/**
 * Entity types that support vector search, mapped to their FILESUMMARY or
 * SYMBOL vector index names (model-key -> indexName).
 * Symbol, FileSummary, and AgentFeedback have embedding columns.
 */
const ENTITY_VECTOR_CONFIG: Partial<
  Record<EntityType, Record<string, { indexName: string; idField: string }>>
> = {
  symbol: {
    "nomic-embed-text-v1.5": {
      indexName: "symbol_vec_nomic_embed_v15",
      idField: "symbolId",
    },
    "jina-embeddings-v2-base-code": {
      indexName: "symbol_vec_jina_code_v2",
      idField: "symbolId",
    },
  },
  fileSummary: {
    "jina-embeddings-v2-base-code": {
      indexName: "filesummary_vec_jina_code_v2",
      idField: "fileId",
    },
    "nomic-embed-text-v1.5": {
      indexName: "filesummary_vec_nomic_embed_v15",
      idField: "fileId",
    },
  },
  agentFeedback: {
    "jina-embeddings-v2-base-code": {
      indexName: "agentfeedback_vec_jina_code_v2",
      idField: "feedbackId",
    },
    "nomic-embed-text-v1.5": {
      indexName: "agentfeedback_vec_nomic_embed_v15",
      idField: "feedbackId",
    },
  },
};

/**
 * Per-source ranked list for entity search — parallel to SourceRanking but
 * keyed by entityId (not symbolId) and tagged with the entity type.
 */
export interface EntitySourceRankingCollection {
  conn: Connection;
  capabilities: RetrievalCapabilities;
  config: SemanticRetrievalConfig;
  rankings: EntitySourceRanking[];
  rrfK: number;
  limit: number;
  fusionLatencyMs: number;
}

async function runEntitySearch<T = never>(
  options: EntitySearchOptions,
  queryContext?: RetrievalQueryContext,
  consumeRankings?: (
    collection: EntitySourceRankingCollection,
  ) => Promise<T>,
): Promise<EntitySearchResult | T> {
  /* sdl.context: entity-search telemetry */
  const entitySearchStart = Date.now();
  const diagnosticTimings = new Map<string, number>();
  const config = resolveConfig();
  let conn: Connection;
  try {
    conn = queryContext?.connection ?? (await getLadybugConn());
  } catch (err) {
    if (consumeRankings) throw err;
    logger.info("Entity search", {
      eventType: "entity_search", timestamp: new Date().toISOString(),
      repoId: options.repoId, latencyMs: Date.now() - entitySearchStart,
      candidateCount: 0, candidateCountPerSource: {}, finalResultCount: 0,
      retrievalMode: "unavailable", retrievalType: "none", fallbackReason: "db-connection-unavailable",
      ftsAvailable: false, vectorAvailable: false,
    });
    logger.warn(
      `[entity-search] Failed to obtain DB connection: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      results: [],
      ...(options.includeEvidence
        ? {
            evidence: buildEntityEvidence(
              [],
              [],
              0,
              "db-connection-unavailable",
            ),
          }
        : {}),
    };
  }

  const caps = await runAfterGraphRetrievalAdmission(
    conn,
    options.repoId,
    async () => {
      const healthFactory = () =>
        checkRetrievalHealth(conn, options.repoId, loadConfig().semantic);
      return queryContext
        ? await getOrCreateHealthPromise(
            queryContext,
            options.repoId,
            healthFactory,
          )
        : healthFactory();
    },
  );

  const ftsEnabled = options.ftsEnabled ?? config.fts.enabled;
  const vectorEnabled = options.vectorEnabled ?? config.vector.enabled;
  const rrfK = options.rrfK ?? config.fusion.rrfK ?? DEFAULT_RRF_K;
  const candidateLimit =
    options.candidateLimit ?? config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const limit = Math.min(options.limit, candidateLimit);

  const ALL_ENTITY_TYPES: EntityType[] = [
    "symbol",
    "memory",
    "cluster",
    "process",
    "fileSummary",
    "agentFeedback",
  ];
  const entityTypes = options.entityTypes ?? ALL_ENTITY_TYPES;
  const ftsQuery = options.ftsQuery?.trim() || options.query;
  for (const entityType of entityTypes) {
    if (!ENTITY_FTS_CONFIG[entityType]) continue;
    const physicallyAvailable =
      entityType === "fileSummary" ? caps.fileSummaryFts : caps.fts;
    markLaneAvailability(
      queryContext,
      `${entityType}:fts`,
      ftsEnabled && physicallyAvailable,
    );
  }
  if (!vectorEnabled) {
    for (const entityType of ["symbol", "fileSummary"] as const) {
      if (!entityTypes.includes(entityType)) continue;
      markLaneAvailability(
        queryContext,
        `${entityType}:vector:configured`,
        false,
      );
    }
  }

  const rankings: EntitySourceRanking[] = [];
  const fusionStart = performance.now();

  // ----- FTS retrieval (per entity type) -----
  if (ftsEnabled && (caps.fts || caps.fileSummaryFts)) {
    const ftsTopK = config.fts.topK ?? DEFAULT_FTS_TOP_K;
    const ftsConjunctive = config.fts.conjunctive ?? false;

    for (const entityType of entityTypes) {
      const entityCfg = ENTITY_FTS_CONFIG[entityType];
      if (!entityCfg) continue; // skip unknown entity types
      const entityFtsAvailable =
        entityType === "fileSummary" ? caps.fileSummaryFts : caps.fts;
      if (!entityFtsAvailable) {
        logger.debug(
          `[entity-search] Skipping FTS for '${entityType}' -- capability unavailable`,
        );
        continue;
      }
      // Use the per-entity FTS index name; fall back to the symbol default for
      // "symbol" so that a config override on config.fts.indexName still applies.
      const indexName =
        entityType === "symbol"
          ? (config.fts.indexName ?? DEFAULT_FTS_INDEX_NAME)
          : ENTITY_FTS_INDEX_NAMES[entityType];

      let ftsRows: FtsRawRow[] = [];
      const ftsStartedAt = performance.now();
      const ftsLane = `${entityType}:fts`;
      markLaneAttempt(queryContext, ftsLane);
      try {
        assertTableName(entityCfg.tableName);
        ftsRows = await queryStoredProcAll<FtsRawRow>(
          conn,
          buildFtsStoredProcQuery(
            entityCfg.tableName,
            indexName,
            ftsQuery,
            ftsTopK,
            ftsConjunctive,
          ),
        );
        markLaneResult(queryContext, ftsLane, true);
      } catch (err) {
        markLaneResult(queryContext, ftsLane, false);
        logger.warn(
          `[entity-search] FTS query failed for '${entityType}' (index may be unavailable): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Skip this entity type's FTS — continue with others.
      }

      recordRetrievalTiming(
        diagnosticTimings,
        `entity.fts.${entityType}`,
        ftsStartedAt,
      );

      if (ftsRows.length > 0) {
        const ranks = new Map<string, number>();
        const rowIdentity = (row: FtsRawRow) =>
          vectorRowId(row, entityCfg.idField);
        const rankedRows = sortFtsRowsByScore(ftsRows, rowIdentity);
        for (let i = 0; i < rankedRows.length; i++) {
          const idVal = rowIdentity(rankedRows[i]);
          if (idVal && !ranks.has(idVal)) {
            ranks.set(idVal, i + 1); // 1-based rank
          }
        }
        rankings.push({
          source: "fts",
          entityType,
          ranks,
          candidateCount: ftsRows.length,
        });
      }
    }
  }

  // ----- Vector retrieval (Symbol and FileSummary only) -----
  if (vectorEnabled) {
    const providerType = resolveEmbeddingProviderType();
    const vectorTopK = config.vector.topK ?? DEFAULT_VECTOR_TOP_K;
    const semanticConfig =
      DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES.loadSemanticConfig();
    const modelPlan = resolveSemanticEmbeddingModelPlan(semanticConfig);
    const configuredEntityModels = new Set<string>();
    if (semanticConfig?.enabled !== false) {
      if (entityTypes.includes("symbol")) {
        for (const model of modelPlan.symbolEmbeddingModels) {
          configuredEntityModels.add(model);
        }
      }
      if (entityTypes.includes("fileSummary")) {
        for (const model of modelPlan.fileSummaryEmbeddingModels) {
          configuredEntityModels.add(model);
        }
      }
    }

    for (const [modelName, modelInfo] of Object.entries(
      EMBEDDING_MODELS,
    ).filter(([name]) => configuredEntityModels.has(name))) {
      const source = vectorSourceForModel(modelName);
      const legacyModelAvailable =
        (source === "vector:nomic" && caps.vectorNomic) ||
        (source === "vector:jinacode" && caps.vectorJinaCode);
      const vectorEntityTypes = entityTypes.filter((entityType) => {
        if (!ENTITY_VECTOR_CONFIG[entityType]?.[modelName]) return false;
        let available = legacyModelAvailable;
        if (entityType === "symbol") {
          const symbolAvailability = caps.vectorByEntityModel?.symbol;
          available = symbolAvailability
            ? symbolAvailability[modelName] === true
            : legacyModelAvailable;
        } else if (entityType === "fileSummary") {
          const fileSummaryAvailability =
            caps.vectorByEntityModel?.fileSummary;
          available = fileSummaryAvailability
            ? fileSummaryAvailability[modelName] === true
            : legacyModelAvailable;
        }
        markLaneAvailability(
          queryContext,
          `${entityType}:vector:${modelName}`,
          available,
        );
        return available;
      });

      if (vectorEntityTypes.length === 0) {
        logger.debug(
          `[entity-search] Skipping vector model '${modelName}' -- capability unavailable for requested entities`,
        );
        continue;
      }

      let queryEmbedding: number[];
      const entityEmbedStartedAt = performance.now();
      const vectorLanes = vectorEntityTypes.map(
        (entityType) =>
          `${entityType}:${vectorSourceForModel(modelName)}`,
      );
      try {
        const prefixedQuery = applyQueryPrefix(modelName, options.query);
        const createEmbedding = embeddingFactory(
          DEFAULT_EMBEDDING_PREWARM_DEPENDENCIES,
          providerType,
          modelName,
          prefixedQuery,
        );
        const promise = queryContext
          ? getOrCreateEmbeddingPromise(
              queryContext,
              modelName,
              prefixedQuery,
              createEmbedding,
            )
          : createEmbedding();
        queryEmbedding = await awaitVectorEmbeddingForLanes(
          queryContext,
          vectorLanes,
          promise,
        );
        if (!queryEmbedding || queryEmbedding.length === 0) {
          logger.debug(
            `[entity-search] Empty embedding returned for model '${modelName}'; skipping`,
          );
          continue;
        }
      } catch (err) {
        logger.debug(
          `[entity-search] Embedding generation failed for '${modelName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      } finally {
        recordRetrievalTiming(
          diagnosticTimings,
          `entity.vector.embed.${timingKeySegment(modelName)}`,
          entityEmbedStartedAt,
        );
      }

      // Query only entity types with an exact healthy index for this model.
      for (const entityType of vectorEntityTypes) {
        const entityVecCfg = ENTITY_VECTOR_CONFIG[entityType]?.[modelName];
        if (!entityVecCfg) {
          // This entity type has no vector index for this model.
          continue;
        }

        // Resolve the index name from config override or entity-vector config default.
        const configIndexEntry = config.vector.indexes?.[modelName];
        const indexName =
          entityType === "symbol"
            ? (configIndexEntry?.indexName ?? modelInfo.indexName)
            : entityVecCfg.indexName;

        let vecRows: { symbolId: string; score: number }[] = [];
        const entityFtsCfg = ENTITY_FTS_CONFIG[entityType];
        if (!entityFtsCfg) continue; // skip unknown entity types in vector path
        const vectorQueryStartedAt = performance.now();
        const vectorLane = `${entityType}:${vectorSourceForModel(modelName)}`;
        try {
          const vectorTableName =
            entityType === "symbol"
              ? SYMBOL_VECTOR_EMBEDDING_TABLE
              : entityFtsCfg.tableName;
          assertTableName(vectorTableName);
          assertIndexName(indexName);
          const k = assertPositiveInt(vectorTopK, "topK");
          const vectorLiteral = cypherNumberArray(queryEmbedding);
          const rawRows = await queryStoredProcAll<VectorRawRow>(
            conn,
            `CALL QUERY_VECTOR_INDEX('${vectorTableName}', '${indexName}', ${vectorLiteral}, ${k}) RETURN node, distance`,
          );
          vecRows = sortVectorRowsByDistance(
            rawRows,
            entityVecCfg.idField,
          ).map((r) => {
            // The id field varies by entity type.
            const idField = entityVecCfg.idField;
            const entityId =
              ((r as Record<string, unknown>)[idField] as string | undefined) ??
              (r.node?.[idField] as string | undefined) ??
              (r._node?.[idField] as string | undefined) ??
              r.symbolId ?? // legacy fallback for Symbol
              r.node?.symbolId ??
              r._node?.symbolId ??
              "";
            const score =
              (r.score ?? r._score) != null
                ? Number(r.score ?? r._score)
                : (r.distance ?? r._distance) != null
                  ? 1 / (1 + Number(r.distance ?? r._distance))
                  : 0;
            return { symbolId: entityId, score };
          });
          markLaneResult(queryContext, vectorLane, true);
        } catch (err) {
          markLaneResult(queryContext, vectorLane, false);
          logger.warn(
            `[entity-search] Vector query failed for '${entityType}' model '${modelName}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        } finally {
          recordRetrievalTiming(
            diagnosticTimings,
            `entity.vector.query.${entityType}.${timingKeySegment(modelName)}`,
            vectorQueryStartedAt,
          );
        }

        if (vecRows.length > 0) {
          const ranks = new Map<string, number>();
          for (let i = 0; i < vecRows.length; i++) {
            const eid = vecRows[i].symbolId; // reusing the mapped field
            if (eid && !ranks.has(eid)) {
              ranks.set(eid, i + 1);
            }
          }
          rankings.push({
            source,
            entityType,
            ranks,
            candidateCount: vecRows.length,
          });
        }
      }
    }
  }

  const fusionLatencyMs = Math.round(performance.now() - fusionStart);
  if (consumeRankings) {
    return consumeRankings({
      conn,
      capabilities: caps,
      config,
      rankings,
      rrfK,
      limit,
      fusionLatencyMs,
    });
  }

  if (rankings.length === 0) {
    const reason =
      !ftsEnabled && !vectorEnabled
        ? "all-backends-disabled"
        : "all-backends-returned-empty";
    const evidence = buildEntityEvidence([], [], fusionLatencyMs, reason);
    const timingRecord = retrievalTimingsToRecord(diagnosticTimings);
    if (timingRecord) evidence.diagnosticTimings = timingRecord;
    return {
      results: [],
      ...(options.includeEvidence ? { evidence } : {}),
    };
  }

  const vectorEntityTypes = new Set(
    rankings
      .filter((ranking) => ranking.source.startsWith("vector:"))
      .map((ranking) => ranking.entityType),
  );
  const activeVectorCoverage = [
    ...(vectorEntityTypes.has("symbol")
      ? [caps.coveragePermille.symbolVector]
      : []),
    ...(vectorEntityTypes.has("fileSummary")
      ? [caps.coveragePermille.fileSummaryVector]
      : []),
  ];
  const entityVectorCoveragePermille =
    activeVectorCoverage.length > 0
      ? Math.min(...activeVectorCoverage)
      : 1000;
  const fusedResults = rrfFuseEntities(rankings, rrfK, limit, {
    weights: coverageAdjustedFusionWeights(
      config.fusion.weights,
      entityVectorCoveragePermille,
    ),
  });

  logger.debug(
    `[entity-search] Fused ${rankings.length} source(s) into ${fusedResults.length} results (${fusionLatencyMs}ms)`,
  );

  {
    const candidateCountPerSource: Record<string, number> = {};
    let totalCandidates = 0;
    for (const r of rankings) {
      const key = r.entityType === "symbol" ? r.source : `${r.source}:${r.entityType}`;
      candidateCountPerSource[key] = (candidateCountPerSource[key] ?? 0) + r.candidateCount;
      totalCandidates += r.candidateCount;
    }
    const sources = Array.from(new Set(rankings.map((r) => r.source)));
    logger.info("Entity search", {
      eventType: "entity_search", timestamp: new Date().toISOString(),
      repoId: options.repoId, latencyMs: Date.now() - entitySearchStart,
      candidateCount: totalCandidates, candidateCountPerSource,
      finalResultCount: fusedResults.length, fusionLatencyMs,
      retrievalMode: "hybrid", retrievalType: "hybrid",
      ftsAvailable: sources.includes("fts"),
      vectorAvailable: sources.some((s) => s.startsWith("vector:")),
    });
  }

  // ----- Chat-aware Personalized PageRank boost (symbol entities only) -----
  let pprAdjusted = fusedResults;
  let pprBoosts: NonNullable<RetrievalEvidence["pprBoosts"]> | undefined;
  if (options.chatMentions && options.chatMentions.length > 0) {
    const pprStart = performance.now();
    try {
      const entitySeedResolutionStartedAt = performance.now();
      const seedResolution = await resolveSeedSymbols(
        conn,
        options.repoId,
        options.chatMentions,
        options.chatMentionWeights,
      );
      recordRetrievalTiming(
        diagnosticTimings,
        "entity.ppr.resolveSeeds",
        entitySeedResolutionStartedAt,
      );
      const entitySnapshotStartedAt = performance.now();
      let snapshot = getGraphSnapshot(options.repoId);
      if (!snapshot) {
        snapshot = await loadAndCacheGraphSnapshot(conn, options.repoId);
      }
      recordRetrievalTiming(
        diagnosticTimings,
        "entity.ppr.loadSnapshot",
        entitySnapshotStartedAt,
      );
      let backend: NonNullable<RetrievalEvidence["pprBoosts"]>["backend"] =
        "js";
      let symbolsBoosted = 0;
      if (snapshot && seedResolution.seeds.size > 0) {
        const entityPprComputeStartedAt = performance.now();
        const pprResult = await computePpr({
          graph: snapshot,
          snapshotCreatedAt:
            getGraphSnapshotCreatedAt(options.repoId) ?? Date.now(),
          repoId: options.repoId,
          options: {
            seeds: seedResolution.seeds,
            direction: options.pprDirection,
          },
        });
        recordRetrievalTiming(
          diagnosticTimings,
          "entity.ppr.compute",
          entityPprComputeStartedAt,
        );
        backend = pprResult.backend;
        try {
          getObservabilityTap()?.pprResult({
            repoId: options.repoId,
            backend: pprResult.backend,
            computeMs: pprResult.computeMs,
            touched: pprResult.touched,
            seedCount: seedResolution.seeds.size,
          });
        } catch { /* swallow */ }
        // Boost only symbol entities; other entity types pass through.
        const symbolItems = fusedResults
          .filter((r) => r.entityType === "symbol")
          .map((r) => ({
            symbolId: r.entityId,
            score: r.score,
            source: r.source,
            sourceRanks: r.sourceRanks,
          }));
        const otherItems = fusedResults.filter((r) => r.entityType !== "symbol");
        const originalScores = new Map(
          symbolItems.map((r) => [r.symbolId, r.score] as const),
        );
        const applyBoostStartedAt = performance.now();
        const boost = applyPprBoost(symbolItems, pprResult.scores, {
          pprWeight: options.pprWeight,
          combinedCap: 4,
          originalScores,
        });
        recordRetrievalTiming(
          diagnosticTimings,
          "entity.ppr.applyBoost",
          applyBoostStartedAt,
        );
        symbolsBoosted = boost.symbolsBoosted;
        const reweightedSymbols = boost.items.map((item) => ({
          entityType: "symbol" as const,
          entityId: item.symbolId,
          score: item.score,
          source: item.source,
          sourceRanks: item.sourceRanks,
        }));
        pprAdjusted = [...reweightedSymbols, ...otherItems].sort(
          (a, b) => b.score - a.score,
        );
      }
      pprBoosts = {
        resolvedSeeds: seedResolution.evidence.resolved,
        unresolvedMentions: seedResolution.evidence.unresolved,
        ambiguousMentions: seedResolution.evidence.ambiguous,
        symbolsBoosted,
        latencyMs: Math.round(performance.now() - pprStart),
        backend,
      };
    } catch (err) {
      logger.debug(
        `[entity-search] PPR boost failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      recordRetrievalTiming(
        diagnosticTimings,
        "entity.pprBoost",
        pprStart,
      );
    }
  }

  if (!options.includeEvidence) {
    return { results: pprAdjusted };
  }
  const evidence = buildEntityEvidence(
    rankings,
    pprAdjusted,
    fusionLatencyMs,
  );
  if (pprBoosts) evidence.pprBoosts = pprBoosts;
  const timingRecord = retrievalTimingsToRecord(diagnosticTimings);
  if (timingRecord) evidence.diagnosticTimings = timingRecord;
  return { results: pprAdjusted, evidence };
}

export async function entitySearch(
  options: EntitySearchOptions,
  queryContext?: RetrievalQueryContext,
): Promise<EntitySearchResult> {
  return runEntitySearch(options, queryContext) as Promise<EntitySearchResult>;
}

export async function collectEntitySourceRankings(
  options: EntitySearchOptions,
  queryContext: RetrievalQueryContext,
): Promise<EntitySourceRankingCollection> {
  return runEntitySearch(
    options,
    queryContext,
    async (collection) => collection,
  ) as Promise<EntitySourceRankingCollection>;
}

/**
 * Narrow the candidate file set for `search.edit` text-mode planning.
 *
 * Runs an entity-level hybrid search (FTS + vector + RRF) restricted to the
 * `symbol` entity type, then maps each returned symbol to its owning
 * file. The caller uses this to shortlist files before bounded raw reads,
 * instead of enumerating the entire repository.
 *
 * Degrades gracefully: when retrieval backends are unavailable the
 * function returns an empty `paths` list and the planner falls back to
 * full enumeration. Evidence (when requested) is always returned so the
 * caller can surface `retrievalEvidence` in its response.
 */
export interface NarrowFilesForQueryOptions {
  repoId: string;
  query: string;
  limit?: number;
  includeEvidence?: boolean;
}

export interface NarrowFilesForQueryResult {
  paths: string[];
  evidence?: RetrievalEvidence;
}

export async function narrowFilesForQuery(
  options: NarrowFilesForQueryOptions,
  queryContext: RetrievalQueryContext = createRetrievalQueryContext(),
): Promise<NarrowFilesForQueryResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 32, 200));
  let entityResult;
  try {
    entityResult = await entitySearch({
      repoId: options.repoId,
      query: options.query,
      limit,
      entityTypes: ["symbol"],
      includeEvidence: options.includeEvidence ?? true,
    }, queryContext);
  } catch (err) {
    if (err instanceof IndexError) throw err;
    logger.debug(
      `[narrow-files] entitySearch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { paths: [] };
  }

  const symbolIds = entityResult.results
    .filter((r) => r.entityType === "symbol")
    .map((r) => r.entityId);
  if (symbolIds.length === 0) {
    return {
      paths: [],
      ...(entityResult.evidence ? { evidence: entityResult.evidence } : {}),
    };
  }

  let conn;
  try {
    conn = await getLadybugConn();
  } catch (err) {
    logger.debug(
      `[narrow-files] getLadybugConn failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      paths: [],
      ...(entityResult.evidence ? { evidence: entityResult.evidence } : {}),
    };
  }

  try {
    const symbols = await ladybugDb.getSymbolsByIds(conn, symbolIds);
    const fileIds: string[] = [];
    const seenFileIds = new Set<string>();
    for (const sid of symbolIds) {
      const sym = symbols.get(sid);
      if (!sym || sym.repoId !== options.repoId) continue;
      if (seenFileIds.has(sym.fileId)) continue;
      seenFileIds.add(sym.fileId);
      fileIds.push(sym.fileId);
    }
    if (fileIds.length === 0) {
      return {
        paths: [],
        ...(entityResult.evidence ? { evidence: entityResult.evidence } : {}),
      };
    }

    const fileRows = await ladybugDb.getFilesByIds(conn, fileIds);
    const paths: string[] = [];
    for (const fid of fileIds) {
      const row = fileRows.get(fid);
      if (row && row.repoId === options.repoId) paths.push(row.relPath);
    }
    return {
      paths,
      ...(entityResult.evidence ? { evidence: entityResult.evidence } : {}),
    };
  } catch (err) {
    logger.debug(
      `[narrow-files] DB lookup failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      paths: [],
      ...(entityResult.evidence ? { evidence: entityResult.evidence } : {}),
    };
  }
}
