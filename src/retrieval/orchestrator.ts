/**
 * Hybrid retrieval orchestrator (stub).
 *
 * Stage 0: establishes the function signature and module boundary.
 * Stage 1 will fill in FTS query, vector query, and RRF fusion logic.
 */

import type { HybridSearchOptions, HybridSearchResult } from "./types.js";

/**
 * Execute a hybrid search combining FTS and vector retrieval with RRF fusion.
 *
 * **Stage 0 stub** -- always throws.  Use the legacy search path until
 * Stage 1 provides the real implementation.
 *
 * @throws {Error} Always -- hybrid retrieval is not yet implemented.
 */
export async function hybridSearch(
  _options: HybridSearchOptions,
): Promise<HybridSearchResult> {
  throw new Error(
    "Hybrid retrieval not yet implemented \u2014 use legacy search path",
  );
}
