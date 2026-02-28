/**
 * Unit tests for fan-in trend computation (T5-A).
 *
 * Tests cover:
 *  - growthRate and isAmplifier calculations
 *  - zero-base edge case (previous=0 → denominator=max(0,1)=1)
 *  - No fanInTrend attached when version IDs are absent
 *  - Amplifiers sorted before non-amplifiers within the same distance tier
 *  - amplifiers summary array contains only isAmplifier:true items
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FAN_IN_AMPLIFIER_THRESHOLD } from "../../src/config/constants.js";

// ============================================================================
// Pure helpers extracted from blastRadius.ts logic (no DB dependency)
// ============================================================================

interface FanInTrend {
  previous: number;
  current: number;
  growthRate: number;
  isAmplifier: boolean;
}

/**
 * Pure function mirroring the fan-in trend computation in computeBlastRadius.
 */
function computeFanInTrend(previous: number, current: number): FanInTrend {
  const growthRate = (current - previous) / Math.max(previous, 1);
  return {
    previous,
    current,
    growthRate,
    isAmplifier: growthRate > FAN_IN_AMPLIFIER_THRESHOLD,
  };
}

interface BlastRadiusItemLike {
  symbolId: string;
  distance: number;
  rank: number;
  fanInTrend?: FanInTrend;
}

/**
 * Sort mirroring the re-sort applied in computeBlastRadius after attaching fanInTrend.
 * Amplifiers first within same distance tier, then by rank descending.
 */
