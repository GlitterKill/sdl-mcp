import { describe, it } from "node:test";
import assert from "node:assert";
import {
  defaultConfidenceForStrategy,
  calibrateResolutionConfidence,
} from "../../src/indexer/edge-confidence.js";

describe("defaultConfidenceForStrategy", () => {
  it("returns 0.92 for exact", () => {
    assert.strictEqual(defaultConfidenceForStrategy("exact"), 0.92);
  });

  it("returns 0.72 for heuristic", () => {
    assert.strictEqual(defaultConfidenceForStrategy("heuristic"), 0.72);
  });

  it("returns 0.2 for unresolved", () => {
    assert.strictEqual(defaultConfidenceForStrategy("unresolved"), 0.2);
  });

  it("returns 0.5 for unknown strategy", () => {
    assert.strictEqual(defaultConfidenceForStrategy("unknown" as any), 0.5);
  });
});

describe("calibrateResolutionConfidence", () => {
  it("defaults to heuristic when resolved=true and no strategy", () => {
    const result = calibrateResolutionConfidence({ isResolved: true });
    assert.strictEqual(result.strategy, "heuristic");
    assert.strictEqual(result.confidence, 0.72);
  });

  it("defaults to unresolved when resolved=false and no strategy", () => {
    const result = calibrateResolutionConfidence({ isResolved: false });
    assert.strictEqual(result.strategy, "unresolved");
    assert.strictEqual(result.confidence, 0.2);
  });

  it("uses explicit strategy when provided", () => {
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
    });
    assert.strictEqual(result.strategy, "exact");
    assert.strictEqual(result.confidence, 0.92);
  });

  it("uses baseConfidence when provided", () => {
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
      baseConfidence: 0.5,
    });
    assert.strictEqual(result.confidence, 0.5);
  });

  it("applies ambiguity penalty for candidateCount > 1", () => {
    // candidateCount=5 → penalty = min(0.35, 5*0.04) = 0.20
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
      candidateCount: 5,
    });
    assert.ok(Math.abs(result.confidence - 0.72) < 0.001);
  });

  it("caps ambiguity penalty at 0.35", () => {
    // candidateCount=100 → penalty = min(0.35, 100*0.04) = 0.35
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
      candidateCount: 100,
    });
    assert.ok(Math.abs(result.confidence - 0.57) < 0.001);
  });

  it("no ambiguity penalty for candidateCount=1", () => {
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
      candidateCount: 1,
    });
    assert.strictEqual(result.confidence, 0.92);
  });

  it("clamps confidence to [0, 1]", () => {
    const result = calibrateResolutionConfidence({
      isResolved: false,
      strategy: "unresolved",
      candidateCount: 100,
    });
    // 0.2 - 0.35 = -0.15 → clamped to 0
    assert.strictEqual(result.confidence, 0);
  });

  it("combined: resolved exact + 3 candidates", () => {
    // baseline=0.92, penalty=min(0.35, 3*0.04)=0.12, result=0.80
    const result = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "exact",
      candidateCount: 3,
    });
    assert.ok(Math.abs(result.confidence - 0.8) < 0.001);
  });
});
