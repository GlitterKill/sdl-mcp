import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  rankCatalog,
  invalidateCatalog,
} from "../../dist/code-mode/action-catalog.js";
import {
  handleActionSearch,
  handleManual,
} from "../../dist/code-mode/index.js";

describe("sdl.action.search behavior", () => {
  describe("query matching via rankCatalog", () => {
    it("prefers context for explain/debug/review-style queries", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "explain debug review auth failure");
      const topActions = ranked.slice(0, 5).map((d) => d.action);
      assert.strictEqual(
        ranked[0]?.action,
        "context",
        `expected context first for explain/debug/review query, got ${topActions.join(", ")}`,
      );
    });

    it("prefers workflow for execute/runtime/transform-style queries", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const ranked = rankCatalog(catalog, "execute runtime transform pipeline");
      const topActions = ranked.slice(0, 5).map((d) => d.action);
      assert.strictEqual(
        ranked[0]?.action,
        "workflow",
        `expected workflow first for execute/runtime/transform query, got ${topActions.join(", ")}`,
      );
    });

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

  describe("schema summaries", () => {
    it("defaults action search to shallow compact schema summaries", () => {
      const result = handleActionSearch({
        query: "context",
        limit: 1,
        includeSchemas: true,
      }) as {
        actions: Array<{
          action: string;
          schemaSummary?: {
            fields: Array<Record<string, unknown>>;
          };
        }>;
        nextAction?: unknown;
      };

      assert.strictEqual(result.actions[0]?.action, "context");
      const budget = result.actions[0]?.schemaSummary?.fields.find(
        (field) => field.name === "budget",
      );
      assert.ok(budget, "expected context budget schema field");
      assert.strictEqual("subFields" in budget, false);
      assert.deepStrictEqual(Object.keys(budget), [
        "name",
        "type",
        "required",
        "nestedFieldCount",
      ]);
      assert.ok(
        typeof budget.nestedFieldCount === "number" &&
          budget.nestedFieldCount > 0,
        "expected a deterministic nested field count",
      );
    });

    it("returns recursive action-search schemas only for explicit full detail", () => {
      const result = handleActionSearch({
        query: "context",
        limit: 1,
        includeSchemas: true,
        detail: "full",
      }) as {
        actions: Array<{
          action: string;
          schemaSummary?: {
            fields: Array<Record<string, unknown>>;
          };
        }>;
        nextAction?: unknown;
      };

      const budget = result.actions[0]?.schemaSummary?.fields.find(
        (field) => field.name === "budget",
      );
      assert.ok(budget, "expected context budget schema field");
      assert.ok(Array.isArray(budget.subFields));
      assert.ok(budget.subFields.length > 0);
      assert.strictEqual("nestedFieldCount" in budget, false);
      assert.strictEqual(result.nextAction, undefined);
    });

    it("honors compact and full schema detail in manual JSON output", () => {
      const compact = handleManual({
        actions: ["context"],
        format: "json",
        includeSchemas: true,
      }) as {
        actions: Array<{
          schemaSummary?: { fields: Array<Record<string, unknown>> };
        }>;
        nextAction?: unknown;
      };
      const full = handleManual({
        actions: ["context"],
        format: "json",
        includeSchemas: true,
        detail: "full",
      }) as typeof compact;
      const compactAgain = handleManual({
        actions: ["context"],
        format: "json",
        includeSchemas: true,
      }) as typeof compact;

      const compactBudget = compact.actions[0]?.schemaSummary?.fields.find(
        (field) => field.name === "budget",
      );
      const fullBudget = full.actions[0]?.schemaSummary?.fields.find(
        (field) => field.name === "budget",
      );
      assert.ok(compactBudget);
      assert.strictEqual("subFields" in compactBudget, false);
      assert.ok(compactBudget.nestedFieldCount);
      assert.ok(fullBudget);
      assert.ok(Array.isArray(fullBudget.subFields));
      assert.ok(fullBudget.subFields.length > 0);
      assert.deepStrictEqual(compact.nextAction, {
        action: "sdl.manual",
        args: {
          actions: ["context"],
          includeSchemas: true,
          detail: "full",
          format: "json",
        },
      });
      assert.strictEqual(full.nextAction, undefined);
      assert.strictEqual(JSON.stringify(compact), JSON.stringify(compactAgain));
    });

    it("returns one stable manual handoff for compact action-search schemas", () => {
      const args = {
        query: "context",
        limit: 1,
        includeSchemas: true,
      };
      const first = handleActionSearch(args) as Record<string, unknown>;
      const second = handleActionSearch(args) as Record<string, unknown>;

      assert.deepStrictEqual(first.nextAction, {
        action: "sdl.manual",
        args: {
          actions: ["context"],
          includeSchemas: true,
          detail: "full",
          format: "json",
        },
      });
      assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
    });

    it("publishes detail parity in action-search and manual catalog schemas", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true, detail: "full" });

      for (const action of ["action.search", "manual"]) {
        const detail = catalog
          .find((entry) => entry.action === action)
          ?.schemaSummary?.fields.find((field) => field.name === "detail");
        assert.ok(detail, `expected ${action} detail schema field`);
        assert.deepStrictEqual(detail.enumValues, ["compact", "full"]);
        assert.strictEqual(detail.default, "compact");
      }
    });

    it("surfaces important limits and op-specific plan-handle guidance", () => {
      invalidateCatalog();
      const catalog = buildCatalog({ includeSchemas: true, detail: "full" });

      const actionSearch = catalog.find((d) => d.action === "action.search");
      const actionLimit = actionSearch?.schemaSummary?.fields.find(
        (field) => field.name === "limit",
      );
      assert.match(actionLimit?.description ?? "", /Maximum 50/);

      const continuation = catalog.find(
        (d) => d.action === "workflowContinuationGet",
      );
      const continuationLimit = continuation?.schemaSummary?.fields.find(
        (field) => field.name === "limit",
      );
      assert.match(continuationLimit?.description ?? "", /capped at 1000/);

      const file = catalog.find((d) => d.action === "file");
      const planHandle = file?.schemaSummary?.fields.find(
        (field) => field.name === "planHandle",
      );
      assert.match(planHandle?.description ?? "", /preview\/source window/);
    });
  });

  describe("catalog structure", () => {
    it("each descriptor has required fields", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      for (const desc of catalog) {
        assert.ok(desc.action, `action should be set for ${desc.fn}`);
        assert.ok(desc.fn, `fn should be set for ${desc.action}`);
        assert.ok(
          desc.description,
          `description should be set for ${desc.action}`,
        );
        assert.ok(
          Array.isArray(desc.tags),
          `tags should be an array for ${desc.action}`,
        );
        assert.ok(
          desc.kind === "gateway" ||
            desc.kind === "internal" ||
            desc.kind === "meta",
          `kind should be gateway, internal, or meta for ${desc.action}`,
        );
      }
    });

    it("catalog contains gateway, internal, and meta actions", () => {
      invalidateCatalog();
      const catalog = buildCatalog();
      const gateway = catalog.filter((d) => d.kind === "gateway");
      const internal = catalog.filter((d) => d.kind === "internal");
      const meta = catalog.filter((d) => d.kind === "meta");
      assert.ok(gateway.length > 0, "should have gateway actions");
      assert.ok(internal.length > 0, "should have internal actions");
      assert.ok(meta.length > 0, "should have meta actions");
    });
  });
});
