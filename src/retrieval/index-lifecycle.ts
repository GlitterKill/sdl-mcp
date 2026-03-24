/**
 * Index lifecycle helpers for Kuzu FTS and vector indexes on Symbol properties.
 *
 * All index operations are wrapped in try/catch and fail gracefully because
 * Kuzu's FTS and vector extension support may be limited or unavailable on the
 * current platform.
 */

import type { Connection } from "kuzu";
import { exec, queryAll } from "../db/ladybug-core.js";
import { getExtensionCapabilities } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import {
  EMBEDDING_MODELS,
  getEmbeddingPropertyName,
  getVectorIndexName,
} from "./model-mapping.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexInfo {
  name: string;
  type: "fts" | "vector";
  property: string;
  status: "healthy" | "unknown";
}

export interface IndexHealthResult {
  fts: {
    exists: boolean;
    healthy: boolean;
    indexName: string | null;
  };
  vectors: Array<{
    model: string;
    exists: boolean;
    healthy: boolean;
    indexName: string | null;
  }>;
}

export interface IndexEnsureResult {
  created: string[];
  skipped: string[];
  failed: string[];
}

// ---------------------------------------------------------------------------
// FTS index
// ---------------------------------------------------------------------------

/**
 * Create an FTS index on Symbol.searchText.
 *
 * Uses the Kuzu `CREATE_FTS_INDEX` stored procedure.  Returns true on success,
 * false if the extension is unavailable or the call fails.
 */
