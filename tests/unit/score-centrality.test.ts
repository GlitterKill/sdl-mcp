import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CENTRALITY_TIEBREAK_EPSILON,
  computeCentralityStats,
  normalizeCentrality,
  computeCentralitySignal,
  computeHotnessV2,
  applyCentralityTiebreak,
  compareScoresWithCentrality,
} from "../../dist/graph/score.js";

describe("Task 4: centrality helpers (pure)", () => {
  describe("normalizeCentrality", () => {
    it("returns 0 when max is 0", () => {
      assert.strictEqual(normalizeCentrality(5, 0), 0);
    });
    it("returns 0 when value is 0 or negative", () => {
      assert.strictEqual(normalizeCentrality(0, 10), 0);
      assert.strictEqual(normalizeCentrality(-1, 10), 0);
    });
    it("scales to [0, 1] by dividing by max", () => {
      assert.strictEqual(normalizeCentrality(5, 10), 0.5);
      assert.strictEqual(normalizeCentrality(10, 10), 1);
    });
    it("clamps at 1 when value exceeds max", () => {
      assert.strictEqual(normalizeCentrality(20, 10), 1);
    });
    it("treats null/undefined as 0", () => {
      assert.strictEqual(normalizeCentrality(null, 10), 0);
      assert.strictEqual(normalizeCentrality(undefined, 10), 0);
    });
  });

  describe("computeCentralityStats", () => {
    it("returns zero stats for empty input", () => {
      const stats = computeCentralityStats([]);
      assert.deepStrictEqual(stats, { maxPageRank: 0, maxKCore: 0 });
    });
    it("handles camelCase and snake_case field shapes", () => {
      const entries = [
        { pageRank: 0.5, kCore: 3 },
        { page_rank: 0.8, k_core: 5 },
        { pageRank: 0.2, kCore: 2 },
      ];
      const stats = computeCentralityStats(entries);
      assert.strictEqual(stats.maxPageRank, 0.8);
      assert.strictEqual(stats.maxKCore, 5);
    });
  });

  describe("computeCentralitySignal", () => {
    const stats = { maxPageRank: 1, maxKCore: 10 };
    it("returns 0 when both metrics are 0", () => {
      assert.strictEqual(computeCentralitySignal(0, 0, stats), 0);
    });
    it("applies 0.6 / 0.4 weights", () => {
      // pr=1 (normalized 1), kc=10 (normalized 1)
      // expected: 0.6*1 + 0.4*1 = 1
      assert.strictEqual(computeCentralitySignal(1, 10, stats), 1);
      // pr=0.5 (normalized 0.5), kc=0 (normalized 0)
      // expected: 0.6*0.5 + 0.4*0 = 0.3
      const v = computeCentralitySignal(0.5, 0, stats);
      assert.ok(Math.abs(v - 0.3) < 1e-12);
    });
    it("is bounded to [0, 1]", () => {
      const v = computeCentralitySignal(100, 100, stats);
      assert.ok(v >= 0 && v <= 1);
    });
  });

  describe("computeHotnessV2", () => {
    it("is shadow-only (75% hotness + 25% centrality)", () => {
      assert.strictEqual(computeHotnessV2(0.8, 0.4), 0.75 * 0.8 + 0.25 * 0.4);
    });
    it("handles NaN / Infinity gracefully", () => {
      assert.strictEqual(computeHotnessV2(Number.NaN, 0.4), 0.25 * 0.4);
      assert.strictEqual(
        computeHotnessV2(Number.POSITIVE_INFINITY, Number.NaN),
        0,
      );
    });
  });

  describe("applyCentralityTiebreak", () => {
    it("is a no-op when centrality is 0 or missing", () => {
      assert.strictEqual(applyCentralityTiebreak(0.5, 0), 0.5);
      assert.strictEqual(applyCentralityTiebreak(0.5, null), 0.5);
      assert.strictEqual(applyCentralityTiebreak(0.5, undefined), 0.5);
    });
    it("adds at most EPSILON", () => {
      const boosted = applyCentralityTiebreak(0.5, 1);
      assert.strictEqual(boosted, 0.5 + CENTRALITY_TIEBREAK_EPSILON);
      // Clamped even when centrality > 1
      const boosted2 = applyCentralityTiebreak(0.5, 2);
      assert.strictEqual(boosted2, 0.5 + CENTRALITY_TIEBREAK_EPSILON);
    });
    it("scales linearly with centrality below 1", () => {
      const boosted = applyCentralityTiebreak(0.5, 0.5);
      assert.strictEqual(boosted, 0.5 + CENTRALITY_TIEBREAK_EPSILON * 0.5);
    });
  });

  describe("compareScoresWithCentrality", () => {
    it("prefers higher primary score when delta exceeds epsilon", () => {
      const cmp = compareScoresWithCentrality({ score: 0.9 }, { score: 0.5 });
      // b - a = -0.4 → negative means a wins (sorts first)
      assert.ok(cmp < 0);
    });
    it("uses centrality as tie-breaker when scores are within epsilon", () => {
      const a = { score: 0.5, centralitySignal: 0.2 };
      const b = { score: 0.5, centralitySignal: 0.8 };
      const cmp = compareScoresWithCentrality(a, b);
      // Both scores equal → falls back to centrality: b > a, so b wins
      assert.ok(cmp > 0);
    });
    it("is stable when both scores and centrality tie", () => {
      const a = { score: 0.5, centralitySignal: 0.5 };
      const b = { score: 0.5, centralitySignal: 0.5 };
      assert.strictEqual(compareScoresWithCentrality(a, b), 0);
    });
    it("treats missing centrality as 0 (preserves existing order)", () => {
      const a = { score: 0.5 };
      const b = { score: 0.5 };
      assert.strictEqual(compareScoresWithCentrality(a, b), 0);
    });
  });
});
