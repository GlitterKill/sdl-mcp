/**
 * Model-to-property/index mapping.
 *
 * Single source of truth for translating embedding model names into the
 * LadybugDB Symbol node property names, card-hash property names, and
 * vector index names used by the retrieval subsystem.
 *
 * Unknown models always return `null` so callers can degrade gracefully.
 */

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/** Metadata for a supported embedding model. */
export interface EmbeddingModelInfo {
  /** Dimensionality of the embedding vector. */
  dimension: number;
  /** Prefix used to derive Symbol node property names. */
  propertyPrefix: string;
}

/**
 * Canonical registry of supported embedding models.
 * Add new models here; every other helper derives from this map.
 */
export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModelInfo>> = {
  "all-MiniLM-L6-v2": { dimension: 384, propertyPrefix: "embeddingMiniLM" },
  "nomic-embed-text-v1.5": { dimension: 768, propertyPrefix: "embeddingNomic" },
} as const;

// ---------------------------------------------------------------------------
// Property name helpers
// ---------------------------------------------------------------------------

/**
 * Return the Symbol node property name that stores the embedding vector for
 * the given model, or `null` if the model is not recognised.
 *
 * @example getEmbeddingPropertyName("all-MiniLM-L6-v2") // "embeddingMiniLM"
 */
export function getEmbeddingPropertyName(model: string): string | null {
  const info = EMBEDDING_MODELS[model];
  return info ? info.propertyPrefix : null;
}

/**
 * Return the Symbol node property name that stores the card-content hash
 * used to detect stale embeddings, or `null` for unknown models.
 *
 * @example getCardHashPropertyName("all-MiniLM-L6-v2") // "embeddingMiniLMCardHash"
 */
export function getCardHashPropertyName(model: string): string | null {
  const info = EMBEDDING_MODELS[model];
  return info ? `${info.propertyPrefix}CardHash` : null;
}

/**
 * Return the Symbol node property name that stores the timestamp of the
 * last embedding update, or `null` for unknown models.
 *
 * @example getUpdatedAtPropertyName("all-MiniLM-L6-v2") // "embeddingMiniLMUpdatedAt"
 */
export function getUpdatedAtPropertyName(model: string): string | null {
  const info = EMBEDDING_MODELS[model];
  return info ? `${info.propertyPrefix}UpdatedAt` : null;
}

// ---------------------------------------------------------------------------
// Vector index name helper
// ---------------------------------------------------------------------------

/**
 * Return the deterministic vector index name for the given model, or `null`
 * for unknown models.  Index names are lowercase with underscores to stay
 * compatible with LadybugDB naming rules.
 *
 * @example getVectorIndexName("all-MiniLM-L6-v2") // "symbol_vec_embeddingminilm"
 */
export function getVectorIndexName(model: string): string | null {
  const info = EMBEDDING_MODELS[model];
  return info ? `symbol_vec_${info.propertyPrefix.toLowerCase()}` : null;
}
