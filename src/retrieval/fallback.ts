/**
 * Retrieval fallback and health checking.
 *
 * Provides capability detection for the retrieval subsystem and the
 * decision logic that determines whether the hybrid pipeline can run
 * or the system should fall back to the legacy search path.
 */

import { getExtensionCapabilities, getLadybugConn } from "../db/ladybug.js";
import { logger } from "../util/logger.js";
import { loadConfig } from "../config/loadConfig.js";
import type { SemanticRetrievalConfig } from "../config/types.js";
import type { RetrievalCapabilities, DegradationReason } from "./types.js";
import { checkIndexHealth } from "./index-lifecycle.js";
/** Build structured degradation reasons from index health data. */
function buildDegradationReasons(
  health: { fts: { exists: boolean }; vectors: Array<{ model: string; exists: boolean }> },
  caps: { fts: boolean; vector: boolean },
): DegradationReason[] {
  const reasons: DegradationReason[] = [];
  if (!caps.fts) {
    reasons.push({ code: "fts-extension-unavailable", message: "FTS extension not loaded", affects: "fts" });
  } else if (!health.fts.exists) {
    reasons.push({ code: "fts-index-missing", message: "FTS index not found in database", affects: "fts" });
  }
  if (!caps.vector) {
    reasons.push({ code: "vector-extension-unavailable", message: "Vector extension not loaded", affects: "vector" });
  } else {
    for (const v of health.vectors) {
      if (!v.exists) {
        reasons.push({ code: "vector-index-missing", message: "Vector index missing for model " + v.model, affects: "vector" });
      }
    }
  }
  return reasons;
}


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
  _repoId?: string,
): Promise<RetrievalCapabilities> {
  const caps = getExtensionCapabilities();

  // Fast path: if neither extension is loaded, indexes cannot exist.
  if (!caps.fts && !caps.vector) {
    return {
      fts: false,
      vectorNomic: false,
      vectorJinaCode: false,
      degradationReasons: [
        { code: "fts-extension-unavailable", message: "FTS extension not loaded", affects: "fts" },
        { code: "vector-extension-unavailable", message: "Vector extension not loaded", affects: "vector" },
      ],
    };
  }

  // Extension(s) available — query for real index existence.
  try {
    const conn = await getLadybugConn();
    const health = await checkIndexHealth(conn);

    // Derive per-model vector availability from the health result.
    let vectorNomic = false;
    let vectorJinaCode = false;

    for (const v of health.vectors) {
      if (v.model === "nomic-embed-text-v1.5") {
        vectorNomic = v.exists;
      } else if (v.model === "jina-embeddings-v2-base-code") {
        vectorJinaCode = v.exists;
      }
    }

    return {
      fts: health.fts.exists,
      vectorNomic,
      vectorJinaCode,
      degradationReasons: buildDegradationReasons(health, caps),
    };
  } catch (err) {
    // Index health check failed — fall back to extension-based proxy
    // so we don't block startup or degrade the caller.
    logger.warn(
      `[retrieval] checkIndexHealth failed, falling back to extension proxy: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );

    return {
      fts: caps.fts,
      vectorNomic: caps.vector,
      vectorJinaCode: caps.vector,
      degradationReasons: [{ code: "health-check-error", message: err instanceof Error ? err.message : String(err), affects: "all" }],
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
 *
 * When `health` is provided and the configured mode is `"legacy"`, the
 * function can auto-flip to hybrid if infrastructure is healthy (FTS +
 * at least one real-model vector index).
 */
export function shouldFallbackToLegacy(
  caps: RetrievalCapabilities,
  config: SemanticRetrievalConfig,
): boolean {
  // Explicit legacy mode -- always use legacy path.
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

// ---------------------------------------------------------------------------
// Auto-flip detection for Stage 2
// ---------------------------------------------------------------------------

/**
 * Check whether hybrid retrieval infrastructure is healthy enough to use.
 * Used by Stage 2 start-node resolution to decide between hybrid and legacy paths.
 * Auto-promotes from legacy to hybrid when:
 * - semantic.enabled is true
 * - FTS index exists
 * - At least one real-model vector index exists
 */
export async function isHybridRetrievalAvailable(): Promise<boolean> {
  try {
    const config = loadConfig();
    const semanticConfig = config.semantic;
    if (!semanticConfig?.enabled) return false;

    const retrievalConfig = semanticConfig.retrieval;

    // Explicit hybrid mode — just check basic capabilities.
    if (retrievalConfig?.mode === "hybrid") {
      const caps = getExtensionCapabilities();
      return caps.fts;
    }

    // Legacy mode — auto-promote when infrastructure is healthy.
    const health = await checkRetrievalHealth();
    return health.fts && (health.vectorNomic || health.vectorJinaCode);
  } catch {
    return false;
  }
}