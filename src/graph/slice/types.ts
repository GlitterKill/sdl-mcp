// =============================================================================
// graph/slice/types.ts — Internal slice-builder request/result types.
//
// Public exports:
//   - SliceBuildInternalResult
//   - SliceBuildRequest
// =============================================================================

import type { Connection } from "kuzu";
import type { RepoId, SymbolId, VersionId } from "../../domain/types.js";
import type { SliceBudget, GraphSlice, CardDetailLevel } from "../../domain/types.js";
import type { RetrievalEvidence, HybridSearchResultItem } from "../../retrieval/types.js";

export interface SliceBuildInternalResult {
  slice: GraphSlice;
  retrievalEvidence?: RetrievalEvidence;
  /** Per-symbol hybrid search items (score + source). Present when hybrid retrieval was used. */
  hybridSearchItems?: HybridSearchResultItem[];
}

export interface SliceBuildRequest {
  repoId: RepoId;
  versionId: VersionId;
  /**
   * Optional Ladybug connection override (primarily for tests).
   * Not exposed via MCP tool schemas.
   */
  conn?: Connection;
  taskText?: string;
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  entrySymbols?: SymbolId[];
  knownCardEtags?: Record<SymbolId, string>;
  cardDetail?: CardDetailLevel;
  adaptiveDetail?: boolean;
  budget?: SliceBudget;
  minConfidence?: number;
  minCallConfidence?: number;
  includeResolutionMetadata?: boolean;
  signal?: AbortSignal;
}
