/**
 * Index lifecycle helpers for Kuzu FTS and vector indexes on Symbol properties.
 *
 * All index operations are wrapped in try/catch and fail gracefully because
 * Kuzu's FTS and vector extension support may be limited or unavailable on the
 * current platform.
 */

import type { Connection } from "kuzu";
import { queryAll, runExclusive } from "../db/ladybug-core.js";
import { getExtensionCapabilities } from "../db/extension-caps.js";
import { logger } from "../util/logger.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import {
  EMBEDDING_MODELS,
  getEmbeddingPropertyName,
  getVecPropertyName,
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

export interface EntityIndexHealth {
  indexName: string;
  table: string;
  exists: boolean;
  healthy: boolean;
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
  /** FTS and vector index health for non-Symbol entity tables (Stage 3). */
  entityIndexes?: EntityIndexHealth[];
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
 * Create an FTS index on <tableName>.searchText.
 *
 * Uses the Kuzu `CREATE_FTS_INDEX` stored procedure.  Returns true on success,
 * false if the extension is unavailable or the call fails.
 *
 * @param conn - Kuzu connection
 * @param tableName - Node table name (e.g. 'Symbol', 'Memory', 'Cluster')
 * @param indexName - Name for the new index
 */

/** Validate that a name is a safe Kuzu identifier (letters, digits, underscores). */
function validateIdentifier(name: string, label: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(name)} — must be an alphanumeric identifier`,
    );
  }
}
export async function createFtsIndex(
  conn: Connection,
  tableName: string,
  indexName: string,
): Promise<boolean> {
  try {
    // Kuzu FTS procedures require literal identifiers, not parameterised values.
    // Validate names to prevent injection before string interpolation.
    validateIdentifier(tableName, "table name");
    validateIdentifier(indexName, "index name");
    // CALL stored procedures cannot be prepared; use conn.query() directly.
    // Wrap in runExclusive so deferred-index builds don't race concurrent
    // tool handlers sharing the same read-pool connection.
    await runExclusive(conn, () =>
      conn.query(
        `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', ['searchText'])`,
      ),
    );
    logger.info(
      `[index-lifecycle] FTS index '${indexName}' created on ${tableName}.searchText`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[index-lifecycle] FTS index '${indexName}' on ${tableName} creation failed (extension may be unavailable): ${
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
 * @param tableName - Node table name (e.g. 'Symbol', 'FileSummary')
 * @param propertyName - Node property that holds the embedding vector
 * @param indexName - Name for the new index
 * @param dimension - Vector dimensionality (must match embedding model)
 * @param efs - HNSW ef_construction parameter (default 200)
 */
export async function createVectorIndex(
  conn: Connection,
  tableName: string,
  propertyName: string,
  indexName: string,
  dimension: number,
  efc: number = 200,
): Promise<boolean> {
  try {
    // Kuzu vector procedures require literal identifiers, not parameterised values.
    validateIdentifier(tableName, "table name");
    validateIdentifier(propertyName, "property name");
    validateIdentifier(indexName, "index name");
    // CALL stored procedures cannot be prepared; use conn.query() directly.
    await runExclusive(conn, () =>
      conn.query(
        `CALL CREATE_VECTOR_INDEX('${tableName}', '${indexName}', '${propertyName}', metric := 'cosine', efc := ${Number(efc)})`,
      ),
    );
    logger.info(
      `[index-lifecycle] Vector index '${indexName}' created on ${tableName}.${propertyName} (dim=${dimension}, efc=${efc})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[index-lifecycle] Vector index '${indexName}' on ${tableName} creation failed (extension may be unavailable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Drop a vector (HNSW) index by name.
 *
 * Uses the Kuzu `DROP_VECTOR_INDEX` stored procedure. Returns true on success
 * (including the case where the index was already absent), false only on
 * unexpected failure modes.
 *
 * Bulk embedding refreshes use this to remove the live index for the
 * duration of the write phase, avoiding O(N · log N · M · efc) HNSW
 * insert/delete cost per row, then recreate the index in one rebuild
 * pass at the end.
 */
/**
 * Recognise LadybugDB's catalog-miss phrasings emitted by `DROP_VECTOR_INDEX`
 * (and equivalents) when the named index isn't registered on the table.
 * The binder verifies the catalog BEFORE issuing the DROP, so any of these
 * forms is authoritative for "this index does not exist on this table at
 * this moment":
 *
 *   - "Binder exception: Table <T> doesn't have an index with name <N>."
 *     (fresh DB, deferred indexes)
 *   - "... does not exist."  (older / generic phrasing)
 *   - "no such (vector|fts) index ..."  (variant phrasings)
 *
 * The regex stays specific to these binder catalog errors — a broader
 * pattern like "not found" would risk misreading an unrelated failure
 * and stranding callers on the index-dropped fast path while a live
 * HNSW index still rejects vec writes.
 *
 * Exported primarily for unit testing; product callers go through
 * `dropVectorIndex` instead.
 */
export function isAbsentIndexError(msg: string): boolean {
  return /does not exist|doesn't have an index with name|no such (vector |fts )?index/i.test(
    msg,
  );
}

export async function dropVectorIndex(
  conn: Connection,
  tableName: string,
  indexName: string,
): Promise<boolean> {
  try {
    validateIdentifier(tableName, "table name");
    validateIdentifier(indexName, "index name");
    await runExclusive(conn, () =>
      conn.query(`CALL DROP_VECTOR_INDEX('${tableName}', '${indexName}')`),
    );
    logger.info(
      `[index-lifecycle] Vector index '${indexName}' dropped on ${tableName}`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbsentIndexError(msg)) {
      // Belt-and-suspenders: cross-check via SHOW_INDEXES. The binder error
      // is authoritative on its own, but if SHOW_INDEXES happens to be
      // available it lets us catch a hypothetical race where the index was
      // re-created between the failed DROP and this check. SHOW_INDEXES
      // returning [] (fresh DB or silent driver failure) is consistent with
      // the binder's catalog verdict and is treated as confirmation.
      try {
        const indexes = await showIndexes(conn);
        const stillPresent = indexes.some(
          (i) => i.name === indexName && i.type === "vector",
        );
        if (!stillPresent) {
          logger.debug(
            `[index-lifecycle] Vector index '${indexName}' on ${tableName} already absent`,
          );
          return true;
        }
      } catch {
        // showIndexes threw — fall through to warn+return false.
      }
    }
    logger.warn(
      `[index-lifecycle] Vector index '${indexName}' on ${tableName} drop failed: ${msg}`,
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
  property_names?: string[];
  table_name?: string;
  [key: string]: unknown;
}

/**
 * List all FTS and vector indexes currently present in the graph database.
 *
 * Best-effort: if SHOW_INDEXES() is unsupported, returns an empty array.
 */
export async function showIndexes(conn: Connection): Promise<IndexInfo[]> {
  try {
    const rows = await queryAll<ShowIndexRow>(
      conn,
      "CALL SHOW_INDEXES() RETURN *",
    );
    const results: IndexInfo[] = [];
    for (const row of rows) {
      const name = String(row.index_name ?? row.name ?? "");
      const rawType = String(row.index_type ?? row.type ?? "").toLowerCase();

      // FTS indexes report property_names (array), vector indexes use property_name (string)
      let property = "";
      if (Array.isArray(row.property_names) && row.property_names.length > 0) {
        property = String(row.property_names[0]);
      } else if (row.property_name) {
        property = String(row.property_name);
      } else if (row.property) {
        property = String(row.property);
      }

      const type: "fts" | "vector" =
        rawType.includes("vector") || rawType.includes("hnsw")
          ? "vector"
          : "fts";

      results.push({ name, type, property, status: "healthy" });
    }
    return results;
  } catch (err) {
    logger.debug(
      `[index-lifecycle] SHOW_INDEXES() RETURN * unavailable: ${
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

// ---------------------------------------------------------------------------
// Entity FTS + vector index name constants (Stage 3)
// ---------------------------------------------------------------------------

/** FTS index names for non-Symbol entity tables. */
export const ENTITY_FTS_INDEX_NAMES = {
  memory: "memory_search_text_v1",
  cluster: "cluster_search_text_v1",
  process: "process_search_text_v1",
  fileSummary: "filesummary_search_text_v1",
  agentFeedback: "agentfeedback_search_text_v1",
} as const;

/** Vector index names for FileSummary embedding properties. */
export const FILESUMMARY_VECTOR_INDEX_NAMES = {
  jinaCode: "filesummary_vec_jina_code_v2",
  nomic: "filesummary_vec_nomic_embed_v15",
} as const;

/** FileSummary embedding property names for vector indexing. */
export const FILESUMMARY_EMBEDDING_PROPERTIES = {
  jinaCode: { property: "embeddingJinaCodeVec", dimension: 768 },
  nomic: { property: "embeddingNomicVec", dimension: 768 },
} as const;

/** Vector index names for AgentFeedback embedding properties. */
export const AGENTFEEDBACK_VECTOR_INDEX_NAMES = {
  jinaCode: "agentfeedback_vec_jina_code_v2",
  nomic: "agentfeedback_vec_nomic_embed_v15",
} as const;

/** AgentFeedback embedding property names for vector indexing. */
export const AGENTFEEDBACK_EMBEDDING_PROPERTIES = {
  jinaCode: { property: "embeddingJinaCodeVec", dimension: 768 },
  nomic: { property: "embeddingNomicVec", dimension: 768 },
} as const;

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
    const propName =
      getVecPropertyName(model) ?? getEmbeddingPropertyName(model);
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
      logger.debug(
        "[index-lifecycle] Skipping FTS index — extension unavailable",
      );
      result.skipped.push(ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME);
    } else {
      const ftsIndexName = ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME;
      if (existingNames.has(ftsIndexName)) {
        logger.debug(
          `[index-lifecycle] FTS index '${ftsIndexName}' already exists, skipping`,
        );
        result.skipped.push(ftsIndexName);
      } else {
        const ok = await createFtsIndex(conn, "Symbol", ftsIndexName);
        if (ok) {
          result.created.push(ftsIndexName);
        } else {
          result.failed.push(ftsIndexName);
        }
      }
    }
  } else {
    logger.debug(
      "[index-lifecycle] FTS index creation skipped (disabled in config)",
    );
  }

  // ------------------------------------------------------------------
  // Vector indexes — one per configured model
  // ------------------------------------------------------------------
  const vectorConfig = config.vector;
  if (vectorConfig?.enabled !== false) {
    if (!caps.vector) {
      logger.debug(
        "[index-lifecycle] Skipping vector indexes — extension unavailable",
      );
      // Record all expected vector index names as skipped
      for (const model of Object.keys(EMBEDDING_MODELS)) {
        const name =
          vectorConfig?.indexes?.[model]?.indexName ??
          getVectorIndexName(model) ??
          model;
        result.skipped.push(name);
      }
    } else {
      const efc = vectorConfig?.efc ?? vectorConfig?.efs ?? 200;

      for (const [model, modelInfo] of Object.entries(EMBEDDING_MODELS)) {
        const propName =
          getVecPropertyName(model) ?? getEmbeddingPropertyName(model);
        if (propName === null) {
          logger.debug(
            `[index-lifecycle] No property name for model '${model}', skipping`,
          );
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
          "Symbol",
          propName,
          indexName,
          modelInfo.dimension,
          efc,
        );
        if (ok) {
          result.created.push(indexName);
        } else {
          result.failed.push(indexName);
        }
      }
    }
  } else {
    logger.debug(
      "[index-lifecycle] Vector index creation skipped (disabled in config)",
    );
  }

  logger.info(
    `[index-lifecycle] ensureIndexes complete — created: [${result.created.join(", ")}], skipped: [${result.skipped.join(", ")}], failed: [${result.failed.join(", ")}]`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Entity index ensure (Stage 3)
// ---------------------------------------------------------------------------

/**
 * Idempotently create FTS indexes for Memory, Cluster, Process, FileSummary,
 * AgentFeedback tables and vector indexes for FileSummary and AgentFeedback
 * embedding properties.
 *
 * Called from startup after ensureIndexes() completes.  Fails gracefully when
 * the FTS or vector extension is unavailable.
 *
 * @returns Structured result listing which indexes were created, skipped, or failed.
 */
export async function ensureEntityIndexes(
  conn: Connection,
): Promise<IndexEnsureResult> {
  const result: IndexEnsureResult = { created: [], skipped: [], failed: [] };

  const caps = getExtensionCapabilities();
  const existing = await showIndexes(conn);
  const existingNames = new Set(existing.map((i) => i.name));

  // ------------------------------------------------------------------
  // FTS indexes for entity tables
  // ------------------------------------------------------------------
  const ftsTables: Array<{ table: string; indexName: string }> = [
    { table: "Memory", indexName: ENTITY_FTS_INDEX_NAMES.memory },
    { table: "Cluster", indexName: ENTITY_FTS_INDEX_NAMES.cluster },
    { table: "Process", indexName: ENTITY_FTS_INDEX_NAMES.process },
    { table: "FileSummary", indexName: ENTITY_FTS_INDEX_NAMES.fileSummary },
    { table: "AgentFeedback", indexName: ENTITY_FTS_INDEX_NAMES.agentFeedback },
  ];

  if (caps.fts) {
    for (const { table, indexName } of ftsTables) {
      if (existingNames.has(indexName)) {
        logger.debug(
          `[index-lifecycle] Entity FTS index '${indexName}' already exists, skipping`,
        );
        result.skipped.push(indexName);
      } else {
        const ok = await createFtsIndex(conn, table, indexName);
        if (ok) {
          result.created.push(indexName);
        } else {
          result.failed.push(indexName);
        }
      }
    }
  } else {
    logger.debug(
      "[index-lifecycle] Skipping entity FTS indexes — extension unavailable",
    );
    for (const { indexName } of ftsTables) {
      result.skipped.push(indexName);
    }
  }

  // ------------------------------------------------------------------
  // Vector indexes for FileSummary
  // ------------------------------------------------------------------
  const vectorEntries = Object.entries(
    FILESUMMARY_EMBEDDING_PROPERTIES,
  ) as Array<
    [
      keyof typeof FILESUMMARY_EMBEDDING_PROPERTIES,
      { property: string; dimension: number },
    ]
  >;

  if (caps.vector) {
    for (const [key, { property, dimension }] of vectorEntries) {
      const indexName = FILESUMMARY_VECTOR_INDEX_NAMES[key];
      if (existingNames.has(indexName)) {
        logger.debug(
          `[index-lifecycle] FileSummary vector index '${indexName}' already exists, skipping`,
        );
        result.skipped.push(indexName);
      } else {
        const ok = await createVectorIndex(
          conn,
          "FileSummary",
          property,
          indexName,
          dimension,
        );
        if (ok) {
          result.created.push(indexName);
        } else {
          result.failed.push(indexName);
        }
      }
    }
  } else {
    logger.debug(
      "[index-lifecycle] Skipping FileSummary vector indexes — extension unavailable",
    );
    for (const [key] of vectorEntries) {
      result.skipped.push(FILESUMMARY_VECTOR_INDEX_NAMES[key]);
    }
  }

  // ------------------------------------------------------------------
  // Vector indexes for AgentFeedback
  // ------------------------------------------------------------------
  const afVectorEntries = Object.entries(
    AGENTFEEDBACK_EMBEDDING_PROPERTIES,
  ) as Array<
    [
      keyof typeof AGENTFEEDBACK_EMBEDDING_PROPERTIES,
      { property: string; dimension: number },
    ]
  >;

  if (caps.vector) {
    for (const [key, { property, dimension }] of afVectorEntries) {
      const indexName = AGENTFEEDBACK_VECTOR_INDEX_NAMES[key];
      if (existingNames.has(indexName)) {
        logger.debug(
          `[index-lifecycle] AgentFeedback vector index '${indexName}' already exists, skipping`,
        );
        result.skipped.push(indexName);
      } else {
        const ok = await createVectorIndex(
          conn,
          "AgentFeedback",
          property,
          indexName,
          dimension,
        );
        if (ok) {
          result.created.push(indexName);
        } else {
          result.failed.push(indexName);
        }
      }
    }
  } else {
    logger.debug(
      "[index-lifecycle] Skipping AgentFeedback vector indexes — extension unavailable",
    );
    for (const [key] of afVectorEntries) {
      result.skipped.push(AGENTFEEDBACK_VECTOR_INDEX_NAMES[key]);
    }
  }

  logger.info(
    `[index-lifecycle] ensureEntityIndexes complete — created: [${result.created.join(", ")}], skipped: [${result.skipped.join(", ")}], failed: [${result.failed.join(", ")}]`,
  );

  return result;
}