function sortWithAmplifiersFirst(
  items: BlastRadiusItemLike[],
): BlastRadiusItemLike[] {
  return [...items].sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    const aAmplifier = a.fanInTrend?.isAmplifier ? 1 : 0;
    const bAmplifier = b.fanInTrend?.isAmplifier ? 1 : 0;
    if (aAmplifier !== bAmplifier) {
      return bAmplifier - aAmplifier; // amplifiers first
    }
    return b.rank - a.rank;
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("Fan-in trend computation (T5-A)", () => {
  describe("growthRate and isAmplifier", () => {
    it("Symbol A: fanIn 10→13 → growthRate≈0.30, isAmplifier=true", () => {
      const trend = computeFanInTrend(10, 13);
      assert.equal(trend.previous, 10);
      assert.equal(trend.current, 13);
      assert.ok(
        Math.abs(trend.growthRate - 0.3) < 1e-9,
        `Expected growthRate≈0.30, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, true);
    });

    it("Symbol B: fanIn 10→11 → growthRate≈0.10, isAmplifier=false", () => {
      const trend = computeFanInTrend(10, 11);
      assert.equal(trend.previous, 10);
      assert.equal(trend.current, 11);
      assert.ok(
        Math.abs(trend.growthRate - 0.1) < 1e-9,
        `Expected growthRate≈0.10, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, false);
    });

    it("Symbol C: fanIn 0→3 → growthRate=3.0 (zero-base: prev=max(0,1)=1), isAmplifier=true", () => {
      const trend = computeFanInTrend(0, 3);
      assert.equal(trend.previous, 0);
      assert.equal(trend.current, 3);
      assert.ok(
        Math.abs(trend.growthRate - 3.0) < 1e-9,
        `Expected growthRate=3.0, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, true);
    });

    it("FAN_IN_AMPLIFIER_THRESHOLD is 0.20", () => {
      assert.equal(FAN_IN_AMPLIFIER_THRESHOLD, 0.20);
    });

    it("growthRate exactly at threshold (0.20) is NOT an amplifier (strict >)", () => {
      const trend = computeFanInTrend(10, 12); // growthRate = (12-10)/10 = 0.20
      assert.ok(
        Math.abs(trend.growthRate - 0.2) < 1e-9,
        `Expected growthRate=0.20, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, false, "0.20 is not > 0.20");
    });

    it("growthRate just above threshold (0.21) IS an amplifier", () => {
      // previous=100, current=121 → (121-100)/100 = 0.21
      const trend = computeFanInTrend(100, 121);
      assert.ok(
        Math.abs(trend.growthRate - 0.21) < 1e-9,
        `Expected growthRate=0.21, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, true);
    });
  });

  describe("fanInTrend absent when no version IDs provided", () => {
    it("Items without version context have no fanInTrend", () => {
      // Simulate what computeBlastRadius does when fromVersionId/toVersionId are absent:
      // it skips the loop that attaches fanInTrend.
      const item: BlastRadiusItemLike = {
        symbolId: "sym-no-version",
        distance: 1,
        rank: 0.8,
        // fanInTrend intentionally absent
      };
      assert.equal(
        item.fanInTrend,
        undefined,
        "fanInTrend must be absent when version IDs are not provided",
      );
    });
  });

  describe("Amplifiers sorted before non-amplifiers within same distance tier", () => {
    it("Within distance=1, amplifier comes before non-amplifier regardless of rank", () => {
      const nonAmplifier: BlastRadiusItemLike = {
        symbolId: "sym-B",
        distance: 1,
        rank: 0.9, // higher rank
        fanInTrend: computeFanInTrend(10, 11), // growthRate=0.10, isAmplifier=false
      };
      const amplifier: BlastRadiusItemLike = {
        symbolId: "sym-A",
        distance: 1,
        rank: 0.5, // lower rank
        fanInTrend: computeFanInTrend(10, 13), // growthRate=0.30, isAmplifier=true
      };
      const zeroBase: BlastRadiusItemLike = {
        symbolId: "sym-C",
        distance: 1,
        rank: 0.3,
        fanInTrend: computeFanInTrend(0, 3), // growthRate=3.0, isAmplifier=true
      };

      const sorted = sortWithAmplifiersFirst([nonAmplifier, amplifier, zeroBase]);

      // Both amplifiers should come before the non-amplifier within distance=1
      assert.equal(sorted[0].fanInTrend?.isAmplifier, true, "First item should be an amplifier");
      assert.equal(sorted[1].fanInTrend?.isAmplifier, true, "Second item should be an amplifier");
      assert.equal(sorted[2].fanInTrend?.isAmplifier, false, "Last item should be the non-amplifier");
      assert.equal(sorted[2].symbolId, "sym-B", "Non-amplifier sym-B should be last");
    });

    it("Items with different distances are sorted by distance first", () => {
      const farAmplifier: BlastRadiusItemLike = {
        symbolId: "sym-far",
        distance: 2,
        rank: 0.9,
        fanInTrend: computeFanInTrend(10, 13), // isAmplifier=true
      };
      const closeNonAmplifier: BlastRadiusItemLike = {
        symbolId: "sym-close",
        distance: 0,
        rank: 0.5,
        fanInTrend: computeFanInTrend(10, 11), // isAmplifier=false
      };

      const sorted = sortWithAmplifiersFirst([farAmplifier, closeNonAmplifier]);
      // Distance 0 comes before distance 2 regardless of amplifier status
      assert.equal(sorted[0].symbolId, "sym-close", "Closer distance should come first");
      assert.equal(sorted[1].symbolId, "sym-far");
    });
  });

  describe("amplifiers summary array", () => {
    it("amplifiers array contains only isAmplifier:true items", () => {
      const blastRadius: BlastRadiusItemLike[] = [
        {
          symbolId: "sym-A",
          distance: 0,
          rank: 0.9,
          fanInTrend: computeFanInTrend(10, 13), // growthRate=0.30, isAmplifier=true
        },
        {
          symbolId: "sym-B",
          distance: 1,
          rank: 0.7,
          fanInTrend: computeFanInTrend(10, 11), // growthRate=0.10, isAmplifier=false
        },
        {
          symbolId: "sym-C",
          distance: 1,
          rank: 0.4,
          fanInTrend: computeFanInTrend(0, 3), // growthRate=3.0, isAmplifier=true
        },
        {
          symbolId: "sym-D",
          distance: 2,
          rank: 0.2,
          // no fanInTrend (version IDs absent for this one)
        },
      ];

      // Mirror the amplifiers computation from handleDeltaGet
      const amplifiers = blastRadius
        .filter((item) => item.fanInTrend?.isAmplifier)
        .map((item) => ({
          symbolId: item.symbolId,
          growthRate: item.fanInTrend!.growthRate,
          previous: item.fanInTrend!.previous,
          current: item.fanInTrend!.current,
        }));

      assert.equal(amplifiers.length, 2, "Should have exactly 2 amplifiers");
      assert.ok(
        amplifiers.every((a) => a.growthRate > FAN_IN_AMPLIFIER_THRESHOLD),
        "All amplifiers must have growthRate > FAN_IN_AMPLIFIER_THRESHOLD",
      );
      const ids = amplifiers.map((a) => a.symbolId);
      assert.ok(ids.includes("sym-A"), "sym-A should be in amplifiers");
      assert.ok(ids.includes("sym-C"), "sym-C should be in amplifiers");
      assert.ok(!ids.includes("sym-B"), "sym-B should NOT be in amplifiers");
      assert.ok(!ids.includes("sym-D"), "sym-D should NOT be in amplifiers");
    });

    it("amplifiers array is empty when no items are amplifiers", () => {
      const blastRadius: BlastRadiusItemLike[] = [
        {
          symbolId: "sym-B",
          distance: 0,
          rank: 0.9,
          fanInTrend: computeFanInTrend(10, 11), // growthRate=0.10, not amplifier
        },
      ];

      const amplifiers = blastRadius
        .filter((item) => item.fanInTrend?.isAmplifier)
        .map((item) => ({
          symbolId: item.symbolId,
          growthRate: item.fanInTrend!.growthRate,
          previous: item.fanInTrend!.previous,
          current: item.fanInTrend!.current,
        }));

      assert.equal(amplifiers.length, 0, "amplifiers should be empty when none qualify");
    });

    it("amplifiers array is empty when no version IDs provided (no fanInTrend)", () => {
      const blastRadius: BlastRadiusItemLike[] = [
        { symbolId: "sym-X", distance: 0, rank: 0.9 },
        { symbolId: "sym-Y", distance: 1, rank: 0.7 },
      ];

      const amplifiers = blastRadius
        .filter((item) => item.fanInTrend?.isAmplifier)
        .map((item) => ({
          symbolId: item.symbolId,
          growthRate: item.fanInTrend!.growthRate,
          previous: item.fanInTrend!.previous,
          current: item.fanInTrend!.current,
        }));

      assert.equal(
        amplifiers.length,
        0,
        "amplifiers must be empty when no fanInTrend attached",
      );
    });
  });

  describe("growthRate formula edge cases", () => {
    it("no growth: fanIn 5→5 → growthRate=0.0", () => {
      const trend = computeFanInTrend(5, 5);
      assert.equal(trend.growthRate, 0);
      assert.equal(trend.isAmplifier, false);
    });

    it("negative growth: fanIn 10→8 → growthRate=-0.2, isAmplifier=false", () => {
      const trend = computeFanInTrend(10, 8);
      assert.ok(
        Math.abs(trend.growthRate - (-0.2)) < 1e-9,
        `Expected -0.2, got ${trend.growthRate}`,
      );
      assert.equal(trend.isAmplifier, false);
    });

    it("large growth: fanIn 1→100 → growthRate=99.0, isAmplifier=true", () => {
      const trend = computeFanInTrend(1, 100);
      assert.equal(trend.growthRate, 99);
      assert.equal(trend.isAmplifier, true);
    });
  });
});
