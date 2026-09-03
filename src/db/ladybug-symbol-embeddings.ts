/** Model-aware storage helpers for the dedicated SymbolVectorEmbedding table. */
import { createHash } from "node:crypto";

import type { Connection } from "kuzu";

import type { SemanticConfig } from "../config/types.js";
import { IndexError } from "../domain/errors.js";
import {
  EMBEDDING_MODELS,
  getVecPropertyName,
  getVectorIndexName,
  SYMBOL_VECTOR_EMBEDDING_TABLE,
} from "../retrieval/model-mapping.js";
import { logger } from "../util/logger.js";
import {
  exec,
  execDdl,
  queryAll,
  querySingle,
  queryStoredProcAll,
  resetPreparedStatementCaches,
  toNumber,
} from "./ladybug-core.js";
import { hasCurrentExclusiveLadybugOperation } from "./ladybug-operation-gate.js";

export interface SymbolVectorEmbeddingRow {
  vector: string;
  cardHash: string;
  updatedAt: string;
}

export interface SymbolVectorEmbeddingBatchItem {
  symbolId: string;
  vector: string;
  cardHash: string;
  vectorArray: number[];
}

export interface SymbolVectorPhysicalIdentity {
  repoHash: string;
  tableName: string;
  indexName: string;
  propertyName: string;
}

const SAFE_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function hashRepositoryId(repoId: string): string {
  return createHash("sha256").update(repoId).digest("hex").slice(0, 32);
}

function getEffectiveLogicalIndexStem(
  model: string,
  semanticConfig?: SemanticConfig,
): string | null {
  return (
    semanticConfig?.retrieval?.vector?.indexes?.[model]?.indexName ??
    getVectorIndexName(model)
  );
}

function assertPhysicalIdentifier(
  identifier: string,
  kind: "table" | "index",
  model: string,
): void {
  if (SAFE_IDENTIFIER.test(identifier)) return;

  if (identifier.length > 64) {
    const guidance =
      kind === "index"
        ? ` Shorten semantic.retrieval.vector.indexes["${model}"].indexName.`
        : "";
    throw new IndexError(
      `Resolved Symbol vector ${kind} identifier "${identifier}" is ${identifier.length} characters, exceeding the 64-character identifier limit.${guidance}`,
    );
  }

  throw new IndexError(
    `Resolved Symbol vector ${kind} identifier "${identifier}" is invalid; identifiers must start with an ASCII letter and contain only ASCII letters, digits, or underscores.`,
  );
}

export function resolveSymbolVectorPhysicalIdentity(
  repoId: string,
  model: string,
  semanticConfig?: SemanticConfig,
): SymbolVectorPhysicalIdentity {
  if (repoId.length === 0) {
    throw new IndexError(
      "Cannot resolve Symbol vector physical identity: repository ID must not be empty.",
    );
  }

  const propertyName = getVecPropertyName(model);
  const logicalIndexStem = getEffectiveLogicalIndexStem(model, semanticConfig);
  if (!propertyName || !logicalIndexStem) {
    throw new IndexError(
      `Unsupported embedding model "${model}": cannot resolve Symbol vector physical identity.`,
    );
  }

  for (const supportedModel of Object.keys(EMBEDDING_MODELS)) {
    if (supportedModel === model) continue;
    const otherLogicalIndexStem = getEffectiveLogicalIndexStem(
      supportedModel,
      semanticConfig,
    );
    if (otherLogicalIndexStem !== logicalIndexStem) continue;
    throw new IndexError(
      `Embedding models "${model}" and "${supportedModel}" resolve to the same Symbol vector logical index stem "${logicalIndexStem}". Configure unique indexName values in semantic.retrieval.vector.indexes because both models share one repository table.`,
    );
  }

  const repoHash = hashRepositoryId(repoId);
  const tableName = `${SYMBOL_VECTOR_EMBEDDING_TABLE}_r_${repoHash}`;
  const indexName = `${logicalIndexStem}_r_${repoHash}`;

  assertPhysicalIdentifier(tableName, "table", model);
  assertPhysicalIdentifier(indexName, "index", model);

  return { repoHash, tableName, indexName, propertyName };
}

