/**
 * Beam-search decision trace store.
 *
 * Bounded LRU cache of {@link BeamExplainResponse} keyed by
 * `${repoId}::${sliceHandle}`. Receives traces from completed slice builds
 * and answers point queries from the observability HTTP layer.
 *
 * Wholly synchronous and pure-data; no I/O or DB access. The class is
 * structurally compatible with `BeamExplainStoreLike` declared in
 * `src/observability/service.ts`, so it can be plugged into
 * `ObservabilityService.setBeamExplainStore()` directly.
 */

import type { BeamExplainEntry, BeamExplainResponse } from "./types.js";

export interface BeamExplainStoreConfig {
  /** Maximum number of distinct slice traces retained in the LRU. */
  capacity: number;
  /** Hard cap on entries kept per slice; truncation flag covers overflow. */
  maxEntriesPerSlice: number;
}

interface PublishInput {
  repoId: string;
  sliceHandle: string;
  builtAt: string;
  entries: BeamExplainEntry[];
  edgeWeights: {
    call: number;
    import: number;
    config: number;
    implements: number;
  };
  thresholds: { sliceScoreThreshold: number; maxFrontier: number };
  truncated: boolean;
}

/**
 * In-memory LRU cache of beam-search decision traces.
 *
 * Traces are grouped per repo so one noisy repo cannot evict every other
 * repo's observability history. Each repo gets a dynamic sub-quota based on
 * the configured global capacity and current repo count, with a minimum of 8
 * traces per repo.
 */
export class BeamExplainStore {
  private readonly capacity: number;
  private readonly maxEntriesPerSlice: number;
  private readonly tracesByRepo = new Map<
    string,
    Map<string, BeamExplainResponse>
  >();

  constructor(config: BeamExplainStoreConfig) {
    this.capacity = Math.max(1, Math.floor(config.capacity));
    this.maxEntriesPerSlice = Math.max(
      1,
      Math.floor(config.maxEntriesPerSlice),
    );
  }

  /**
   * Record a completed slice's beam-search trace. Caller-side
   * truncation is preserved; the store applies a defensive secondary
   * cap of `maxEntriesPerSlice` and OR's the truncated flag if it
   * trims further.
   */
  private getOrCreateRepoTraces(
    repoId: string,
  ): Map<string, BeamExplainResponse> {
    let repoTraces = this.tracesByRepo.get(repoId);
    if (!repoTraces) {
      repoTraces = new Map();
      this.tracesByRepo.set(repoId, repoTraces);
    }
    return repoTraces;
  }

  private trimRepoTraces(
    repoTraces: Map<string, BeamExplainResponse>,
    repoCapacity: number,
  ): void {
    while (repoTraces.size > repoCapacity) {
      const oldestKey = repoTraces.keys().next().value;
      if (oldestKey === undefined) break;
      repoTraces.delete(oldestKey);
    }
  }

  private rebalanceAllRepos(): void {
    const repoCapacity = Math.max(
      8,
      Math.floor(this.capacity / Math.max(this.tracesByRepo.size, 1)),
    );
    for (const repoTraces of this.tracesByRepo.values()) {
      this.trimRepoTraces(repoTraces, repoCapacity);
    }
  }

  publishTrace(input: PublishInput): void {
    let entries = input.entries;
    let truncated = input.truncated;
    if (entries.length > this.maxEntriesPerSlice) {
      entries = entries.slice(0, this.maxEntriesPerSlice);
      truncated = true;
    }
    const response: BeamExplainResponse = {
      schemaVersion: 1,
      repoId: input.repoId,
      sliceHandle: input.sliceHandle,
      builtAt: input.builtAt,
      entries,
      truncated,
      edgeWeights: {
        call: input.edgeWeights.call,
        import: input.edgeWeights.import,
        config: input.edgeWeights.config,
        implements: input.edgeWeights.implements,
      },
      thresholds: {
        sliceScoreThreshold: input.thresholds.sliceScoreThreshold,
        maxFrontier: input.thresholds.maxFrontier,
      },
    };
    const repoTraces = this.getOrCreateRepoTraces(input.repoId);
    if (repoTraces.has(input.sliceHandle)) {
      repoTraces.delete(input.sliceHandle);
    }
    repoTraces.set(input.sliceHandle, response);
    this.rebalanceAllRepos();
  }

  /**
   * Fetch a previously published trace. When `symbolId` is provided,
   * filters `entries` to those involving that symbol — either as the
   * subject (`entry.symbolId`) or as the source of the edge that led
   * to the decision (`entry.edgeFromSymbolId`). The response otherwise
   * preserves all metadata, including the original `truncated` flag.
   */
  get(
    repoId: string,
    sliceHandle: string,
    symbolId?: string,
  ): BeamExplainResponse | null {
    const repoTraces = this.tracesByRepo.get(repoId);
    if (!repoTraces) return null;
    const stored = repoTraces.get(sliceHandle);
    if (stored === undefined) return null;
    // Refresh LRU position on access.
    repoTraces.delete(sliceHandle);
    repoTraces.set(sliceHandle, stored);
    if (symbolId === undefined) {
      return stored;
    }
    const filtered = stored.entries.filter(
      (e) => e.symbolId === symbolId || e.edgeFromSymbolId === symbolId,
    );
    return {
      ...stored,
      entries: filtered,
    };
  }

  /** Number of distinct slice traces currently retained. */
  size(): number {
    let total = 0;
    for (const repoTraces of this.tracesByRepo.values()) {
      total += repoTraces.size;
    }
    return total;
  }

  /** Drop every retained trace. */
  clear(): void {
    this.tracesByRepo.clear();
  }
}
