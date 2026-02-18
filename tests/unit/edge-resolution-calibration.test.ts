import { describe, it } from "node:test";
import assert from "node:assert";
import {
  calibrateResolutionConfidence,
  defaultConfidenceForStrategy,
} from "../../src/indexer/edge-confidence.js";

describe("edge resolution calibration", () => {
  it("returns expected defaults by strategy", () => {
    assert.strictEqual(defaultConfidenceForStrategy("exact"), 0.92);
    assert.strictEqual(defaultConfidenceForStrategy("heuristic"), 0.72);
    assert.strictEqual(defaultConfidenceForStrategy("unresolved"), 0.2);
  });

  it("penalizes ambiguous candidates", () => {
    const noAmbiguity = calibrateResolutionConfidence({
      isResolved: true,
      strategy: "heuristic",
      baseConfidence: 0.8,
      candidateCount: 1,
    });
    const ambiguous = calibrateResolutionConfidence({
      isResolved: false,
      strategy: "unresolved",
      baseConfidence: 0.8,
      candidateCount: 5,
    });
    assert.ok(ambiguous.confidence < noAmbiguity.confidence);
  });
});
