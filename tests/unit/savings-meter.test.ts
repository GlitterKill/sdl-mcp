import { describe, it } from "node:test";
import assert from "node:assert";
import {
  renderMeter,
  formatTokenCount,
  renderOperationMeter,
  renderTaskSummary,
  renderSessionSummary,
  renderLifetimeSummary,
  type AggregateUsage,
} from "../../src/mcp/savings-meter.js";
import type { SessionUsageSnapshot } from "../../src/mcp/token-accumulator.js";

// ---------------------------------------------------------------------------
// renderMeter
// ---------------------------------------------------------------------------

describe("renderMeter", () => {
  it("fills 9 sections for 94%", () => {
    assert.strictEqual(renderMeter(94), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591");
  });

  it("fills 0 sections for 7% (less than 10)", () => {
    assert.strictEqual(renderMeter(7), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("fills 5 sections for 50%", () => {
    assert.strictEqual(renderMeter(50), "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591");
  });

  it("fills all 10 sections for 100%", () => {
    assert.strictEqual(renderMeter(100), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588");
  });

  it("fills 0 sections for 0%", () => {
    assert.strictEqual(renderMeter(0), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("fills 1 section for 10%", () => {
    assert.strictEqual(renderMeter(10), "\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("fills 9 sections for 99%", () => {
    assert.strictEqual(renderMeter(99), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591");
  });

  it("fills 0 sections for 9%", () => {
    assert.strictEqual(renderMeter(9), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("clamps negative to 0 filled", () => {
    assert.strictEqual(renderMeter(-5), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("clamps above 100 to all filled", () => {
    assert.strictEqual(renderMeter(105), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588");
  });

  it("always returns exactly 10 characters", () => {
    for (const pct of [0, 1, 9, 10, 25, 50, 75, 94, 99, 100]) {
      assert.strictEqual(renderMeter(pct).length, 10, `length for ${pct}%`);
    }
  });
});

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  it("formats small numbers as-is", () => {
    assert.strictEqual(formatTokenCount(0), "0");
    assert.strictEqual(formatTokenCount(999), "999");
  });

  it("formats thousands with k suffix", () => {
    assert.strictEqual(formatTokenCount(1000), "1.0k");
    assert.strictEqual(formatTokenCount(1200), "1.2k");
    assert.strictEqual(formatTokenCount(65000), "65.0k");
    assert.strictEqual(formatTokenCount(76750), "76.8k");
  });

  it("formats millions with M suffix", () => {
    assert.strictEqual(formatTokenCount(1000000), "1.00M");
    assert.strictEqual(formatTokenCount(1084000), "1.08M");
    assert.strictEqual(formatTokenCount(1240000), "1.24M");
  });

  it("formats hundreds of thousands with k", () => {
    assert.strictEqual(formatTokenCount(820000), "820.0k");
    assert.strictEqual(formatTokenCount(156000), "156.0k");
  });
});

// ---------------------------------------------------------------------------
// renderOperationMeter
// ---------------------------------------------------------------------------

describe("renderOperationMeter", () => {
  it("renders meter with percentage for high savings", () => {
    assert.strictEqual(renderOperationMeter(98), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591 98%");
  });

  it("renders meter with percentage for zero savings", () => {
    assert.strictEqual(renderOperationMeter(0), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
  });

  it("renders meter with percentage for mid savings", () => {
    assert.strictEqual(renderOperationMeter(51), "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591 51%");
  });

  it("renders meter for sub-10 savings", () => {
    assert.strictEqual(renderOperationMeter(7), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 7%");
  });

  it("matches expected pattern", () => {
    for (const pct of [0, 50, 98, 100]) {
      assert.match(renderOperationMeter(pct), /^[\u2588\u2591]{10} \d+%$/);
    }
  });
});

// ---------------------------------------------------------------------------
// renderTaskSummary
// ---------------------------------------------------------------------------

describe("renderTaskSummary", () => {
  const snapshot: SessionUsageSnapshot = {
    sessionId: "test-session",
    startedAt: "2026-03-20T00:00:00Z",
    totalSdlTokens: 12450,
    totalRawEquivalent: 89200,
    totalSavedTokens: 76750,
    overallSavingsPercent: 86,
    callCount: 47,
    toolBreakdown: [
      { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 18 },
      { tool: "sdl.slice.build", sdlTokens: 3000, rawEquivalent: 68000, savedTokens: 65000, callCount: 8 },
    ],
  };

  it("contains header line with Token Savings", () => {
    const result = renderTaskSummary(snapshot);
    const lines = result.split("\n");
    assert.ok(lines[0].includes("Token Savings"));
    assert.ok(lines[0].startsWith("\u2500\u2500"));
  });

  it("contains session totals line", () => {
    const result = renderTaskSummary(snapshot);
    assert.ok(result.includes("47 calls"));
    assert.ok(result.includes("76.8k saved"));
    assert.ok(result.includes("86%"));
  });

  it("contains overall meter", () => {
    const result = renderTaskSummary(snapshot);
    assert.ok(result.includes("\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591"));
  });

  it("contains tool breakdown without sdl. prefix", () => {
    const result = renderTaskSummary(snapshot);
    assert.ok(result.includes("symbol.search"));
    assert.ok(result.includes("slice.build"));
    assert.ok(!result.includes("sdl.symbol"));
  });

  it("sorts tools by saved tokens descending", () => {
    const result = renderTaskSummary(snapshot);
    const sliceIdx = result.indexOf("slice.build");
    const searchIdx = result.indexOf("symbol.search");
    assert.ok(sliceIdx < searchIdx, "slice.build (65k saved) should come before symbol.search (1.2k saved)");
  });

  it("contains footer line of border characters", () => {
    const result = renderTaskSummary(snapshot);
    const lines = result.split("\n");
    assert.match(lines[lines.length - 1], /^\u2500+$/);
  });

  it("renders empty summary when no calls", () => {
    const empty: SessionUsageSnapshot = {
      sessionId: "empty",
      startedAt: "2026-03-20T00:00:00Z",
      totalSdlTokens: 0,
      totalRawEquivalent: 0,
      totalSavedTokens: 0,
      overallSavingsPercent: 0,
      callCount: 0,
      toolBreakdown: [],
    };
    const result = renderTaskSummary(empty);
    assert.ok(result.includes("0 calls"));
    assert.ok(result.includes("\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591"));
  });
});

// ---------------------------------------------------------------------------
// renderSessionSummary
// ---------------------------------------------------------------------------

describe("renderSessionSummary", () => {
  const session: SessionUsageSnapshot = {
    sessionId: "test",
    startedAt: "2026-03-20T00:00:00Z",
    totalSdlTokens: 12450,
    totalRawEquivalent: 89200,
    totalSavedTokens: 76750,
    overallSavingsPercent: 86,
    callCount: 47,
    toolBreakdown: [
      { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 18 },
    ],
  };

  const lifetime: AggregateUsage = {
    totalSdlTokens: 156000,
    totalRawEquivalent: 1240000,
    totalSavedTokens: 1084000,
    overallSavingsPercent: 87,
    totalCalls: 342,
    sessionCount: 28,
  };

  const lifetimeTools = [
    { tool: "sdl.slice.build", sdlTokens: 30000, rawEquivalent: 850000, savedTokens: 820000, callCount: 52 },
    { tool: "sdl.symbol.search", sdlTokens: 2000, rawEquivalent: 14000, savedTokens: 12000, callCount: 180 },
  ];

  it("renders both session and lifetime sections", () => {
    const result = renderSessionSummary(session, lifetime, lifetimeTools);

    assert.ok(result.includes("Session:"));
    assert.ok(result.includes("47 calls"));
    assert.ok(result.includes("Lifetime:"));
    assert.ok(result.includes("342 calls"));
    assert.ok(result.includes("28 sessions"));
    assert.ok(result.includes("1.08M saved"));
    assert.ok(result.includes("87%"));
  });

  it("contains lifetime tool breakdown", () => {
    const result = renderSessionSummary(session, lifetime, lifetimeTools);
    assert.ok(result.includes("slice.build"));
    assert.ok(result.includes("820.0k saved"));
  });

  it("renders without lifetime tools when empty", () => {
    const result = renderSessionSummary(session, lifetime, []);
    assert.ok(result.includes("Lifetime:"));
    // No tool rows after lifetime header
    const ltIdx = result.indexOf("Lifetime:");
    const afterLt = result.slice(ltIdx);
    assert.ok(!afterLt.includes("slice.build"));
  });
});

// ---------------------------------------------------------------------------
// renderLifetimeSummary
// ---------------------------------------------------------------------------

describe("renderLifetimeSummary", () => {
  const lifetime: AggregateUsage = {
    totalSdlTokens: 50000,
    totalRawEquivalent: 500000,
    totalSavedTokens: 450000,
    overallSavingsPercent: 90,
    totalCalls: 100,
    sessionCount: 5,
  };

  const tools = [
    { tool: "sdl.slice.build", sdlTokens: 10000, rawEquivalent: 300000, savedTokens: 290000, callCount: 30 },
  ];

  it("renders lifetime without session section", () => {
    const result = renderLifetimeSummary(lifetime, tools);
    assert.ok(result.includes("Lifetime:"));
    assert.ok(!result.includes("Session:"));
    assert.ok(result.includes("100 calls"));
    assert.ok(result.includes("5 sessions"));
    assert.ok(result.includes("450.0k saved"));
  });

  it("renders without tools when empty", () => {
    const result = renderLifetimeSummary(lifetime, []);
    assert.ok(result.includes("Lifetime:"));
    assert.ok(!result.includes("slice.build"));
  });
});
