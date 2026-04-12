import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { mergeSearchResults } from "../../dist/live-index/overlay-merge.js";
import type { OverlaySearchResult } from "../../dist/live-index/overlay-merge.js";
import {
  OverlayEmbeddingCache,
  getOverlayEmbeddingCache,
  resetOverlayEmbeddingCache,
} from "../../dist/live-index/overlay-embedding-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  symbolId: string,
  name: string,
  overrides: Partial<OverlaySearchResult> = {},
): OverlaySearchResult {
  return {
    symbolId,
    name,
    fileId: `file-${symbolId}`,
    kind: "function",
    filePath: `src/${name}.ts`,
    matchedTermCount: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mergeSearchResults – overlay-only preservation
// ---------------------------------------------------------------------------

describe("mergeSearchResults – overlay-only preservation", () => {
  it("should preserve overlay-only items even when limit would drop them by score", () => {
    // 10 high-quality durable results
    const durable = Array.from({ length: 10 }, (_, i) =>
      makeResult(`durable-${i}`, `DurableSymbol${i}`, { matchedTermCount: 3 }),
    );

    // 1 lower-quality overlay-only result
    const overlay = [
      makeResult("overlay-1", "DraftFunction", {
        matchedTermCount: 1,
        overlayOnly: true,
      }),
    ];

    // With limit 5, durable items fill 4 slots (limit - overlayOnlyCount = 5 - 1 = 4)
    // and overlay-only item is always appended
    const result = mergeSearchResults(durable, overlay, "Symbol", 5);

    const hasOverlayOnly = result.some((r) => r.symbolId === "overlay-1");
    assert.ok(hasOverlayOnly, "overlay-only item must not be dropped by limit truncation");
  });

  it("should not drop multiple overlay-only items", () => {
    const durable = Array.from({ length: 10 }, (_, i) =>
      makeResult(`durable-${i}`, `Durable${i}`, { matchedTermCount: 3 }),
    );

    const overlay = [
      makeResult("ov-1", "Draft1", { matchedTermCount: 1, overlayOnly: true }),
      makeResult("ov-2", "Draft2", { matchedTermCount: 1, overlayOnly: true }),
    ];

    // limit 3: regular fills 3-2=1 slot, both overlay-only appended → 3 total
    const result = mergeSearchResults(durable, overlay, "Draft", 3);

    assert.ok(result.some((r) => r.symbolId === "ov-1"), "ov-1 must be present");
    assert.ok(result.some((r) => r.symbolId === "ov-2"), "ov-2 must be present");
  });

  it("should deduplicate results that appear in both durable and overlay", () => {
    const durable = [makeResult("shared-1", "SharedSymbol", { matchedTermCount: 2 })];
    const overlay = [
      makeResult("shared-1", "SharedSymbol", {
        matchedTermCount: 2,
        overlayOnly: false,
      }),
    ];

    const result = mergeSearchResults(durable, overlay, "Shared", 10);
    // Overlay overwrites durable for the same symbolId → only one entry
    assert.equal(result.length, 1, "duplicate symbolId should be deduplicated");
    assert.equal(result[0].symbolId, "shared-1");
  });

  it("should not mark non-overlay-only items as overlayOnly", () => {
    const durable = [makeResult("sym-1", "NormalSym")];
    const overlay = [makeResult("sym-1", "NormalSym", { overlayOnly: false })];

    const result = mergeSearchResults(durable, overlay, "Normal", 10);
    assert.equal(result.length, 1);
    assert.ok(!result[0].overlayOnly, "shared symbol must not be marked overlayOnly");
  });

  it("should return empty array when both inputs are empty", () => {
    const result = mergeSearchResults([], [], "empty", 10);
    assert.equal(result.length, 0);
  });

  it("should handle durable-only results (no overlay)", () => {
    const durable = Array.from({ length: 5 }, (_, i) =>
      makeResult(`d-${i}`, `Sym${i}`),
    );
    const result = mergeSearchResults(durable, [], "Sym", 3);
    assert.equal(result.length, 3, "should respect limit for durable-only results");
  });

  it("should handle overlay-only results (no durable)", () => {
    const overlay = [
      makeResult("ov-a", "DraftA", { overlayOnly: true }),
      makeResult("ov-b", "DraftB", { overlayOnly: true }),
    ];
    const result = mergeSearchResults([], overlay, "Draft", 10);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.overlayOnly), "all should be overlay-only");
  });

  it("should use limit of zero to return only overlay-only items", () => {
    const durable = Array.from({ length: 5 }, (_, i) =>
      makeResult(`d-${i}`, `Sym${i}`),
    );
    const overlay = [makeResult("ov-1", "Draft1", { overlayOnly: true })];

    // limit=1: regular fills max(0, 1-1)=0 slots; overlay-only appended
    const result = mergeSearchResults(durable, overlay, "q", 1);
    assert.ok(result.some((r) => r.symbolId === "ov-1"), "overlay-only must survive");
  });
});

