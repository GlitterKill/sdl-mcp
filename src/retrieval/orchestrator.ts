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


 * Hybrid retrieval orchestrator.
 *
 * Combines FTS (full-text search) and vector retrieval backends, then
 * fuses results via Reciprocal Rank Fusion (RRF).  Degrades gracefully
 * when individual backends are unavailable.
 */

import type { Connection } from "kuzu";
import { queryAll } from "../db/ladybug-core.js";
import { getLadybugConn } from "../db/ladybug.js";
import * as ladybugDb from "../db/ladybug-queries.js";
import { loadConfig } from "../config/loadConfig.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import { logger } from "../util/logger.js";
import { getEmbeddingProvider } from "../indexer/embeddings.js";
import { applyQueryPrefix } from "../indexer/model-registry.js";
import { EMBEDDING_MODELS } from "./model-mapping.js";
import { ENTITY_FTS_INDEX_NAMES } from "./index-lifecycle.js";
import { checkRetrievalHealth, shouldFallbackToLegacy } from "./fallback.js";
import type {
  HybridSearchOptions,
  HybridSearchResult,
  RetrievalEvidence,
  RetrievalSource,
  EntityType,
  EntitySearchOptions,
  EntitySearchResult,
} from "./types.js";
import {
  type SourceRanking,
  type EntitySourceRanking,
  DEFAULT_RRF_K,
  rrfFuse,
  buildEvidence,
  rrfFuseEntities,
  buildEntityEvidence,
} from "./fusion.js";

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
const DEFAULT_VECTOR_TOP_K = 75;
const DEFAULT_FTS_INDEX_NAME = "symbol_search_text_v1";

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
): Promise<FtsRawRow[]> {
  try {
    assertIndexName(indexName);
    const k = assertPositiveInt(topK, "topK");
    const rows = await queryAll<FtsRawRow>(
      conn,
      `CALL QUERY_FTS_INDEX('Symbol', '${indexName}', $query, K := ${k}, conjunctive := ${conjunctive ? "true" : "false"}) RETURN node, score`,
      { query },
    );
    return rows;
  } catch (err) {
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
): Promise<{ symbolId: string; score: number }[]> {
  try {
    assertIndexName(indexName);
    const k = assertPositiveInt(topK, "topK");
    const rows = await queryAll<VectorRawRow>(
      conn,
      `CALL QUERY_VECTOR_INDEX('Symbol', '${indexName}', $queryVector, ${k}) RETURN node, distance`,
      { queryVector: embedding },
    );
    return rows.map((r) => ({
      symbolId: r.symbolId ?? r.node?.symbolId ?? r._node?.symbolId ?? "",
      // Kuzu vector index returns distance; convert to a similarity score.
      // Lower distance = more similar, so score = 1 / (1 + distance).
      score:
        (r.score ?? r._score) != null
          ? Number(r.score ?? r._score)
          : (r.distance ?? r._distance) != null
            ? 1 / (1 + Number(r.distance ?? r._distance))
            : 0,
    }));
  } catch (err) {
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
    mode: "legacy",
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
    fusion: { strategy: "rrf", rrfK: DEFAULT_RRF_K },
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
): Promise<HybridSearchResult> {
  const config = resolveConfig();
  const caps = await checkRetrievalHealth(options.repoId);

  // Honour explicit option overrides, then fall back to config.
  const ftsEnabled = options.ftsEnabled ?? config.fts.enabled;
  const vectorEnabled = options.vectorEnabled ?? config.vector.enabled;
  const rrfK = options.rrfK ?? config.fusion.rrfK ?? DEFAULT_RRF_K;
  const candidateLimit =
    options.candidateLimit ?? config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const limit = Math.min(options.limit, candidateLimit);

  // If the system should fall back to legacy, return empty with reason.
  if (shouldFallbackToLegacy(caps, config)) {
    logger.debug(
      "[hybrid-search] Falling back to legacy -- caps or config require it",
    );
    return {
      results: [],
      ...(options.includeEvidence
        ? {
            evidence: buildEvidence(
              [],
              [],
              0,
              "fallback-to-legacy: " +
                (caps.degradationReasons?.map((r) => r.message).join("; ") ??
                  "retrieval unavailable"),
            ),
          }
        : {}),
    };
  }

  let conn: Connection;
  try {
    conn = await getLadybugConn();
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

  const rankings: SourceRanking[] = [];

  const fusionStart = performance.now();

  // ----- FTS retrieval -----
  // TODO(Stage 1): Verify Kuzu QUERY_FTS_INDEX return columns against a live
  // instance.  The extraction below handles both flat (symbolId, score) and
  // nested (node.symbolId, _node.symbolId) formats defensively.
  if (ftsEnabled && caps.fts) {
    const ftsTopK = config.fts.topK ?? DEFAULT_FTS_TOP_K;
    const ftsIndexName = config.fts.indexName ?? DEFAULT_FTS_INDEX_NAME;
    const ftsConjunctive = config.fts.conjunctive ?? false;

    const ftsRows = await queryFts(
      conn,
      ftsIndexName,
      options.query,
      ftsTopK,
      ftsConjunctive,
    );

    if (ftsRows.length > 0) {
      const ranks = new Map<string, number>();
      for (let i = 0; i < ftsRows.length; i++) {
        const sid =
          ftsRows[i].symbolId ??
          ftsRows[i].node?.symbolId ??
          ftsRows[i]._node?.symbolId;
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

    // Prioritize Jina for Symbol retrieval, then Nomic
    const sortedModels = Object.entries(EMBEDDING_MODELS).sort(([a], [b]) => {
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

      if (!capAvailable) {
        logger.debug(
          `[hybrid-search] Skipping vector model '${modelName}' -- capability unavailable`,
        );
        continue;
      }

      // Resolve the index name from config override or model-mapping default.
      const configIndexEntry = config.vector.indexes?.[modelName];
      const indexName = configIndexEntry?.indexName ?? modelInfo.indexName;

      // Obtain an embedding provider and check for mock fallback.
      let provider;
      try {
        provider = getEmbeddingProvider(providerType, modelName);
      } catch (err) {
        logger.debug(
          `[hybrid-search] Failed to get embedding provider for '${modelName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      if (provider.isMockFallback?.()) {
        logger.debug(
          `[hybrid-search] Skipping vector model '${modelName}' -- provider is mock fallback`,
        );
        continue;
      }

      // Generate query embedding.
      let queryEmbedding: number[];
      try {
        const prefixedQuery = applyQueryPrefix(modelName, options.query);
        const embeddings = await provider.embed([prefixedQuery]);
        queryEmbedding = embeddings[0];
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
      }

      // Query the vector index.
      const vecResults = await queryVectorIndex(
        conn,
        indexName,
        queryEmbedding,
        vectorTopK,
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

    return {
      results: [],
      ...(options.includeEvidence
        ? { evidence: buildEvidence([], [], fusionLatencyMs, reason) }
        : {}),
    };
  }

  // ----- RRF fusion -----
  const fusedResults = rrfFuse(rankings, rrfK, limit);

  logger.debug(
    `[hybrid-search] Fused ${rankings.length} source(s) into ${fusedResults.length} results (${fusionLatencyMs}ms)`,
  );

  return {
    results: fusedResults,
    ...(options.includeEvidence
      ? {
          evidence: buildEvidence(rankings, fusedResults, fusionLatencyMs),
        }
      : {}),
  };
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
export async function entitySearch(
  options: EntitySearchOptions,
): Promise<EntitySearchResult> {
  /* sdl.context: entity-search telemetry */
  const entitySearchStart = Date.now();
  const config = resolveConfig();
  const caps = await checkRetrievalHealth(options.repoId);

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

  if (shouldFallbackToLegacy(caps, config)) {
    const fallbackReason = "fallback-to-legacy: " + (caps.degradationReasons?.map((r) => r.message).join("; ") ?? "retrieval unavailable");
    logger.info("Entity search", {
      eventType: "entity_search", timestamp: new Date().toISOString(),
      repoId: options.repoId, latencyMs: Date.now() - entitySearchStart,
      candidateCount: 0, candidateCountPerSource: {}, finalResultCount: 0,
      retrievalMode: "legacy", retrievalType: "lexical-only", fallbackReason,
      ftsAvailable: false, vectorAvailable: false,
    });
    return {
      results: [],
      ...(options.includeEvidence
        ? {
            evidence: buildEntityEvidence(
              [],
              [],
              0,
              "fallback-to-legacy: " +
                (caps.degradationReasons?.map((r) => r.message).join("; ") ??
                  "retrieval unavailable"),
            ),
          }
        : {}),
    };
  }

  let conn: Connection;
  try {
    conn = await getLadybugConn();
  } catch (err) {
    logger.info("Entity search", {
      eventType: "entity_search", timestamp: new Date().toISOString(),
      repoId: options.repoId, latencyMs: Date.now() - entitySearchStart,
      candidateCount: 0, candidateCountPerSource: {}, finalResultCount: 0,
      retrievalMode: "legacy", retrievalType: "lexical-only", fallbackReason: "db-connection-unavailable",
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

  const rankings: EntitySourceRanking[] = [];
  const fusionStart = performance.now();

  // ----- FTS retrieval (per entity type) -----
  if (ftsEnabled && caps.fts) {
    const ftsTopK = config.fts.topK ?? DEFAULT_FTS_TOP_K;
    const ftsConjunctive = config.fts.conjunctive ?? false;

    for (const entityType of entityTypes) {
      const entityCfg = ENTITY_FTS_CONFIG[entityType];
      if (!entityCfg) continue; // skip unknown entity types
      // Use the per-entity FTS index name; fall back to the symbol default for
      // "symbol" so that a config override on config.fts.indexName still applies.
      const indexName =
        entityType === "symbol"
          ? (config.fts.indexName ?? DEFAULT_FTS_INDEX_NAME)
          : ENTITY_FTS_INDEX_NAMES[entityType];

      let ftsRows: FtsRawRow[] = [];
      try {
        assertTableName(entityCfg.tableName);
        assertIndexName(indexName);
        const k = assertPositiveInt(ftsTopK, "topK");
        ftsRows = await queryAll<FtsRawRow>(
          conn,
          `CALL QUERY_FTS_INDEX('${entityCfg.tableName}', '${indexName}', $query, K := ${k}, conjunctive := ${ftsConjunctive ? "true" : "false"}) RETURN node, score`,
          { query: options.query },
        );
      } catch (err) {
        logger.warn(
          `[entity-search] FTS query failed for '${entityType}' (index may be unavailable): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Skip this entity type's FTS — continue with others.
      }

      if (ftsRows.length > 0) {
        const ranks = new Map<string, number>();
        for (let i = 0; i < ftsRows.length; i++) {
          // ID field varies by entity type; fall back through defensive paths.
          const idVal =
            ((ftsRows[i] as Record<string, unknown>)[entityCfg.idField] as
              | string
              | undefined) ??
            (ftsRows[i].node?.[entityCfg.idField] as string | undefined) ??
            (ftsRows[i]._node?.[entityCfg.idField] as string | undefined);
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

    for (const [modelName, modelInfo] of Object.entries(EMBEDDING_MODELS)) {
      const source = vectorSourceForModel(modelName);
      const capAvailable =
        (source === "vector:nomic" && caps.vectorNomic) ||
        (source === "vector:jinacode" && caps.vectorJinaCode);

      if (!capAvailable) {
        logger.debug(
          `[entity-search] Skipping vector model '${modelName}' -- capability unavailable`,
        );
        continue;
      }

      // Obtain a shared query embedding for this model (reuse across entity types).
      let provider;
      try {
        provider = getEmbeddingProvider(providerType, modelName);
      } catch (err) {
        logger.debug(
          `[entity-search] Failed to get embedding provider for '${modelName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      if (provider.isMockFallback?.()) {
        logger.debug(
          `[entity-search] Skipping vector model '${modelName}' -- provider is mock fallback`,
        );
        continue;
      }

      let queryEmbedding: number[];
      try {
        const prefixedQuery = applyQueryPrefix(modelName, options.query);
        const embeddings = await provider.embed([prefixedQuery]);
        queryEmbedding = embeddings[0];
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
      }

      // Query each entity type that supports this model's vector index.
      for (const entityType of entityTypes) {
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
        try {
          assertTableName(entityFtsCfg.tableName);
          assertIndexName(indexName);
          const k = assertPositiveInt(vectorTopK, "topK");
          const rawRows = await queryAll<VectorRawRow>(
            conn,
            `CALL QUERY_VECTOR_INDEX('${entityFtsCfg.tableName}', '${indexName}', $queryVector, ${k}) RETURN node, distance`,
            { queryVector: queryEmbedding },
          );
          vecRows = rawRows.map((r) => {
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
        } catch (err) {
          logger.warn(
            `[entity-search] Vector query failed for '${entityType}' model '${modelName}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
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

  if (rankings.length === 0) {
    const reason =
      !ftsEnabled && !vectorEnabled
        ? "all-backends-disabled"
        : "all-backends-returned-empty";
    return {
      results: [],
      ...(options.includeEvidence
        ? { evidence: buildEntityEvidence([], [], fusionLatencyMs, reason) }
        : {}),
    };
  }

  const fusedResults = rrfFuseEntities(rankings, rrfK, limit);

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

  return {
    results: fusedResults,
    ...(options.includeEvidence
      ? {
          evidence: buildEntityEvidence(
            rankings,
            fusedResults,
            fusionLatencyMs,
          ),
        }
      : {}),
  };
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
    });
  } catch (err) {
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
