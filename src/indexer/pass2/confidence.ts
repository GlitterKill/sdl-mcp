/**
 * Centralized call-resolution confidence rubric (Phase 2 Task 2.0.1).
 *
 * Each named tier corresponds to a `CallResolutionStrategy`. The mapping
 * `CONFIDENCE_NEW` is the new Phase-2 rubric. `CONFIDENCE_LEGACY` is the
 * pre-Phase-2 set of literals scattered across the per-language resolvers.
 *
 * Behavior is gated by the env flag `SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC`.
 * When unset, `confidenceFor()` returns the legacy value so edge weights
 * remain byte-for-byte identical to the pre-Phase-2 snapshot. When set,
 * the new rubric is returned. Audit events emit BOTH values via
 * `confidenceForBoth()` so drift can be measured for one release before
 * the legacy code path is dropped in Task 2.11.2.
 */

/**
 * Canonical strategy enum. Per-language resolvers must record their
 * resolution under one of these names rather than freeform strings so
 * that the rubric and telemetry buckets line up.
 */
export type CallResolutionStrategy =
  | "compiler-resolved"
  | "import-direct"
  | "import-aliased"
  | "import-barrel"
  | "same-file-lexical"
  | "cross-file-name-unique"
  | "cross-file-name-ambiguous"
  | "receiver-this"
  | "receiver-self"
  | "receiver-type"
  | "namespace-qualified"
  | "module-qualified"
  | "package-qualified"
  | "header-pair"
  | "psr4-autoload"
  | "extension-method"
  | "trait-default"
  | "inheritance-method"
  | "function-pointer"
  | "global-preferred"
  | "global-fallback"
  | "builtin-or-global"
  | "heuristic-only"
  | "disambiguated";

/**
 * Phase-2 rubric. Seven coarse tiers; per-strategy assignment maps each
 * canonical strategy to one tier. Designed so calling code can think in
 * terms of "how confident am I" without coupling to a specific language's
 * heuristic name.
 */
export const CallConfidence = {
  COMPILER_RESOLVED: 1.0,
  IMPORT_DIRECT: 0.9,
  SAME_FILE_LEXICAL: 0.7,
  CROSS_FILE_NAME_UNIQUE: 0.65,
  CROSS_FILE_NAME_AMBIGUOUS: 0.45,
  BUILTIN_OR_GLOBAL: 0.3,
  HEURISTIC_ONLY: 0.2,
} as const;

export type CallConfidenceTier =
  (typeof CallConfidence)[keyof typeof CallConfidence];

const CONFIDENCE_NEW: Record<CallResolutionStrategy, number> = {
  "compiler-resolved": CallConfidence.COMPILER_RESOLVED,
  "import-direct": CallConfidence.IMPORT_DIRECT,
  "import-aliased": CallConfidence.IMPORT_DIRECT,
  "import-barrel": CallConfidence.IMPORT_DIRECT,
  "same-file-lexical": CallConfidence.SAME_FILE_LEXICAL,
  "cross-file-name-unique": CallConfidence.CROSS_FILE_NAME_UNIQUE,
  "cross-file-name-ambiguous": CallConfidence.CROSS_FILE_NAME_AMBIGUOUS,
  "receiver-this": CallConfidence.SAME_FILE_LEXICAL,
  "receiver-self": CallConfidence.SAME_FILE_LEXICAL,
  "receiver-type": CallConfidence.CROSS_FILE_NAME_UNIQUE,
  "namespace-qualified": CallConfidence.IMPORT_DIRECT,
  "module-qualified": CallConfidence.IMPORT_DIRECT,
  "package-qualified": CallConfidence.IMPORT_DIRECT,
  "header-pair": CallConfidence.CROSS_FILE_NAME_UNIQUE,
  "psr4-autoload": CallConfidence.IMPORT_DIRECT,
  "extension-method": CallConfidence.CROSS_FILE_NAME_UNIQUE,
  "trait-default": CallConfidence.CROSS_FILE_NAME_UNIQUE,
  "inheritance-method": CallConfidence.SAME_FILE_LEXICAL,
  "function-pointer": CallConfidence.CROSS_FILE_NAME_AMBIGUOUS,
  "global-preferred": CallConfidence.BUILTIN_OR_GLOBAL,
  "global-fallback": CallConfidence.BUILTIN_OR_GLOBAL,
  "builtin-or-global": CallConfidence.BUILTIN_OR_GLOBAL,
  "heuristic-only": CallConfidence.HEURISTIC_ONLY,
  "disambiguated": CallConfidence.CROSS_FILE_NAME_AMBIGUOUS,
};

/**
 * Pre-Phase-2 literal values. These are what the per-language resolvers
 * historically wrote into edge rows. Sweep this map whenever a new
 * strategy is added so the legacy path stays comparable.
 */
