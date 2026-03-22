import { describe, it } from "node:test";
import assert from "node:assert";

import {
  renderMeter,
  renderOperationMeter,
  renderUserNotificationLine,
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

  it("handles negative savings (SDL > raw) gracefully", () => {
    // When SDL tokens exceed raw equivalent, saved is clamped to 0
    const result = renderUserNotificationLine(1500, 1000);
    assert.strictEqual(result, "\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0%");
  });

  it("handles very small numbers", () => {
    const result = renderUserNotificationLine(1, 10);
    // 9/10 = 90%
    assert.strictEqual(result, "\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591 90%");
  });
});
