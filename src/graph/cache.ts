/**
 * LRU Cache with version-based invalidation for SDL-MCP
 *
 * Provides in-memory caching for SymbolCard and GraphSlice objects with:
 * - LRU (Least Recently Used) eviction policy
 * - Version-based cache key invalidation
 * - Cache statistics tracking (hits, misses, evictions)
 * - Configurable size limits per cache type
 */

import type { SymbolCard, GraphSlice } from "../mcp/types.js";
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
 * LRU Cache implementation with version-based invalidation
 */
class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private accessOrder: string[] = [];
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

  /**
   * Generates a cache key including version for invalidation
   */
  private makeKey(repoId: RepoId, id: string, versionId: VersionId): string {
    return `${repoId}:${id}:${versionId}`;
  }

  /**
   * Estimates size of a cache entry in bytes
   * Accounts for object overhead and string encoding
   */
  private estimateSize(value: unknown): number {
    try {
      const jsonString = JSON.stringify(value);
      const stringBytes = Buffer.byteLength(jsonString, "utf8");
      const objectOverhead = 64;
      return stringBytes + objectOverhead;
    } catch {
      return 1024;
    }
  }

  /**
   * Updates access order for LRU tracking
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * Evicts entries to fit within cache limits
   */
  private evictIfNeeded(): void {
    while (
      this.accessOrder.length > this.config.maxEntries ||
      (this.stats.currentSize > this.config.maxSizeBytes &&
        this.accessOrder.length > 1)
    ) {
      if (this.accessOrder.length === 0) break;

      const oldestKey = this.accessOrder.shift()!;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.stats.currentSize -= entry.size;
        this.stats.entryCount--;
        this.stats.evictions++;
        this.cache.delete(oldestKey);
      }
    }
  }

  /**
   * Invalidates all cache entries for a specific version
   */
  invalidateVersion(versionId: VersionId): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${versionId}`)) {
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
      const index = this.accessOrder.indexOf(key);
      if (index !== -1) {
        this.accessOrder.splice(index, 1);
      }
    }
  }

  /**
   * Clears all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.stats.currentSize = 0;
    this.stats.entryCount = 0;
  }

  /**
   * Gets a cached value
   */
  get(repoId: RepoId, id: string, versionId: VersionId): T | undefined {
    const key = this.makeKey(repoId, id, versionId);
    const entry = this.cache.get(key);

    if (entry) {
      this.updateAccessOrder(key);
      entry.lastAccessed = Date.now();
      this.stats.hits++;
      return entry.value;
    }

    this.stats.misses++;
    return undefined;
  }

  /**
   * Sets a cached value
   */
  async set(
    repoId: RepoId,
    id: string,
    versionId: VersionId,
    value: T,
  ): Promise<void> {
    await this.lock;
    const release = this.acquireLock();

    try {
      const key = this.makeKey(repoId, id, versionId);
      const size = this.estimateSize(value);
      const now = Date.now();

      const existingEntry = this.cache.get(key);
      if (existingEntry) {
        this.stats.currentSize -= existingEntry.size;
        this.stats.entryCount--;
      }

      const newTotalSize = this.stats.currentSize + size;

      if (
        newTotalSize > this.config.maxSizeBytes &&
        this.accessOrder.length > 0
      ) {
        const oldestKey = this.accessOrder.shift()!;
        const entry = this.cache.get(oldestKey);
        if (entry) {
          this.stats.currentSize -= entry.size;
          this.stats.entryCount--;
          this.stats.evictions++;
          this.cache.delete(oldestKey);
        }
      }

      this.cache.set(key, {
        value,
        versionId,
        lastAccessed: now,
        size,
      });
      this.stats.currentSize += size;
      this.stats.entryCount++;
      this.updateAccessOrder(key);

      this.evictIfNeeded();
    } finally {
      release();
    }
  }

  /**
   * Acquires a simple mutex lock for atomic operations
   */
  private acquireLock(): () => void {
    let released = false;
    const previousLock = this.lock;
    this.lock = new Promise<void>((resolve) => {
      previousLock.then(() => {
        if (released) {
          resolve();
        } else {
          this.lock = new Promise<void>((r) => r()).then(() => resolve());
        }
      });
    });
    return () => {
      released = true;
    };
  }

  /**
   * Checks if a key exists in the cache
   */
  has(repoId: RepoId, id: string, versionId: VersionId): boolean {
    const key = this.makeKey(repoId, id, versionId);
    return this.cache.has(key);
  }

  /**
   * Gets cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Resets cache statistics
   */
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
export const graphSliceCache = new LRUCache<GraphSlice>(DEFAULT_CACHE_CONFIG);

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

export function makeGraphSliceCacheKey(
  repoId: RepoId,
  versionId: VersionId,
  entrySymbols: SymbolId[],
  budget: { maxCards?: number; maxEstimatedTokens?: number },
): string {
  const budgetStr = `${budget.maxCards || 0}:${budget.maxEstimatedTokens || 0}`;
  const symbolsStr = entrySymbols.sort().join(",");
  return `${repoId}:${versionId}:${symbolsStr}:${budgetStr}`;
}

/**
 * Cache statistics retrieval
 */
export function getSymbolCardCacheStats(): CacheStats {
  return symbolCardCache.getStats();
}

export function getGraphSliceCacheStats(): CacheStats {
  return graphSliceCache.getStats();
}

/**
 * Cache invalidation helpers
 */
export function invalidateSymbolCardVersion(versionId: VersionId): void {
  symbolCardCache.invalidateVersion(versionId);
}

export function invalidateGraphSliceVersion(versionId: VersionId): void {
  graphSliceCache.invalidateVersion(versionId);
}

/**
 * Clears all caches
 */
export function clearAllCaches(): void {
  symbolCardCache.clear();
  graphSliceCache.clear();
}

/**
 * Resets all cache statistics
 */
export function resetAllCacheStats(): void {
  symbolCardCache.resetStats();
  graphSliceCache.resetStats();
}

export { LRUCache };
export type { CacheEntry, CacheStats, CacheConfig };
