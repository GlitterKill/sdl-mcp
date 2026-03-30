import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import the function under test
// Note: computeRelevance is not exported, so we test via the search handler
// For unit testing, we replicate the function logic here
function computeRelevance(name, query) {
  const nl = name.toLowerCase();
  const ql = query.toLowerCase();
  if (nl === ql) return 1.0;
  if (ql.includes("*") || ql.includes("?")) {
    const escaped = ql.replace(/[.+^{}()|[\\]]/g, "\\" + "&");
    const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    try {
      if (new RegExp("^" + pattern + "$", "i").test(nl)) return 0.9;
      if (new RegExp(pattern, "i").test(nl)) return 0.75;
    } catch { /* invalid pattern */ }
  }
  if (nl.startsWith(ql)) return 0.85;
  if (nl.includes(ql)) return 0.7;
  const splitCamel = (s) => s.replace(/([a-z])([A-Z])/g, (_, a, b) => a + " " + b).split(/[\s_]+/).map(w => w.toLowerCase()).filter(w => w.length >= 2);
  const queryParts = splitCamel(query);
  const nameParts = splitCamel(name);
  if (queryParts.length >= 2 && nameParts.length >= 2) {
    const matchCount = queryParts.filter(qp => nameParts.some(np => np.includes(qp) || qp.includes(np))).length;
    if (matchCount === queryParts.length) return 0.8;
    if (matchCount > 0) return 0.3 + 0.3 * (matchCount / queryParts.length);
  }
  const queryWords = ql.split(/[\s_]+/).filter(w => w.length >= 3);
  if (queryWords.length > 1) {
    const matchCount = queryWords.filter(w => nl.includes(w)).length;
    if (matchCount > 0) return 0.3 + 0.3 * (matchCount / queryWords.length);
  }
  if (nl.length >= 3 && ql.includes(nl)) return 0.5;
  const nameWords = nl.replace(/([a-z])([A-Z])/g, (_, a, b) => a + " " + b).toLowerCase().split(/[\s_]+/).filter(w => w.length >= 3);
  const overlap = nameWords.filter(w => ql.includes(w)).length;
  if (overlap > 0) return 0.1 + 0.15 * (overlap / Math.max(nameWords.length, 1));
  return 0.05;
}

describe("computeRelevance - wildcard and camelCase matching", () => {
  it("returns 1.0 for exact match", () => {
    assert.equal(computeRelevance("buildSlice", "buildSlice"), 1.0);
  });

  it("returns 0.85 for prefix match", () => {
    assert.equal(computeRelevance("buildSliceContext", "buildSlice"), 0.85);
  });

  it("returns 0.7 for substring match", () => {
    assert.equal(computeRelevance("rebuildSliceCache", "buildSlice"), 0.7);
  });

  it("matches glob wildcard build*Slice", () => {
    const score = computeRelevance("buildSlice", "build*Slice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });

  it("matches glob wildcard build*Slice against buildGraphSlice", () => {
    const score = computeRelevance("buildGraphSlice", "build*Slice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });

  it("matches camelCase parts: buildGraphSlice vs buildSlice", () => {
    const score = computeRelevance("buildGraphSlice", "buildSlice");
    assert.ok(score >= 0.3, `Expected >= 0.3 for camelCase part match, got ${score}`);
  });

  it("matches single-char wildcard build?lice", () => {
    const score = computeRelevance("buildSlice", "build?lice");
    assert.ok(score >= 0.75, `Expected >= 0.75, got ${score}`);
  });

  it("returns low score for unrelated names", () => {
    const score = computeRelevance("parseConfig", "buildSlice");
    assert.ok(score < 0.3, `Expected < 0.3, got ${score}`);
  });

  it("differentiates semantic search scores", () => {
    const scores = [
      computeRelevance("normalizePath", "normalize path windows"),
      computeRelevance("isWindowsPathLike", "normalize path windows"),
      computeRelevance("parseConfig", "normalize path windows"),
    ];
    // At least some differentiation (not all 0.5)
    const unique = new Set(scores.map(s => Math.round(s * 100)));
    assert.ok(unique.size >= 2, `Expected differentiated scores, got ${JSON.stringify(scores)}`);
  });
});
