import { describe, it } from "node:test";
import assert from "node:assert";
import { aggregateToolBreakdowns } from "../../src/db/ladybug-usage.js";

describe("aggregateToolBreakdowns", () => {
  it("aggregates tool entries from multiple snapshots", () => {
    const snapshots = [
      JSON.stringify([
        { tool: "sdl.symbol.search", sdlTokens: 100, rawEquivalent: 700, savedTokens: 600, callCount: 5 },
        { tool: "sdl.slice.build", sdlTokens: 500, rawEquivalent: 10000, savedTokens: 9500, callCount: 3 },
      ]),
      JSON.stringify([
        { tool: "sdl.symbol.search", sdlTokens: 200, rawEquivalent: 1400, savedTokens: 1200, callCount: 10 },
      ]),
    ];

    const result = aggregateToolBreakdowns(snapshots);

    assert.strictEqual(result.length, 2);

    const search = result.find((e) => e.tool === "sdl.symbol.search");
    assert.ok(search);
    assert.strictEqual(search.sdlTokens, 300);
    assert.strictEqual(search.rawEquivalent, 2100);
    assert.strictEqual(search.savedTokens, 1800);
    assert.strictEqual(search.callCount, 15);

    const slice = result.find((e) => e.tool === "sdl.slice.build");
    assert.ok(slice);
    assert.strictEqual(slice.savedTokens, 9500);
    assert.strictEqual(slice.callCount, 3);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(aggregateToolBreakdowns([]), []);
  });

  it("handles malformed JSON gracefully", () => {
    const result = aggregateToolBreakdowns(["not-json", "also-bad"]);
    assert.deepStrictEqual(result, []);
  });

  it("handles mixed valid and invalid JSON", () => {
    const result = aggregateToolBreakdowns([
      "not-json",
      JSON.stringify([
        { tool: "sdl.symbol.search", sdlTokens: 50, rawEquivalent: 500, savedTokens: 450, callCount: 2 },
      ]),
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tool, "sdl.symbol.search");
    assert.strictEqual(result[0].savedTokens, 450);
  });

  it("handles non-array JSON values", () => {
    const result = aggregateToolBreakdowns([
      JSON.stringify({ not: "an array" }),
      JSON.stringify("string"),
    ]);
    assert.deepStrictEqual(result, []);
  });

  it("skips entries with missing tool field", () => {
    const result = aggregateToolBreakdowns([
      JSON.stringify([
        { sdlTokens: 100, rawEquivalent: 500, savedTokens: 400, callCount: 1 },
        { tool: "sdl.symbol.search", sdlTokens: 50, rawEquivalent: 500, savedTokens: 450, callCount: 2 },
      ]),
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].tool, "sdl.symbol.search");
  });
});
