import { describe, it } from "node:test";
import assert from "node:assert";

import {
  renderMeter,
  renderOperationMeter,
  renderUserNotificationLine,
  formatTokenCount,
  renderSessionSummary,
  renderLifetimeSummary,
} from "../../dist/mcp/savings-meter.js";

describe("renderMeter", () => {
  it("renders 0% as all empty", () => {
    const meter = renderMeter(0);
    assert.strictEqual(meter, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("renders 100% as all filled", () => {
    const meter = renderMeter(100);
    assert.strictEqual(meter, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588");
  });

  it("renders 50% as 5 filled + 5 empty", () => {
    const meter = renderMeter(50);
    assert.strictEqual(meter, "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591");
  });

  it("renders values under 10% as 0 filled", () => {
    assert.strictEqual(renderMeter(5), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
    assert.strictEqual(renderMeter(9), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("renders boundary at 10% as 1 filled", () => {
    assert.strictEqual(renderMeter(10), "\u2588\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("renders 90% as 9 filled + 1 empty", () => {
    assert.strictEqual(renderMeter(90), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591");
  });

  it("clamps negative values to 0", () => {
    assert.strictEqual(renderMeter(-10), "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591");
  });

  it("clamps values over 100 to 100", () => {
    assert.strictEqual(renderMeter(150), "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588");
  });
});

describe("renderOperationMeter", () => {
  it("renders meter with percentage suffix", () => {
    const result = renderOperationMeter(84);
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591 84%");
  });

  it("clamps and renders 0%", () => {
    const result = renderOperationMeter(0);
    assert.strictEqual(result, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
  });

  it("clamps and renders 100%", () => {
    const result = renderOperationMeter(100);
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 100%");
  });
});

describe("renderUserNotificationLine", () => {
  it("renders 0% when no raw equivalent (zero tokens)", () => {
    const result = renderUserNotificationLine(0, 0);
    assert.strictEqual(result, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
  });

  it("renders 0% when SDL tokens equal raw equivalent", () => {
    const result = renderUserNotificationLine(1000, 1000);
    assert.strictEqual(result, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
  });

  it("renders correct percentage for typical savings", () => {
    // 160 SDL tokens from 1000 raw = 840 saved = 84%
    const result = renderUserNotificationLine(160, 1000);
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591 84%");
  });

  it("renders 50% savings", () => {
    const result = renderUserNotificationLine(500, 1000);
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591 50%");
  });

  it("renders 100% savings (zero SDL tokens)", () => {
    const result = renderUserNotificationLine(0, 1000);
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588 100%");
  });

  it("handles negative savings (SDL > raw) by showing overhead", () => {
    // When SDL tokens exceed raw equivalent, show overhead percentage
    const result = renderUserNotificationLine(1500, 1000);
    assert.strictEqual(result, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0% (SDL overhead: +50%)");
  });

  it("handles very small numbers", () => {
    const result = renderUserNotificationLine(1, 10);
    // 9/10 = 90%
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591 90%");
  });
});

describe("formatTokenCount", () => {
  it("returns raw number below 1000", () => {    assert.strictEqual(formatTokenCount(0), "0");
    assert.strictEqual(formatTokenCount(1), "1");
    assert.strictEqual(formatTokenCount(999), "999");
  });

  it("returns k suffix for thousands", () => {    assert.strictEqual(formatTokenCount(1000), "1.0k");
    assert.strictEqual(formatTokenCount(1200), "1.2k");
    assert.strictEqual(formatTokenCount(65000), "65.0k");
    assert.strictEqual(formatTokenCount(999999), "1000.0k");
  });

  it("returns M suffix for millions", () => {    assert.strictEqual(formatTokenCount(1_000_000), "1.00M");
    assert.strictEqual(formatTokenCount(1_080_000), "1.08M");
    assert.strictEqual(formatTokenCount(10_500_000), "10.50M");
  });
});

describe("renderSessionSummary", () => {
  it("renders session and lifetime sections", () => {
    const session = {
      sessionId: "test-session",
      startedAt: "2026-01-01T00:00:00Z",
      totalSdlTokens: 500,
      totalRawEquivalent: 5000,
      totalSavedTokens: 4500,
      overallSavingsPercent: 90,
      callCount: 10,
      toolBreakdown: [
        { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 2000, savedTokens: 1800, callCount: 5 },
        { tool: "sdl.symbol.getCard", sdlTokens: 300, rawEquivalent: 3000, savedTokens: 2700, callCount: 5 },
      ],
    };

    const lifetime = {
      totalSdlTokens: 10000,
      totalRawEquivalent: 100000,
      totalSavedTokens: 90000,
      overallSavingsPercent: 90,
      totalCalls: 100,
      sessionCount: 5,
    };

    const ltBreakdown = [
      { tool: "sdl.symbol.search", sdlTokens: 5000, rawEquivalent: 50000, savedTokens: 45000, callCount: 50 },
    ];

    const result = renderSessionSummary(session, lifetime, ltBreakdown);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Session:"), "should include Session header");
    assert.ok(result.includes("10 calls"), "should include call count");
    assert.ok(result.includes("Lifetime:"), "should include Lifetime section");
    assert.ok(result.includes("100 calls"), "should include lifetime calls");
    assert.ok(result.includes("5 sessions"), "should include session count");
  });

  it("omits lifetime section when no lifetime data", () => {
    const session = {
      sessionId: "s",
      startedAt: "2026-01-01T00:00:00Z",
      totalSdlTokens: 100,
      totalRawEquivalent: 1000,
      totalSavedTokens: 900,
      overallSavingsPercent: 90,
      callCount: 1,
      toolBreakdown: [],
    };

    const emptyLifetime = {
      totalSdlTokens: 0,
      totalRawEquivalent: 0,
      totalSavedTokens: 0,
      overallSavingsPercent: 0,
      totalCalls: 0,
      sessionCount: 0,
    };

    const result = renderSessionSummary(session, emptyLifetime, []);
    assert.ok(!result.includes("Lifetime:"), "should omit Lifetime when no data");
  });
});

describe("renderLifetimeSummary", () => {
  it("renders lifetime-only summary", () => {
    const lifetime = {
      totalSdlTokens: 5000,
      totalRawEquivalent: 50000,
      totalSavedTokens: 45000,
      overallSavingsPercent: 90,
      totalCalls: 200,
      sessionCount: 10,
    };

    const breakdown = [
      { tool: "sdl.slice.build", sdlTokens: 3000, rawEquivalent: 30000, savedTokens: 27000, callCount: 100 },
      { tool: "sdl.symbol.search", sdlTokens: 2000, rawEquivalent: 20000, savedTokens: 18000, callCount: 100 },
    ];

    const result = renderLifetimeSummary(lifetime, breakdown);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Lifetime:"), "should include Lifetime header");
    assert.ok(result.includes("200 calls"), "should include total calls");
    assert.ok(result.includes("10 sessions"), "should include session count");
  });

  it("renders without tool breakdown", () => {
    const lifetime = {
      totalSdlTokens: 100,
      totalRawEquivalent: 1000,
      totalSavedTokens: 900,
      overallSavingsPercent: 90,
      totalCalls: 5,
      sessionCount: 1,
    };

    const result = renderLifetimeSummary(lifetime, []);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("5 calls"), "should include call count");
  });
});
