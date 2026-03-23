import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  safeJsonParse,
  safeJsonParseOptional,
  safeJsonParseOrThrow,
  StringArraySchema,
  SignatureSchema,
} from "../../dist/util/safeJson.js";
import { DatabaseError } from "../../dist/mcp/errors.js";

// Tests verifying that corrupted JSON in MCP tool fields doesn't crash handlers.
// These tests exercise the safeJson utilities as used in the MCP tool files.

describe("mcp-tools JSON safety: agent-feedback fields", () => {
  test("usefulSymbolsJson: corrupted JSON returns empty array fallback", () => {
    const corrupted = "not-valid-json{{{";
    const result = safeJsonParse(corrupted, StringArraySchema, []);
    assert.deepStrictEqual(result, []);
  });

  test("missingSymbolsJson: null input returns empty array fallback", () => {
    const result = safeJsonParse(null, StringArraySchema, []);
    assert.deepStrictEqual(result, []);
  });

  test("taskTagsJson: corrupted JSON returns empty array fallback", () => {
    const corrupted = '["tag1", 42, null]'; // mixed types fail StringArraySchema
    const result = safeJsonParse(corrupted, StringArraySchema, []);
    assert.deepStrictEqual(result, []);
  });

  test("usefulSymbolsJson: valid JSON parses correctly", () => {
    const valid = '["sym1", "sym2", "sym3"]';
    const result = safeJsonParse(valid, StringArraySchema, []);
    assert.deepStrictEqual(result, ["sym1", "sym2", "sym3"]);
  });
});

describe("mcp-tools JSON safety: policy configJson fields", () => {
  const RepoConfigJsonSchema = z.record(z.string(), z.any());

  test("configJson: corrupted JSON throws DatabaseError", () => {
    assert.throws(
      () => safeJsonParseOrThrow("{{invalid}}", RepoConfigJsonSchema, "repo configJson for test-repo"),
      (err) => err instanceof DatabaseError,
    );
  });

  test("configJson: null input throws DatabaseError", () => {
    assert.throws(
      () => safeJsonParseOrThrow(null, RepoConfigJsonSchema, "repo configJson for test-repo"),
      (err) => err instanceof DatabaseError,
    );
  });

  test("configJson: valid JSON parses and preserves policy field", () => {
    const valid = JSON.stringify({ repoId: "test", rootPath: "/tmp", policy: { maxWindowLines: 100 } });
    const result = safeJsonParseOrThrow(valid, RepoConfigJsonSchema, "repo configJson");
    assert.strictEqual((result as Record<string, unknown>).repoId, "test");
    assert.deepStrictEqual((result as Record<string, unknown>).policy, { maxWindowLines: 100 });
  });
});

describe("mcp-tools JSON safety: symbol signatureJson fields", () => {
  test("signatureJson: corrupted JSON returns undefined", () => {
    const result = safeJsonParseOptional("not-json", SignatureSchema);
    assert.strictEqual(result, undefined);
  });

  test("signatureJson: null input returns undefined", () => {
    const result = safeJsonParseOptional(null, SignatureSchema);
    assert.strictEqual(result, undefined);
  });

  test("signatureJson: valid JSON parses correctly", () => {
    const valid = JSON.stringify({ name: "myFunc", params: ["a", "b"], returnType: "void" });
    const result = safeJsonParseOptional(valid, SignatureSchema);
    assert.deepStrictEqual(result, { name: "myFunc", params: ["a", "b"], returnType: "void" });
  });
});

describe("mcp-tools JSON safety: slice spillover fields", () => {
  const SpilloverRefSchema = z.array(z.object({
    symbolId: z.string(),
    reason: z.string(),
    priority: z.enum(["must", "should", "optional"]),
  }));

  test("spilloverRef: corrupted JSON throws DatabaseError", () => {
    assert.throws(
      () => safeJsonParseOrThrow("corrupted{", SpilloverRefSchema, "spillover_ref for handle h1"),
      (err) => err instanceof DatabaseError,
    );
  });

  test("spilloverRef: schema mismatch throws DatabaseError", () => {
    // Missing required fields
    const invalid = JSON.stringify([{ symbolId: "s1" }]);
    assert.throws(
      () => safeJsonParseOrThrow(invalid, SpilloverRefSchema, "spillover_ref for handle h1"),
      (err) => err instanceof DatabaseError,
    );
  });

  test("spilloverRef: valid JSON parses correctly", () => {
    const valid = JSON.stringify([
      { symbolId: "s1", reason: "high fanout", priority: "must" },
      { symbolId: "s2", reason: "low score", priority: "optional" },
    ]);
    const result = safeJsonParseOrThrow(valid, SpilloverRefSchema, "spillover_ref");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].symbolId, "s1");
    assert.strictEqual(result[1].priority, "optional");
  });
});

describe("mcp-tools JSON safety: testRefsJson and array fields", () => {
  test("testRefsJson: corrupted JSON returns empty array", () => {
    const result = safeJsonParse("{{bad}}", StringArraySchema, []);
    assert.deepStrictEqual(result, []);
  });

  test("testRefsJson: array with non-strings returns empty array", () => {
    const result = safeJsonParse('[1, 2, 3]', StringArraySchema, []);
    assert.deepStrictEqual(result, []);
  });

  test("testRefsJson: valid string array parses correctly", () => {
    const valid = JSON.stringify(["tests/foo.test.ts", "tests/bar.test.ts"]);
    const result = safeJsonParse(valid, StringArraySchema, []);
    assert.deepStrictEqual(result, ["tests/foo.test.ts", "tests/bar.test.ts"]);
  });
});
