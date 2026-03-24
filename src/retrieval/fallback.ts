/**
 * Retrieval fallback and health checking.
 *
 * Provides capability detection for the retrieval subsystem and the
 * decision logic that determines whether the hybrid pipeline can run
 * or the system should fall back to the legacy search path.
 */

import { getExtensionCapabilities, getLadybugConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import type { RetrievalCapabilities } from "./types.js";
import { checkIndexHealth } from "./index-lifecycle.js";

// ---------------------------------------------------------------------------
// Health / capability detection
// ---------------------------------------------------------------------------

/**
 * Probe the current runtime to determine which retrieval backends are
 * available.
 *
 * Fast path: if the underlying extension is not loaded the corresponding
 * index cannot exist, so we short-circuit to `false` without hitting the
 * database.  When the extension *is* loaded we query the actual FTS and
 * vector indexes via {@link checkIndexHealth} so the returned capabilities
 * reflect reality rather than just theoretical availability.
 *
 * If the index health check fails for any reason (e.g. the DB is not
 * initialised yet) we fall back to the extension-based proxy so the
 * caller still gets a best-effort answer.
 *
 * @param _repoId - Repository ID (reserved for future per-repo index scoping).
 */
export async function checkRetrievalHealth(
  _repoId: string,
): Promise<RetrievalCapabilities> {
  const caps = getExtensionCapabilities();

  // Fast path: if neither extension is loaded, indexes cannot exist.
  if (!caps.fts && !caps.vector) {
    return {
      fts: false,
      vectorMiniLM: false,
      vectorNomic: false,
    };
  }

  // Extension(s) available — query for real index existence.
  try {
    const conn = await getLadybugConn();
    const health = await checkIndexHealth(conn);

    // Derive per-model vector availability from the health result.
    let vectorMiniLM = false;
    let vectorNomic = false;

    for (const v of health.vectors) {
      if (v.model === "all-MiniLM-L6-v2") {
        vectorMiniLM = v.exists;
      } else if (v.model === "nomic-embed-text-v1.5") {
        vectorNomic = v.exists;
      }
    }

    return {
      fts: health.fts.exists,
      vectorMiniLM,
      vectorNomic,
    };
  } catch (err) {
    // Index health check failed — fall back to extension-based proxy
    // so we don’t block startup or degrade the caller.
    logger.warn(
      `[retrieval] checkIndexHealth failed, falling back to extension proxy: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );

    return {
      fts: caps.fts,
      vectorMiniLM: caps.vector,
      vectorNomic: caps.vector,
    };
  }
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
