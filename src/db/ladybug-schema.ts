/**
 * LadybugDB Schema Definition for SDL-MCP v0.8
 *
 * Defines complete Cypher schema for the graph database.
 * Schema is auto-created via initLadybugDb() and is idempotent.
 *
 * Note: LadybugDB doesn't support NOT NULL constraints - all properties
 * are nullable by default except PRIMARY KEY.
 *
 * Node tables: Repo, File, Symbol, Version, SymbolVersion, Metrics,
 *              Cluster, Process, FileSummary, SliceHandle, CardHash, Audit,
 *              AgentFeedback (with searchText + embedding columns),
 *              SymbolEmbedding, SummaryCache, SyncArtifact,
 *              SymbolReference, Memory, UsageSnapshot, SchemaVersion,
 *              ScipIngestion
 *
 * Rel tables: FILE_IN_REPO, SYMBOL_IN_FILE, SYMBOL_IN_REPO, DEPENDS_ON,
 *             VERSION_OF_REPO, BELONGS_TO_CLUSTER, PARTICIPATES_IN,
 *             CLUSTER_IN_REPO, PROCESS_IN_REPO, HAS_MEMORY, MEMORY_OF,
 *             MEMORY_OF_FILE, FILE_SUMMARY_IN_REPO, SUMMARY_OF_FILE
 */

