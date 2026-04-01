import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TokenAccumulator,
} from "../../dist/mcp/token-accumulator.js";

describe("negative savings accounting", () => {
  it("records SDL overhead as negative saved tokens", () => {
    const accumulator = new TokenAccumulator();

    accumulator.recordUsage("sdl.runtime.execute", 182, 10);

    const snapshot = accumulator.getSnapshot();
    assert.equal(snapshot.totalSdlTokens, 182);
    assert.equal(snapshot.totalRawEquivalent, 10);
    assert.equal(snapshot.totalSavedTokens, -172);
    assert.equal(snapshot.overallSavingsPercent, -1720);
    assert.equal(snapshot.toolBreakdown[0]?.savedTokens, -172);
  });
});
