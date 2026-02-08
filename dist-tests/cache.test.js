/**
 * Tests for LRU cache with version-based invalidation
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { LRUCache, makeSymbolCardCacheKey, makeGraphSliceCacheKey, } from "../src/graph/cache.js";
describe("LRU Cache", () => {
    describe("Basic cache operations", () => {
        it("should store and retrieve values", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            const result = cache.get("repo1", "key1", "v1");
            assert.strictEqual(result, "value1");
        });
        it("should return undefined for non-existent keys", () => {
            const cache = new LRUCache();
            const result = cache.get("repo1", "key1", "v1");
            assert.strictEqual(result, undefined);
        });
        it("should update existing values", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            await cache.set("repo1", "key1", "v1", "value2");
            const result = cache.get("repo1", "key1", "v1");
            assert.strictEqual(result, "value2");
        });
        it("should check key existence", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            assert.strictEqual(cache.has("repo1", "key1", "v1"), true);
            assert.strictEqual(cache.has("repo1", "key2", "v1"), false);
        });
    });
    describe("Version-based invalidation", () => {
        it("should not return values from different versions", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            const result = cache.get("repo1", "key1", "v2");
            assert.strictEqual(result, undefined);
        });
        it("should invalidate all entries for a specific version", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            await cache.set("repo1", "key2", "v1", "value2");
            await cache.set("repo1", "key1", "v2", "value3");
            cache.invalidateVersion("v1");
            assert.strictEqual(cache.get("repo1", "key1", "v1"), undefined);
            assert.strictEqual(cache.get("repo1", "key2", "v1"), undefined);
            assert.strictEqual(cache.get("repo1", "key1", "v2"), "value3");
        });
    });
    describe("LRU eviction", () => {
        it("should evict least recently used entry when max entries reached", async () => {
            const cache = new LRUCache({ maxEntries: 2 });
            await cache.set("repo1", "key1", "v1", "value1");
            await cache.set("repo1", "key2", "v1", "value2");
            await cache.set("repo1", "key3", "v1", "value3");
            assert.strictEqual(cache.get("repo1", "key1", "v1"), undefined);
            assert.strictEqual(cache.get("repo1", "key2", "v1"), "value2");
            assert.strictEqual(cache.get("repo1", "key3", "v1"), "value3");
        });
        it("should update access order on get", async () => {
            const cache = new LRUCache({ maxEntries: 2 });
            await cache.set("repo1", "key1", "v1", "value1");
            await cache.set("repo1", "key2", "v1", "value2");
            cache.get("repo1", "key1", "v1");
            await cache.set("repo1", "key3", "v1", "value3");
            assert.strictEqual(cache.get("repo1", "key1", "v1"), "value1");
            assert.strictEqual(cache.get("repo1", "key2", "v1"), undefined);
            assert.strictEqual(cache.get("repo1", "key3", "v1"), "value3");
        });
    });
    describe("Cache statistics", () => {
        it("should track hits and misses", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            cache.get("repo1", "key1", "v1");
            cache.get("repo1", "key1", "v1");
            cache.get("repo1", "key2", "v1");
            const stats = cache.getStats();
            assert.strictEqual(stats.hits, 2);
            assert.strictEqual(stats.misses, 1);
            assert.strictEqual(stats.evictions, 0);
        });
        it("should track evictions", async () => {
            const cache = new LRUCache({ maxEntries: 2 });
            await cache.set("repo1", "key1", "v1", "value1");
            await cache.set("repo1", "key2", "v1", "value2");
            await cache.set("repo1", "key3", "v1", "value3");
            const stats = cache.getStats();
            assert.strictEqual(stats.evictions, 1);
        });
        it("should reset statistics", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            cache.get("repo1", "key1", "v1");
            cache.resetStats();
            const stats = cache.getStats();
            assert.strictEqual(stats.hits, 0);
            assert.strictEqual(stats.misses, 0);
        });
    });
    describe("Size-based eviction", () => {
        it("should evict when size limit reached", async () => {
            const largeValue = "x".repeat(1024);
            const cache = new LRUCache({
                maxSizeBytes: 1024 * 1.5,
            });
            await cache.set("repo1", "key1", "v1", largeValue);
            const statsAfterFirst = cache.getStats();
            assert.strictEqual(statsAfterFirst.entryCount, 1);
            await cache.set("repo1", "key2", "v1", largeValue);
            const statsAfterSecond = cache.getStats();
            assert.strictEqual(statsAfterSecond.entryCount, 1);
        });
    });
    describe("Cache clearing", () => {
        it("should clear all entries", async () => {
            const cache = new LRUCache();
            await cache.set("repo1", "key1", "v1", "value1");
            cache.set("repo1", "key2", "v1", "value2");
            cache.clear();
            assert.strictEqual(cache.has("repo1", "key1", "v1"), false);
            assert.strictEqual(cache.has("repo1", "key2", "v1"), false);
            assert.strictEqual(cache.getStats().entryCount, 0);
        });
    });
});
describe("Global cache functions", () => {
    describe("Cache key generation", () => {
        it("should generate symbol card cache keys", () => {
            const key = makeSymbolCardCacheKey("repo1", "symbol1", "v1");
            assert.strictEqual(key, "repo1:symbol1:v1");
        });
        it("should generate graph slice cache keys", () => {
            const key = makeGraphSliceCacheKey("repo1", "v1", ["sym1", "sym2"], {
                maxCards: 100,
                maxEstimatedTokens: 5000,
            });
            assert.strictEqual(key, "repo1:v1:sym1,sym2:100:5000");
        });
    });
});
//# sourceMappingURL=cache.test.js.map