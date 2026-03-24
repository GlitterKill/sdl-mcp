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
 *              Cluster, Process, SliceHandle, CardHash, Audit,
 *              AgentFeedback, SymbolEmbedding, SummaryCache, SyncArtifact,
 *              SymbolReference, Memory, UsageSnapshot, SchemaVersion
 *
 * Rel tables: FILE_IN_REPO, SYMBOL_IN_FILE, SYMBOL_IN_REPO, DEPENDS_ON,
 *             VERSION_OF_REPO, BELONGS_TO_CLUSTER, PARTICIPATES_IN,
 *             CLUSTER_IN_REPO, PROCESS_IN_REPO, HAS_MEMORY, MEMORY_OF,
 *             MEMORY_OF_FILE
 */

import type { Connection } from "kuzu";
import { exec, querySingle } from "./ladybug-core.js";
import { LADYBUG_SCHEMA_VERSION } from "./migrations/index.js";

/**
 * DDL statements for all LadybugDB node tables.
 * Symbol includes inline embedding columns (embeddingMiniLM*, embeddingNomic*)
 * for the hybrid-retrieval feature (Stage 0+). SymbolEmbedding is kept during
 * migration until Stage 1 is verified complete.
 */
const NODE_TABLES: string[] = [
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
    embeddingNomic STRING,
    embeddingNomicCardHash STRING,
    embeddingNomicUpdatedAt STRING
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
    updatedAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Cluster (
    clusterId STRING PRIMARY KEY,
    repoId STRING,
    label STRING,
    symbolCount INT32 DEFAULT 0,
    cohesionScore DOUBLE DEFAULT 0.0,
    versionId STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Process (
    processId STRING PRIMARY KEY,
    repoId STRING,
    entrySymbolId STRING,
    label STRING,
    depth INT32 DEFAULT 0,
    versionId STRING,
    createdAt STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SliceHandle (
    handle STRING PRIMARY KEY,
    repoId STRING,
    createdAt STRING,
    expiresAt STRING,
    minVersion STRING,
    maxVersion STRING,
    sliceHash STRING,
    spilloverRef STRING
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
    createdAt STRING
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
    toolBreakdownJson STRING
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SchemaVersion (
    id STRING PRIMARY KEY,
    schemaVersion INT64,
    createdAt STRING,
    updatedAt STRING
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
];

async function execDdl(conn: Connection, ddl: string): Promise<void> {
  const result = await conn.query(ddl);
  result.close();
}

const INDEXES: string[] = [
  // Secondary indexes for common query patterns
  `CREATE INDEX IF NOT EXISTS idx_symbol_name ON Symbol(name)`,
  `CREATE INDEX IF NOT EXISTS idx_file_relPath ON File(relPath)`,
  `CREATE INDEX IF NOT EXISTS idx_file_directory ON File(directory)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_repoId ON Cluster(repoId)`,
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
];

export async function createSchema(conn: Connection): Promise<void> {
  for (const ddl of NODE_TABLES) {
    await execDdl(conn, ddl);
  }

  for (const ddl of REL_TABLES) {
    await execDdl(conn, ddl);
  }

  for (const ddl of INDEXES) {
    try {
      await execDdl(conn, ddl);
    } catch {
      // Kùzu versions before 0.4 do not support CREATE INDEX. Since indexes
      // are performance-only (not correctness), silently skipping is safe.
    }
  }

  // Insert or verify schema version
  const now = new Date().toISOString();
  await exec(
    conn,
    `MERGE (sv:SchemaVersion {id: 'current'})
     ON CREATE SET sv.schemaVersion = $schemaVersion, sv.createdAt = $createdAt, sv.updatedAt = $updatedAt
     ON MATCH SET sv.schemaVersion = $schemaVersion, sv.updatedAt = $updatedAt`,
    { schemaVersion: LADYBUG_SCHEMA_VERSION, createdAt: now, updatedAt: now },
  );
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
