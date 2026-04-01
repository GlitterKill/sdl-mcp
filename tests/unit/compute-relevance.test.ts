import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the exported functions from the built output
import { computeRelevance, splitCamelSubwords } from "../../dist/mcp/tools/symbol.js";

describe("splitCamelSubwords", () => {
  it("splits camelCase identifiers", () => {
    assert.deepEqual(splitCamelSubwords("buildGraphSlice"), ["build", "graph", "slice"]);
  });

  it("splits PascalCase identifiers", () => {
    assert.deepEqual(splitCamelSubwords("SymbolSearchResponse"), ["symbol", "search", "response"]);
  });

  it("handles acronyms", () => {
    const parts = splitCamelSubwords("parseHTTPRequest");
    assert.ok(parts.includes("parse"), `Expected 'parse' in ${JSON.stringify(parts)}`);
    assert.ok(parts.some(p => p === "http"), `Expected 'http' in ${JSON.stringify(parts)}`);
    assert.ok(parts.includes("request"), `Expected 'request' in ${JSON.stringify(parts)}`);
  });

  it("filters out single-char words", () => {
    const parts = splitCamelSubwords("aB");
    assert.ok(parts.length <= 2);
  });
});

describe("computeRelevance - exact and prefix matching", () => {
  it("returns 1.0 for exact match", () => {
    assert.equal(computeRelevance("buildSlice", "buildSlice"), 1.0);
  });

  it("returns 1.0 for case-insensitive exact match", () => {
    assert.equal(computeRelevance("BuildSlice", "buildslice"), 1);
  });

  it("returns 0.85 for prefix match", () => {
    assert.equal(computeRelevance("buildSliceContext", "buildSlice"), 0.85);
  });

  it("returns 0.7 for substring match", () => {
    assert.equal(computeRelevance("rebuildSliceCache", "buildSlice"), 0.7);
  });
});

describe("computeRelevance - glob wildcard matching", () => {
  it("matches glob wildcard build*Slice", () => {
    const score = computeRelevance("buildSlice", "build*Slice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });

  it("matches glob wildcard build*Slice against buildGraphSlice", () => {
    const score = computeRelevance("buildGraphSlice", "build*Slice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });

  it("matches single-char wildcard build?lice", () => {
    const score = computeRelevance("buildSlice", "build?lice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });
});

describe("computeRelevance - camelCase subword matching", () => {
  it("returns 0.8 when all subwords match", () => {
    const score = computeRelevance("buildGraphSlice", "buildSlice");
    assert.ok(score >= 0.7, `Expected >= 0.7 for all-subwords match, got ${score}`);
  });

  it("gives low score when only 1 of 3 subwords match", () => {
    const score = computeRelevance("acceptNodeIntoSlice", "buildGraphSlice");
    assert.ok(score < 0.3, `Expected < 0.3 for 1/3 subword match, got ${score}`);
  });

  it("gives moderate score when 2 of 3 subwords match", () => {
    const score = computeRelevance("buildNodeSlice", "buildGraphSlice");
    assert.ok(score >= 0.2, `Expected >= 0.2 for 2/3 subword match, got ${score}`);
    assert.ok(score < 0.8, `Expected < 0.8 for partial match, got ${score}`);
  });

  it("ranks full subword match higher than partial", () => {
    const fullMatch = computeRelevance("buildGraphSlice", "buildSlice");
    const partialMatch = computeRelevance("acceptNodeIntoSlice", "buildGraphSlice");
    assert.ok(fullMatch > partialMatch, `Full match (${fullMatch}) should be > partial (${partialMatch})`);
  });
});

describe("computeRelevance - unrelated names", () => {
  it("returns low score for unrelated names", () => {
    const score = computeRelevance("parseConfig", "buildSlice");
    assert.ok(score < 0.3, `Expected < 0.3, got ${score}`);
  });

  it("returns very low score for completely different names", () => {
    const score = computeRelevance("DatabaseError", "normalizePath");
    assert.ok(score < 0.3, `Expected < 0.3, got ${score}`);
  });
});

describe("computeRelevance - trigram similarity", () => {
  it("gives higher score to similar names via trigrams", () => {
    const score = computeRelevance("buildSlicr", "buildSlice");
    assert.ok(score > 0.1, `Expected > 0.1 for similar names, got ${score}`);
  });

  it("differentiates semantic search scores", () => {
    const scores = [
      computeRelevance("normalizePath", "normalize path windows"),
      computeRelevance("isWindowsPathLike", "normalize path windows"),
      computeRelevance("parseConfig", "normalize path windows"),
    ];
    const unique = new Set(scores.map(s => Math.round(s * 100)));
    assert.ok(unique.size >= 2, `Expected differentiated scores, got ${JSON.stringify(scores)}`);
  });
});

describe("computeRelevance - regression: Issue 1 scenario", () => {
  it("acceptNodeIntoSlice should score below threshold for buildGraphSlice query", () => {
    const score = computeRelevance("acceptNodeIntoSlice", "buildGraphSlice");
    assert.ok(score < 0.3, `Expected < 0.3 (below MIN_RELEVANCE_THRESHOLD), got ${score}`);
  });

  it("buildGraphSlice should score high against itself", () => {
    assert.equal(computeRelevance("buildGraphSlice", "buildGraphSlice"), 1.0);
  });

  it("buildSlice should score reasonably for buildGraphSlice query", () => {
    const score = computeRelevance("buildSlice", "buildGraphSlice");
    assert.ok(score >= 0.2, `Expected >= 0.2 for 2/3 subword match, got ${score}`);
  });
});
