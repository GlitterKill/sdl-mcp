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
 * | indexing.concurrency             | 4         | 8           | 12            |
 * | concurrency.maxToolConcurrency   | 8         | 12          | 16            |
 * | concurrency.readPoolSize         | 4         | 8           | 8             |
 * | concurrency.maxSessions          | 4         | 8           | 16            |
 * | runtime.maxConcurrentJobs        | 2         | 4           | 8             |
 * | liveIndex.reconcileConcurrency   | 1         | 3           | 6             |
 * | semantic.summaryMaxConcurrency   | 3         | 8           | 16            |
 * | parallelScorer.enabled           | false     | true        | true          |
 * | parallelScorer.poolSize          | null      | 4           | 8             |
 * | indexing.pass2Concurrency        | 1         | 3           | 6             |
 * | scip.ingestConcurrency           | 1         | 2           | 3             |
 *
 * Tuning notes:
 *   - dispatch:readPool ratio kept at 2:1 so read connections are not
 *     over-contended under concurrent tool dispatch.
 *   - indexingConcurrency tuned to 12 (extreme) / 8 (high): the LadybugDB
 *     write path now uses UNWIND-batched MERGE so per-symbol round-trips
 *     collapse, but the writer is still single. These values keep the
 *     parser CPU saturated without queuing too many writers behind the
 *     single-writer lock.
 *   - pass2Concurrency parallelises the cross-file call resolver. Mid stays
 *     sequential (1) because writes still serialise; high (3) and extreme
 *     (6) overlap resolver CPU + read I/O with the writer.
 *   - scipIngestConcurrency overlaps decode/parse of multi-language SCIP
 *     indexes (TS + Go + Rust). Writes still serialise via writeLimiter.
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
  pass2Concurrency: number;
  scipIngestConcurrency: number;
}

/**
 * Return the raw preset values for a given tier.
 * These represent the recommended defaults — not clamped by schema limits.
 */
export function getTierPresets(tier: CpuTier): PerformancePresets {
  switch (tier) {
    case "extreme":
      return {
        indexingConcurrency: 12,
        maxToolConcurrency: 16,
        readPoolSize: 8,

        maxSessions: 16,
        runtimeMaxConcurrentJobs: 8,
        reconcileConcurrency: 6,
        summaryMaxConcurrency: 16,
        parallelScorerEnabled: true,
        parallelScorerPoolSize: 8,
        // F1: raised from 6 → 12 after C1 eliminated the per-file
        // tree-sitter re-parse on the JS main thread. With pass-2 reads now
        // served by the import cache (A1) and writes coalesced per batch,
        // the new bottleneck is CPU on the resolver hot loop — higher
        // concurrency overlaps that work across files instead of queueing
        // it behind a single-threaded main-thread parse.
        pass2Concurrency: 12,
        scipIngestConcurrency: 3,
      };
    case "high":
      return {
        indexingConcurrency: 8,
        maxToolConcurrency: 12,
        readPoolSize: 8,

        maxSessions: 8,
        runtimeMaxConcurrentJobs: 4,
        reconcileConcurrency: 3,
        summaryMaxConcurrency: 8,
        parallelScorerEnabled: true,
        parallelScorerPoolSize: 4,
        // F1: raised from 3 → 8 (see extreme-tier note above).
        pass2Concurrency: 8,
        scipIngestConcurrency: 2,
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
        pass2Concurrency: 1,
        scipIngestConcurrency: 1,
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

    pass2Concurrency:
      userConfig.indexing?.pass2Concurrency ?? presets.pass2Concurrency,

    scipIngestConcurrency:
      (userConfig.scip as { ingestConcurrency?: number } | undefined)
        ?.ingestConcurrency ?? presets.scipIngestConcurrency,
  };
}
