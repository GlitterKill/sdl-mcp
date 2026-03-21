import { describe, it } from "node:test";
import assert from "node:assert";
import {
  renderMeter,
  renderOperationMeter,
  renderSessionSummary,
  renderLifetimeSummary,
  formatTokenCount,
  type AggregateUsage,
} from "../../src/mcp/savings-meter.js";
import type { SessionUsageSnapshot, ToolUsageEntry } from "../../src/mcp/token-accumulator.js";

// ---------------------------------------------------------------------------
// Golden: renderOperationMeter exact output
// ---------------------------------------------------------------------------

describe("savings-meter golden snapshots", () => {
  it("renderOperationMeter matches expected format exactly", () => {
    assert.strictEqual(renderOperationMeter(98), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591 98%");
    assert.strictEqual(renderOperationMeter(0), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
    assert.strictEqual(renderOperationMeter(51), "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591 51%");
    assert.strictEqual(renderOperationMeter(100), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 100%");
  });

  // ---------------------------------------------------------------------------
  // Golden: renderSessionSummary structure
  // ---------------------------------------------------------------------------

  it("renderSessionSummary golden structure", () => {
    const session: SessionUsageSnapshot = {
      sessionId: "golden-session",
      startedAt: "2026-03-20T00:00:00Z",
      totalSdlTokens: 1000,
      totalRawEquivalent: 10000,
      totalSavedTokens: 9000,
      overallSavingsPercent: 90,
      callCount: 20,
      toolBreakdown: [
        { tool: "sdl.slice.build", sdlTokens: 500, rawEquivalent: 8000, savedTokens: 7500, callCount: 5 },
      ],
    };

    const lifetime: AggregateUsage = {
      totalSdlTokens: 50000,
      totalRawEquivalent: 500000,
      totalSavedTokens: 450000,
      overallSavingsPercent: 90,
      totalCalls: 200,
      sessionCount: 10,
    };

    const lifetimeTools: ToolUsageEntry[] = [
      { tool: "sdl.slice.build", sdlTokens: 25000, rawEquivalent: 400000, savedTokens: 375000, callCount: 80 },
      { tool: "sdl.symbol.search", sdlTokens: 5000, rawEquivalent: 50000, savedTokens: 45000, callCount: 100 },
    ];

    const result = renderSessionSummary(session, lifetime, lifetimeTools);

    // Must contain both sections
    assert.ok(result.includes("Session:"));
    assert.ok(result.includes("Lifetime:"));

    // Session section
    assert.ok(result.includes("20 calls"));
    assert.ok(result.includes("9.0k saved"));

    // Lifetime section
    assert.ok(result.includes("200 calls"));
    assert.ok(result.includes("10 sessions"));
    assert.ok(result.includes("450.0k saved"));

    // Lifetime tools
    assert.ok(result.includes("375.0k saved"));
    assert.ok(result.includes("45.0k saved"));

    // Starts with header, ends with footer
    const lines = result.split("\n");
    assert.ok(lines[0].startsWith("\u2500\u2500"));
    assert.match(lines[lines.length - 1], /^\u2500+$/);
  });

  // ---------------------------------------------------------------------------
  // Golden: renderLifetimeSummary structure
  // ---------------------------------------------------------------------------

  it("renderLifetimeSummary golden structure", () => {
    const lifetime: AggregateUsage = {
      totalSdlTokens: 100000,
      totalRawEquivalent: 1000000,
      totalSavedTokens: 900000,
      overallSavingsPercent: 90,
      totalCalls: 500,
      sessionCount: 25,
    };

    const tools: ToolUsageEntry[] = [
      { tool: "sdl.slice.build", sdlTokens: 50000, rawEquivalent: 800000, savedTokens: 750000, callCount: 200 },
    ];

    const result = renderLifetimeSummary(lifetime, tools);

    assert.ok(result.includes("Lifetime:"));
    assert.ok(!result.includes("Session:"));
    assert.ok(result.includes("500 calls"));
    assert.ok(result.includes("25 sessions"));
    assert.ok(result.includes("900.0k saved"));
    assert.ok(result.includes("slice.build"));
    assert.ok(result.includes("750.0k saved"));
  });
});