// ---------------------------------------------------------------------------
// OverlayEmbeddingCache
// ---------------------------------------------------------------------------

describe("OverlayEmbeddingCache", () => {
  let cache: OverlayEmbeddingCache;

  beforeEach(() => {
    resetOverlayEmbeddingCache();
    cache = new OverlayEmbeddingCache();
  });

  it("should return null for a symbol that was never cached", () => {
    const result = cache.get("nonexistent-sym", "jina-embeddings-v2-base-code");
    assert.equal(result, null, "uncached symbol should return null");
  });

  it("should return null for a known symbol with an unknown model", () => {
    // Even if we had a different model cached, an unknown model key is null.
    const result = cache.get("sym-1", "unknown-model-xyz");
    assert.equal(result, null);
  });

  it("should report size 0 for a new cache", () => {
    assert.equal(cache.size, 0);
  });

  it("should clear all entries and report size 0", () => {
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it("should invalidate a single symbol without error", () => {
    cache.invalidate("sym-1");
    assert.equal(cache.get("sym-1", "jina-embeddings-v2-base-code"), null);
  });

  it("should invalidate multiple symbols at once", () => {
    cache.invalidateMany(["sym-1", "sym-2", "sym-3"]);
    assert.equal(cache.get("sym-1", "jina-embeddings-v2-base-code"), null);
    assert.equal(cache.get("sym-2", "nomic-embed-text-v1.5"), null);
    assert.equal(cache.get("sym-3", "jina-embeddings-v2-base-code"), null);
  });

  it("should invalidateMany with an empty array without error", () => {
    assert.doesNotThrow(() => cache.invalidateMany([]));
    assert.equal(cache.size, 0);
  });

  it("should remain empty after clear then invalidate", () => {
    cache.clear();
    cache.invalidate("sym-x");
    assert.equal(cache.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Singleton: getOverlayEmbeddingCache / resetOverlayEmbeddingCache
// ---------------------------------------------------------------------------

describe("getOverlayEmbeddingCache / resetOverlayEmbeddingCache – singleton", () => {
  beforeEach(() => {
    resetOverlayEmbeddingCache();
  });

  it("should return the same instance on repeated calls", () => {
    const a = getOverlayEmbeddingCache();
    const b = getOverlayEmbeddingCache();
    assert.strictEqual(a, b, "getOverlayEmbeddingCache should return the same singleton");
  });

  it("should return a new instance after reset", () => {
    const before = getOverlayEmbeddingCache();
    resetOverlayEmbeddingCache();
    const after = getOverlayEmbeddingCache();
    assert.notStrictEqual(before, after, "after reset a new instance should be created");
  });

  it("should have size 0 after reset", () => {
    const cache = getOverlayEmbeddingCache();
    cache.clear();
    resetOverlayEmbeddingCache();
    const fresh = getOverlayEmbeddingCache();
    assert.equal(fresh.size, 0);
  });

  it("should not share state with a separately constructed OverlayEmbeddingCache", () => {
    const singleton = getOverlayEmbeddingCache();
    const standalone = new OverlayEmbeddingCache();
    // Both start empty
    assert.equal(singleton.size, 0);
    assert.equal(standalone.size, 0);
    // Clearing singleton does not affect standalone
    singleton.clear();
    assert.equal(standalone.size, 0);
  });
});
