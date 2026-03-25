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
  EntityType,
  EntitySearchOptions,
  EntitySearchResultItem,
  EntitySearchResult,
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
export { hybridSearch, entitySearch } from "./orchestrator.js";
// Feedback boosting
export {
  mergeFeedbackBoosts,
  queryFeedbackBoosts,
} from "./feedback-boost.js";
export type {
  FeedbackBoostResult,
  FeedbackBoostOptions,
} from "./feedback-boost.js";

// Fallback / health
export {
  checkRetrievalHealth,
  shouldFallbackToLegacy,
  isHybridRetrievalAvailable,
} from "./fallback.js";
// Index lifecycle
export {
  createFtsIndex,
  createVectorIndex,
  showIndexes,
  checkIndexHealth,
  ensureIndexes,
  ensureEntityIndexes,
  ENTITY_FTS_INDEX_NAMES,
  FILESUMMARY_VECTOR_INDEX_NAMES,
  FILESUMMARY_EMBEDDING_PROPERTIES,
} from "./index-lifecycle.js";
export type {
  IndexInfo,
  IndexHealthResult,
  IndexEnsureResult,
  EntityIndexHealth,
} from "./index-lifecycle.js";

// Evidence classification
export { classifySymptomType } from "./evidence.js";

// AgentFeedback index constants
export {
  AGENTFEEDBACK_VECTOR_INDEX_NAMES,
  AGENTFEEDBACK_EMBEDDING_PROPERTIES,
} from "./index-lifecycle.js";
