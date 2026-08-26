/** Model-aware storage helpers for the dedicated SymbolVectorEmbedding table. */
import type { Connection } from "kuzu";

import {
  getVecPropertyName,
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

const SAFE_PROPERTY_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function resolveVectorProperty(model: string): string {
  const vectorProperty = getVecPropertyName(model);
  if (!vectorProperty) {
    throw new Error(
      `Unknown embedding model "${model}": cannot resolve vector property`,
    );
  }
  if (!SAFE_PROPERTY_NAME.test(vectorProperty)) {
    throw new Error(`Unsafe Cypher property name: "${vectorProperty}"`);
  }
  return vectorProperty;
}

function getEmbeddingId(symbolId: string, model: string): string {
  return `${model}:${symbolId}`;
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
  const vectorProperty = resolveVectorProperty(model);
  await exec(
    conn,
    `MERGE (e:${SYMBOL_VECTOR_EMBEDDING_TABLE} {embeddingId: $embeddingId})
     SET e.repoId = $repoId,
         e.symbolId = $symbolId,
         e.model = $model,
         e.embeddingVector = $vector,
         e.cardHash = $cardHash,
         e.updatedAt = $updatedAt,
         e.${vectorProperty} = $vectorArray`,
    {
      embeddingId: getEmbeddingId(symbolId, model),
      repoId,
      symbolId,
      model,
      vector,
      cardHash,
      updatedAt: new Date().toISOString(),
      vectorArray,
    },
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
