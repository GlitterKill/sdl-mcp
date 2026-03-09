/**
 * Regression test: Verify that src/mcp/types.ts barrel re-exports all runtime
 * values from src/domain/types.ts with reference identity.
 *
 * CRITICAL: The barrel MUST use `export *` (NOT `export type *`) because
 * domain/types.ts exports 4 functions and 2 const values that are runtime
 * dependencies consumed by src/graph/slice.ts and src/graph/slice/slice-serializer.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Import runtime values from the canonical domain source
import {
  CARD_DETAIL_LEVELS as domainLevels,
  CARD_DETAIL_LEVEL_RANK as domainRank,
  normalizeCardDetailLevel as domainNormalize,
  legacyDetailLevelToWire as domainLegacy,
  isLegacyDetailLevel as domainIsLegacy,
  cardDetailLevelOrder as domainOrder,
} from "../../src/domain/types.js";

// Import the same runtime values from the barrel re-export
import {
  CARD_DETAIL_LEVELS as mcpLevels,
  CARD_DETAIL_LEVEL_RANK as mcpRank,
  normalizeCardDetailLevel as mcpNormalize,
  legacyDetailLevelToWire as mcpLegacy,
  isLegacyDetailLevel as mcpIsLegacy,
  cardDetailLevelOrder as mcpOrder,
} from "../../src/mcp/types.js";

describe("domain/types.ts re-export barrel correctness", () => {
  describe("runtime value identity (export * not export type *)", () => {
    it("CARD_DETAIL_LEVELS is the same reference from both paths", () => {
      assert.strictEqual(domainLevels, mcpLevels);
    });

    it("CARD_DETAIL_LEVEL_RANK is the same reference from both paths", () => {
      assert.strictEqual(domainRank, mcpRank);
    });

    it("normalizeCardDetailLevel is the same function from both paths", () => {
      assert.strictEqual(domainNormalize, mcpNormalize);
    });

    it("legacyDetailLevelToWire is the same function from both paths", () => {
      assert.strictEqual(domainLegacy, mcpLegacy);
    });

    it("isLegacyDetailLevel is the same function from both paths", () => {
      assert.strictEqual(domainIsLegacy, mcpIsLegacy);
    });

    it("cardDetailLevelOrder is the same function from both paths", () => {
      assert.strictEqual(domainOrder, mcpOrder);
    });
  });

  describe("runtime values are functional (not undefined)", () => {
    it("CARD_DETAIL_LEVELS is a non-empty array", () => {
      assert.ok(Array.isArray(domainLevels));
      assert.ok(domainLevels.length > 0);
      assert.deepStrictEqual(domainLevels, [
        "minimal",
        "signature",
        "deps",
        "compact",
        "full",
      ]);
    });

    it("CARD_DETAIL_LEVEL_RANK maps all levels", () => {
      assert.strictEqual(typeof domainRank, "object");
      assert.strictEqual(domainRank.minimal, 0);
      assert.strictEqual(domainRank.full, 4);
    });

    it("normalizeCardDetailLevel returns expected values", () => {
      assert.strictEqual(domainNormalize(undefined), "deps");
      assert.strictEqual(domainNormalize("compact"), "deps");
      assert.strictEqual(domainNormalize("full"), "full");
      assert.strictEqual(domainNormalize("minimal"), "minimal");
    });

    it("cardDetailLevelOrder returns numeric ranks", () => {
      assert.strictEqual(domainOrder("minimal"), 0);
      assert.strictEqual(domainOrder("full"), 4);
    });

    it("isLegacyDetailLevel correctly identifies legacy levels", () => {
      assert.strictEqual(domainIsLegacy("compact"), true);
      assert.strictEqual(domainIsLegacy("full"), true);
      assert.strictEqual(domainIsLegacy("minimal"), false);
      assert.strictEqual(domainIsLegacy("deps"), false);
    });
  });
});
