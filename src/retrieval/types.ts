/**
 * Retrieval subsystem types.
 *
 * Defines the core types for hybrid retrieval orchestration, evidence
 * reporting, and capability detection.  Stage 0 establishes the type
 * surface; Stage 1 fills in the runtime implementation.
 */

// ---------------------------------------------------------------------------
// Retrieval source discriminator
// ---------------------------------------------------------------------------

/** Identifies which retrieval backend produced a result. */
export type RetrievalSource =
  | "fts"
  | "vector:minilm"
  | "vector:nomic"
  | "legacyFallback"
  | "overlay";

// ---------------------------------------------------------------------------
// Evidence / diagnostics
// ---------------------------------------------------------------------------

/**
 * Diagnostic evidence attached to a hybrid search response so callers can
 * understand which backends contributed and how the fusion was performed.
 */
export interface RetrievalEvidence {
  /** Which retrieval sources were actually queried. */
  sources: RetrievalSource[];

  /**
   * For each source, the 1-based rank positions of its top contributions
   * in the fused result list (e.g. `{ "fts": [1, 3, 7] }`).
   */
  topRanksPerSource: Record<string, number[]>;

  /** Present when the orchestrator fell back to a simpler path. */
  fallbackReason?: string;

  /** Wall-clock time (ms) spent in the fusion step. */
  fusionLatencyMs?: number;

  /** Number of raw candidates each source produced before fusion. */
  candidateCountPerSource: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Snapshot of which retrieval backends are available at runtime. */
export interface RetrievalCapabilities {
  fts: boolean;
  vectorMiniLM: boolean;
  vectorNomic: boolean;
}

// ---------------------------------------------------------------------------
// Search options / results
// ---------------------------------------------------------------------------

/** Options for the hybrid search orchestrator. */
export interface HybridSearchOptions {
  repoId: string;
  query: string;
  limit: number;
  ftsEnabled?: boolean;
  vectorEnabled?: boolean;
  fusionStrategy?: "rrf";
  rrfK?: number;
  candidateLimit?: number;
  includeEvidence?: boolean;
}

/** A single scored result from hybrid search. */
export interface HybridSearchResultItem {
  symbolId: string;
  score: number;
  source: RetrievalSource;
}

/** Response envelope from the hybrid search orchestrator. */
export interface HybridSearchResult {
  results: HybridSearchResultItem[];
  evidence?: RetrievalEvidence;
}

// ---------------------------------------------------------------------------
// Entity search types (Stage 3)
// ---------------------------------------------------------------------------

/**
 * Discriminator for the entity kinds supported by multi-entity hybrid search.
 * "symbol" corresponds to the existing Symbol node; the rest are Stage 3 additions.
 */
export type EntityType =
  | "symbol"
  | "memory"
  | "cluster"
  | "process"
  | "fileSummary";

/** A single scored result from multi-entity hybrid search. */
export interface EntitySearchResultItem {
  entityType: EntityType;
  /** The primary-key field of the entity (symbolId / memoryId / clusterId / processId / fileId). */
  entityId: string;
  score: number;
  source: RetrievalSource;
}

/** Response envelope from the multi-entity hybrid search orchestrator. */
export interface EntitySearchResult {
  results: EntitySearchResultItem[];
  evidence?: RetrievalEvidence;
}

/** Options for the multi-entity hybrid search orchestrator. */
export interface EntitySearchOptions {
  repoId: string;
  query: string;
  limit: number;
  /** Which entity types to search.  Defaults to all supported types. */
  entityTypes?: EntityType[];
  ftsEnabled?: boolean;
  vectorEnabled?: boolean;
  fusionStrategy?: "rrf";
  rrfK?: number;
  candidateLimit?: number;
  includeEvidence?: boolean;
}
