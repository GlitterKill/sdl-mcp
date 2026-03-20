import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  rankCatalog,
  invalidateCatalog,
} from "../../dist/code-mode/action-catalog.js";

describe("sdl.action.search behavior", () => {
  describe("query matching via rankCatalog", () => {
    it("returns results for a broad query like 'symbol'", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "symbol");
      assert.ok(ranked.length > 0, "should match at least one action");
    });

    it("returns results for 'slice' query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "slice");
      assert.ok(ranked.length > 0, "should match at least one action");
      const topActions = ranked.slice(0, 5).map((d) => d.action);
      assert.ok(
        topActions.some((a) => a.includes("slice")),
        `Expected a slice action in top 5, got: ${topActions.join(", ")}`,
      );
    });

    it("returns results for 'code skeleton' query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "code skeleton");
      assert.ok(ranked.length > 0, "should match at least one action");
    });

    it("returns results for 'delta' query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "delta");
      assert.ok(ranked.length > 0, "should match at least one action");
    });

    it("returns empty array for unknown query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "xyznonexistent123abcdef");
      assert.strictEqual(ranked.length, 0);
    });

    it("returns empty array for random gibberish", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "qqwwrrttyy99887766");
      assert.strictEqual(ranked.length, 0);
    });
  });

  describe("limit parameter simulation", () => {
    it("slicing ranked results respects limit", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "symbol");
      const limited = ranked.slice(0, 3);
      assert.ok(limited.length <= 3, "should respect limit of 3");
    });

    it("limit of 1 returns at most one result", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "symbol").slice(0, 1);
      assert.ok(ranked.length <= 1, "should return at most 1 result");
    });

    it("large limit returns all matches", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const allMatches = rankCatalog(catalog, "symbol");
      const withLargeLimit = allMatches.slice(0, 25);
      assert.strictEqual(
        withLargeLimit.length,
        Math.min(allMatches.length, 25),
        "large limit should return all matches up to limit",
      );
    });
  });

  describe("includeSchemas flag", () => {
    it("without includeSchemas, descriptors have no schemaSummary", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.strictEqual(
          desc.schemaSummary,
          undefined,
          `${desc.action} should not have schemaSummary without flag`,
        );
      }
    });

    it("with includeSchemas, some descriptors have schemaSummary", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true });
      const withSchema = catalog.filter((d) => d.schemaSummary !== undefined);
      assert.ok(
        withSchema.length > 0,
        "at least some descriptors should have schemas",
      );
    });

    it("schemaSummary has fields array when present", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true });
      const withSchema = catalog.filter((d) => d.schemaSummary !== undefined);
      for (const desc of withSchema) {
        assert.ok(
          Array.isArray(desc.schemaSummary!.fields),
          `schemaSummary.fields should be an array for ${desc.action}`,
        );
      }
    });
  });

  describe("includeExamples flag", () => {
    it("without includeExamples, descriptors have no example", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.strictEqual(
          desc.example,
          undefined,
          `${desc.action} should not have example without flag`,
        );
      }
    });

    it("with includeExamples, some descriptors have example", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeExamples: true });
      const withExample = catalog.filter((d) => d.example !== undefined);
      assert.ok(
        withExample.length > 0,
        "at least some descriptors should have examples",
      );
    });
  });

  describe("combined flags", () => {
    it("both includeSchemas and includeExamples can be set together", () => {
      invalidateCatalog();
      const catalog = buildCatalog({
        includeSchemas: true,
        includeExamples: true,
      });
      const withSchema = catalog.filter((d) => d.schemaSummary !== undefined);
      const withExample = catalog.filter((d) => d.example !== undefined);
      assert.ok(withSchema.length > 0, "should have some schemas");
      assert.ok(withExample.length > 0, "should have some examples");
    });

    it("ranked results preserve schema/example enrichment", () => {
      invalidateCatalog();
      const catalog = buildCatalog({
        includeSchemas: true,
        includeExamples: true,
      });
      const ranked = rankCatalog(catalog, "symbol");
      if (ranked.length > 0) {
        // At least the top result should retain any enrichment it had
        const topAction = ranked[0].action;
        const original = catalog.find((d) => d.action === topAction);
        assert.ok(original, `original should exist for ${topAction}`);
        if (original!.schemaSummary) {
          assert.ok(
            ranked[0].schemaSummary,
            "ranked result should retain schemaSummary",
          );
        }
      }
    });
  });

  describe("catalog structure", () => {
    it("each descriptor has required fields", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.ok(desc.action, `action should be set for ${desc.fn}`);
        assert.ok(desc.fn, `fn should be set for ${desc.action}`);
        assert.ok(desc.description, `description should be set for ${desc.action}`);
        assert.ok(Array.isArray(desc.tags), `tags should be an array for ${desc.action}`);
        assert.ok(
          desc.kind === "gateway" || desc.kind === "internal",
          `kind should be gateway or internal for ${desc.action}`,
        );
      }
    });

    it("catalog contains both gateway and internal actions", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const gateway = catalog.filter((d) => d.kind === "gateway");
      const internal = catalog.filter((d) => d.kind === "internal");
      assert.ok(gateway.length > 0, "should have gateway actions");
      assert.ok(internal.length > 0, "should have internal actions");
    });
  });
});