import type { Connection } from "kuzu";
import { exec, execDdl, execStoredProcRaw, querySingle } from "./ladybug-core.js";
import { logger } from "../util/logger.js";
import { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";

/**
 * DDL statements for all LadybugDB node tables.
 * Symbol includes inline embedding columns (embeddingJinaCode*, embeddingNomic*)
 * for the hybrid-retrieval feature (Stage 0+). SymbolEmbedding is kept during
 * migration until Stage 1 is verified complete.
 */
export const NODE_TABLES: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS Repo (
    repoId STRING PRIMARY KEY,
    rootPath STRING,
    configJson STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS File (
    fileId STRING PRIMARY KEY,
    relPath STRING,
    contentHash STRING,
    language STRING,
    byteSize INT64,
    lastIndexedAt STRING,
    directory STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Symbol (
    symbolId STRING PRIMARY KEY,
    repoId STRING,
    kind STRING,
    name STRING,
    exported BOOLEAN,
    visibility STRING,
    language STRING,
    rangeStartLine INT64,
    rangeStartCol INT64,
    rangeEndLine INT64,
    rangeEndCol INT64,
    astFingerprint STRING,
    signatureJson STRING,
    summary STRING,
    summaryQuality DOUBLE DEFAULT 0.0,
    summarySource STRING DEFAULT 'unknown',
    invariantsJson STRING,
    sideEffectsJson STRING,
    roleTagsJson STRING,
    searchText STRING,
    updatedAt STRING,
    embeddingMiniLM STRING,
    embeddingMiniLMCardHash STRING,
    embeddingMiniLMUpdatedAt STRING,
    embeddingMiniLMVec DOUBLE[768],
    embeddingNomic STRING,
    embeddingNomicCardHash STRING,
    embeddingNomicUpdatedAt STRING,
    embeddingJinaCode STRING,
    embeddingJinaCodeCardHash STRING,
    embeddingJinaCodeUpdatedAt STRING,
    embeddingNomicVec DOUBLE[768],
    embeddingJinaCodeVec DOUBLE[768],
    external BOOL DEFAULT false,
    scipSymbol STRING,
    source STRING DEFAULT 'treesitter',
    packageName STRING,
    packageVersion STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Version (
    versionId STRING PRIMARY KEY,
    createdAt STRING,
    reason STRING,
    prevVersionHash STRING,
    versionHash STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SymbolVersion (
    id STRING PRIMARY KEY,
    versionId STRING,
    symbolId STRING,
    astFingerprint STRING,
    signatureJson STRING,
    summary STRING,
    invariantsJson STRING,
    sideEffectsJson STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Metrics (
    symbolId STRING PRIMARY KEY,
    fanIn INT64 DEFAULT 0,
    fanOut INT64 DEFAULT 0,
    churn30d INT64 DEFAULT 0,
    testRefsJson STRING,
    canonicalTestJson STRING,
    pageRank DOUBLE DEFAULT 0.0,
    kCore INT64 DEFAULT 0,
    updatedAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ShadowCluster (
    shadowClusterId STRING PRIMARY KEY,
    repoId STRING,
    algorithm STRING,
    label STRING,
    symbolCount INT64 DEFAULT 0,
    modularity DOUBLE DEFAULT 0.0,
    versionId STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Cluster (
    clusterId STRING PRIMARY KEY,
    repoId STRING,
    label STRING,
    symbolCount INT32 DEFAULT 0,
    cohesionScore DOUBLE DEFAULT 0.0,
    versionId STRING,
    createdAt STRING,
    searchText STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS FileSummary (
    fileId STRING PRIMARY KEY,
    repoId STRING,
    summary STRING,
    searchText STRING,
    updatedAt STRING,
    embeddingMiniLM STRING,
    embeddingMiniLMCardHash STRING,
    embeddingMiniLMUpdatedAt STRING,
    embeddingMiniLMVec DOUBLE[768],
    embeddingNomic STRING,
    embeddingNomicCardHash STRING,
    embeddingNomicUpdatedAt STRING,
    embeddingNomicVec DOUBLE[768],
    embeddingJinaCode STRING,
    embeddingJinaCodeCardHash STRING,
    embeddingJinaCodeUpdatedAt STRING,
    embeddingJinaCodeVec DOUBLE[768]
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Process (
    processId STRING PRIMARY KEY,
    repoId STRING,
    entrySymbolId STRING,
    label STRING,
    depth INT32 DEFAULT 0,
    versionId STRING,
    createdAt STRING,
    searchText STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SliceHandle (
    handle STRING PRIMARY KEY,
    repoId STRING,
    createdAt STRING,
    expiresAt STRING,
    minVersion STRING,
    maxVersion STRING,
    sliceHash STRING,
    spilloverRef STRING,
    cardDetail STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS CardHash (
    cardHash STRING PRIMARY KEY,
    cardBlob STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Audit (
    eventId STRING PRIMARY KEY,
    timestamp STRING,
    tool STRING,
    decision STRING,
    repoId STRING,
    symbolId STRING,
    detailsJson STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS AgentFeedback (
    feedbackId STRING PRIMARY KEY,
    repoId STRING,
    versionId STRING,
    sliceHandle STRING,
    usefulSymbolsJson STRING DEFAULT '[]',
    missingSymbolsJson STRING DEFAULT '[]',
    taskTagsJson STRING,
    taskType STRING,
    taskText STRING,
    createdAt STRING,
    searchText STRING,
    embeddingMiniLM STRING,
    embeddingMiniLMCardHash STRING,
    embeddingMiniLMUpdatedAt STRING,
    embeddingMiniLMVec DOUBLE[768],
    embeddingNomic STRING,
    embeddingNomicCardHash STRING,
    embeddingNomicUpdatedAt STRING,
    embeddingNomicVec DOUBLE[768],
    embeddingJinaCode STRING,
    embeddingJinaCodeCardHash STRING,
    embeddingJinaCodeUpdatedAt STRING,
    embeddingJinaCodeVec DOUBLE[768]
  )`,

  // TODO(hybrid-retrieval): Remove after Stage 1 when SymbolEmbedding migration is verified complete
  `CREATE NODE TABLE IF NOT EXISTS SymbolEmbedding (
    symbolId STRING PRIMARY KEY,
    model STRING,
    embeddingVector STRING,
    version STRING,
    cardHash STRING,
    createdAt STRING,
    updatedAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SummaryCache (
    symbolId STRING PRIMARY KEY,
    summary STRING,
    provider STRING,
    model STRING,
    cardHash STRING,
    costUsd DOUBLE DEFAULT 0.0,
    createdAt STRING,
    updatedAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SyncArtifact (
    artifactId STRING PRIMARY KEY,
    repoId STRING,
    versionId STRING,
    commitSha STRING,
    branch STRING,
    artifactHash STRING,
    compressedData STRING,
    createdAt STRING,
    sizeBytes INT64
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SymbolReference (
    refId STRING PRIMARY KEY,
    repoId STRING,
    symbolName STRING,
    fileId STRING,
    lineNumber INT64,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ToolPolicyHash (
    policyHash STRING PRIMARY KEY,
    policyBlob STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS TsconfigHash (
    tsconfigHash STRING PRIMARY KEY,
    tsconfigBlob STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Memory (
    memoryId STRING PRIMARY KEY,
    repoId STRING,
    type STRING,
    title STRING,
    content STRING,
    contentHash STRING,
    searchText STRING,
    tagsJson STRING DEFAULT '[]',
    confidence DOUBLE DEFAULT 0.8,
    createdAt STRING,
    updatedAt STRING,
    createdByVersion STRING,
    stale BOOLEAN DEFAULT false,
    staleVersion STRING,
    sourceFile STRING,
    deleted BOOLEAN DEFAULT false
  )`,

  `CREATE NODE TABLE IF NOT EXISTS UsageSnapshot (
    snapshotId STRING PRIMARY KEY,
    sessionId STRING,
    repoId STRING,
    timestamp STRING,
    totalSdlTokens INT64,
    totalRawEquivalent INT64,
    totalSavedTokens INT64,
    savingsPercent DOUBLE,
    callCount INT64,
    toolBreakdownJson STRING,
    packedEncodings INT64 DEFAULT 0,
    packedFallbacks INT64 DEFAULT 0,
    packedBytesSaved INT64 DEFAULT 0,
    packedByEncoderJson STRING DEFAULT '{}'
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (
    id STRING PRIMARY KEY,
    schemaVersion INT64,
    createdAt STRING,
    updatedAt STRING
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ScipIngestion (
    id STRING PRIMARY KEY,
    repoId STRING,
    indexPath STRING,
    contentHash STRING,
    ingestedAt STRING,
    ledgerVersion STRING,
    symbolCount INT64,
    edgeCount INT64,
    externalSymbolCount INT64,
    truncated BOOL DEFAULT false
  )`,

  // Per-repo derived-state freshness record. Cluster/process/algorithm/
  // summary/embedding recompute may lag after incremental runs; this
  // table makes the staleness lifecycle explicit, queryable, and
  // recoverable. See devdocs/plans/2026-04-17-post-pass2-performance-and-feedback-plan.md §5.
  `CREATE NODE TABLE IF NOT EXISTS DerivedState (
    repoId STRING PRIMARY KEY,
    clustersDirty BOOL DEFAULT false,
    processesDirty BOOL DEFAULT false,
    algorithmsDirty BOOL DEFAULT false,
    summariesDirty BOOL DEFAULT false,
    embeddingsDirty BOOL DEFAULT false,
    targetVersionId STRING,
    computedVersionId STRING,
    updatedAt STRING,
    lastError STRING
  )`,
];

export const CALL_EDGE_METADATA_FIELDS = [
  "confidence",
  "resolution",
  "resolverId",
  "resolutionPhase",
] as const;

const REL_TABLES: string[] = [
  `CREATE REL TABLE IF NOT EXISTS FILE_IN_REPO (
    FROM File TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_FILE (
    FROM Symbol TO File
  )`,

  `CREATE REL TABLE IF NOT EXISTS SYMBOL_IN_REPO (
    FROM Symbol TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS DEPENDS_ON (
    FROM Symbol TO Symbol,
    edgeType STRING DEFAULT 'call',
    weight DOUBLE DEFAULT 1.0,
    confidence DOUBLE DEFAULT 1.0,
    resolution STRING DEFAULT 'exact',
    resolverId STRING DEFAULT 'pass1-generic',
    resolutionPhase STRING DEFAULT 'pass1',
    provenance STRING,
    createdAt STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS VERSION_OF_REPO (
    FROM Version TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS BELONGS_TO_CLUSTER (
    FROM Symbol TO Cluster,
    membershipScore DOUBLE DEFAULT 0.0
  )`,

  `CREATE REL TABLE IF NOT EXISTS BELONGS_TO_SHADOW_CLUSTER (
    FROM Symbol TO ShadowCluster,
    membershipScore DOUBLE DEFAULT 1.0
  )`,

  `CREATE REL TABLE IF NOT EXISTS SHADOW_CLUSTER_IN_REPO (
    FROM ShadowCluster TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS PARTICIPATES_IN (
    FROM Symbol TO Process,
    stepOrder INT32 DEFAULT 0,
    role STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS CLUSTER_IN_REPO (
    FROM Cluster TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS PROCESS_IN_REPO (
    FROM Process TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS HAS_MEMORY (
    FROM Repo TO Memory
  )`,

  `CREATE REL TABLE IF NOT EXISTS MEMORY_OF (
    FROM Memory TO Symbol
  )`,

  `CREATE REL TABLE IF NOT EXISTS MEMORY_OF_FILE (
    FROM Memory TO File
  )`,

  `CREATE REL TABLE IF NOT EXISTS FILE_SUMMARY_IN_REPO (
    FROM FileSummary TO Repo
  )`,

  `CREATE REL TABLE IF NOT EXISTS SUMMARY_OF_FILE (
    FROM FileSummary TO File
  )`,
];

const INDEXES: string[] = [
  // Secondary indexes for common query patterns
  `CREATE INDEX IF NOT EXISTS idx_symbol_name ON Symbol(name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_repoId ON Symbol(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_file_relPath ON File(relPath)`,
  `CREATE INDEX IF NOT EXISTS idx_file_directory ON File(directory)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_repoId ON Cluster(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_shadowcluster_repoId ON ShadowCluster(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_process_repoId ON Process(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_reference_fileId ON SymbolReference(fileId)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_reference_symbolName ON SymbolReference(symbolName)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_repoId ON Memory(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_type ON Memory(type)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_contentHash ON Memory(contentHash)`,
  `CREATE INDEX IF NOT EXISTS idx_symbolversion_versionId ON SymbolVersion(versionId)`,
  `CREATE INDEX IF NOT EXISTS idx_usagesnapshot_repoId ON UsageSnapshot(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_usagesnapshot_timestamp ON UsageSnapshot(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_repoId ON Audit(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_agentfeedback_repoId ON AgentFeedback(repoId)`,
  `CREATE INDEX IF NOT EXISTS idx_symbolversion_symbolId ON SymbolVersion(symbolId)`,
  `CREATE INDEX IF NOT EXISTS idx_filesummary_repoId ON FileSummary(repoId)`,
];

export async function createBaseSchema(conn: Connection): Promise<void> {
  for (const ddl of NODE_TABLES) {
    await execDdl(conn, ddl);
  }

  for (const ddl of REL_TABLES) {
    await execDdl(conn, ddl);
  }

  const now = new Date().toISOString();
  await exec(
    conn,
    `MERGE (sv:SchemaVersion {id: 'current'})
     ON CREATE SET sv.schemaVersion = $schemaVersion, sv.createdAt = $createdAt, sv.updatedAt = $updatedAt
     ON MATCH SET sv.schemaVersion = $schemaVersion, sv.updatedAt = $updatedAt`,
    { schemaVersion: LADYBUG_SCHEMA_VERSION, createdAt: now, updatedAt: now },
  );
}

export async function createSecondaryIndexes(conn: Connection): Promise<void> {
  for (const ddl of INDEXES) {
    try {
      await execDdl(conn, ddl);
    } catch {
      // LadybugDB versions before 0.4 do not support CREATE INDEX. Since indexes
      // are performance-only (not correctness), silently skipping is safe.
    }
  }
}

export async function createSchema(conn: Connection): Promise<void> {
  await createBaseSchema(conn);
  await createSecondaryIndexes(conn);
}

export async function getSchemaVersion(
  conn: Connection,
): Promise<number | null> {
  const row = await querySingle<{ schemaVersion?: unknown }>(
    conn,
    `MATCH (sv:SchemaVersion {id: 'current'})
     RETURN sv.schemaVersion AS schemaVersion`,
    {},
  );
  if (!row) return null;
  const value = row.schemaVersion;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return null;
}

export { LADYBUG_SCHEMA_VERSION };

export function supportsCallResolutionMetadata(
  schemaVersion: number | null | undefined,
): boolean {
  return typeof schemaVersion === "number" && schemaVersion >= 2;
}

/**
 * Migrate DOUBLE[] (variable-length LIST) embedding columns to DOUBLE[N]
 * (fixed-size ARRAY) so HNSW vector indexes can be created.
 * Idempotent: only runs if the column type is wrong.
 */
export async function migrateVecColumnsToFixedSize(
  conn: Connection,
): Promise<void> {
  // Check if any HNSW indexes exist. If so, the columns were either already
  // correct or a previous migration succeeded — skip to avoid the Kuzu crash
  // that occurs when DROP+ADD is used on columns with existing HNSW indexes.
  let hasHnswIndexes = false;
  try {
    const result = await execStoredProcRaw(
      conn,
      "CALL SHOW_INDEXES() RETURN *",
    );
    try {
      const rows = await result.getAll();
      hasHnswIndexes = (rows as Array<Record<string, unknown>>).some(
        (r) => r.index_type === "HNSW",
      );
    } finally {
      result.close();
    }
  } catch {
    // SHOW_INDEXES unavailable — assume no indexes, allow migration
  }

  if (hasHnswIndexes) {
    logger.debug(
      "[schema-migration] HNSW indexes already exist, skipping vec column migration",
    );
    return;
  }

  const migrations: Array<{ table: string; column: string; size: number }> = [
    { table: "Symbol", column: "embeddingNomicVec", size: 768 },
    { table: "Symbol", column: "embeddingJinaCodeVec", size: 768 },
    { table: "FileSummary", column: "embeddingNomicVec", size: 768 },
    { table: "FileSummary", column: "embeddingJinaCodeVec", size: 768 },
    { table: "AgentFeedback", column: "embeddingNomicVec", size: 768 },
    { table: "AgentFeedback", column: "embeddingJinaCodeVec", size: 768 },
  ];

  const tableInfoCache = new Map<string, Array<Record<string, unknown>>>();

  let migrated = 0;
  for (const { table, column, size } of migrations) {
    try {
      if (!tableInfoCache.has(table)) {
        const infoResult = await execStoredProcRaw(
          conn,
          `CALL TABLE_INFO('${table}') RETURN *`,
        );
        try {
          const infoRows = (await infoResult.getAll()) as Array<
            Record<string, unknown>
          >;
          tableInfoCache.set(table, infoRows);
        } finally {
          infoResult.close();
        }
      }
      const colInfo = tableInfoCache.get(table)!.find(
        (r) => r.name === column,
      );
      if (colInfo && /DOUBLE\[\d+\]/.test(String(colInfo.type))) {
        logger.debug(
          `[schema-migration] ${table}.${column} already DOUBLE[${size}], skipping`,
        );
        continue;
      }

      // Count non-null rows before DROP so a silent data loss surfaces
      // in logs. Parameterised so the column name is safe (we already
      // gated on the column name being a known fixed-size vec target).
      try {
        const countRow = await querySingle<{ n: number | bigint }>(
          conn,
          `MATCH (n:${table}) WHERE n.${column} IS NOT NULL RETURN count(n) AS n`,
        );
        const nonNull =
          typeof countRow?.n === "bigint"
            ? Number(countRow.n)
            : (countRow?.n ?? 0);
        if (nonNull > 0) {
          logger.warn(
            `[schema-migration] DROP+ADD will discard ${nonNull} non-null vector row(s) on ${table}.${column}; rebuild required after migration`,
          );
        }
      } catch (countErr) {
        logger.debug(
          `[schema-migration] Pre-drop count failed for ${table}.${column}: ${countErr instanceof Error ? countErr.message : String(countErr)}`,
        );
      }

      await execDdl(conn, `ALTER TABLE ${table} DROP ${column}`);
      await execDdl(
        conn,
        `ALTER TABLE ${table} ADD ${column} DOUBLE[${size}]`,
      );
      logger.info(
        `[schema-migration] Migrated ${table}.${column} to DOUBLE[${size}]`,
      );
      migrated++;
    } catch (err) {
      logger.debug(
        `[schema-migration] ${table}.${column} migration skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (migrated > 0) {
    logger.info(
      `[schema-migration] Vec column migration complete: ${migrated} column(s) converted to fixed-size ARRAY`,
    );
  }
}
