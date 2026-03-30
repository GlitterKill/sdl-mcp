import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeTransform,
  isInternalTransform,
  INTERNAL_TRANSFORM_NAMES,
  TransformError,
} from "../../dist/code-mode/transforms.js";

describe("code-mode transforms", () => {
  describe("isInternalTransform", () => {
    it("recognizes all transform names", () => {
      for (const name of INTERNAL_TRANSFORM_NAMES) {
        assert.ok(isInternalTransform(name), `${name} should be recognized`);
      }
    });

    it("rejects unknown names", () => {
      assert.ok(!isInternalTransform("symbolSearch"));
      assert.ok(!isInternalTransform("unknown"));
    });
  });

  describe("dataPick", () => {
    it("projects fields from an object", () => {
      const result = executeTransform("dataPick", {
        input: { name: "foo", kind: "function", file: "bar.ts", extra: true },
        fields: { name: "name", path: "file" },
      });
      assert.deepStrictEqual(result, { name: "foo", path: "bar.ts" });
    });

    it("handles nested paths", () => {
      const result = executeTransform("dataPick", {
        input: { a: { b: { c: 42 } } },
        fields: { value: "a.b.c" },
      });
      assert.deepStrictEqual(result, { value: 42 });
    });

    it("returns undefined for missing paths", () => {
      const result = executeTransform("dataPick", {
        input: { a: 1 },
        fields: { missing: "b.c" },
      });
      assert.deepStrictEqual(result, { missing: undefined });
    });

    it("wraps scalar input under 'value' key", () => {
      const result = executeTransform("dataPick", { input: "hello", fields: { v: "value" } });
      assert.deepStrictEqual(result, { v: "hello" });
    });
  });

  describe("dataMap", () => {
    it("projects fields from each array element", () => {
      const result = executeTransform("dataMap", {
        input: [
          { symbolId: "a", name: "foo", kind: "function" },
          { symbolId: "b", name: "bar", kind: "class" },
        ],
        fields: { id: "symbolId", name: "name" },
      });
      assert.deepStrictEqual(result, [
        { id: "a", name: "foo" },
        { id: "b", name: "bar" },
      ]);
    });

    it("handles empty array", () => {
      const result = executeTransform("dataMap", {
        input: [],
        fields: { a: "b" },
      });
      assert.deepStrictEqual(result, []);
    });
  });

  describe("dataFilter", () => {
    const items = [
      { name: "foo", kind: "function", lines: 10 },
      { name: "bar", kind: "class", lines: 50 },
      { name: "baz", kind: "function", lines: 100 },
    ];

    it("filters by eq", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [{ path: "kind", op: "eq", value: "function" }],
      }) as unknown[];
      assert.strictEqual(result.length, 2);
    });

    it("filters by ne", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [{ path: "kind", op: "ne", value: "function" }],
      }) as unknown[];
      assert.strictEqual(result.length, 1);
    });

    it("filters by gt", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [{ path: "lines", op: "gt", value: 20 }],
      }) as unknown[];
      assert.strictEqual(result.length, 2);
    });

    it("filters by contains", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [{ path: "name", op: "contains", value: "ba" }],
      }) as unknown[];
      assert.strictEqual(result.length, 2);
    });

    it("filters by in", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [{ path: "kind", op: "in", value: ["class", "interface"] }],
      }) as unknown[];
      assert.strictEqual(result.length, 1);
    });

    it("filters by exists", () => {
      const input = [{ a: 1 }, { b: 2 }, { a: null }];
      const result = executeTransform("dataFilter", {
        input,
        clauses: [{ path: "a", op: "exists" }],
      }) as unknown[];
      assert.strictEqual(result.length, 1);
    });

    it("mode any matches if any clause passes", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [
          { path: "kind", op: "eq", value: "class" },
          { path: "lines", op: "gt", value: 90 },
        ],
        mode: "any",
      }) as unknown[];
      assert.strictEqual(result.length, 2);
    });

    it("mode all requires all clauses to match", () => {
      const result = executeTransform("dataFilter", {
        input: items,
        clauses: [
          { path: "kind", op: "eq", value: "function" },
          { path: "lines", op: "gt", value: 50 },
        ],
        mode: "all",
      }) as unknown[];
      assert.strictEqual(result.length, 1);
    });
  });

  describe("dataSort", () => {
    it("sorts by string field ascending", () => {
      const input = [{ name: "c" }, { name: "a" }, { name: "b" }];
      const result = executeTransform("dataSort", {
        input,
        by: { path: "name", direction: "asc", type: "string" },
      }) as Array<{ name: string }>;
      assert.deepStrictEqual(
        result.map((r) => r.name),
        ["a", "b", "c"],
      );
    });

    it("sorts by number field descending", () => {
      const input = [{ val: 1 }, { val: 3 }, { val: 2 }];
      const result = executeTransform("dataSort", {
        input,
        by: { path: "val", direction: "desc", type: "number" },
      }) as Array<{ val: number }>;
      assert.deepStrictEqual(
        result.map((r) => r.val),
        [3, 2, 1],
      );
    });

    it("does not mutate input", () => {
      const input = [{ val: 3 }, { val: 1 }, { val: 2 }];
      const original = [...input];
      executeTransform("dataSort", {
        input,
        by: { path: "val", direction: "asc", type: "number" },
      });
      assert.deepStrictEqual(input, original);
    });
  });

  describe("dataTemplate", () => {
    it("renders template for single object", () => {
      const result = executeTransform("dataTemplate", {
        input: { name: "foo", kind: "function" },
        template: "{{name}} is a {{kind}}",
      });
      assert.strictEqual(result, "foo is a function");
    });

    it("renders template for array with joinWith", () => {
      const result = executeTransform("dataTemplate", {
        input: [
          { name: "foo", kind: "function" },
          { name: "bar", kind: "class" },
        ],
        template: "- {{name}} ({{kind}})",
        joinWith: "\n",
      });
      assert.strictEqual(result, "- foo (function)\n- bar (class)");
    });

    it("missing fields render as empty string", () => {
      const result = executeTransform("dataTemplate", {
        input: { name: "foo" },
        template: "{{name}} {{missing}}",
      });
      assert.strictEqual(result, "foo ");
    });
  });

  describe("error handling", () => {
    it("unknown transform throws TransformError", () => {
      assert.throws(
        () => executeTransform("unknownTransform", {}),
        TransformError,
      );
    });

    it("Zod validation errors produce TransformError", () => {
      assert.throws(
        () => executeTransform("dataMap", { input: "not an array", fields: {} }),
        TransformError,
      );
    });
  });
});
