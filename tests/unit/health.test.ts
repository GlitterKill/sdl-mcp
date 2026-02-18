import { describe, it } from "node:test";
import assert from "node:assert";
import { computeHealthScore } from "../../src/mcp/health.js";

describe("health scoring", () => {
  it("returns unavailable for empty repos", () => {
    const result = computeHealthScore({
      indexedFiles: 0,
      totalEligibleFiles: 0,
      indexErrors: 0,
      totalFiles: 0,
      resolvedCallEdges: 0,
      totalCallEdges: 0,
      minutesSinceLastIndex: null,
      minIndexedFiles: 1,
      minIndexedSymbols: 1,
      indexedSymbols: 0,
    });

    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, 0);
  });

  it("computes a bounded weighted score and components", () => {
    const result = computeHealthScore({
      indexedFiles: 90,
      totalEligibleFiles: 100,
      indexErrors: 2,
      totalFiles: 100,
      resolvedCallEdges: 80,
      totalCallEdges: 100,
      minutesSinceLastIndex: 60,
      minIndexedFiles: 1,
      minIndexedSymbols: 1,
      indexedSymbols: 300,
    });

    assert.strictEqual(result.available, true);
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.ok(result.components.freshness > 0);
    assert.ok(result.components.coverage > 0);
    assert.ok(result.components.errorRate > 0);
    assert.ok(result.components.edgeQuality > 0);
  });

  it("reaches 100 for perfect health", () => {
    const result = computeHealthScore({
      indexedFiles: 100,
      totalEligibleFiles: 100,
      indexErrors: 0,
      totalFiles: 100,
      resolvedCallEdges: 20,
      totalCallEdges: 20,
      minutesSinceLastIndex: 0,
      minIndexedFiles: 1,
      minIndexedSymbols: 1,
      indexedSymbols: 200,
    });

    assert.strictEqual(result.score, 100);
  });
});