function resolveVectorProperty(model: string): string {
  const vectorProperty = getVecPropertyName(model);
  if (!vectorProperty) {
    throw new Error(
      `Unknown embedding model "${model}": cannot resolve vector property`,
    );
  }
  if (!SAFE_IDENTIFIER.test(vectorProperty)) {
    throw new Error(`Unsafe Cypher property name: "${vectorProperty}"`);
  }
  return vectorProperty;
}

function getEmbeddingId(symbolId: string, model: string): string {
  return `${model}:${symbolId}`;
}

/** True when the selected model has at least one complete persisted vector row. */
export async function hasCompleteSymbolVectorEmbedding(
  conn: Connection,
  model: string,
): Promise<boolean> {
  const vectorProperty = resolveVectorProperty(model);
  const row = await querySingle<{ embeddingId: string }>(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE} {model: $model})
     WHERE e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN e.embeddingId AS embeddingId
     LIMIT 1`,
    { model },
  );
  return row !== null;
}

export async function deleteSymbolVectorEmbeddingsBySymbolIds(
  conn: Connection,
  symbolIds: readonly string[],
): Promise<void> {
  if (symbolIds.length === 0) return;
  await exec(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE})
     WHERE e.symbolId IN $symbolIds
     DELETE e`,
    { symbolIds: [...symbolIds] },
  );
}

export async function getSymbolVectorEmbedding(
  conn: Connection,
  symbolId: string,
  model: string,
): Promise<SymbolVectorEmbeddingRow | null> {
  const vectorProperty = resolveVectorProperty(model);
  const row = await querySingle<{
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE} {embeddingId: $embeddingId})
     WHERE e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN e.embeddingVector AS vector,
            e.cardHash AS cardHash,
            e.updatedAt AS updatedAt`,
    { embeddingId: getEmbeddingId(symbolId, model) },
  );

  if (!row || row.vector === null || row.cardHash === null) return null;
  return {
    vector: row.vector,
    cardHash: row.cardHash,
    updatedAt: row.updatedAt ?? "",
  };
}

export async function getSymbolVectorEmbeddings(
  conn: Connection,
  symbolIds: string[],
  model: string,
): Promise<Map<string, SymbolVectorEmbeddingRow>> {
  const result = new Map<string, SymbolVectorEmbeddingRow>();
  if (symbolIds.length === 0) return result;

  const vectorProperty = resolveVectorProperty(model);
  const embeddingIds = symbolIds.map((symbolId) =>
    getEmbeddingId(symbolId, model),
  );
  const rows = await queryAll<{
    symbolId: string;
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE})
     WHERE e.embeddingId IN $embeddingIds
       AND e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN e.symbolId AS symbolId,
            e.embeddingVector AS vector,
            e.cardHash AS cardHash,
            e.updatedAt AS updatedAt`,
    { embeddingIds },
  );

  for (const row of rows) {
    if (row.vector === null || row.cardHash === null) continue;
    result.set(row.symbolId, {
      vector: row.vector,
      cardHash: row.cardHash,
      updatedAt: row.updatedAt ?? "",
    });
  }

  logger.debug(
    "getSymbolVectorEmbeddings: loaded complete model-scoped embeddings",
    { model, requested: symbolIds.length, found: result.size },
  );
  return result;
}

export async function setSymbolVectorEmbedding(
  conn: Connection,
  repoId: string,
  symbolId: string,
  model: string,
  vector: string,
  cardHash: string,
  vectorArray: number[],
): Promise<void> {
  await setSymbolVectorEmbeddingBatch(
    conn,
    repoId,
    model,
    [{ symbolId, vector, cardHash, vectorArray }],
  );
}

export async function setSymbolVectorEmbeddingBatch(
  conn: Connection,
  repoId: string,
  model: string,
  items: SymbolVectorEmbeddingBatchItem[],
): Promise<void> {
  if (items.length === 0) return;

  const vectorProperty = resolveVectorProperty(model);
  const updatedAt = new Date().toISOString();
  const rows = items.map((item) => ({
    embeddingId: getEmbeddingId(item.symbolId, model),
    repoId,
    symbolId: item.symbolId,
    model,
    vector: item.vector,
    cardHash: item.cardHash,
    updatedAt,
    vectorArray: item.vectorArray,
  }));

  // Separate autocommits make an interrupted replacement visible to dirty/retry.
  await exec(
    conn,
    `MATCH (e:${SYMBOL_VECTOR_EMBEDDING_TABLE})
     WHERE e.embeddingId IN $embeddingIds
     DELETE e`,
    { embeddingIds: rows.map((row) => row.embeddingId) },
  );
  await exec(
    conn,
    `UNWIND $rows AS r
     MERGE (e:${SYMBOL_VECTOR_EMBEDDING_TABLE} {embeddingId: r.embeddingId})
     SET e.repoId = r.repoId,
         e.symbolId = r.symbolId,
         e.model = r.model,
         e.embeddingVector = r.vector,
         e.cardHash = r.cardHash,
         e.updatedAt = r.updatedAt,
         e.${vectorProperty} = r.vectorArray`,
    { rows },
  );
}


