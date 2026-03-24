/**
 * Retrieval fallback and health checking.
 *
 * Provides capability detection for the retrieval subsystem and the
 * decision logic that determines whether the hybrid pipeline can run
 * or the system should fall back to the legacy search path.
 */

import { getExtensionCapabilities } from "../db/ladybug.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import type { RetrievalCapabilities } from "./types.js";

// ---------------------------------------------------------------------------
// Health / capability detection
// ---------------------------------------------------------------------------

/**
 * Probe the current runtime to determine which retrieval backends are
 * available.
 *
 * For Stage 0 the vector-model checks use the extension capability as a
 * proxy (i.e. "vector extension loaded" implies both MiniLM and Nomic
 * *could* be used).  Stage 1 will refine this to check whether real
 * vector indexes actually exist for each model.
 *
 * @param _repoId - Repository ID (reserved for per-repo index checks in Stage 1).
 */
export async function checkRetrievalHealth(
  _repoId: string,
): Promise<RetrievalCapabilities> {
  const caps = getExtensionCapabilities();

  return {
    fts: caps.fts,
    // Stage 0 proxy: if the vector extension loaded, assume both model
    // indexes *could* exist.  Stage 1 will query for actual indexes.
    vectorMiniLM: caps.vector,
    vectorNomic: caps.vector,
  };
}

// ---------------------------------------------------------------------------
// Fallback decision
// ---------------------------------------------------------------------------

/**
 * Determine whether the system should fall back to the legacy (non-hybrid)
 * search path.
 *
 * Returns `true` (use legacy) when:
 * - The configured mode is explicitly `"legacy"`, OR
 * - The configured mode is `"hybrid"` but the required capabilities are
 *   not available (e.g. FTS extension failed to load).
 *
 * Returns `false` (use hybrid) when mode is `"hybrid"` and at least the
 * FTS capability is present (vector is optional for a degraded hybrid run).
 */
export function shouldFallbackToLegacy(
  caps: RetrievalCapabilities,
  config: SemanticRetrievalConfig,
): boolean {
  // Explicit legacy mode -- always fall back.
  if (config.mode === "legacy") {
    return true;
  }

  // Hybrid mode requested but FTS is unavailable -- cannot run the
  // minimum viable hybrid pipeline.
  if (!caps.fts) {
    return true;
  }

  // Hybrid mode with at least FTS available -- proceed with hybrid.
  // (Missing vector backends will simply contribute zero candidates.)
  return false;
}
