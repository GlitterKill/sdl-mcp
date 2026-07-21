/**
 * ladybug-queries.ts � Barrel re-export for backward compatibility
 *
 * This file was split into domain-specific modules as part of the v0.8.0 refactor.
 * All 62 importers continue to work unchanged via this barrel.
 *
 * Domain modules:
 *   ladybug-core.ts       � Shared helpers (exec, queryAll, querySingle, toNumber, etc.)
 *   ladybug-repos.ts      � Repository & File operations
 *   ladybug-symbols.ts    � Symbol operations
 *   ladybug-edges.ts      � Edge (dependency) operations
 *   ladybug-versions.ts   � Version & snapshot operations
 *   ladybug-slices.ts     � Slice handle operations
 *   ladybug-metrics.ts    � Metrics operations
 *   ladybug-feedback.ts   � Audit & agent feedback operations
 *   ladybug-embeddings.ts � Symbol embeddings, summary cache, sync artifacts, symbol references
 *   ladybug-config.ts     � Tool policy & tsconfig hash operations
 *   ladybug-clusters.ts   � Cluster operations
 *   ladybug-processes.ts   Process operations
 *   ladybug-file-summaries.ts FileSummary operations
 *   ladybug-scip.ts          SCIP ingestion operations
 *   ladybug-semantic.ts      Semantic enrichment provider run operations
 */

// Core helpers
export {
  exec,
  queryAll,
  querySingle,
  toNumber,
  toBoolean,
  withTransaction,
  assertSafeInt,
  getPreparedStatement,
} from "./ladybug-core.js";
export * from "./ladybug-batching.js";

// Repository & File operations
export * from "./ladybug-repos.js";

// Symbol operations
export * from "./ladybug-symbols.js";

// Edge operations
export * from "./ladybug-edges.js";

// Version operations
export * from "./ladybug-versions.js";

// Slice handle operations
export * from "./ladybug-slices.js";

// Metrics operations
export * from "./ladybug-metrics.js";

// Audit & agent feedback operations
export * from "./ladybug-feedback.js";

// Legacy SymbolEmbedding compatibility CRUD, summary cache, sync artifacts, and symbol references.
export * from "./ladybug-embeddings.js";

// Model-aware Symbol node embedding helpers (replaces SymbolEmbedding table access)
export * from "./ladybug-symbol-embeddings.js";

// Tool policy & tsconfig hash operations
export * from "./ladybug-config.js";

// Cluster operations
export * from "./ladybug-clusters.js";

// Process operations
export * from "./ladybug-processes.js";

// Memory operations
export * from "./ladybug-memory.js";

// Usage snapshot operations
export * from "./ladybug-usage.js";

// FileSummary operations
export * from "./ladybug-file-summaries.js";


// Predictive prefetch outcome operations
export * from "./ladybug-prefetch-outcomes.js";

// SCIP ingestion operations
export * from "./ladybug-scip.js";
// Semantic enrichment operations
export * from "./ladybug-semantic.js";

// Graph algorithm adapter (PageRank, K-core, Louvain, shortest-path)
export * from "./ladybug-algorithms.js";
export {
  advanceGraphIntegrityRevisionInTransaction,
  beginGraphIntegrityVersion,
  graphIntegrityIsAvailableForVersion,
  graphIntegrityIsVerifiedForVersion,
  listPendingGraphIntegrityRevisions,
  markCurrentGraphIntegrityRevisionFailed,
  markGraphIntegrityFailedIfVerifying,
  markGraphIntegrityVerifiedIfVerifying,
  type GraphIntegrityPendingRevision,
} from "./ladybug-derived-state.js";
// Shadow cluster (Louvain) operations
export * from "./ladybug-shadow-clusters.js";

// New db modules must use named exports here; do not add more `export *` lines.
export {
  finalizeProviderFirstShadowDb,
  type FinalizeProviderFirstShadowDbParams,
  type ProviderFirstShadowFinalizationBulkArtifact,
  type ProviderFirstShadowFinalizationBulkLoadSummary,
  type ProviderFirstShadowFinalizationCounts,
  type ProviderFirstShadowFinalizationStatus,
  type ProviderFirstShadowFinalizationSummary,
} from "./ladybug-shadow-finalization.js";
export {
  copyProviderFirstArtifact,
  deleteProviderReplacementSymbols,
  readLegacyFallbackEdges,
  readLegacyFallbackFiles,
  readLegacyFallbackSymbols,
  readProviderFirstShadowDbCounts,
  type LegacyFallbackEdgeDbRow,
  type LegacyFallbackFileDbRow,
  type LegacyFallbackSymbolDbRow,
  type ProviderFirstCopyArtifact,
  type ProviderFirstShadowDbCounts,
} from "./ladybug-provider-first.js";
export {
  rewriteResolvedImportEdges,
  type ResolvedImportEdgeRewriteRow,
} from "./ladybug-unresolved-imports.js";
export {
  getClusterLayoutInputRows,
  getNeighborSymbolIds,
  getSymbolLayoutInputRows,
  loadGraphNeighborhoodRows,
  type GraphLayoutInputRows,
  type GraphNeighborhoodEdgeRow,
} from "./ladybug-graph-read.js";
export {
  computeGalaxy,
  fnv1a32,
  getClusterEdges,
  getClusterIdsForSymbols,
  getClusters,
  getSymbolCard,
  getSymbolEdges,
  getUniverse,
  viewerSettingsSnapshot,
} from "./ladybug-viewer.js";
export {
  findRetrievalSeedSymbolsByIdPrefix,
  findRetrievalSeedSymbolsByName,
  hasRetrievalSeedSymbol,
  type RetrievalSeedCandidateRow,
} from "./ladybug-retrieval.js";
export { countRowsInNodeTable } from "./ladybug-index-lifecycle.js";
export {
  getPersistedGraphIntegrityFileReferenceCounts,
  getPersistedGraphIntegrityOtherRepoSymbolCount,
  getPersistedGraphIntegrityReferenceCountPage,
  getPersistedGraphIntegritySourceReferenceCounts,
  getPersistedGraphIntegritySymbolPage,
  hasPersistedGraphIntegrityFilelessSourceReferences,
  type GraphIntegritySymbolCursor,
  type PersistedGraphIntegrityFileReferenceCount,
  type PersistedGraphIntegrityReferenceCount,
  type PersistedGraphIntegrityReferenceCountCursor,
  type PersistedGraphIntegritySourceReferenceCount,
  type PersistedGraphIntegritySymbolRow,
} from "./ladybug-graph-integrity.js";