interface RepoVectorCatalogTableRow {
  name?: unknown;
  type?: unknown;
}

interface RepoVectorCatalogColumnRow {
  name?: unknown;
  type?: unknown;
  "primary key"?: unknown;
  primary_key?: unknown;
  primaryKey?: unknown;
}

export interface RepoSymbolVectorTableInspection {
  tableName: string;
  state: "absent" | "present";
}

const TABLE_IDENTITY_MODEL = "jina-embeddings-v2-base-code";
const REPO_VECTOR_COLUMNS = [
  { name: "embeddingId", type: "STRING", primaryKey: true },
  { name: "repoId", type: "STRING", primaryKey: false },
  { name: "symbolId", type: "STRING", primaryKey: false },
  { name: "model", type: "STRING", primaryKey: false },
  { name: "embeddingVector", type: "STRING", primaryKey: false },
  { name: "cardHash", type: "STRING", primaryKey: false },
  { name: "updatedAt", type: "STRING", primaryKey: false },
  { name: "embeddingJinaCodeVec", type: "DOUBLE[768]", primaryKey: false },
  { name: "embeddingNomicVec", type: "DOUBLE[768]", primaryKey: false },
] as const;

function resolveRepoVectorTableName(repoId: string): string {
  return resolveSymbolVectorPhysicalIdentity(repoId, TABLE_IDENTITY_MODEL)
    .tableName;
}

function catalogPrimaryKey(row: RepoVectorCatalogColumnRow): boolean {
  const value = row["primary key"] ?? row.primary_key ?? row.primaryKey;
  return value === true || value === 1 || value === 1n || value === "true";
}

function assertRepoVectorSchema(
  tableName: string,
  rows: RepoVectorCatalogColumnRow[],
): void {
  if (rows.length !== REPO_VECTOR_COLUMNS.length) {
    throw new IndexError(
      `Repository Symbol vector table "${tableName}" has an incompatible schema: expected ${REPO_VECTOR_COLUMNS.length} columns, found ${rows.length}.`,
    );
  }

  const actualByName = new Map<string, RepoVectorCatalogColumnRow>();
  for (const row of rows) {
    if (typeof row.name !== "string" || actualByName.has(row.name)) {
      throw new IndexError(
        `Repository Symbol vector table "${tableName}" has an incompatible schema: invalid or duplicate column metadata.`,
      );
    }
    actualByName.set(row.name, row);
  }

  for (const expected of REPO_VECTOR_COLUMNS) {
    const actual = actualByName.get(expected.name);
    if (
      !actual ||
      typeof actual.type !== "string" ||
      actual.type.toUpperCase() !== expected.type ||
      catalogPrimaryKey(actual) !== expected.primaryKey
    ) {
      throw new IndexError(
        `Repository Symbol vector table "${tableName}" has an incompatible schema at column "${expected.name}".`,
      );
    }
  }
}

/**
 * Inspect one repository table without mutating it. Absence is returned only
 * after SHOW_TABLES succeeds; catalog failures propagate through the raw
 * stored-procedure query path.
 */
export async function inspectRepoSymbolVectorTable(
  conn: Connection,
  repoId: string,
): Promise<RepoSymbolVectorTableInspection> {
  const tableName = resolveRepoVectorTableName(repoId);
  const catalogRows = await queryStoredProcAll<RepoVectorCatalogTableRow>(
    conn,
    "CALL SHOW_TABLES() RETURN name, type",
  );
  const matches = catalogRows.filter((row) => row.name === tableName);
  if (matches.length === 0) return { tableName, state: "absent" };
  if (
    matches.length !== 1 ||
    typeof matches[0]?.type !== "string" ||
    matches[0].type.toUpperCase() !== "NODE"
  ) {
    throw new IndexError(
      `Repository Symbol vector table "${tableName}" has an incompatible catalog identity.`,
    );
  }

  const columns = await queryStoredProcAll<RepoVectorCatalogColumnRow>(
    conn,
    `CALL TABLE_INFO('${tableName}') RETURN *`,
  );
  assertRepoVectorSchema(tableName, columns);
  return { tableName, state: "present" };
}

