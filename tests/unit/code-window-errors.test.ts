import { describe, it } from "node:test";
import assert from "node:assert";
import { extractWindow, identifiersExistInWindow } from "../../dist/code/windows.js";

describe("Code Window Error Handling", () => {
  it("should return empty result when file does not exist", () => {
    const result = extractWindow(
      "/nonexistent/path/to/file.ts",
      { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
      "symbol",
      180,
      1400,
    );

    assert.strictEqual(result.code, "");
    assert.strictEqual(result.estimatedTokens, 0);
    assert.strictEqual(result.truncated, true);
  });

  it("should return empty result when path is a directory", () => {
    const result = extractWindow(
      ".",
      { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
      "symbol",
      180,
      1400,
    );

    assert.strictEqual(result.code, "");
    assert.strictEqual(result.truncated, true);
  });
});

describe("identifiersExistInWindow", () => {
  it("should return false for empty identifiers", () => {
    assert.strictEqual(identifiersExistInWindow("const foo = 1;", []), false);
  });

  it("should find word-boundary identifiers", () => {
    const code = "const fooBar = getData(x);";
    assert.strictEqual(identifiersExistInWindow(code, ["fooBar"]), true);
    assert.strictEqual(identifiersExistInWindow(code, ["getData"]), true);
  });

  it("should not match partial identifiers", () => {
    const code = "const fooBarBaz = 1;";
    assert.strictEqual(identifiersExistInWindow(code, ["fooBar"]), false);
  });

  it("should match identifiers exactly as they appear", () => {
    const code = "const FOO = bar();";
    assert.strictEqual(identifiersExistInWindow(code, ["FOO", "bar"]), true);
    // Case mismatch - FOO vs foo - regex won't match
    assert.strictEqual(identifiersExistInWindow(code, ["foo", "bar"]), false);
  });

  it("should return false if only some identifiers match", () => {
    const code = "const foo = 1;";
    assert.strictEqual(
      identifiersExistInWindow(code, ["foo", "missing"]),
      false,
    );
  });

  it("should handle regex special characters in identifiers", () => {
    const code = "const $value = 1;";
    assert.strictEqual(identifiersExistInWindow(code, ["$value"]), true);
  });
});
