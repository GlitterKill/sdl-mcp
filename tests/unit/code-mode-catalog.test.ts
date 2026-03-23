import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  rankCatalog,
  zodToSchemaSummary,
  invalidateCatalog,
} from "../../dist/code-mode/action-catalog.js";
import { z } from "zod";

describe("code-mode action catalog", () => {
  describe("buildCatalog", () => {
    it("returns gateway actions and internal transforms", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      assert.ok(catalog.length > 0, "catalog should not be empty");

      const gatewayActions = catalog.filter((d) => d.kind === "gateway");
      const transforms = catalog.filter((d) => d.kind === "internal");

      assert.ok(gatewayActions.length >= 29, `expected at least 29 gateway actions, got ${gatewayActions.length}`);
      assert.strictEqual(transforms.length, 5, "should have 5 internal transforms");
    });

    it("each descriptor has action, fn, description, tags, kind", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.ok(desc.action, `action should be set for ${desc.fn}`);
        assert.ok(desc.fn, `fn should be set for ${desc.action}`);
        assert.ok(desc.description, `description should be set for ${desc.fn}`);
        assert.ok(Array.isArray(desc.tags), `tags should be an array for ${desc.fn}`);
        assert.ok(desc.kind === "gateway" || desc.kind === "internal");
      }
    });

    it("includes shared agent-facing metadata for dependency hints and fallbacks", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeExamples: true });
      const getCard = catalog.find((d) => d.action === "symbol.getCard");
      const needWindow = catalog.find((d) => d.action === "code.needWindow");

      assert.ok(getCard, "expected symbol.getCard descriptor");
      assert.ok(
        Array.isArray(getCard?.prerequisites),
        "symbol.getCard should expose prerequisites",
      );
      assert.ok(
        Array.isArray(getCard?.recommendedNextActions),
        "symbol.getCard should expose recommended next actions",
      );
      assert.ok(
        Array.isArray(getCard?.fallbacks),
        "symbol.getCard should expose fallbacks",
      );

      assert.ok(needWindow, "expected code.needWindow descriptor");
      assert.deepStrictEqual(needWindow?.prerequisites, [
        "code.getSkeleton",
        "code.getHotPath",
      ]);
      assert.ok(
        needWindow?.fallbacks.includes("code.getSkeleton"),
        "code.needWindow should suggest code.getSkeleton as a fallback",
      );
    });

    it("includeSchemas adds schemaSummary to descriptors", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true });
      const withSchema = catalog.filter((d) => d.schemaSummary !== undefined);
      assert.ok(withSchema.length > 0, "at least some descriptors should have schemas");
    });

    it("includeExamples adds example to descriptors", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeExamples: true });
      const withExample = catalog.filter((d) => d.example !== undefined);
      assert.ok(withExample.length > 0, "at least some descriptors should have examples");
    });

    it("without includes, no schemaSummary or example", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.strictEqual(desc.schemaSummary, undefined);
        assert.strictEqual(desc.example, undefined);
      }
    });
  });

  describe("rankCatalog", () => {
    it("ranks symbol.getCard high for 'symbol card' query", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "symbol card");
      assert.ok(ranked.length > 0, "should have results");
      const topActions = ranked.slice(0, 3).map((d) => d.action);
      assert.ok(
        topActions.includes("symbol.getCard") || topActions.includes("symbol.getCards"),
        `Expected symbol.getCard or symbol.getCards in top 3, got: ${topActions.join(", ")}`,
      );
    });

    it("returns empty array for no matches", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "xyznonexistent123");
      assert.strictEqual(ranked.length, 0);
    });

    it("matches by tag", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "transform");
      assert.ok(ranked.length >= 5, "should match all 5 transforms");
    });
  });

  describe("zodToSchemaSummary", () => {
    // TODO: zodToSchemaSummary uses Zod v3 internals (_def.typeName) - update src/code-mode/action-catalog.ts for Zod v4
    it("converts simple ZodObject", () => {
      const schema = z.object({
        name: z.string(),
        count: z.number().optional(),
        flag: z.boolean().default(false),
      });

      const summary = zodToSchemaSummary(schema);
      assert.strictEqual(summary.fields.length, 3);

      const nameField = summary.fields.find((f) => f.name === "name");
      assert.ok(nameField);
      assert.strictEqual(nameField.type, "string");
      assert.strictEqual(nameField.required, true);

      const countField = summary.fields.find((f) => f.name === "count");
      assert.ok(countField);
      assert.strictEqual(countField.required, false);

      const flagField = summary.fields.find((f) => f.name === "flag");
      assert.ok(flagField);
      assert.strictEqual(flagField.required, false);
      assert.strictEqual(flagField.default, false);
    });

    // TODO: zodToSchemaSummary uses Zod v3 internals (_def.typeName/_def.values) - update src/code-mode/action-catalog.ts for Zod v4
    it("handles enum fields", () => {
      const schema = z.object({
        mode: z.enum(["full", "incremental"]),
      });

      const summary = zodToSchemaSummary(schema);
      const modeField = summary.fields.find((f) => f.name === "mode");
      assert.ok(modeField);
      assert.deepStrictEqual(modeField.enumValues, ["full", "incremental"]);
    });

    it("handles non-object schema gracefully", () => {
      const summary = zodToSchemaSummary(z.string());
      assert.strictEqual(summary.fields.length, 0);
    });
  });
});
