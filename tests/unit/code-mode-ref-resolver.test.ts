import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveRefs,
  resolveRef,
  RefResolutionError,
} from "../../dist/code-mode/ref-resolver.js";

describe("code-mode ref resolver", () => {
  it("$0 resolves to entire result object", () => {
    assert.deepStrictEqual(resolveRef("$0", [{ foo: "bar" }]), { foo: "bar" });
  });

  it("$0.field resolves to nested field value", () => {
    assert.strictEqual(resolveRef("$0.name", [{ name: "test" }]), "test");
  });

  it("$0.arr[0].id resolves through array index + field", () => {
    assert.strictEqual(
      resolveRef("$0.symbols[0].symbolId", [
        { symbols: [{ symbolId: "abc" }] },
      ]),
      "abc",
    );
  });

  it("$1.deep.nested resolves multi-level path", () => {
    assert.strictEqual(resolveRef("$1.a.b", [null, { a: { b: 42 } }]), 42);
  });

  it("embedded ref in string: prefix $0.name suffix", () => {
    const result = resolveRefs({ msg: "prefix $0.name suffix" }, [
      { name: "foo" },
    ]);
    assert.strictEqual(result.msg, "prefix foo suffix");
  });

  it("multiple refs in one string", () => {
    const result = resolveRefs({ msg: "$0.a and $1.b" }, [
      { a: "X" },
      { b: "Y" },
    ]);
    assert.strictEqual(result.msg, "X and Y");
  });

  it("non-string values in args passed through unchanged", () => {
    const result = resolveRefs({ num: 42, bool: true, nil: null }, []);
    assert.strictEqual(result.num, 42);
    assert.strictEqual(result.bool, true);
    assert.strictEqual(result.nil, null);
  });

  it("out-of-range $N throws RefResolutionError", () => {
    assert.throws(() => resolveRef("$5", [{ x: 1 }]), RefResolutionError);
  });

  it("missing field path throws RefResolutionError", () => {
    assert.throws(
      () => resolveRef("$0.nonexistent", [{ foo: 1 }]),
      RefResolutionError,
    );
  });

  it("array index out of bounds throws RefResolutionError", () => {
    assert.throws(
      () => resolveRef("$0.arr[999]", [{ arr: [1, 2] }]),
      RefResolutionError,
    );
  });

  it("original args object is not mutated (deep clone)", () => {
    const original = { x: "$0.val" };
    const before = JSON.stringify(original);
    resolveRefs(original, [{ val: "resolved" }]);
    assert.strictEqual(JSON.stringify(original), before);
  });

  it("nested objects in args are recursed into", () => {
    const result = resolveRefs({ outer: { inner: "$0.x" } }, [{ x: "deep" }]);
    const outer = result.outer as Record<string, unknown>;
    assert.strictEqual(outer.inner, "deep");
  });

  it("full-value ref preserves type (returns object/array, not string)", () => {
    const result = resolveRefs({ data: "$0.arr" }, [{ arr: [1, 2, 3] }]);
    assert.ok(Array.isArray(result.data));
    assert.deepStrictEqual(result.data, [1, 2, 3]);
  });
});