const CONFIDENCE_LEGACY: Record<CallResolutionStrategy, number> = {
  "compiler-resolved": 0.95,
  "import-direct": 0.9,
  "import-aliased": 0.88,
  "import-barrel": 0.85,
  "same-file-lexical": 0.9,
  "cross-file-name-unique": 0.78,
  "cross-file-name-ambiguous": 0.45,
  "receiver-this": 0.92,
  "receiver-self": 0.92,
  "receiver-type": 0.85,
  "namespace-qualified": 0.88,
  "module-qualified": 0.88,
  "package-qualified": 0.93,
  "header-pair": 0.82,
  "psr4-autoload": 0.93,
  "extension-method": 0.78,
  "trait-default": 0.78,
  "inheritance-method": 0.78,
  "function-pointer": 0.45,
  "global-preferred": 0.95,
  "global-fallback": 0.8,
  "builtin-or-global": 0.3,
  "heuristic-only": 0.35,
  "disambiguated": 0.55,
};

let cachedNewConfidenceRubricEnabled: boolean | null = null;

/**
 * Returns true when the new Phase-2 rubric is enabled via env flag.
 * The result is cached after the first lookup; tests can reset the cache
 * with `resetConfidenceRubricCacheForTests()` when they need to flip the
 * flag mid-run.
 */
export function resetConfidenceRubricCacheForTests(): void {
  cachedNewConfidenceRubricEnabled = null;
}

export function isNewConfidenceRubricEnabled(): boolean {
  if (cachedNewConfidenceRubricEnabled === null) {
    const value = process.env.SDL_MCP_USE_NEW_CONFIDENCE_RUBRIC;
    cachedNewConfidenceRubricEnabled = value === "1" || value === "true";
  }
  return cachedNewConfidenceRubricEnabled;
}

/**
 * Returns the confidence value for a strategy, honoring the env flag.
 * Per-language resolvers must call this instead of writing literal
 * confidence values.
 */
export function confidenceFor(strategy: CallResolutionStrategy): number {
  return isNewConfidenceRubricEnabled()
    ? CONFIDENCE_NEW[strategy]
    : CONFIDENCE_LEGACY[strategy];
}

/**
 * Returns both legacy and new confidence values for audit-event emission.
 * Used during the dual-emit observation period before Task 2.11.2 drops
 * the legacy path.
 */
export function confidenceForBoth(strategy: CallResolutionStrategy): {
  legacy: number;
  next: number;
  active: number;
} {
  const legacy = CONFIDENCE_LEGACY[strategy];
  const next = CONFIDENCE_NEW[strategy];
  return {
    legacy,
    next,
    active: isNewConfidenceRubricEnabled() ? next : legacy,
  };
}

/**
 * Returns the broad telemetry bucket a strategy resolves into. Used by
 * `Pass2ResolverTelemetry` to track resolved-by-compiler / resolved-by-
 * import / resolved-by-lexical / etc. without leaking strategy names.
 */
export function telemetryBucketFor(
  strategy: CallResolutionStrategy,
): "compiler" | "import" | "lexical" | "ambiguous" | "global" | "heuristic" {
  switch (strategy) {
    case "compiler-resolved":
      return "compiler";
    case "import-direct":
    case "import-aliased":
    case "import-barrel":
    case "namespace-qualified":
    case "module-qualified":
    case "package-qualified":
    case "psr4-autoload":
    case "header-pair":
      return "import";
    case "same-file-lexical":
    case "receiver-this":
    case "receiver-self":
    case "receiver-type":
    case "inheritance-method":
    case "trait-default":
    case "extension-method":
      return "lexical";
    case "cross-file-name-ambiguous":
    case "function-pointer":
    case "disambiguated":
      return "ambiguous";
    case "cross-file-name-unique":
      return "lexical";
    case "global-preferred":
    case "global-fallback":
    case "builtin-or-global":
      return "global";
    case "heuristic-only":
      return "heuristic";
    default: {
      const _exhaustive: never = strategy;
      void _exhaustive;
      return "heuristic";
    }
  }
}

/**
 * Test-only escape hatch: returns a frozen view of the rubric tables.
 * Used by `tests/unit/pass2-confidence.test.ts` to assert every strategy
 * has both a legacy and a new value and to prove byte-for-byte parity
 * with the pre-Phase-2 snapshot when the env flag is unset.
 */
export function getConfidenceTablesForTesting(): {
  legacy: Readonly<Record<CallResolutionStrategy, number>>;
  next: Readonly<Record<CallResolutionStrategy, number>>;
} {
  return { legacy: CONFIDENCE_LEGACY, next: CONFIDENCE_NEW };
}
