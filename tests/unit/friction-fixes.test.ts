import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeTransform } from "../../dist/code-mode/transforms.js";
import { buildCatalog } from "../../dist/code-mode/action-catalog.js";

describe("friction-fixes", () => {
  describe("dataSort accepts both object and array for by", () => {
    const data = [
      { name: "Charlie", age: 30 },
      { name: "Alice", age: 25 },
      { name: "Bob", age: 35 },
    ];

    it("sorts with single object by (backward compat)", () => {
      const result = executeTransform("dataSort", {
        input: data,
        by: { path: "name", direction: "asc" },
      }) as Array<{ name: string }>;
      assert.equal(result[0].name, "Alice");
      assert.equal(result[1].name, "Bob");
      assert.equal(result[2].name, "Charlie");
    });

    it("sorts with array of one spec", () => {
      const result = executeTransform("dataSort", {
        input: data,
        by: [{ path: "name", direction: "desc" }],
      }) as Array<{ name: string }>;
      assert.equal(result[0].name, "Charlie");
      assert.equal(result[2].name, "Alice");
    });

    it("sorts with multi-key specs", () => {
      const multiData = [
        { group: "A", value: 3 },
        { group: "B", value: 1 },
        { group: "A", value: 1 },
        { group: "B", value: 2 },
      ];
      const result = executeTransform("dataSort", {
        input: multiData,
        by: [
          { path: "group", direction: "asc" },
          { path: "value", direction: "asc", type: "number" },
        ],
      }) as Array<{ group: string; value: number }>;
      assert.equal(result[0].group, "A");
      assert.equal(result[0].value, 1);
      assert.equal(result[1].group, "A");
      assert.equal(result[1].value, 3);
      assert.equal(result[2].group, "B");
      assert.equal(result[2].value, 1);
    });
  });

  describe("requiredParams in action catalog", () => {
    it("requiredParams is present on gateway actions", () => {
      const catalog = buildCatalog();
      for (const action of catalog) {
        assert.ok(
          Array.isArray(action.requiredParams),
          `${action.action} should have requiredParams array`,
        );
      }
    });

    it("requiredParams excludes repoId", () => {
      const catalog = buildCatalog();
      for (const action of catalog) {
        assert.ok(
          !action.requiredParams.includes("repoId"),
          `${action.action} should not include repoId in requiredParams`,
        );
      }
    });

    it("contextSummary requires query", () => {
      const catalog = buildCatalog();
      const cs = catalog.find((a) => a.action === "context.summary");
      assert.ok(cs);
      assert.ok(
        cs.requiredParams.includes("query"),
        "context.summary should require 'query'",
      );
    });

    it("pr.risk.analyze requires fromVersion and toVersion", () => {
      const catalog = buildCatalog();
      const pr = catalog.find((a) => a.action === "pr.risk.analyze");
      assert.ok(pr);
      assert.ok(
        pr.requiredParams.includes("fromVersion"),
        "pr.risk.analyze should require 'fromVersion'",
      );
      assert.ok(
        pr.requiredParams.includes("toVersion"),
        "pr.risk.analyze should require 'toVersion'",
      );
    });

    it("internal transforms have requiredParams", () => {
      const catalog = buildCatalog();
      const sort = catalog.find((a) => a.fn === "dataSort");
      assert.ok(sort);
      assert.ok(
        sort.requiredParams.includes("input"),
        "dataSort should require 'input'",
      );
      assert.ok(
        sort.requiredParams.includes("by"),
        "dataSort should require 'by'",
      );
    });
  });

  describe("chainContinuationGet transform", () => {
    it("is registered as an internal transform", () => {
      const catalog = buildCatalog();
      const cont = catalog.find((a) => a.fn === "chainContinuationGet");
      assert.ok(cont, "chainContinuationGet should be in catalog");
      assert.equal(cont.kind, "internal");
    });

    it("errors on invalid handle", () => {
      assert.throws(
        () => executeTransform("chainContinuationGet", { handle: "nonexistent" }),
        /expired or not found/,
      );
    });
  });
});
