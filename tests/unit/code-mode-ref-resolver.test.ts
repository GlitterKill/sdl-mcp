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

  it("$0.results.0.symbolId resolves numeric dot segments", () => {
    assert.strictEqual(
      resolveRef("$0.results.0.symbolId", [
        { results: [{ symbolId: "abc" }] },
      ]),
      "abc",
    );
  });

  it("$0.results?.0.symbolId supports optional numeric dot segments", () => {
    assert.strictEqual(
      resolveRef("$0.results?.0.symbolId", [{ results: [] }]),
      undefined,
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

  it("optional field access returns undefined for missing properties", () => {
    assert.strictEqual(
      resolveRef("$0.maybe?.symbolId", [{ maybe: {} }]),
      undefined,
    );
  });

  it("optional index access returns undefined for out-of-bounds arrays", () => {
    assert.strictEqual(
      resolveRef("$0.arr?.[999]", [{ arr: [1, 2] }]),
      undefined,
    );
  });

  it("optional chaining short-circuits after a missing intermediate index", () => {
    assert.strictEqual(
      resolveRef("$0.results[1]?.symbolId", [{ results: [{ symbolId: "sym-0" }] }]),
      undefined,
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

describe("code-mode ref resolver wildcard projection", () => {
  it("$0.results[*].symbolId projects a field over every element", () => {
    assert.deepStrictEqual(
      resolveRef("$0.results[*].symbolId", [
        { results: [{ symbolId: "a" }, { symbolId: "b" }] },
      ]),
      ["a", "b"],
    );
  });

  it("trailing [*] returns a shallow copy of the array", () => {
    const arr = [1, 2, 3];
    const projected = resolveRef("$0.items[*]", [{ items: arr }]);
    assert.deepStrictEqual(projected, [1, 2, 3]);
    assert.notStrictEqual(projected, arr);
  });

  it("[*] on a non-array throws RefResolutionError", () => {
    assert.throws(
      () => resolveRef("$0.results[*].symbolId", [{ results: { symbolId: "a" } }]),
      RefResolutionError,
    );
  });

  it("missing field inside a [*] projection throws RefResolutionError", () => {
    assert.throws(
      () => resolveRef("$0.results[*].nope", [{ results: [{ symbolId: "a" }] }]),
      RefResolutionError,
    );
  });

  it("full-string wildcard ref preserves array type through resolveRefs", () => {
    const result = resolveRefs({ symbolIds: "$0.results[*].symbolId" }, [
      { results: [{ symbolId: "a" }, { symbolId: "b" }] },
    ]);
    assert.deepStrictEqual(result.symbolIds, ["a", "b"]);
  });

  it("wildcard refs work inside array args (sliceBuild entrySymbols shape)", () => {
    const result = resolveRefs(
      { entrySymbols: "$0.results[*].symbolId", budget: { maxCards: 5 } },
      [{ results: [{ symbolId: "x" }] }],
    );
    assert.deepStrictEqual(result.entrySymbols, ["x"]);
  });
});
