import { type CpuTier } from "./cpu-detect.js";
import { type AppConfig } from "../config/types.js";

/**
 * Resolved performance settings derived from a CPU tier.
 *
 * All fields are optional — only values that should override the schema default
 * are included. Callers should spread these on top of defaults, then let
 * explicit user-config values win a final merge.
 *
 * Preset values by tier:
 *
 * | Setting                          | mid (1-8) | high (9-20) | extreme (21+) |
 * |----------------------------------|-----------|-------------|---------------|
 * | indexing.concurrency             | 4         | 12          | 16            |
 * | concurrency.maxToolConcurrency   | 8         | 12          | 16            |
 * | concurrency.readPoolSize         | 4         | 8           | 8             |
 * | concurrency.maxSessions          | 4         | 8           | 16            |
 * | runtime.maxConcurrentJobs        | 2         | 4           | 8             |
 * | liveIndex.reconcileConcurrency   | 1         | 3           | 6             |
 * | semantic.summaryMaxConcurrency   | 3         | 8           | 16            |
 * | parallelScorer.enabled           | false     | true        | true          |
 * | parallelScorer.poolSize          | null      | 4           | 8             |
 *
 * Tuning notes:
 *   - dispatch:readPool ratio kept at 2:1 so read connections are not
 *     over-contended under concurrent tool dispatch.
 *   - indexingConcurrency capped at 16 (extreme) / 12 (high): empirically
 *     saturates the Rust parse stage; higher values yielded <5% gain while
 *     doubling DB contention windows.
 *   - During an active `indexRepo`, the dispatch limiter throttles to
 *     INDEXING_DISPATCH_CAP (see src/mcp/indexing-gate.ts) so tool callers
 *     don't compete with the indexer for the same connections.
 */
export interface PerformancePresets {
  indexingConcurrency: number;
  maxToolConcurrency: number;
  readPoolSize: number;
  maxSessions: number;
  runtimeMaxConcurrentJobs: number;
  reconcileConcurrency: number;
  summaryMaxConcurrency: number;
  parallelScorerEnabled: boolean;
  parallelScorerPoolSize: number | null;
}

/**
 * Return the raw preset values for a given tier.
 * These represent the recommended defaults — not clamped by schema limits.
 */
export function getTierPresets(tier: CpuTier): PerformancePresets {
  switch (tier) {
    case "extreme":
      return {
        indexingConcurrency: 16,
        maxToolConcurrency: 16,
        readPoolSize: 8,

        maxSessions: 16,
        runtimeMaxConcurrentJobs: 8,
        reconcileConcurrency: 6,
        summaryMaxConcurrency: 16,
        parallelScorerEnabled: true,
        parallelScorerPoolSize: 8,
      };
    case "high":
      return {
        indexingConcurrency: 12,
        maxToolConcurrency: 12,
        readPoolSize: 8,

        maxSessions: 8,
        runtimeMaxConcurrentJobs: 4,
        reconcileConcurrency: 3,
        summaryMaxConcurrency: 8,
        parallelScorerEnabled: true,
        parallelScorerPoolSize: 4,
      };
    case "mid":
    default:
      return {
        indexingConcurrency: 4,
        maxToolConcurrency: 8,
        readPoolSize: 4,

        maxSessions: 4,
        runtimeMaxConcurrentJobs: 2,
        reconcileConcurrency: 1,
        summaryMaxConcurrency: 3,
        parallelScorerEnabled: false,
        parallelScorerPoolSize: null,
      };
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Resolve effective performance values by merging tier presets with the user's
 * explicit config choices.
 *
 * Rules:
 *   1. Start from tier presets.
 *   2. If the user explicitly set a field, their value wins.
 *
 * "Explicitly set" means the relevant config section was provided by the user
 * and contains the field (non-undefined). Zod-filled defaults are indistinct
 * from user values at runtime, so callers should pass only the raw partial
 * config (before schema.parse()) for best results. When the full parsed config
 * is passed, all Zod defaults will be treated as user-explicit — which is safe
 * (defaults keep working) but means auto-tier has no effect for those fields.
 *
 * @param tier         The resolved CPU tier (never "auto").
 * @param userConfig   The raw (pre-parse) or fully-parsed AppConfig. Fields
 *                     present here override preset values.
 */
export function resolvePerformancePresets(
  tier: CpuTier,
  userConfig: DeepPartial<AppConfig>,
): PerformancePresets {
  const presets = getTierPresets(tier);

  return {
    indexingConcurrency:
      userConfig.indexing?.concurrency ?? presets.indexingConcurrency,

    maxToolConcurrency:
      userConfig.concurrency?.maxToolConcurrency ?? presets.maxToolConcurrency,

    readPoolSize: userConfig.concurrency?.readPoolSize ?? presets.readPoolSize,

    maxSessions: userConfig.concurrency?.maxSessions ?? presets.maxSessions,

    runtimeMaxConcurrentJobs:
      userConfig.runtime?.maxConcurrentJobs ?? presets.runtimeMaxConcurrentJobs,

    reconcileConcurrency:
      userConfig.liveIndex?.reconcileConcurrency ??
      presets.reconcileConcurrency,

    summaryMaxConcurrency:
      userConfig.semantic?.summaryMaxConcurrency ??
      presets.summaryMaxConcurrency,

    parallelScorerEnabled:
      userConfig.parallelScorer?.enabled ?? presets.parallelScorerEnabled,

    parallelScorerPoolSize:
      userConfig.parallelScorer?.poolSize !== undefined
        ? (userConfig.parallelScorer.poolSize ?? null)
        : presets.parallelScorerPoolSize,
  };
}
