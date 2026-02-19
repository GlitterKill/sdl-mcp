import { describe, it } from "node:test";
import assert from "node:assert";
import { LRUCache } from "../../dist/graph/cache.js";

describe("LRU Cache", () => {
  it("should store and retrieve values", async () => {
    const cache = new LRUCache<string>({ maxEntries: 10, maxSizeBytes: 10000 });
    await cache.set("repo", "id1", "v1", "value1");
    assert.strictEqual(cache.get("repo", "id1", "v1"), "value1");
  });

  it("should track hits and misses", async () => {
    const cache = new LRUCache<string>({ maxEntries: 10, maxSizeBytes: 10000 });
    await cache.set("repo", "id1", "v1", "value1");

    cache.get("repo", "id1", "v1");
    cache.get("repo", "missing", "v1");

    const stats = cache.getStats();
    assert.strictEqual(stats.hits, 1);
    assert.strictEqual(stats.misses, 1);
  });

  it("should evict LRU entry when max entries exceeded", async () => {
    const cache = new LRUCache<string>({ maxEntries: 2, maxSizeBytes: 100000 });
    await cache.set("repo", "id1", "v1", "first");
    await cache.set("repo", "id2", "v1", "second");
    await cache.set("repo", "id3", "v1", "third");

    // id1 should have been evicted (LRU)
    assert.strictEqual(cache.get("repo", "id1", "v1"), undefined);
    assert.strictEqual(cache.get("repo", "id2", "v1"), "second");
    assert.strictEqual(cache.get("repo", "id3", "v1"), "third");
  });

  it("should promote accessed entry and evict correct LRU", async () => {
    const cache = new LRUCache<string>({ maxEntries: 2, maxSizeBytes: 100000 });
    await cache.set("repo", "id1", "v1", "first");
    await cache.set("repo", "id2", "v1", "second");

    // Access id1 to promote it
    cache.get("repo", "id1", "v1");

    // Now id2 is LRU; adding id3 should evict id2
    await cache.set("repo", "id3", "v1", "third");

    assert.strictEqual(cache.get("repo", "id1", "v1"), "first");
    assert.strictEqual(cache.get("repo", "id2", "v1"), undefined);
    assert.strictEqual(cache.get("repo", "id3", "v1"), "third");
  });

  it("should invalidate entries by version", async () => {
    const cache = new LRUCache<string>({ maxEntries: 10, maxSizeBytes: 100000 });
    await cache.set("repo", "id1", "v1", "old");
    await cache.set("repo", "id2", "v1", "also-old");
    await cache.set("repo", "id3", "v2", "keep");

    cache.invalidateVersion("v1");

    assert.strictEqual(cache.get("repo", "id1", "v1"), undefined);
    assert.strictEqual(cache.get("repo", "id2", "v1"), undefined);
    assert.strictEqual(cache.get("repo", "id3", "v2"), "keep");
  });

  it("should clear all entries", async () => {
    const cache = new LRUCache<string>({ maxEntries: 10, maxSizeBytes: 100000 });
    await cache.set("repo", "id1", "v1", "value");

    cache.clear();

    assert.strictEqual(cache.get("repo", "id1", "v1"), undefined);
    const stats = cache.getStats();
    assert.strictEqual(stats.entryCount, 0);
    assert.strictEqual(stats.currentSize, 0);
  });
});
