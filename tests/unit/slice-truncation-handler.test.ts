import { describe, it } from "node:test";
import assert from "node:assert";
import {
  computeMinCardsForDynamicCap,
  shouldTightenDynamicCardCap,
  buildTruncationInfo,
  DYNAMIC_CAP_MIN_CARDS,
  type DynamicCapState,
} from "../../src/graph/slice/truncation-handler.js";

describe("computeMinCardsForDynamicCap", () => {
  it("returns DYNAMIC_CAP_MIN_CARDS when budget is large and no entries", () => {
    const result = computeMinCardsForDynamicCap(100, 0);
    assert.strictEqual(result, DYNAMIC_CAP_MIN_CARDS);
  });

  it("returns entryFloor when entries exceed DYNAMIC_CAP_MIN_CARDS", () => {
    // entryFloor = 10 + 2 = 12, min(100,12) = 12, max(6, 12) = 12
    const result = computeMinCardsForDynamicCap(100, 10);
    assert.strictEqual(result, 12);
  });

  it("caps at budget when budget is very small", () => {
    const result = computeMinCardsForDynamicCap(3, 0);
    // min(3, 6) = 3, max(3, 3) = 3
    assert.strictEqual(result, 3);
  });

  it("handles budget smaller than entry floor", () => {
    // entryFloor = 5+2=7, min(4, 6)=4, min(4, 7)=4, max(4,4)=4
    const result = computeMinCardsForDynamicCap(4, 5);
    assert.strictEqual(result, 4);
  });
});

describe("shouldTightenDynamicCardCap", () => {
  const baseState: DynamicCapState = {
    sliceSize: 20,
    minCardsForDynamicCap: 6,
    highConfidenceCards: 15,
    requiredEntryCoverage: 5,
    coveredEntrySymbols: 5,
    recentAcceptedScores: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3],
    nextFrontierScore: 0.01,
  };

  it("returns false when sliceSize < minCardsForDynamicCap", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({ ...baseState, sliceSize: 3 }),
      false,
    );
  });

  it("returns false when nextFrontierScore is null", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({ ...baseState, nextFrontierScore: null }),
      false,
    );
  });

  it("returns false when recentAcceptedScores is empty", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({
        ...baseState,
        recentAcceptedScores: [],
      }),
      false,
    );
  });

  it("returns false when highConfidenceRatio < 0.6", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({
        ...baseState,
        highConfidenceCards: 5,
        sliceSize: 20,
      }),
      false,
    );
  });

  it("returns false when entry coverage is insufficient", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({
        ...baseState,
        coveredEntrySymbols: 2,
        requiredEntryCoverage: 5,
      }),
      false,
    );
  });

  it("returns true when frontier score drops below threshold", () => {
    // nextFrontierScore=0.01 is very low, should trigger tightening
    assert.strictEqual(shouldTightenDynamicCardCap(baseState), true);
  });

  it("returns false when frontier score is high enough", () => {
    assert.strictEqual(
      shouldTightenDynamicCardCap({
        ...baseState,
        nextFrontierScore: 0.9,
      }),
      false,
    );
  });

  it("skips entry coverage check when requiredEntryCoverage is 0", () => {
    const result = shouldTightenDynamicCardCap({
      ...baseState,
      requiredEntryCoverage: 0,
      coveredEntrySymbols: 0,
    });
    assert.strictEqual(result, true);
  });
});

describe("buildTruncationInfo", () => {
  it("returns undefined when not truncated", () => {
    assert.strictEqual(buildTruncationInfo(false, 0, 0, 0), undefined);
  });

  it("returns correct TruncationInfo when truncated", () => {
    const info = buildTruncationInfo(true, 10, 50, 2000);
    assert.ok(info !== undefined);
    assert.strictEqual(info!.truncated, true);
    assert.strictEqual(info!.droppedCards, 10);
    assert.strictEqual(info!.droppedEdges, 10);
    assert.deepStrictEqual(info!.howToResume, { type: "token", value: 2000 });
  });

  it("droppedEdges is at least 0", () => {
    const info = buildTruncationInfo(true, 0, 100, 500);
    assert.ok(info !== undefined);
    assert.strictEqual(info!.droppedEdges, 0);
  });
});
