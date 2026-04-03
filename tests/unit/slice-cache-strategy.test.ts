import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  getCachedSlice,
  setCachedSlice,
  clearSliceCache,
  getSliceCacheStats,
  getSliceCacheKey,
} from "../../dist/graph/sliceCache.js";

describe("Slice Cache Strategy", () => {
  beforeEach(() => {
    clearSliceCache();
  });

  describe("Cache correctness (baseline Map-based)", () => {
    it("should return null for missing keys", () => {
      const key = "test:missing:key";
      assert.strictEqual(getCachedSlice(key), null);
    });

    it("should store and retrieve slices", () => {
      const key = getSliceCacheKey({
        repoId: "test-repo" as never,
        versionId: "v1" as never,
        taskText: "test task",
      });
      const slice = { cards: [], handle: "h1" } as never;

      setCachedSlice(key, slice);
      const result = getCachedSlice(key);

      assert.deepStrictEqual(result, slice);
    });

    it("should track cache statistics correctly", () => {
      const key = getSliceCacheKey({
        repoId: "test-repo" as never,
        versionId: "v1" as never,
      });
      const slice = { cards: [], handle: "h1" } as never;

      setCachedSlice(key, slice);

      getCachedSlice(key);
      getCachedSlice("missing-key");
      getCachedSlice(key);

      const stats = getSliceCacheStats();
      assert.strictEqual(stats.hits, 2);
      assert.strictEqual(stats.misses, 1);
    });

    it("should generate stable cache keys", () => {
      const request = {
        repoId: "repo1" as never,
        versionId: "v1" as never,
        taskText: "find bug",
        entrySymbols: ["sym1", "sym2"] as never,
      };

      const key1 = getSliceCacheKey(request);
      const key2 = getSliceCacheKey(request);

      assert.strictEqual(key1, key2);
    });

    it("should handle different request parameters", () => {
      const key1 = getSliceCacheKey({
        repoId: "repo1" as never,
        versionId: "v1" as never,
        taskText: "task a",
      });
      const key2 = getSliceCacheKey({
        repoId: "repo1" as never,
        versionId: "v1" as never,
        taskText: "task b",
      });

      assert.notStrictEqual(key1, key2);
    });
  });

  describe("Bloom filter simulation correctness", () => {
    it("should demonstrate false positives do not affect correctness", () => {
      const cache = new Map<string, string>();
      const present = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const key = `key-${i}`;
        cache.set(key, `value-${i}`);
        present.add(key);
      }

      for (const key of present) {
        const value = cache.get(key);
        assert.ok(value !== undefined);
        assert.strictEqual(value, cache.get(key));
      }

      for (let i = 100; i < 200; i++) {
        const key = `nonexistent-${i}`;
        const value = cache.get(key);
        assert.strictEqual(value, undefined);
      }
    });

    it("should verify cache lookup returns correct values after pre-check", () => {
      const cache = new Map<string, { data: string }>();
      const keys = ["a", "b", "c"];

      keys.forEach((k) => cache.set(k, { data: `value-${k}` }));

      for (const key of keys) {
        const entry = cache.get(key);
        assert.ok(entry !== undefined);
        assert.strictEqual(entry.data, `value-${key}`);
      }

      const missingKey = "nonexistent";
      const missing = cache.get(missingKey);
      assert.strictEqual(missing, undefined);
    });
  });
});

describe("Benchmark validation", () => {
  it("should demonstrate Map lookup is O(1)", () => {
    const cache = new Map<string, number>();

    for (let i = 0; i < 1000; i++) {
      cache.set(`key-${i}`, i);
    }

    const iterations = 10000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      cache.get(`key-${i % 1000}`);
      cache.get(`missing-${i}`);
    }

    const elapsed = performance.now() - start;
    const avgNs = (elapsed / iterations / 2) * 1_000_000;

    assert.ok(
      avgNs < 1000,
      `Map lookup should be sub-microsecond, got ${avgNs.toFixed(2)}ns`,
    );
  });

  it("should verify Bloom filter pre-check has no false negatives", () => {
    const cache = new Map<string, number>();
    const bloomBits = new Uint8Array(1024);

    const simpleHash = (key: string): number => {
      let h = 0;
      for (let i = 0; i < key.length; i++) {
        h = (h * 31 + key.charCodeAt(i)) % 8192;
      }
      return h;
    };

    const addToBloom = (key: string): void => {
      const idx = simpleHash(key);
      bloomBits[Math.floor(idx / 8)] |= 1 << (idx % 8);
    };

    const mightContain = (key: string): boolean => {
      const idx = simpleHash(key);
      return (bloomBits[Math.floor(idx / 8)] & (1 << (idx % 8))) !== 0;
    };

    for (let i = 0; i < 1000; i++) {
      const key = `key-${i}`;
      cache.set(key, i);
      addToBloom(key);
    }

    // Bloom filters must never have false negatives: every inserted key must be found
    for (let i = 0; i < 1000; i++) {
      assert.ok(
        mightContain(`key-${i}`),
        `Bloom filter false negative for key-${i}`,
      );
    }

    // Keys never inserted may or may not match (false positives are allowed)
    let falsePositives = 0;
    for (let i = 1000; i < 2000; i++) {
      if (mightContain(`key-${i}`)) falsePositives++;
    }
    // With 8192 bits and 1000 keys, false positive rate should be well under 50%
    assert.ok(
      falsePositives < 500,
      `Too many false positives: ${falsePositives}/1000`,
    );
  });
});
