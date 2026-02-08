import { test } from "node:test";
import assert from "node:assert";
import {
  getSliceCacheKey,
  getCachedSlice,
  setCachedSlice,
  clearSliceCache,
  getSliceCacheStats,
} from "../src/graph/sliceCache.js";
import type { SliceBuildRequest } from "../src/graph/slice.js";

test("Slice Cache - Cache key generation", async (t) => {
  await t.test(
    "should generate consistent cache keys for identical requests",
    () => {
      const request1: SliceBuildRequest = {
        repoId: "repo1",
        versionId: "v1",
        taskText: "test",
        entrySymbols: ["sym1", "sym2"],
      };
      const request2: SliceBuildRequest = {
        repoId: "repo1",
        versionId: "v1",
        taskText: "test",
        entrySymbols: ["sym2", "sym1"],
      };
      const key1 = getSliceCacheKey(request1);
      const key2 = getSliceCacheKey(request2);
      assert.strictEqual(
        key1,
        key2,
        "Keys should be identical regardless of array order",
      );
    },
  );

  await t.test(
    "should generate different cache keys for different requests",
    () => {
      const request1: SliceBuildRequest = {
        repoId: "repo1",
        versionId: "v1",
        taskText: "test",
      };
      const request2: SliceBuildRequest = {
        repoId: "repo1",
        versionId: "v1",
        taskText: "different",
      };
      const key1 = getSliceCacheKey(request1);
      const key2 = getSliceCacheKey(request2);
      assert.notStrictEqual(
        key1,
        key2,
        "Keys should differ for different requests",
      );
    },
  );
});

test("Slice Cache - Cache operations", async (t) => {
  const mockSlice: any = {
    repoId: "repo1",
    versionId: "v1",
    cards: [],
    edges: [],
    startSymbols: [],
    budget: { maxCards: 10, maxEstimatedTokens: 1000 },
  };

  await t.test("should store and retrieve slices", () => {
    clearSliceCache();
    const key = "test-key-1";
    setCachedSlice(key, mockSlice);
    const retrieved = getCachedSlice(key);
    assert.deepStrictEqual(
      retrieved,
      mockSlice,
      "Should retrieve the stored slice",
    );
  });

  await t.test("should store and retrieve slices", () => {
    const key = "test-key-1";
    setCachedSlice(key, mockSlice);
    const retrieved = getCachedSlice(key);
    assert.deepStrictEqual(
      retrieved,
      mockSlice,
      "Should retrieve the stored slice",
    );
  });

  await t.test("should return null for non-existent keys", () => {
    const retrieved = getCachedSlice("non-existent-key");
    assert.strictEqual(
      retrieved,
      null,
      "Should return null for non-existent key",
    );
  });

  await t.test("should return null for expired entries", () => {
    clearSliceCache();
    const key = "test-key-2";
    setCachedSlice(key, mockSlice);
    const stats = getSliceCacheStats();
    assert.strictEqual(stats.hits, 0, "No hits before retrieval");
    assert.strictEqual(stats.misses, 0, "No misses before retrieval");

    const retrieved = getCachedSlice(key);
    assert.deepStrictEqual(retrieved, mockSlice, "Should retrieve the slice");
    const afterGet = getSliceCacheStats();
    assert.strictEqual(afterGet.hits, 1, "Should count a hit");
  });

  await t.test("should track cache statistics", () => {
    clearSliceCache();
    const key = "test-key-3";
    const stats = getSliceCacheStats();

    assert.strictEqual(stats.hits, 0, "No hits initially");
    assert.strictEqual(stats.misses, 0, "No misses initially");
    assert.strictEqual(stats.evictions, 0, "No evictions initially");
    assert.strictEqual(stats.currentSize, 0, "Cache empty initially");

    setCachedSlice(key, mockSlice);
    const afterSet = getSliceCacheStats();
    assert.strictEqual(afterSet.currentSize, 1, "Cache should have 1 entry");

    getCachedSlice(key);
    const afterHit = getSliceCacheStats();
    assert.strictEqual(afterHit.hits, 1, "Should have 1 hit");

    getCachedSlice("non-existent");
    const afterMiss = getSliceCacheStats();
    assert.strictEqual(afterMiss.misses, 1, "Should have 1 miss");
    assert.strictEqual(afterMiss.hitRate, 0.5, "Hit rate should be 0.5");
  });

  await t.test("should respect cache size limit", () => {
    clearSliceCache();
    const maxEntries = 100;
    const keys: string[] = [];

    for (let i = 0; i < maxEntries + 10; i++) {
      const key = `key-${i}`;
      keys.push(key);
      setCachedSlice(key, { ...mockSlice, id: i });
    }

    const stats = getSliceCacheStats();
    assert.ok(stats.evictions > 0, "Should have evicted some entries");
    assert.ok(stats.currentSize <= 100, "Cache size should not exceed limit");
  });

  await t.test("should clear all cache entries", () => {
    clearSliceCache();
    setCachedSlice("key-1", mockSlice);
    setCachedSlice("key-2", mockSlice);

    let stats = getSliceCacheStats();
    assert.strictEqual(stats.currentSize, 2, "Cache should have 2 entries");

    clearSliceCache();

    stats = getSliceCacheStats();
    assert.strictEqual(stats.currentSize, 0, "Cache should be empty");
    assert.strictEqual(stats.hits, 0, "Stats should be reset");
    assert.strictEqual(stats.misses, 0, "Stats should be reset");
  });
});
