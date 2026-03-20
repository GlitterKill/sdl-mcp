import { describe, it, before } from "node:test";
import assert from "node:assert";

import { UsageStatsRequestSchema } from "../../dist/mcp/tools.js";
import { tokenAccumulator } from "../../dist/mcp/token-accumulator.js";

describe("UsageStatsRequestSchema validation", () => {
  it("parses minimal valid request (defaults scope to 'both')", () => {
    const parsed = UsageStatsRequestSchema.safeParse({});
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.scope, "both");
    }
  });

  it("parses request with scope 'session'", () => {
    const parsed = UsageStatsRequestSchema.safeParse({ scope: "session" });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.scope, "session");
    }
  });

  it("parses request with scope 'history'", () => {
    const parsed = UsageStatsRequestSchema.safeParse({ scope: "history" });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.scope, "history");
    }
  });

  it("parses request with scope 'both'", () => {
    const parsed = UsageStatsRequestSchema.safeParse({ scope: "both" });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.scope, "both");
    }
  });

  it("rejects invalid scope value", () => {
    const parsed = UsageStatsRequestSchema.safeParse({ scope: "invalid" });
    assert.strictEqual(parsed.success, false);
  });

  it("parses request with persist flag", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "session",
      persist: true,
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.persist, true);
    }
  });

  it("parses request with repoId", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      repoId: "my-repo",
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.repoId, "my-repo");
    }
  });

  it("parses request with since date string", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      since: "2026-01-01T00:00:00Z",
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.since, "2026-01-01T00:00:00Z");
    }
  });

  it("parses request with limit", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      limit: 50,
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.limit, 50);
    }
  });

  it("rejects limit less than 1", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      limit: 0,
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects limit greater than 100", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      limit: 101,
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects non-integer limit", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "history",
      limit: 10.5,
    });
    assert.strictEqual(parsed.success, false);
  });

  it("rejects non-boolean persist", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "session",
      persist: "yes",
    });
    assert.strictEqual(parsed.success, false);
  });

  it("parses full valid request with all optional fields", () => {
    const parsed = UsageStatsRequestSchema.safeParse({
      scope: "both",
      repoId: "test-repo",
      since: "2026-01-01T00:00:00Z",
      limit: 20,
      persist: true,
    });
    assert.strictEqual(parsed.success, true);
    if (parsed.success) {
      assert.strictEqual(parsed.data.scope, "both");
      assert.strictEqual(parsed.data.repoId, "test-repo");
      assert.strictEqual(parsed.data.since, "2026-01-01T00:00:00Z");
      assert.strictEqual(parsed.data.limit, 20);
      assert.strictEqual(parsed.data.persist, true);
    }
  });
});

describe("handleUsageStats session scope (no DB required)", () => {
  let handleUsageStats: (args: unknown) => Promise<unknown>;
  let usageAvailable = true;

  before(async () => {
    try {
      const usageMod = await import("../../dist/mcp/tools/usage.js");
      handleUsageStats = usageMod.handleUsageStats;
    } catch {
      usageAvailable = false;
    }
  });

  it("returns session snapshot for scope 'session'", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();

    const result = (await handleUsageStats({ scope: "session" })) as Record<string, unknown>;
    assert.ok(result, "should return a response");
    assert.ok(result.session, "should have session data");

    const session = result.session as Record<string, unknown>;
    assert.ok(typeof session.sessionId === "string", "session should have sessionId");
    assert.ok(typeof session.totalSdlTokens === "number", "session should have totalSdlTokens");
    assert.ok(typeof session.totalRawEquivalent === "number", "session should have totalRawEquivalent");
    assert.ok(typeof session.totalSavedTokens === "number", "session should have totalSavedTokens");
    assert.ok(typeof session.callCount === "number", "session should have callCount");
  });

  it("includes formattedSummary for session scope", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();
    tokenAccumulator.recordUsage("sdl.symbol.search", 100, 500);

    const result = (await handleUsageStats({ scope: "session" })) as Record<string, unknown>;
    assert.ok(result.session, "should have session data");
    assert.ok(typeof result.formattedSummary === "string", "should have formattedSummary");
    assert.ok(
      (result.formattedSummary as string).length > 0,
      "formattedSummary should not be empty",
    );
  });

  it("session data reflects accumulated usage", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();
    tokenAccumulator.recordUsage("sdl.symbol.search", 100, 500);
    tokenAccumulator.recordUsage("sdl.slice.build", 200, 1000);

    const result = (await handleUsageStats({ scope: "session" })) as Record<string, unknown>;
    const session = result.session as Record<string, unknown>;
    assert.strictEqual(session.totalSdlTokens, 300);
    assert.strictEqual(session.totalRawEquivalent, 1500);
    assert.strictEqual(session.totalSavedTokens, 1200);
    assert.strictEqual(session.callCount, 2);
  });

  it("session data has toolBreakdown array", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();
    tokenAccumulator.recordUsage("sdl.symbol.search", 50, 200);

    const result = (await handleUsageStats({ scope: "session" })) as Record<string, unknown>;
    const session = result.session as Record<string, unknown>;
    assert.ok(Array.isArray(session.toolBreakdown), "should have toolBreakdown array");
    const breakdown = session.toolBreakdown as Array<Record<string, unknown>>;
    assert.strictEqual(breakdown.length, 1, "should have one tool entry");
    assert.strictEqual(breakdown[0].tool, "sdl.symbol.search");
    assert.strictEqual(breakdown[0].sdlTokens, 50);
    assert.strictEqual(breakdown[0].rawEquivalent, 200);
  });

  it("rejects invalid args with ValidationError", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    await assert.rejects(
      () => handleUsageStats({ scope: "invalid_scope" }),
      (err: Error) => {
        assert.ok(
          err.message.includes("Invalid") || err.name === "ValidationError",
          `Expected ValidationError, got: ${err.name}: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("empty session returns zero totals", async (t) => {
    if (!usageAvailable) return t.skip("usage module not available");
    tokenAccumulator.reset();

    const result = (await handleUsageStats({ scope: "session" })) as Record<string, unknown>;
    const session = result.session as Record<string, unknown>;
    assert.strictEqual(session.totalSdlTokens, 0);
    assert.strictEqual(session.totalRawEquivalent, 0);
    assert.strictEqual(session.totalSavedTokens, 0);
    assert.strictEqual(session.callCount, 0);
  });
});
