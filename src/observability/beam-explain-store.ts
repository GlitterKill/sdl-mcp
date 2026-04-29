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

function cacheKey(repoId: string, sliceHandle: string): string {
  return `${repoId}::${sliceHandle}`;
}

/**
 * In-memory LRU cache of beam-search decision traces.
 *
 * Insertion order is tracked via Map iteration order — every publish (or
 * mutation) deletes-and-re-inserts the entry to keep the most-recently-used
 * key at the tail. Eviction pops the oldest (first) key.
 */
export class BeamExplainStore {
  private readonly capacity: number;
  private readonly maxEntriesPerSlice: number;
  private readonly traces = new Map<string, BeamExplainResponse>();

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
    const key = cacheKey(input.repoId, input.sliceHandle);
    if (this.traces.has(key)) {
      this.traces.delete(key);
    }
    this.traces.set(key, response);
    while (this.traces.size > this.capacity) {
      const oldestKey = this.traces.keys().next().value;
      if (oldestKey === undefined) break;
      this.traces.delete(oldestKey);
    }
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
    const key = cacheKey(repoId, sliceHandle);
    const stored = this.traces.get(key);
    if (stored === undefined) return null;
    // Refresh LRU position on access.
    this.traces.delete(key);
    this.traces.set(key, stored);
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
    return this.traces.size;
  }

  /** Drop every retained trace. */
  clear(): void {
    this.traces.clear();
  }
}
