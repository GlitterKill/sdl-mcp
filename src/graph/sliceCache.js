const SLICE_CACHE_TTL_MS = 60_000;
const SLICE_CACHE_MAX = 100;
const sliceCache = new Map();
let cacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    hitRate: 0,
};
function updateHitRate() {
    const total = cacheStats.hits + cacheStats.misses;
    cacheStats.hitRate = total > 0 ? cacheStats.hits / total : 0;
}
function stableStringify(value) {
    if (value === undefined) {
        return "null";
    }
    if (value === null) {
        return "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (typeof value === "object") {
        const entries = Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => `"${key}":${stableStringify(val)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}
export function getSliceCacheKey(request) {
    const context = {
        taskText: request.taskText ?? null,
        stackTrace: request.stackTrace ?? null,
        failingTestPath: request.failingTestPath ?? null,
        editedFiles: request.editedFiles ? [...request.editedFiles].sort() : null,
        entrySymbols: request.entrySymbols
            ? [...request.entrySymbols].sort()
            : null,
        budget: request.budget ?? null,
    };
    return `${request.repoId}:${request.versionId}:${stableStringify(context)}`;
}
export function getCachedSlice(key) {
    const entry = sliceCache.get(key);
    if (!entry) {
        cacheStats.misses++;
        updateHitRate();
        return null;
    }
    if (entry.expiresAt <= Date.now()) {
        sliceCache.delete(key);
        cacheStats.currentSize--;
        cacheStats.misses++;
        updateHitRate();
        return null;
    }
    cacheStats.hits++;
    updateHitRate();
    return entry.slice;
}
export function setCachedSlice(key, slice) {
    if (sliceCache.size >= SLICE_CACHE_MAX) {
        const oldestKey = sliceCache.keys().next().value;
        if (oldestKey) {
            sliceCache.delete(oldestKey);
            cacheStats.evictions++;
            cacheStats.currentSize--;
        }
    }
    sliceCache.set(key, {
        slice,
        expiresAt: Date.now() + SLICE_CACHE_TTL_MS,
        createdAt: Date.now(),
    });
    cacheStats.currentSize++;
}
export function invalidateVersion(versionId) {
    const keysToDelete = [];
    for (const key of sliceCache.keys()) {
        if (key.includes(`:${versionId}:`)) {
            keysToDelete.push(key);
        }
    }
    for (const key of keysToDelete) {
        sliceCache.delete(key);
        cacheStats.currentSize--;
    }
}
export function clearSliceCache() {
    sliceCache.clear();
    cacheStats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        currentSize: 0,
        hitRate: 0,
    };
}
export function getSliceCacheStats() {
    return { ...cacheStats };
}
export function resetSliceCacheStats() {
    cacheStats = {
        hits: 0,
        misses: 0,
        evictions: 0,
        currentSize: sliceCache.size,
        hitRate: 0,
    };
}
//# sourceMappingURL=sliceCache.js.map