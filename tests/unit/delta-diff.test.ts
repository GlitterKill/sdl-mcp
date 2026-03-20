import { describe, it } from "node:test";
import assert from "node:assert";

import { diffSignature, diffArray } from "../../dist/delta/diff.js";

describe("diffSignature", () => {
  it("returns undefined when before and after are identical strings", () => {
    const result = diffSignature('{"params":"()"}', '{"params":"()"}');
    assert.strictEqual(result, undefined);
  });

  it("returns undefined when both are null", () => {
    const result = diffSignature(null, null);
    assert.strictEqual(result, undefined);
  });

  it("detects change from null to a value", () => {
    const result = diffSignature(null, '{"params":"(x: number)"}');
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.before, undefined);
    assert.strictEqual(result!.after, '{"params":"(x: number)"}');
  });

  it("detects change from a value to null", () => {
    const result = diffSignature('{"params":"(x: number)"}', null);
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.before, '{"params":"(x: number)"}');
    assert.strictEqual(result!.after, undefined);
  });

  it("detects change between two different signatures", () => {
    const before = JSON.stringify({ params: "(a: string)" });
    const after = JSON.stringify({ params: "(a: string, b: number)" });
    const result = diffSignature(before, after);
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.before, before);
    assert.strictEqual(result!.after, after);
  });

  it("treats semantically equal JSON as equal (ignoring whitespace)", () => {
    // Same object, different formatting
    const before = '{"params":"(x: number)","returnType":"void"}';
    const after = '{ "params": "(x: number)", "returnType": "void" }';
    const result = diffSignature(before, after);
    // They should be parsed to the same JSON, so undefined (no diff)
    assert.strictEqual(result, undefined);
  });

  it("sets parseWarning when before is invalid JSON", () => {
    const result = diffSignature("not-json", '{"valid": true}');
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.parseWarning, true);
    assert.strictEqual(result!.before, "not-json");
    assert.strictEqual(result!.after, '{"valid": true}');
  });

  it("sets parseWarning when after is invalid JSON", () => {
    const result = diffSignature('{"valid": true}', "not-json");
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.parseWarning, true);
  });

  it("sets parseWarning when both are invalid JSON", () => {
    const result = diffSignature("bad-before", "bad-after");
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.parseWarning, true);
  });
});

describe("diffArray", () => {
  it("returns undefined when before and after are identical strings", () => {
    const arr = JSON.stringify(["a", "b", "c"]);
    const result = diffArray(arr, arr);
    assert.strictEqual(result, undefined);
  });

  it("returns undefined when both are null", () => {
    const result = diffArray(null, null);
    assert.strictEqual(result, undefined);
  });

  it("detects items added (null to array)", () => {
    const after = JSON.stringify(["a", "b"]);
    const result = diffArray(null, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, ["a", "b"]);
    assert.deepStrictEqual(result!.removed, []);
  });

  it("detects items removed (array to null)", () => {
    const before = JSON.stringify(["a", "b"]);
    const result = diffArray(before, null);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, []);
    assert.deepStrictEqual(result!.removed, ["a", "b"]);
  });

  it("detects items added and removed in one diff", () => {
    const before = JSON.stringify(["a", "b", "c"]);
    const after = JSON.stringify(["b", "c", "d"]);
    const result = diffArray(before, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, ["d"]);
    assert.deepStrictEqual(result!.removed, ["a"]);
  });

  it("returns undefined when arrays have same elements (different order in JSON)", () => {
    // Both have the same set contents but are identical strings
    const arr = JSON.stringify(["x", "y"]);
    const result = diffArray(arr, arr);
    assert.strictEqual(result, undefined);
  });

  it("detects only added items", () => {
    const before = JSON.stringify(["a"]);
    const after = JSON.stringify(["a", "b", "c"]);
    const result = diffArray(before, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, ["b", "c"]);
    assert.deepStrictEqual(result!.removed, []);
  });

  it("detects only removed items", () => {
    const before = JSON.stringify(["a", "b", "c"]);
    const after = JSON.stringify(["a"]);
    const result = diffArray(before, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, []);
    assert.deepStrictEqual(result!.removed, ["b", "c"]);
  });

  it("handles empty arrays", () => {
    const before = JSON.stringify([]);
    const after = JSON.stringify(["a"]);
    const result = diffArray(before, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added, ["a"]);
    assert.deepStrictEqual(result!.removed, []);
  });

  it("returns undefined for two empty arrays", () => {
    const empty = JSON.stringify([]);
    const result = diffArray(empty, empty);
    assert.strictEqual(result, undefined);
  });

  it("sets parseWarning when before is invalid JSON", () => {
    const result = diffArray("not-json", JSON.stringify(["a"]));
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.parseWarning, true);
    // Invalid JSON is treated as empty array, so "a" is added
    assert.deepStrictEqual(result!.added, ["a"]);
  });

  it("sets parseWarning when after is invalid JSON", () => {
    const result = diffArray(JSON.stringify(["a"]), "not-json");
    assert.ok(result, "should return a diff object");
    assert.strictEqual(result!.parseWarning, true);
    // Invalid JSON is treated as empty array, so "a" is removed
    assert.deepStrictEqual(result!.removed, ["a"]);
  });

  it("handles completely disjoint sets", () => {
    const before = JSON.stringify(["a", "b"]);
    const after = JSON.stringify(["c", "d"]);
    const result = diffArray(before, after);
    assert.ok(result, "should return a diff object");
    assert.deepStrictEqual(result!.added.sort(), ["c", "d"]);
    assert.deepStrictEqual(result!.removed.sort(), ["a", "b"]);
  });
});