function assertExclusiveRepoVectorMutation(operation: string): void {
  if (hasCurrentExclusiveLadybugOperation()) return;
  throw new IndexError(
    `${operation} requires exclusive LadybugDB admission before repository vector mutation.`,
  );
}

async function assertRepoOwnership(
  conn: Connection,
  tableName: string,
  repoId: string,
): Promise<void> {
  const foreign = await querySingle<{ repoId: unknown }>(
    conn,
    `MATCH (e:${tableName})
     WHERE e.repoId IS NULL OR e.repoId <> $repoId
     RETURN e.repoId AS repoId
     LIMIT 1`,
    { repoId },
  );
  if (foreign) {
    throw new IndexError(
      `Repository Symbol vector table "${tableName}" violates ownership for repository "${repoId}".`,
    );
  }
}

async function assertMappedVectorOwnership(
  conn: Connection,
  tableName: string,
  repoId: string,
  model: string,
): Promise<void> {
  const vectorProperty = resolveVectorProperty(model);
  const invalid = await querySingle<{ invalid: unknown }>(
    conn,
    `MATCH (e:${tableName})
     WHERE e.repoId IS NULL OR e.repoId <> $repoId
        OR (
          e.${vectorProperty} IS NOT NULL
          AND (
            e.model IS NULL OR e.model <> $model
            OR e.symbolId IS NULL
            OR e.embeddingId IS NULL
            OR e.embeddingId <> $model + ':' + e.symbolId
          )
        )
     RETURN 1 AS invalid
     LIMIT 1`,
    { repoId, model },
  );

  if (invalid !== null) {
    throw new IndexError(
      `Repository Symbol vector table "${tableName}" violates ownership for repository "${repoId}" and model "${model}".`,
    );
  }
}

/**
 * Create or validate the physical vector table for one repository.
 * Callers must hold exclusive admission so schema inspection and DDL cannot
 * race with prepared traffic.
 */
export async function ensureRepoSymbolVectorTable(
  conn: Connection,
  repoId: string,
): Promise<string> {
  assertExclusiveRepoVectorMutation("ensureRepoSymbolVectorTable");
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "present") {
    await assertRepoOwnership(conn, inspection.tableName, repoId);
    return inspection.tableName;
  }

  await execDdl(
    conn,
    `CREATE NODE TABLE ${inspection.tableName} (
       embeddingId STRING PRIMARY KEY,
       repoId STRING,
       symbolId STRING,
       model STRING,
       embeddingVector STRING,
       cardHash STRING,
       updatedAt STRING,
       embeddingJinaCodeVec DOUBLE[768],
       embeddingNomicVec DOUBLE[768]
     )`,
  );
  // DDL invalidates physical plans on every connection, not only this writer.
  resetPreparedStatementCaches();
  return inspection.tableName;
}

export async function validateRepoSymbolVectorOwnership(
  conn: Connection,
  repoId: string,
  model: string,
): Promise<void> {
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") return;
  await assertMappedVectorOwnership(
    conn,
    inspection.tableName,
    repoId,
    model,
  );
}

export async function countCompleteRepoSymbolVectors(
  conn: Connection,
  repoId: string,
  model: string,
): Promise<number> {
  const vectorProperty = resolveVectorProperty(model);
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") return 0;
  const row = await querySingle<{ count: unknown }>(
    conn,
    `MATCH (e:${inspection.tableName})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN count(e.embeddingId) AS count`,
    { repoId, model },
  );
  return toNumber(row?.count);
}

