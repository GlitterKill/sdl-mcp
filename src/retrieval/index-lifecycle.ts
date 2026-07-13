/**
 * Index lifecycle helpers for Kuzu FTS and vector indexes on Symbol properties.
 *
 * All index operations are wrapped in try/catch and fail gracefully because
 * Kuzu's FTS and vector extension support may be limited or unavailable on the
 * current platform.
 */

import type { Connection } from "kuzu";
import {
  execStoredProc,
  queryStoredProcAll,
} from "../db/ladybug-core.js";
import { countRowsInNodeTable } from "../db/ladybug-index-lifecycle.js";
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
  tableName?: string;
  extensionLoaded?: boolean;
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

export type IndexLifecycleTimingRecorder = (
  phaseName: string,
  durationMs: number,
) => void;

export interface EnsureIndexesOptions {
  includeFtsIndex?: boolean;
  includeVectorIndexes?: boolean;
  recordTiming?: IndexLifecycleTimingRecorder;
}

export interface EnsureEntityIndexesOptions {
  includeEntityFtsIndexes?: boolean;
  includeFileSummaryVectorIndexes?: boolean;
  includeAgentFeedbackVectorIndexes?: boolean;
  recordTiming?: IndexLifecycleTimingRecorder;
}

export type DropVectorIndexResult =
  | { status: "dropped" }
  | { status: "absent" }
  | { status: "failed"; error: string };

export type DropFtsIndexResult =
  | { status: "dropped" }
  | { status: "absent" }
  | { status: "failed"; error: string };

export type EnsureFtsIndexResult =
  | { status: "created" }
  | { status: "exists" }
  | { status: "empty" }
  | { status: "failed"; error: string };

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
      `Invalid ${label}: ${JSON.stringify(name)} - must be an alphanumeric identifier`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function countRowsInTable(
  conn: Connection,
  tableName: string,
): Promise<number> {
  return countRowsInNodeTable(conn, tableName);
}

export function indexExistsForTable(
  indexes: readonly IndexInfo[],
  tableName: string,
  indexName: string,
  type: IndexInfo["type"],
): boolean {
  return indexes.some(
    (index) =>
      index.name === indexName &&
      index.type === type &&
      index.tableName === tableName,
  );
}

function hasAmbiguousIndexWithoutTable(
  indexes: readonly IndexInfo[],
  indexName: string,
  type: IndexInfo["type"],
): boolean {
  return indexes.some(
    (index) =>
      index.name === indexName &&
      index.type === type &&
      index.tableName === undefined,
  );
}

export async function ensureFtsIndexForNonEmptyTableWithDependencies(
  conn: Connection,
  tableName: string,
  indexName: string,
  dependencies: {
    showIndexes: (conn: Connection) => Promise<IndexInfo[]>;
    countRowsInTable: (conn: Connection, tableName: string) => Promise<number>;
    createFtsIndex: (
      conn: Connection,
      tableName: string,
      indexName: string,
    ) => Promise<boolean>;
  },
  existingIndexes?: readonly IndexInfo[],
): Promise<EnsureFtsIndexResult> {
  const indexes = existingIndexes ?? (await dependencies.showIndexes(conn));
  if (indexExistsForTable(indexes, tableName, indexName, "fts")) {
    return { status: "exists" };
  }

  const rowCount = await dependencies.countRowsInTable(conn, tableName);
  if (rowCount === 0) {
    logger.debug(
      `[index-lifecycle] FTS index '${indexName}' on ${tableName} deferred because table is empty`,
    );
    return { status: "empty" };
  }

  const ok = await dependencies.createFtsIndex(conn, tableName, indexName);
  return ok
    ? { status: "created" }
    : { status: "failed", error: "CREATE_FTS_INDEX returned false" };
}

