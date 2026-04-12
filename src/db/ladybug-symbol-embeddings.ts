/**
 * ladybug-symbol-embeddings.ts - Model-aware Symbol node embedding helpers
 *
 * Reads/writes embedding data directly on the Symbol node using model-specific
 * property names (e.g., embeddingJinaCode, embeddingJinaCodeCardHash, embeddingJinaCodeUpdatedAt).
 *
 * These helpers replace the legacy SymbolEmbedding-table-based functions in
 * ladybug-embeddings.ts for the hybrid retrieval pipeline.
 */
import type { Connection } from "kuzu";
import { exec, queryAll, querySingle } from "./ladybug-core.js";
import {
  getEmbeddingPropertyName,
  getVecPropertyName,
  getCardHashPropertyName,
  getUpdatedAtPropertyName,
} from "../retrieval/model-mapping.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape returned by the Symbol-node embedding read helpers. */
export interface SymbolNodeEmbeddingRow {
  vector: string;
  cardHash: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal: build trusted property names
// ---------------------------------------------------------------------------

/**
 * Resolve property names for a model or throw if the model is unknown.
 * Property names come from a trusted internal mapping (not user input),
 * so interpolating them into Cypher is safe.
 */
function resolvePropertyNames(model: string): {
  vectorProp: string;
  vecProp: string | null;
  cardHashProp: string;
  updatedAtProp: string;
} {
  const vectorProp = getEmbeddingPropertyName(model);
  const cardHashProp = getCardHashPropertyName(model);
  const updatedAtProp = getUpdatedAtPropertyName(model);

  const vecProp = getVecPropertyName(model);
  if (!vectorProp || !cardHashProp || !updatedAtProp) {
    throw new Error(
      `Unknown embedding model "${model}": cannot resolve Symbol node property names`,
    );
  }

  // Validate property names before they are interpolated into Cypher queries
  const SAFE_PROP = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
  for (const [label, value] of Object.entries({ vectorProp, cardHashProp, updatedAtProp })) {
    if (!SAFE_PROP.test(value)) {
      throw new Error(
        `Unsafe Cypher property name for ${label}: "${value}"`,
      );
    }
  }

  return { vectorProp, vecProp, cardHashProp, updatedAtProp };
}

// ---------------------------------------------------------------------------
// Read: single symbol
// ---------------------------------------------------------------------------

/**
 * Read the embedding vector, card hash, and updatedAt timestamp for a single
 * symbol from the Symbol node properties for the given model.
 *
 * Returns `null` if the symbol does not exist or has no embedding stored for
 * the requested model.
 */
export async function getSymbolEmbeddingFromNode(
  conn: Connection,
  symbolId: string,
  model: string,
): Promise<SymbolNodeEmbeddingRow | null> {
  const { vectorProp, vecProp: _vecProp, cardHashProp, updatedAtProp } =
    resolvePropertyNames(model);

  // Property names come from the trusted EMBEDDING_MODELS registry, so
  // interpolation is safe here. Kuzu does not support parameterised property
  // names in RETURN clauses.
  const row = await querySingle<{
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     RETURN s.${vectorProp} AS vector,
            s.${cardHashProp} AS cardHash,
            s.${updatedAtProp} AS updatedAt`,
    { symbolId },
  );

  if (!row || !row.vector) {
    return null;
  }

  return {
    vector: row.vector,
    cardHash: row.cardHash ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Write: single symbol
// ---------------------------------------------------------------------------

/**
 * Write (or overwrite) the embedding vector, card hash, and updatedAt
 * timestamp on the Symbol node for the given model.
 */
export async function setSymbolEmbeddingOnNode(
  conn: Connection,
  symbolId: string,
  model: string,
  vector: string,
  cardHash: string,
  vectorArray?: number[],
): Promise<void> {
  const { vectorProp, vecProp, cardHashProp, updatedAtProp } =
    resolvePropertyNames(model);

  const updatedAt = new Date().toISOString();

  await exec(
    conn,
    `MATCH (s:Symbol {symbolId: $symbolId})
     SET s.${vectorProp} = $vector,
         s.${cardHashProp} = $cardHash,
         s.${updatedAtProp} = $updatedAt`,
    { symbolId, vector, cardHash, updatedAt },
  );

  // Also write to the numeric DOUBLE[] column for vector indexing
  if (vectorArray && vecProp) {
    await exec(
      conn,
      `MATCH (s:Symbol {symbolId: $symbolId})
       SET s.${vecProp} = $vectorArray`,
      { symbolId, vectorArray },
    );
  }
}

// ---------------------------------------------------------------------------
// Read: batch
// ---------------------------------------------------------------------------

/**
 * Batch-read embedding data from Symbol nodes for multiple symbols.
 *
 * Returns a Map keyed by symbolId. Symbols that do not exist or lack an
 * embedding for the requested model are omitted from the result.
 */
export async function getSymbolEmbeddingsFromNodes(
  conn: Connection,
  symbolIds: string[],
  model: string,
): Promise<Map<string, SymbolNodeEmbeddingRow>> {
  const result = new Map<string, SymbolNodeEmbeddingRow>();

  if (symbolIds.length === 0) {
    return result;
  }

  const { vectorProp, vecProp: _vecProp2, cardHashProp, updatedAtProp } =
    resolvePropertyNames(model);

  // Batch query: filter symbols that have a non-null vector property.
  const rows = await queryAll<{
    symbolId: string;
    vector: string | null;
    cardHash: string | null;
    updatedAt: string | null;
  }>(
    conn,
    `MATCH (s:Symbol)
     WHERE s.symbolId IN $symbolIds
       AND s.${vectorProp} IS NOT NULL
     RETURN s.symbolId AS symbolId,
            s.${vectorProp} AS vector,
            s.${cardHashProp} AS cardHash,
            s.${updatedAtProp} AS updatedAt`,
    { symbolIds },
  );

  for (const row of rows) {
    if (!row.vector) continue;
    result.set(row.symbolId, {
      vector: row.vector,
      cardHash: row.cardHash ?? "",
      updatedAt: row.updatedAt ?? "",
    });
  }

  logger.debug("getSymbolEmbeddingsFromNodes: loaded embeddings from Symbol nodes", {
    model,
    requested: symbolIds.length,
    found: result.size,
  });

  return result;
}
