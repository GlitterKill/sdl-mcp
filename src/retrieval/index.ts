/**
 * Retrieval subsystem barrel export.
 *
 * Re-exports all public APIs from the retrieval subsystem modules.
 */

// Types
export type {
  RetrievalSource,
  RetrievalEvidence,
  RetrievalCapabilities,
  HybridSearchOptions,
  HybridSearchResultItem,
  HybridSearchResult,
} from "./types.js";

// Model mapping
export {
  EMBEDDING_MODELS,
  getEmbeddingPropertyName,
  getCardHashPropertyName,
  getUpdatedAtPropertyName,
  getVectorIndexName,
} from "./model-mapping.js";
export type { EmbeddingModelInfo } from "./model-mapping.js";

// Orchestrator (stub in Stage 0)
export { hybridSearch } from "./orchestrator.js";

// Fallback / health
export {
  checkRetrievalHealth,
  shouldFallbackToLegacy,
} from "./fallback.js";
// Index lifecycle
export {
  createFtsIndex,
  createVectorIndex,
  showIndexes,
  checkIndexHealth,
  ensureIndexes,
} from "./index-lifecycle.js";
export type {
  IndexInfo,
  IndexHealthResult,
  IndexEnsureResult,
} from "./index-lifecycle.js";
