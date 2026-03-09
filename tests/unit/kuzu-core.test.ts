/**
 * Tests for src/db/kuzu-core.ts — shared KuzuDB helper functions
 * These are unit tests for the pure utility functions (toNumber, toBoolean, assertSafeInt).
 * The async DB functions (exec, queryAll, querySingle, withTransaction) are tested
 * indirectly through the existing integration tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toNumber, toBoolean, assertSafeInt, isJoinHintSyntaxUnsupported } from "../../src/db/kuzu-core.js";

describe("toNumber", () => {
  it("returns number as-is", () => {
    assert.equal(toNumber(42), 42);
    assert.equal(toNumber(0), 0);
    assert.equal(toNumber(-1.5), -1.5);
  });

  it("converts bigint to number", () => {
    assert.equal(toNumber(100n), 100);
    assert.equal(toNumber(0n), 0);
  });

  it("converts numeric string to number", () => {
    assert.equal(toNumber("42"), 42);
    assert.equal(toNumber("3.14"), 3.14);
  });

  it("returns 0 for null", () => {
    assert.equal(toNumber(null), 0);
  });

  it("returns 0 for undefined", () => {
    assert.equal(toNumber(undefined), 0);
  });
});

describe("toBoolean", () => {
  it("returns boolean as-is", () => {
    assert.equal(toBoolean(true), true);
    assert.equal(toBoolean(false), false);
  });

  it("converts number to boolean", () => {
    assert.equal(toBoolean(1), true);
    assert.equal(toBoolean(0), false);
    assert.equal(toBoolean(-1), true);
  });

  it("converts bigint to boolean", () => {
    assert.equal(toBoolean(1n), true);
    assert.equal(toBoolean(0n), false);
  });

  it("converts string 'true' and '1' to true", () => {
    assert.equal(toBoolean("true"), true);
    assert.equal(toBoolean("1"), true);
  });

  it("converts other strings to false", () => {
    assert.equal(toBoolean("false"), false);
    assert.equal(toBoolean("0"), false);
    assert.equal(toBoolean(""), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(toBoolean(null), false);
    assert.equal(toBoolean(undefined), false);
  });
});

describe("assertSafeInt", () => {
  it("does not throw for safe integers", () => {
    assert.doesNotThrow(() => assertSafeInt(0, "value"));
    assert.doesNotThrow(() => assertSafeInt(Number.MAX_SAFE_INTEGER, "value"));
    assert.doesNotThrow(() => assertSafeInt(Number.MIN_SAFE_INTEGER, "value"));
    assert.doesNotThrow(() => assertSafeInt(42, "value"));
  });

  it("throws DatabaseError for values outside safe integer range", () => {
    assert.throws(
      () => assertSafeInt(Number.MAX_SAFE_INTEGER + 1, "value"),
      { name: "DatabaseError" }
    );
  });

  it("throws DatabaseError for Infinity", () => {
    assert.throws(
      () => assertSafeInt(Infinity, "value"),
      { name: "DatabaseError" }
    );
  });

  it("throws DatabaseError for NaN", () => {
    assert.throws(
      () => assertSafeInt(NaN, "value"),
      { name: "DatabaseError" }
    );
  });

  it("throws DatabaseError for floats", () => {
    assert.throws(
      () => assertSafeInt(1.5, "value"),
      { name: "DatabaseError" }
    );
  });
});

describe("isJoinHintSyntaxUnsupported", () => {
  it("returns true for HINT-related error messages", () => {
    assert.equal(isJoinHintSyntaxUnsupported(new Error("extraneous input 'HINT'")), true);
    assert.equal(isJoinHintSyntaxUnsupported(new Error('extraneous input "HINT"')), true);
  });

  it("returns false for unrelated errors", () => {
    assert.equal(isJoinHintSyntaxUnsupported(new Error("connection failed")), false);
    assert.equal(isJoinHintSyntaxUnsupported(new Error("syntax error")), false);
  });

  it("handles non-Error values", () => {
    assert.equal(isJoinHintSyntaxUnsupported("extraneous input 'HINT'"), true);
    assert.equal(isJoinHintSyntaxUnsupported("some other error"), false);
    assert.equal(isJoinHintSyntaxUnsupported(null), false);
  });
});
