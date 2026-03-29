import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * T4: Validates that the token accumulator correctly handles neutral savings
 * (sdlTokens === rawEquivalent), which is used by sdl.workflow and other tools
 * that report totalTokens. The server.ts dispatch loop calls:
 *   tokenAccumulator.recordUsage(name, totalTokens, totalTokens)
 * to count the call without inflating savings.
 */
describe("TokenAccumulator neutral savings accounting", () => {
  it("records zero savings when sdlTokens equals rawEquivalent", async () => {
    const { TokenAccumulator } = await import(
      "../../dist/mcp/token-accumulator.js"
    );
    const acc = new TokenAccumulator();

    // Neutral accounting: both values are equal
    acc.recordUsage("sdl.workflow", 500, 500);

    const snapshot = acc.getSnapshot();
    assert.strictEqual(snapshot.totalSdlTokens, 500);
    assert.strictEqual(snapshot.totalRawEquivalent, 500);
    assert.strictEqual(snapshot.totalSavedTokens, 0, "saved tokens should be 0 for neutral call");
    assert.strictEqual(snapshot.overallSavingsPercent, 0, "savings percent should be 0");
    assert.strictEqual(snapshot.callCount, 1, "call should still be counted");
  });

  it("does not inflate savings when mixing neutral and real savings calls", async () => {
    const { TokenAccumulator } = await import(
      "../../dist/mcp/token-accumulator.js"
    );
    const acc = new TokenAccumulator();

    // Real savings call: 100 SDL tokens vs 400 raw
    acc.recordUsage("sdl.symbol.getCard", 100, 400);
    // Neutral call: 500 SDL tokens vs 500 raw (e.g., sdl.workflow)
    acc.recordUsage("sdl.workflow", 500, 500);

    const snapshot = acc.getSnapshot();
    assert.strictEqual(snapshot.totalSdlTokens, 600);
    assert.strictEqual(snapshot.totalRawEquivalent, 900);
    assert.strictEqual(snapshot.totalSavedTokens, 300, "only the getCard call should contribute savings");
    assert.strictEqual(snapshot.callCount, 2);
  });

  it("per-tool breakdown shows zero saved for neutral tool", async () => {
    const { TokenAccumulator } = await import(
      "../../dist/mcp/token-accumulator.js"
    );
    const acc = new TokenAccumulator();

    acc.recordUsage("sdl.workflow", 200, 200);

    const snapshot = acc.getSnapshot();
    const chainEntry = snapshot.toolBreakdown.find(
      (e: { tool: string }) => e.tool === "sdl.workflow",
    );
    assert.ok(chainEntry, "sdl.workflow should appear in breakdown");
    assert.strictEqual(chainEntry.savedTokens, 0, "chain should show 0 saved tokens");
    assert.strictEqual(chainEntry.callCount, 1);
    assert.strictEqual(chainEntry.sdlTokens, 200);
    assert.strictEqual(chainEntry.rawEquivalent, 200);
  });
});
