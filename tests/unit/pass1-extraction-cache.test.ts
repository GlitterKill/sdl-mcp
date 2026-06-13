import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getPass1ExtractionCacheStats,
  getPass1ExtractionCacheTargetCoverageStats,
  PASS1_EXTRACTION_CACHE_MAX_ENTRIES,
  PASS1_EXTRACTION_C_SOURCE_PROTECTED_MAX_BYTES,
  storePass1Extraction,
  type Pass1ExtractionCache,
  type Pass1ExtractionEntry,
} from "../../dist/indexer/pass2/types.js";

function entry(content = "x"): Pass1ExtractionEntry {
  return {
    symbolsWithNodeIds: [],
    imports: [],
    calls: [],
    content,
  };
}

describe("pass1 extraction cache", () => {
  it("keeps byte-bounded C source entries outside the normal shared cap", () => {
    const cache: Pass1ExtractionCache = new Map();

    for (let index = 0; index < PASS1_EXTRACTION_CACHE_MAX_ENTRIES; index++) {
      storePass1Extraction(cache, `src/file-${index}.ts`, entry());
    }
    storePass1Extraction(cache, "src/kept.c", entry());
    storePass1Extraction(cache, "include/kept.h", entry());
    storePass1Extraction(cache, "src/new.ts", entry());

    assert.equal(cache.has("src/file-0.ts"), false);
    assert.equal(cache.has("src/kept.c"), true);
    assert.equal(cache.has("include/kept.h"), true);
    assert.equal(cache.has("src/new.ts"), true);
    assert.equal(cache.size, PASS1_EXTRACTION_CACHE_MAX_ENTRIES + 2);

    const stats = getPass1ExtractionCacheStats(cache);
    assert.equal(stats.protectedEntries, 2);
    assert.equal(stats.protectedStores, 2);
    assert.equal(stats.unprotectedEntries, PASS1_EXTRACTION_CACHE_MAX_ENTRIES);
    assert.equal(stats.unprotectedEvictions, 1);
    assert.equal(stats.buckets.c.entries, 1);
    assert.equal(stats.buckets.h.entries, 1);
    assert.equal(stats.buckets.other.evictions, 1);
  });

  it("evicts protected C source entries when their byte budget is exceeded", () => {
    const cache: Pass1ExtractionCache = new Map();

    storePass1Extraction(
      cache,
      "src/huge.c",
      entry("x".repeat(PASS1_EXTRACTION_C_SOURCE_PROTECTED_MAX_BYTES + 1)),
    );

    assert.equal(cache.has("src/huge.c"), false);
    assert.equal(cache.size, 0);

    const stats = getPass1ExtractionCacheStats(cache);
    assert.equal(stats.protectedStores, 1);
    assert.equal(stats.protectedEvictions, 1);
    assert.equal(stats.protectedEntries, 0);
    assert.equal(
      stats.protectedEvictionBytes,
      PASS1_EXTRACTION_C_SOURCE_PROTECTED_MAX_BYTES + 1,
    );
    assert.equal(stats.buckets.c.evictions, 1);
  });

  it("classifies target coverage as live, evicted, or never stored", () => {
    const cache: Pass1ExtractionCache = new Map();

    for (let index = 0; index < PASS1_EXTRACTION_CACHE_MAX_ENTRIES; index++) {
      storePass1Extraction(cache, `src/file-${index}.cpp`, entry("xx"));
    }
    storePass1Extraction(cache, "src/live.cpp", entry("xxxx"));
    storePass1Extraction(cache, "src/live.c", entry("xxx"));

    const coverage = getPass1ExtractionCacheTargetCoverageStats(
      cache,
      ["src/file-0.cpp", "src/live.cpp", "src/live.c", "src/never.cpp"],
      new Map([
        ["src/file-0.cpp", 2],
        ["src/live.cpp", 4],
        ["src/live.c", 3],
        ["src/never.cpp", 5],
      ]),
    );

    assert.equal(coverage.targets, 4);
    assert.equal(coverage.live, 2);
    assert.equal(coverage.evicted, 1);
    assert.equal(coverage.neverStored, 1);
    assert.equal(coverage.targetBytes, 14);
    assert.equal(coverage.liveBytes, 7);
    assert.equal(coverage.evictedBytes, 2);
    assert.equal(coverage.neverStoredBytes, 5);
    assert.equal(coverage.buckets.cpp.targets, 3);
    assert.equal(coverage.buckets.cpp.live, 1);
    assert.equal(coverage.buckets.cpp.evicted, 1);
    assert.equal(coverage.buckets.cpp.neverStored, 1);
    assert.equal(coverage.buckets.cpp.targetBytes, 11);
    assert.equal(coverage.buckets.cpp.liveBytes, 4);
    assert.equal(coverage.buckets.cpp.evictedBytes, 2);
    assert.equal(coverage.buckets.cpp.neverStoredBytes, 5);
    assert.equal(coverage.buckets.c.targets, 1);
    assert.equal(coverage.buckets.c.live, 1);
    assert.equal(coverage.buckets.c.liveBytes, 3);
  });
});
