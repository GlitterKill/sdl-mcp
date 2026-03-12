/**
 * LRU Cache with version-based invalidation for SDL-MCP
 *
 * Provides in-memory caching for SymbolCard and GraphSlice objects with:
 * - LRU (Least Recently Used) eviction policy
 * - Version-based cache key invalidation
 * - Cache statistics tracking (hits, misses, evictions)
 * - Configurable size limits per cache type
 */

import type { SymbolCard } from "../domain/types.js";
import type { VersionId, SymbolId, RepoId } from "../db/schema.js";

interface CacheEntry<T> {
  value: T;
  versionId: VersionId;
  lastAccessed: number;
  size: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  entryCount: number;
}

interface CacheConfig {
  maxEntries: number;
  maxSizeBytes: number;
}

const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxEntries: 1000,
  maxSizeBytes: 50 * 1024 * 1024,
};

const DEFAULT_SYMBOL_CACHE_CONFIG: CacheConfig = {
  maxEntries: 2000,
  maxSizeBytes: 100 * 1024 * 1024,
};

/**
 * LRU Cache implementation with version-based invalidation.
 *
 * Uses Map insertion-order semantics for O(1) LRU promotion:
 * delete + re-insert moves a key to the end (most-recently-used).
 * Iteration order is insertion order, so the first key is the LRU candidate.
 */
class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    entryCount: 0,
  };
  private config: CacheConfig;
  private lock: Promise<void> = Promise.resolve();

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  private makeKey(repoId: RepoId, id: string, versionId: VersionId): string {
    return `${repoId}:${id}:${versionId}`;
  }

  private estimateSize(value: unknown): number {
    return this.estimateSizeWalk(value, 0);
  }

  /**
   * Recursive size estimator that avoids JSON.stringify overhead.
   * Walks the object tree with a depth limit to prevent runaway traversal.
   */
  private estimateSizeWalk(value: unknown, depth: number): number {
    // Depth guard: at depth 6+, use a flat estimate per remaining key
    if (depth > 5) return 128;

    if (value === null || value === undefined) return 8;

    switch (typeof value) {
      case "string":
        // 2 bytes per char is a reasonable UTF-8 upper bound
        return 16 + (value as string).length * 2;
      case "number":
      case "boolean":
        return 16;
      case "object": {
        const OBJECT_OVERHEAD = 64;
        if (Array.isArray(value)) {
          let total = OBJECT_OVERHEAD;
          for (const item of value) {
            total += this.estimateSizeWalk(item, depth + 1);
          }
          return total;
        }
        let total = OBJECT_OVERHEAD;
        for (const key of Object.keys(value as Record<string, unknown>)) {
          total += 16 + key.length * 2; // key overhead
          total += this.estimateSizeWalk(
            (value as Record<string, unknown>)[key],
            depth + 1,
          );
        }
        return total;
      }
      default:
        return 64;
    }
  }

  /**
   * O(1) LRU promotion: delete and re-insert to move key to end of Map.
   */
  private promoteKey(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
  }

  /**
   * Evicts the least-recently-used entry (first key in Map iteration order).
   */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey === undefined) return;

    const entry = this.cache.get(firstKey);
    if (entry) {
      this.stats.currentSize -= entry.size;
      this.stats.entryCount--;
      this.stats.evictions++;
    }
    this.cache.delete(firstKey);
  }

  private evictIfNeeded(): void {
    while (
      this.cache.size > this.config.maxEntries ||
      (this.stats.currentSize > this.config.maxSizeBytes && this.cache.size > 1)
    ) {
      if (this.cache.size === 0) break;
      this.evictLRU();
    }
  }

  invalidateVersion(versionId: VersionId): void {
    const suffix = `:${versionId}`;
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.endsWith(suffix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      const entry = this.cache.get(key);
      if (entry) {
        this.stats.currentSize -= entry.size;
        this.stats.entryCount--;
      }
      this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.stats.currentSize = 0;
    this.stats.entryCount = 0;
  }

  get(repoId: RepoId, id: string, versionId: VersionId): T | undefined {
    const key = this.makeKey(repoId, id, versionId);
    const entry = this.cache.get(key);

    if (entry) {
      this.promoteKey(key);
      entry.lastAccessed = Date.now();
      this.stats.hits++;
      return entry.value;
    }

    this.stats.misses++;
    return undefined;
  }

  async set(
    repoId: RepoId,
    id: string,
    versionId: VersionId,
    value: T,
  ): Promise<void> {
    let releaseLock: (() => void) | undefined;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = this.lock;
    this.lock = previousLock.then(() => nextLock);

    await previousLock;

    try {
      const key = this.makeKey(repoId, id, versionId);
      const size = this.estimateSize(value);
      const now = Date.now();

      const existingEntry = this.cache.get(key);
      if (existingEntry) {
        this.stats.currentSize -= existingEntry.size;
        this.stats.entryCount--;
        this.cache.delete(key);
      }

      const newTotalSize = this.stats.currentSize + size;

      if (newTotalSize > this.config.maxSizeBytes && this.cache.size > 0) {
        this.evictLRU();
      }

      this.cache.set(key, {
        value,
        versionId,
        lastAccessed: now,
        size,
      });
      this.stats.currentSize += size;
      this.stats.entryCount++;

      this.evictIfNeeded();
    } finally {
      releaseLock?.();
    }
  }

  has(repoId: RepoId, id: string, versionId: VersionId): boolean {
    const key = this.makeKey(repoId, id, versionId);
    return this.cache.has(key);
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.evictions = 0;
  }
}

/**
 * Global cache instances
 */
export const symbolCardCache = new LRUCache<SymbolCard>(
  DEFAULT_SYMBOL_CACHE_CONFIG,
);

/**
 * Cache key generators
 */
export function makeSymbolCardCacheKey(
  repoId: RepoId,
  symbolId: SymbolId,
  versionId: VersionId,
): string {
  return `${repoId}:${symbolId}:${versionId}`;
}

/**
 * Cache statistics retrieval
 */
export function getSymbolCardCacheStats(): CacheStats {
  return symbolCardCache.getStats();
}

/**
 * Cache invalidation helpers
 */
export function invalidateSymbolCardVersion(versionId: VersionId): void {
  symbolCardCache.invalidateVersion(versionId);
}

/**
 * Clears all caches
 */
export function clearAllCaches(): void {
  symbolCardCache.clear();
}

/**
 * Resets all cache statistics
 */
export function resetAllCacheStats(): void {
  symbolCardCache.resetStats();
}

export { LRUCache };
export type { CacheEntry, CacheStats, CacheConfig };