export async function createFtsIndex(
  conn: Connection,
  indexName: string,
): Promise<boolean> {
  try {
    // Kuzu FTS extension syntax: CALL CREATE_FTS_INDEX(tableName, indexName, propertyNames)
    await exec(
      conn,
      `CALL CREATE_FTS_INDEX('Symbol', $indexName, ['searchText'])`,
      { indexName },
    );
    logger.info(`[index-lifecycle] FTS index '${indexName}' created on Symbol.searchText`);
    return true;
  } catch (err) {
    logger.warn(
      `[index-lifecycle] FTS index '${indexName}' creation failed (extension may be unavailable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Vector index
// ---------------------------------------------------------------------------

/**
 * Create a vector (HNSW) index on Symbol.<propertyName>.
 *
 * Uses the Kuzu `CREATE_VECTOR_INDEX` stored procedure.  Returns true on
 * success, false if the extension is unavailable or the call fails.
 *
 * @param conn - Kuzu connection
 * @param propertyName - Symbol node property that holds the embedding vector
 * @param indexName - Name for the new index
 * @param dimension - Vector dimensionality (must match embedding model)
 * @param efs - HNSW ef_construction parameter (default 200)
 */
export async function createVectorIndex(
  conn: Connection,
  propertyName: string,
  indexName: string,
  dimension: number,
  efs: number = 200,
): Promise<boolean> {
  try {
    // Kuzu vector index syntax: CALL CREATE_VECTOR_INDEX(tableName, indexName, propertyName, dimension, efs)
    await exec(
      conn,
      `CALL CREATE_VECTOR_INDEX('Symbol', $indexName, $propertyName, $dimension, $efs)`,
      { indexName, propertyName, dimension, efs },
    );
    logger.info(
      `[index-lifecycle] Vector index '${indexName}' created on Symbol.${propertyName} (dim=${dimension}, efs=${efs})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[index-lifecycle] Vector index '${indexName}' creation failed (extension may be unavailable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Index introspection
// ---------------------------------------------------------------------------

/** Raw row returned by CALL SHOW_INDEXES() */
interface ShowIndexRow {
  name?: string;
  index_name?: string;
  type?: string;
  index_type?: string;
  property?: string;
  property_name?: string;
  [key: string]: unknown;
}

/**
 * List all FTS and vector indexes currently present in the graph database.
 *
 * Best-effort: if SHOW_INDEXES() is unsupported, returns an empty array.
 */
export async function showIndexes(conn: Connection): Promise<IndexInfo[]> {
  try {
    const rows = await queryAll<ShowIndexRow>(conn, "CALL SHOW_INDEXES()");
    const results: IndexInfo[] = [];
    for (const row of rows) {
      const name = String(row.name ?? row.index_name ?? "");
      const rawType = String(row.type ?? row.index_type ?? "").toLowerCase();
      const property = String(row.property ?? row.property_name ?? "");

      const type: "fts" | "vector" =
        rawType.includes("vector") || rawType.includes("hnsw")
          ? "vector"
          : "fts";

      results.push({ name, type, property, status: "healthy" });
    }
    return results;
  } catch (err) {
    logger.debug(
      `[index-lifecycle] SHOW_INDEXES() unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/** Expected FTS index name when not overridden by config. */
const DEFAULT_FTS_INDEX_NAME = "symbol_search_text_v1";

/**
 * Check whether the expected FTS and vector indexes exist and are healthy.
 *
 * Uses showIndexes() for introspection; returns unknown status when the
 * SHOW_INDEXES procedure is unavailable.
 */
export async function checkIndexHealth(
  conn: Connection,
): Promise<IndexHealthResult> {
  const indexes = await showIndexes(conn);
  const indexNames = new Set(indexes.map((i) => i.name));

  const ftsExists = indexNames.has(DEFAULT_FTS_INDEX_NAME);

  const vectors = Object.entries(EMBEDDING_MODELS).map(([model]) => {
    const fallbackName = getVectorIndexName(model);
    const propName = getEmbeddingPropertyName(model);
    // Check by property name match as well as the derived index name
    const byName = fallbackName !== null && indexNames.has(fallbackName);
    const byProp =
      propName !== null &&
      indexes.some((i) => i.type === "vector" && i.property === propName);
    const exists = byName || byProp;
    return {
      model,
      exists,
      healthy: exists,
      indexName: fallbackName,
    };
  });

  return {
    fts: {
      exists: ftsExists,
      healthy: ftsExists,
      indexName: DEFAULT_FTS_INDEX_NAME,
    },
    vectors,
  };
}

// ---------------------------------------------------------------------------
// Idempotent ensure
// ---------------------------------------------------------------------------

/**
 * Idempotently create all indexes required by the given retrieval config.
 *
 * Checks getExtensionCapabilities() first — if neither FTS nor vector
 * extensions are available, all operations are skipped gracefully.
 *
 * @returns Structured result listing which indexes were created, skipped, or failed.
 */
export async function ensureIndexes(
  conn: Connection,
  config: SemanticRetrievalConfig,
): Promise<IndexEnsureResult> {
  const result: IndexEnsureResult = { created: [], skipped: [], failed: [] };

  const caps = getExtensionCapabilities();

  // Discover existing indexes once so we can skip already-present ones.
  const existing = await showIndexes(conn);
  const existingNames = new Set(existing.map((i) => i.name));

  // ------------------------------------------------------------------
  // FTS index
  // ------------------------------------------------------------------
  const ftsConfig = config.fts;
  if (ftsConfig?.enabled !== false) {
    if (!caps.fts) {
      logger.debug("[index-lifecycle] Skipping FTS index — extension unavailable");
      result.skipped.push(ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME);
    } else {
      const ftsIndexName = ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME;
      if (existingNames.has(ftsIndexName)) {
        logger.debug(`[index-lifecycle] FTS index '${ftsIndexName}' already exists, skipping`);
        result.skipped.push(ftsIndexName);
      } else {
        const ok = await createFtsIndex(conn, ftsIndexName);
        if (ok) {
          result.created.push(ftsIndexName);
        } else {
          result.failed.push(ftsIndexName);
        }
      }
    }
  } else {
    logger.debug("[index-lifecycle] FTS index creation skipped (disabled in config)");
  }

  // ------------------------------------------------------------------
  // Vector indexes — one per configured model
  // ------------------------------------------------------------------
  const vectorConfig = config.vector;
  if (vectorConfig?.enabled !== false) {
    if (!caps.vector) {
      logger.debug("[index-lifecycle] Skipping vector indexes — extension unavailable");
      // Record all expected vector index names as skipped
      for (const model of Object.keys(EMBEDDING_MODELS)) {
        const name =
          vectorConfig?.indexes?.[model]?.indexName ??
          getVectorIndexName(model) ??
          model;
        result.skipped.push(name);
      }
    } else {
      const efs = vectorConfig?.efs ?? 200;

      for (const [model, modelInfo] of Object.entries(EMBEDDING_MODELS)) {
        const propName = getEmbeddingPropertyName(model);
        if (propName === null) {
          logger.debug(`[index-lifecycle] No property name for model '${model}', skipping`);
          continue;
        }

        // Prefer the index name from config's per-model override; fall back to
        // the deterministic name from model-mapping.
        const configuredEntry = vectorConfig?.indexes?.[model];
        const indexName =
          configuredEntry?.indexName ??
          getVectorIndexName(model) ??
          `symbol_vec_${propName.toLowerCase()}`;

        if (existingNames.has(indexName)) {
          logger.debug(
            `[index-lifecycle] Vector index '${indexName}' already exists, skipping`,
          );
          result.skipped.push(indexName);
          continue;
        }

        const ok = await createVectorIndex(
          conn,
          propName,
          indexName,
          modelInfo.dimension,
          efs,
        );
        if (ok) {
          result.created.push(indexName);
        } else {
          result.failed.push(indexName);
        }
      }
    }
  } else {
    logger.debug("[index-lifecycle] Vector index creation skipped (disabled in config)");
  }

  logger.info(
    `[index-lifecycle] ensureIndexes complete — created: [${result.created.join(", ")}], skipped: [${result.skipped.join(", ")}], failed: [${result.failed.join(", ")}]`,
  );

  return result;
}
