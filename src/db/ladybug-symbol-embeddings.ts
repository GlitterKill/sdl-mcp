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
import { exec, queryAll, querySingle } from "./ladybug-core.js";

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
