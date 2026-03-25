/**
 * feedback-boost-integration.test.ts
 *
 * Pure-logic test for feedback boost score adjustment math used in
 * start-node resolution. Tests that feedback boosts correctly reorder
 * start nodes within the same source-priority tier.
 *
 * This is a self-contained logic test (no DB, no imports from modules
 * that transitively load OTel).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Reproduce the start-node sorting logic with feedback boost tiebreaker.
 * This mirrors the actual sort in resolveStartNodesLadybug.
 */
function sortWithFeedbackBoost(
  nodes: Array<{ symbolId: string; source: string }>,
  sourcePriority: Record<string, number>,
  feedbackBoostMap: Map<string, number>,
): Array<{ symbolId: string; source: string }> {
  return [...nodes].sort((a, b) => {
    const pa = sourcePriority[a.source] ?? 99;
    const pb = sourcePriority[b.source] ?? 99;
    if (pa !== pb) return pa - pb;
    // Within same tier, boosted symbols come first
    const boostA = feedbackBoostMap.get(a.symbolId) ?? 0;
    const boostB = feedbackBoostMap.get(b.symbolId) ?? 0;
    if (boostA !== boostB) return boostB - boostA; // Higher boost = earlier
    return a.symbolId.localeCompare(b.symbolId);
  });
}

const SOURCE_PRIORITY: Record<string, number> = {
  entrySymbol: 0,
  entrySibling: 1,
  entryFirstHop: 2,
  stackTrace: 3,
  failingTestPath: 4,
  editedFile: 5,
  taskText: 6,
};

describe("feedback boost integration in start-node resolution", () => {
  it("promotes boosted symbols within same source-priority tier", () => {
    const startNodes = [
      { symbolId: "sym-a", source: "taskText" },
      { symbolId: "sym-b", source: "taskText" },
      { symbolId: "sym-c", source: "taskText" },
    ];

    const boosts = new Map<string, number>([
      ["sym-c", 0.3], // sym-c gets boosted
    ]);

    const sorted = sortWithFeedbackBoost(startNodes, SOURCE_PRIORITY, boosts);

    // sym-c should now be first in the taskText tier (highest boost)
    assert.equal(sorted[0].symbolId, "sym-c");
  });

  it("does not override source-priority ordering", () => {
    const startNodes = [
      { symbolId: "sym-a", source: "entrySymbol" },
      { symbolId: "sym-b", source: "taskText" },
    ];

    const boosts = new Map<string, number>([
      ["sym-b", 1.0], // taskText sym gets max boost
    ]);

    const sorted = sortWithFeedbackBoost(startNodes, SOURCE_PRIORITY, boosts);

    // entrySymbol still comes first (priority 0 < 6)
    assert.equal(sorted[0].symbolId, "sym-a");
    assert.equal(sorted[0].source, "entrySymbol");
  });

  it("handles no boosts (no change to ordering)", () => {
    const startNodes = [
      { symbolId: "sym-a", source: "taskText" },
      { symbolId: "sym-b", source: "taskText" },
    ];

    const boosts = new Map<string, number>(); // empty

    const sorted = sortWithFeedbackBoost(startNodes, SOURCE_PRIORITY, boosts);

    // Alphabetical tiebreaker: sym-a before sym-b
    assert.equal(sorted[0].symbolId, "sym-a");
    assert.equal(sorted[1].symbolId, "sym-b");
  });

  it("handles multiple boosted symbols with different boost values", () => {
    const startNodes = [
      { symbolId: "sym-a", source: "taskText" },
      { symbolId: "sym-b", source: "taskText" },
      { symbolId: "sym-c", source: "taskText" },
    ];

    const boosts = new Map<string, number>([
      ["sym-a", 0.1],
      ["sym-c", 0.5],
    ]);

    const sorted = sortWithFeedbackBoost(startNodes, SOURCE_PRIORITY, boosts);

    // sym-c has highest boost -> first
    assert.equal(sorted[0].symbolId, "sym-c");
    // sym-a has some boost -> second
    assert.equal(sorted[1].symbolId, "sym-a");
    // sym-b has no boost -> last
    assert.equal(sorted[2].symbolId, "sym-b");
  });

  it("preserves tier ordering across mixed sources with boosts", () => {
    const startNodes = [
      { symbolId: "sym-a", source: "entrySymbol" },
      { symbolId: "sym-b", source: "stackTrace" },
      { symbolId: "sym-c", source: "taskText" },
      { symbolId: "sym-d", source: "taskText" },
    ];

    const boosts = new Map<string, number>([
      ["sym-d", 0.8], // boost the second taskText sym
    ]);

    const sorted = sortWithFeedbackBoost(startNodes, SOURCE_PRIORITY, boosts);

    // Order: entrySymbol(0) -> stackTrace(3) -> taskText(6) with boost tiebreaker
    assert.equal(sorted[0].symbolId, "sym-a"); // entrySymbol
    assert.equal(sorted[1].symbolId, "sym-b"); // stackTrace
    assert.equal(sorted[2].symbolId, "sym-d"); // taskText, boosted
    assert.equal(sorted[3].symbolId, "sym-c"); // taskText, not boosted
  });
});
