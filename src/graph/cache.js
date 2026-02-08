/**
 * LRU Cache with version-based invalidation for SDL-MCP
 *
 * Provides in-memory caching for SymbolCard and GraphSlice objects with:
 * - LRU (Least Recently Used) eviction policy
 * - Version-based cache key invalidation
 * - Cache statistics tracking (hits, misses, evictions)
 * - Configurable size limits per cache type
 */
const DEFAULT_CACHE_CONFIG = {
    maxEntries: 1000,
    maxSizeBytes: 50 * 1024 * 1024,
};
const DEFAULT_SYMBOL_CACHE_CONFIG = {
    maxEntries: 2000,
    maxSizeBytes: 100 * 1024 * 1024,
};
/**
 * LRU Cache implementation with version-based invalidation
 */
class LRUCache {
    cache = new Map();
    accessOrder = [];
    stats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        currentSize: 0,
        entryCount: 0,
    };
    config;
    lock = Promise.resolve();
    constructor(config = {}) {
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    }
    /**
     * Generates a cache key including version for invalidation
     */
    makeKey(repoId, id, versionId) {
        return `${repoId}:${id}:${versionId}`;
    }
    /**
     * Estimates size of a cache entry in bytes
     * Accounts for object overhead and string encoding
     */
    estimateSize(value) {
        try {
            const jsonString = JSON.stringify(value);
            const stringBytes = Buffer.byteLength(jsonString, "utf8");
            const objectOverhead = 64;
            return stringBytes + objectOverhead;
        }
        catch {
            return 1024;
        }
    }
    /**
     * Updates access order for LRU tracking
     */
    updateAccessOrder(key) {
        const index = this.accessOrder.indexOf(key);
        if (index !== -1) {
            this.accessOrder.splice(index, 1);
        }
        this.accessOrder.push(key);
    }
    /**
     * Evicts entries to fit within cache limits
     */
    evictIfNeeded() {
        while (this.accessOrder.length > this.config.maxEntries ||
            (this.stats.currentSize > this.config.maxSizeBytes &&
                this.accessOrder.length > 1)) {
            if (this.accessOrder.length === 0)
                break;
            const oldestKey = this.accessOrder.shift();
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
    invalidateVersion(versionId) {
        const keysToDelete = [];
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
    clear() {
        this.cache.clear();
        this.accessOrder = [];
        this.stats.currentSize = 0;
        this.stats.entryCount = 0;
    }
    /**
     * Gets a cached value
     */
    get(repoId, id, versionId) {
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
    async set(repoId, id, versionId, value) {
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
            if (newTotalSize > this.config.maxSizeBytes &&
                this.accessOrder.length > 0) {
                const oldestKey = this.accessOrder.shift();
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
        }
        finally {
            release();
        }
    }
    /**
     * Acquires a simple mutex lock for atomic operations
     */
    acquireLock() {
        let released = false;
        const previousLock = this.lock;
        this.lock = new Promise((resolve) => {
            previousLock.then(() => {
                if (released) {
                    resolve();
                }
                else {
                    this.lock = new Promise((r) => r()).then(() => resolve());
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
    has(repoId, id, versionId) {
        const key = this.makeKey(repoId, id, versionId);
        return this.cache.has(key);
    }
    /**
     * Gets cache statistics
     */
    getStats() {
        return { ...this.stats };
    }
    /**
     * Resets cache statistics
     */
    resetStats() {
        this.stats.hits = 0;
        this.stats.misses = 0;
        this.stats.evictions = 0;
    }
}
/**
 * Global cache instances
 */
export const symbolCardCache = new LRUCache(DEFAULT_SYMBOL_CACHE_CONFIG);
export const graphSliceCache = new LRUCache(DEFAULT_CACHE_CONFIG);
/**
 * Cache key generators
 */
export function makeSymbolCardCacheKey(repoId, symbolId, versionId) {
    return `${repoId}:${symbolId}:${versionId}`;
}
export function makeGraphSliceCacheKey(repoId, versionId, entrySymbols, budget) {
    const budgetStr = `${budget.maxCards || 0}:${budget.maxEstimatedTokens || 0}`;
    const symbolsStr = entrySymbols.sort().join(",");
    return `${repoId}:${versionId}:${symbolsStr}:${budgetStr}`;
}
/**
 * Cache statistics retrieval
 */
export function getSymbolCardCacheStats() {
    return symbolCardCache.getStats();
}
export function getGraphSliceCacheStats() {
    return graphSliceCache.getStats();
}
/**
 * Cache invalidation helpers
 */
export function invalidateSymbolCardVersion(versionId) {
    symbolCardCache.invalidateVersion(versionId);
}
export function invalidateGraphSliceVersion(versionId) {
    graphSliceCache.invalidateVersion(versionId);
}
/**
 * Clears all caches
 */
export function clearAllCaches() {
    symbolCardCache.clear();
    graphSliceCache.clear();
}
/**
 * Resets all cache statistics
 */
export function resetAllCacheStats() {
    symbolCardCache.resetStats();
    graphSliceCache.resetStats();
}
export { LRUCache };
//# sourceMappingURL=cache.js.map