export async function getRepoSymbolVectorEmbedding(
  conn: Connection,
  repoId: string,
  symbolId: string,
  model: string,
): Promise<SymbolVectorEmbeddingRow | null> {
  const vectorProperty = resolveVectorProperty(model);
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") return null;
  const row = await querySingle<{
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (e:${inspection.tableName} {embeddingId: $embeddingId})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN e.embeddingVector AS vector,
            e.cardHash AS cardHash,
            e.updatedAt AS updatedAt`,
    { embeddingId: getEmbeddingId(symbolId, model), repoId, model },
  );
  if (!row || row.vector === null || row.cardHash === null) return null;
  return {
    vector: row.vector,
    cardHash: row.cardHash,
    updatedAt: row.updatedAt ?? "",
  };
}

export async function getRepoSymbolVectorEmbeddings(
  conn: Connection,
  repoId: string,
  symbolIds: string[],
  model: string,
): Promise<Map<string, SymbolVectorEmbeddingRow>> {
  const result = new Map<string, SymbolVectorEmbeddingRow>();
  if (symbolIds.length === 0) return result;
  const vectorProperty = resolveVectorProperty(model);
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") return result;
  const embeddingIds = symbolIds.map((symbolId) =>
    getEmbeddingId(symbolId, model),
  );
  const rows = await queryAll<{
    symbolId: string;
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (e:${inspection.tableName})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.embeddingId IN $embeddingIds
       AND e.embeddingVector IS NOT NULL
       AND e.cardHash IS NOT NULL
       AND e.${vectorProperty} IS NOT NULL
     RETURN e.symbolId AS symbolId,
            e.embeddingVector AS vector,
            e.cardHash AS cardHash,
            e.updatedAt AS updatedAt`,
    { repoId, model, embeddingIds },
  );

  for (const row of rows) {
    if (row.vector === null || row.cardHash === null) continue;
    result.set(row.symbolId, {
      vector: row.vector,
      cardHash: row.cardHash,
      updatedAt: row.updatedAt ?? "",
    });
  }
  return result;
}

export async function deleteRepoSymbolVectorEmbeddingsBySymbolIds(
  conn: Connection,
  repoId: string,
  model: string,
  symbolIds: readonly string[],
): Promise<void> {
  if (symbolIds.length === 0) return;
  assertExclusiveRepoVectorMutation(
    "deleteRepoSymbolVectorEmbeddingsBySymbolIds",
  );
  const inspection = await inspectRepoSymbolVectorTable(conn, repoId);
  if (inspection.state === "absent") return;
  await assertMappedVectorOwnership(
    conn,
    inspection.tableName,
    repoId,
    model,
  );
  await exec(
    conn,
    `MATCH (e:${inspection.tableName})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.symbolId IN $symbolIds
     DELETE e`,
    { repoId, model, symbolIds: [...symbolIds] },
  );
}

export async function setRepoSymbolVectorEmbedding(
  conn: Connection,
  repoId: string,
  symbolId: string,
  model: string,
  vector: string,
  cardHash: string,
  vectorArray: number[],
): Promise<void> {
  await setRepoSymbolVectorEmbeddingBatch(
    conn,
    repoId,
    model,
    [{ symbolId, vector, cardHash, vectorArray }],
  );
}

export async function setRepoSymbolVectorEmbeddingBatch(
  conn: Connection,
  repoId: string,
  model: string,
  items: SymbolVectorEmbeddingBatchItem[],
): Promise<void> {
  if (items.length === 0) return;
  const tableName = await ensureRepoSymbolVectorTable(conn, repoId);
  await assertMappedVectorOwnership(conn, tableName, repoId, model);
  const vectorProperty = resolveVectorProperty(model);
  const updatedAt = new Date().toISOString();
  const rows = items.map((item) => ({
    embeddingId: getEmbeddingId(item.symbolId, model),
    repoId,
    symbolId: item.symbolId,
    model,
    vector: item.vector,
    cardHash: item.cardHash,
    updatedAt,
    vectorArray: item.vectorArray,
  }));

  // Keep replacement as separate autocommits. Indexed vectors cannot be SET
  // in place, and combining DELETE + MERGE in a transaction is unsupported.
  await exec(
    conn,
    `MATCH (e:${tableName})
     WHERE e.repoId = $repoId
       AND e.model = $model
       AND e.symbolId IN $symbolIds
     DELETE e`,
    {
      repoId,
      model,
      symbolIds: rows.map((row) => row.symbolId),
    },
  );
  await exec(
    conn,
    `UNWIND $rows AS r
     MERGE (e:${tableName} {embeddingId: r.embeddingId})
     SET e.repoId = r.repoId,
         e.symbolId = r.symbolId,
         e.model = r.model,
         e.embeddingVector = r.vector,
         e.cardHash = r.cardHash,
         e.updatedAt = r.updatedAt,
         e.${vectorProperty} = r.vectorArray`,
    { rows },
  );
}
