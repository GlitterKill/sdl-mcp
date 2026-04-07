import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CodeNeedWindowRequestSchema,
  SliceSpilloverGetRequestSchema,
} from "../../dist/mcp/tools.js";

// ---------------------------------------------------------------------------
// Regression guards for the schema hardening landed in fix/mcp-schema-hardening.
// These capture the empty-string / unbounded-length bypasses surfaced by the
// multi-agent review of the MCP tool surface.
// ---------------------------------------------------------------------------

describe("CodeNeedWindowRequestSchema hardening", () => {
  const base = {
    repoId: "repo",
    symbolId: "s".repeat(8),
    reason: "need to inspect logic",
    expectedLines: 20,
    identifiersToFind: ["validate"],
  };

  it("accepts a well-formed request", () => {
    const parsed = CodeNeedWindowRequestSchema.safeParse(base);
    assert.strictEqual(parsed.success, true);
  });

  it("rejects empty-string identifiersToFind elements (proof-of-need bypass)", () => {
    // Regression guard: before the schema required .min(1) on the inner
    // string, an empty identifier could be smuggled through and satisfy the
    // identifiersExistInWindow check, bypassing proof-of-need gating.
    const parsed = CodeNeedWindowRequestSchema.safeParse({
      ...base,
      identifiersToFind: [""],
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects overlong identifiers", () => {
    const parsed = CodeNeedWindowRequestSchema.safeParse({
      ...base,
      identifiersToFind: ["x".repeat(512)],
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects expectedLines above the schema-level cap", () => {
    const parsed = CodeNeedWindowRequestSchema.safeParse({
      ...base,
      expectedLines: 1_000_000_000,
    });
    assert.strictEqual(parsed.success, false);
  });
});

describe("SliceSpilloverGetRequestSchema hardening", () => {
  it("accepts a well-formed request", () => {
    const parsed = SliceSpilloverGetRequestSchema.safeParse({
      spilloverHandle: "abc123",
      cursor: "0",
      pageSize: 20,
    });
    assert.strictEqual(parsed.success, true);
  });

  it("rejects empty-string spilloverHandle", () => {
    const parsed = SliceSpilloverGetRequestSchema.safeParse({
      spilloverHandle: "",
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects oversized spilloverHandle", () => {
    const parsed = SliceSpilloverGetRequestSchema.safeParse({
      spilloverHandle: "x".repeat(1024),
    });
    assert.strictEqual(parsed.success, false);
  });
});