export async function ensureFtsIndexForNonEmptyTable(
  conn: Connection,
  tableName: string,
  indexName: string,
  existingIndexes?: readonly IndexInfo[],
): Promise<EnsureFtsIndexResult> {
  return ensureFtsIndexForNonEmptyTableWithDependencies(
    conn,
    tableName,
    indexName,
    { showIndexes, countRowsInTable, createFtsIndex },
    existingIndexes,
  );
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
    await execStoredProc(
      conn,
      `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', ['searchText'])`,
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

export async function dropFtsIndex(
  conn: Connection,
  tableName: string,
  indexName: string,
): Promise<DropFtsIndexResult> {
  return dropFtsIndexWithDependencies(conn, tableName, indexName, {
    execStoredProc,
    showIndexes: showIndexesStrict,
  });
}

export async function dropFtsIndexWithDependencies(
  conn: Connection,
  tableName: string,
  indexName: string,
  dependencies: {
    execStoredProc: (conn: Connection, statement: string) => Promise<void>;
    showIndexes: (conn: Connection) => Promise<IndexInfo[]>;
  },
): Promise<DropFtsIndexResult> {
  try {
    // Kuzu FTS procedures require literal identifiers, not parameterised values.
    // Validate names to prevent injection before string interpolation.
    validateIdentifier(tableName, "table name");
    validateIdentifier(indexName, "index name");
    await dependencies.execStoredProc(
      conn,
      `CALL DROP_FTS_INDEX('${tableName}', '${indexName}')`,
    );
    logger.info(
      `[index-lifecycle] FTS index '${indexName}' dropped on ${tableName}`,
    );
    return { status: "dropped" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      isAbsentFtsIndexError(msg, tableName, indexName) ||
      isMissingFtsProcedureError(msg)
    ) {
      try {
        const indexes = await dependencies.showIndexes(conn);
        const stillPresent = indexExistsForTable(
          indexes,
          tableName,
          indexName,
          "fts",
        );
        if (
          !stillPresent &&
          !hasAmbiguousIndexWithoutTable(indexes, indexName, "fts")
        ) {
          logger.debug(
            `[index-lifecycle] FTS index '${indexName}' on ${tableName} already absent`,
          );
          return { status: "absent" };
        }
      } catch {
        // showIndexes threw - fall through to warn and return a failed result.
      }
    }
    logger.warn(
      `[index-lifecycle] FTS index '${indexName}' on ${tableName} drop failed: ${msg}`,
    );
    return { status: "failed", error: msg };
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
    await execStoredProc(
      conn,
      `CALL CREATE_VECTOR_INDEX('${tableName}', '${indexName}', '${propertyName}', metric := 'cosine', efc := ${Number(efc)})`,
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
 * duration of the write phase, avoiding O(N * log N * M * efc) HNSW
 * insert/delete cost per row, then recreate the index in one rebuild
 * pass at the end.
 */
/**
 * Recognise LadybugDB's catalog-miss phrasings emitted by `DROP_VECTOR_INDEX`
 * when the requested vector index is not registered on the requested table.
 * Generic "does not exist" messages are not enough: they can also describe a
 * missing procedure, table, or property and must not be treated as a dropped
 * HNSW index unless the expected vector index name is present.
 *
 * Exported primarily for unit testing; product callers go through
 * `dropVectorIndex` instead.
 */
export function isAbsentIndexError(
  msg: string,
  tableName: string,
  indexName: string,
): boolean {
  const table = escapeRegExp(tableName);
  const index = escapeRegExp(indexName);
  const missingOnTable = new RegExp(
    `table\\s+${table}\\s+(?:doesn'?t|does\\s+not)\\s+have\\s+an\\s+index\\s+with\\s+name\\s+['"]?${index}['"]?`,
    "i",
  );
  const missingNamedIndex = new RegExp(
    `(?:doesn'?t|does\\s+not)\\s+have\\s+an\\s+index\\s+with\\s+name\\s+['"]?${index}['"]?`,
    "i",
  );
  const noSuchVectorIndex = new RegExp(
    `no\\s+such\\s+(?:vector\\s+)?index\\s+['"]?${index}['"]?`,
    "i",
  );
  const namedVectorIndexDoesNotExist = new RegExp(
    `(?:vector\\s+)?index\\s+['"]?${index}['"]?\\s+does\\s+not\\s+exist`,
    "i",
  );

  return (
    missingOnTable.test(msg) ||
    missingNamedIndex.test(msg) ||
    noSuchVectorIndex.test(msg) ||
    namedVectorIndexDoesNotExist.test(msg)
  );
}

export function isAbsentFtsIndexError(
  msg: string,
  tableName: string,
  indexName: string,
): boolean {
  const table = escapeRegExp(tableName);
  const index = escapeRegExp(indexName);
  const missingOnTable = new RegExp(
    `table\\s+${table}\\s+(?:doesn'?t|does\\s+not)\\s+have\\s+an\\s+index\\s+with\\s+name\\s+['"]?${index}['"]?`,
    "i",
  );
  const missingNamedIndex = new RegExp(
    `(?:doesn'?t|does\\s+not)\\s+have\\s+an\\s+index\\s+with\\s+name\\s+['"]?${index}['"]?`,
    "i",
  );
  const noSuchFtsIndex = new RegExp(
    `no\\s+such\\s+fts\\s+index\\s+['"]?${index}['"]?`,
    "i",
  );
  const namedIndexDoesNotExist = new RegExp(
    `(?:fts\\s+)?index\\s+['"]?${index}['"]?\\s+does\\s+not\\s+exist`,
    "i",
  );
  return (
    missingOnTable.test(msg) ||
    missingNamedIndex.test(msg) ||
    noSuchFtsIndex.test(msg) ||
    namedIndexDoesNotExist.test(msg)
  );
}

function isMissingFtsProcedureError(msg: string): boolean {
  return (
    /procedure\s+DROP_FTS_INDEX\s+(?:does\s+not|doesn'?t)\s+exist/i.test(
      msg,
    ) || /function\s+DROP_FTS_INDEX\s+is\s+not\s+defined/i.test(msg)
  );
}

function isMissingVectorProcedureError(msg: string): boolean {
  return (
    /procedure\s+DROP_VECTOR_INDEX\s+(?:does\s+not|doesn'?t)\s+exist/i.test(
      msg,
    ) || /function\s+DROP_VECTOR_INDEX\s+is\s+not\s+defined/i.test(msg)
  );
}

async function measureIndexLifecyclePhase<T>(
  recordTiming: IndexLifecycleTimingRecorder | undefined,
  phaseName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    recordTiming?.(phaseName, Date.now() - startedAt);
  }
}

export async function dropVectorIndex(
  conn: Connection,
  tableName: string,
  indexName: string,
): Promise<DropVectorIndexResult> {
  return dropVectorIndexWithDependencies(conn, tableName, indexName, {
    execStoredProc,
    showIndexes: showIndexesStrict,
  });
}

export async function dropVectorIndexWithDependencies(
  conn: Connection,
  tableName: string,
  indexName: string,
  dependencies: {
    execStoredProc: (conn: Connection, statement: string) => Promise<void>;
    showIndexes: (conn: Connection) => Promise<IndexInfo[]>;
  },
): Promise<DropVectorIndexResult> {
  try {
    validateIdentifier(tableName, "table name");
    validateIdentifier(indexName, "index name");
    await dependencies.execStoredProc(
      conn,
      `CALL DROP_VECTOR_INDEX('${tableName}', '${indexName}')`,
    );
    logger.info(
      `[index-lifecycle] Vector index '${indexName}' dropped on ${tableName}`,
    );
    return { status: "dropped" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      isAbsentIndexError(msg, tableName, indexName) ||
      isMissingVectorProcedureError(msg)
    ) {
      // Belt-and-suspenders: cross-check via SHOW_INDEXES. The binder error
      // is authoritative on its own, but if SHOW_INDEXES happens to be
      // available it lets us catch a hypothetical race where the index was
      // re-created between the failed DROP and this check. SHOW_INDEXES
      // returning [] (fresh DB or silent driver failure) is consistent with
      // the binder's catalog verdict and is treated as confirmation.
      try {
        const indexes = await dependencies.showIndexes(conn);
        const stillPresent = indexExistsForTable(
          indexes,
          tableName,
          indexName,
          "vector",
        );
        if (
          !stillPresent &&
          !hasAmbiguousIndexWithoutTable(indexes, indexName, "vector")
        ) {
          logger.debug(
            `[index-lifecycle] Vector index '${indexName}' on ${tableName} already absent`,
          );
          return { status: "absent" };
        }
      } catch {
        // showIndexes threw - fall through to warn and return a failed result.
      }
    }
    logger.warn(
      `[index-lifecycle] Vector index '${indexName}' on ${tableName} drop failed: ${msg}`,
    );
    return { status: "failed", error: msg };
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
  extension_loaded?: boolean;
  [key: string]: unknown;
}

function parseShowIndexRows(rows: ShowIndexRow[]): IndexInfo[] {
  const results: IndexInfo[] = [];
  for (const row of rows) {
    const name = String(row.index_name ?? row.name ?? "");
    const rawType = String(row.index_type ?? row.type ?? "").toLowerCase();

    // FTS indexes report property_names (array), vector indexes use property_name (string).
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

    const tableName =
      typeof row.table_name === "string" && row.table_name.length > 0
        ? row.table_name
        : undefined;
    const extensionLoaded =
      typeof row.extension_loaded === "boolean"
        ? row.extension_loaded
        : undefined;

    results.push({
      name,
      type,
      property,
      ...(tableName ? { tableName } : {}),
      ...(extensionLoaded !== undefined ? { extensionLoaded } : {}),
      status: extensionLoaded === false ? "unknown" : "healthy",
    });
  }
  return results;
}

export async function showIndexesStrict(conn: Connection): Promise<IndexInfo[]> {
  const rows = await queryStoredProcAll<ShowIndexRow>(
    conn,
    "CALL SHOW_INDEXES() RETURN *",
  );
  return parseShowIndexRows(rows);
}

/**
 * List all FTS and vector indexes currently present in the graph database.
 *
 * Best-effort: if SHOW_INDEXES() is unsupported, returns an empty array.
 */
export async function showIndexes(conn: Connection): Promise<IndexInfo[]> {
  try {
    return await showIndexesStrict(conn);
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

/** Default Symbol FTS index name when not overridden by config. */
export const SYMBOL_FTS_INDEX_NAME = "symbol_search_text_v1";
const DEFAULT_FTS_INDEX_NAME = SYMBOL_FTS_INDEX_NAME;

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

  const ftsExists = indexExistsForTable(
    indexes,
    "Symbol",
    DEFAULT_FTS_INDEX_NAME,
    "fts",
  );

  const vectors = Object.entries(EMBEDDING_MODELS).map(([model]) => {
    const fallbackName = getVectorIndexName(model);
    const propName =
      getVecPropertyName(model) ?? getEmbeddingPropertyName(model);
    // Check by property name match as well as the derived index name
    const match = indexes.find(
      (index) =>
        index.type === "vector" &&
        index.tableName === "Symbol" &&
        ((fallbackName !== null && index.name === fallbackName) ||
          (propName !== null && index.property === propName)),
    );
    const exists = match !== undefined;
    return {
      model,
      exists,
      healthy: match?.status === "healthy",
      indexName: fallbackName,
    };
  });

  return {
    fts: {
      exists: ftsExists,
      healthy:
        ftsExists &&
        indexes.some(
          (index) =>
            index.name === DEFAULT_FTS_INDEX_NAME &&
            index.type === "fts" &&
            index.tableName === "Symbol" &&
            index.status === "healthy",
        ),
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
 * Checks getExtensionCapabilities() first - if neither FTS nor vector
 * extensions are available, all operations are skipped gracefully.
 *
 * @returns Structured result listing which indexes were created, skipped, or failed.
 */
export async function ensureIndexes(
  conn: Connection,
  config: SemanticRetrievalConfig,
  options: EnsureIndexesOptions = {},
): Promise<IndexEnsureResult> {
  const result: IndexEnsureResult = { created: [], skipped: [], failed: [] };
  const includeFtsIndex = options.includeFtsIndex !== false;
  const includeVectorIndexes = options.includeVectorIndexes !== false;

  const caps = getExtensionCapabilities();

  // Discover existing indexes once so we can skip already-present ones.
  const existing = await measureIndexLifecyclePhase(
    options.recordTiming,
    "symbolDiscovery",
    () => showIndexes(conn),
  );

  // ------------------------------------------------------------------
  // FTS index
  // ------------------------------------------------------------------
  const ftsConfig = config.fts;
  await measureIndexLifecyclePhase(
    options.recordTiming,
    "symbolFts",
    async () => {
      if (!includeFtsIndex) {
        const ftsIndexName = ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME;
        logger.debug(
          "[index-lifecycle] Skipping Symbol FTS index - semantic readiness deferred",
        );
        result.skipped.push(ftsIndexName);
      } else if (ftsConfig?.enabled !== false) {
        if (!caps.fts) {
          logger.debug(
            "[index-lifecycle] Skipping FTS index - extension unavailable",
          );
          result.skipped.push(ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME);
        } else {
          const ftsIndexName = ftsConfig?.indexName ?? DEFAULT_FTS_INDEX_NAME;
          const ensureResult = await ensureFtsIndexForNonEmptyTable(
            conn,
            "Symbol",
            ftsIndexName,
            existing,
          );
          switch (ensureResult.status) {
            case "created":
              result.created.push(ftsIndexName);
              break;
            case "failed":
              result.failed.push(ftsIndexName);
              break;
            case "exists":
            case "empty":
              result.skipped.push(ftsIndexName);
              break;
          }
        }
      } else {
        logger.debug(
          "[index-lifecycle] FTS index creation skipped (disabled in config)",
        );
      }
    },
  );

  // ------------------------------------------------------------------
  // Vector indexes - one per configured model
  // ------------------------------------------------------------------
  const vectorConfig = config.vector;
  await measureIndexLifecyclePhase(
    options.recordTiming,
    "symbolVectors",
    async () => {
      if (vectorConfig?.enabled !== false) {
        if (!includeVectorIndexes) {
          logger.debug(
            "[index-lifecycle] Skipping Symbol vector indexes - semantic refresh deferred",
          );
          for (const model of Object.keys(EMBEDDING_MODELS)) {
            const name =
              vectorConfig?.indexes?.[model]?.indexName ??
              getVectorIndexName(model) ??
              model;
            result.skipped.push(name);
          }
        } else if (!caps.vector) {
          logger.debug(
            "[index-lifecycle] Skipping vector indexes - extension unavailable",
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

            if (indexExistsForTable(existing, "Symbol", indexName, "vector")) {
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
    },
  );

  logger.info(
    `[index-lifecycle] ensureIndexes complete - created: [${result.created.join(", ")}], skipped: [${result.skipped.join(", ")}], failed: [${result.failed.join(", ")}]`,
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
  options: EnsureEntityIndexesOptions = {},
): Promise<IndexEnsureResult> {
  const result: IndexEnsureResult = { created: [], skipped: [], failed: [] };
  const includeEntityFtsIndexes =
    options.includeEntityFtsIndexes !== false;
  const includeFileSummaryVectorIndexes =
    options.includeFileSummaryVectorIndexes !== false;
  const includeAgentFeedbackVectorIndexes =
    options.includeAgentFeedbackVectorIndexes !== false;

  const caps = getExtensionCapabilities();
  const existing = await measureIndexLifecyclePhase(
    options.recordTiming,
    "entityDiscovery",
    () => showIndexes(conn),
  );

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

  await measureIndexLifecyclePhase(
    options.recordTiming,
    "entityFts",
    async () => {
      if (!includeEntityFtsIndexes) {
        logger.debug(
          "[index-lifecycle] Skipping entity FTS indexes - semantic readiness deferred",
        );
        for (const { indexName } of ftsTables) {
          result.skipped.push(indexName);
        }
      } else if (caps.fts) {
        for (const { table, indexName } of ftsTables) {
          const ensureResult = await ensureFtsIndexForNonEmptyTable(
            conn,
            table,
            indexName,
            existing,
          );
          switch (ensureResult.status) {
            case "created":
              result.created.push(indexName);
              break;
            case "failed":
              result.failed.push(indexName);
              break;
            case "exists":
            case "empty":
              result.skipped.push(indexName);
              break;
          }
        }
      } else {
        logger.debug(
          "[index-lifecycle] Skipping entity FTS indexes - extension unavailable",
        );
        for (const { indexName } of ftsTables) {
          result.skipped.push(indexName);
        }
      }
    },
  );

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

  await measureIndexLifecyclePhase(
    options.recordTiming,
    "fileSummaryVectors",
    async () => {
      if (!includeFileSummaryVectorIndexes) {
        logger.debug(
          "[index-lifecycle] Skipping FileSummary vector indexes - semantic refresh deferred",
        );
        for (const [key] of vectorEntries) {
          result.skipped.push(FILESUMMARY_VECTOR_INDEX_NAMES[key]);
        }
      } else if (caps.vector) {
        for (const [key, { property, dimension }] of vectorEntries) {
          const indexName = FILESUMMARY_VECTOR_INDEX_NAMES[key];
          if (
            indexExistsForTable(existing, "FileSummary", indexName, "vector")
          ) {
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
          "[index-lifecycle] Skipping FileSummary vector indexes - extension unavailable",
        );
        for (const [key] of vectorEntries) {
          result.skipped.push(FILESUMMARY_VECTOR_INDEX_NAMES[key]);
        }
      }
    },
  );

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

  await measureIndexLifecyclePhase(
    options.recordTiming,
    "agentFeedbackVectors",
    async () => {
      if (!includeAgentFeedbackVectorIndexes) {
        logger.debug(
          "[index-lifecycle] Skipping AgentFeedback vector indexes by option",
        );
        for (const [key] of afVectorEntries) {
          result.skipped.push(AGENTFEEDBACK_VECTOR_INDEX_NAMES[key]);
        }
      } else if (caps.vector) {
        for (const [key, { property, dimension }] of afVectorEntries) {
          const indexName = AGENTFEEDBACK_VECTOR_INDEX_NAMES[key];
          if (
            indexExistsForTable(existing, "AgentFeedback", indexName, "vector")
          ) {
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
          "[index-lifecycle] Skipping AgentFeedback vector indexes - extension unavailable",
        );
        for (const [key] of afVectorEntries) {
          result.skipped.push(AGENTFEEDBACK_VECTOR_INDEX_NAMES[key]);
        }
      }
    },
  );

  logger.info(
    `[index-lifecycle] ensureEntityIndexes complete - created: [${result.created.join(", ")}], skipped: [${result.skipped.join(", ")}], failed: [${result.failed.join(", ")}]`,
  );

  return result;
}
