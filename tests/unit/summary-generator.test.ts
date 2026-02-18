import { describe, it } from "node:test";
import assert from "node:assert";
import { generateSummaryWithGuardrails } from "../../src/indexer/summary-generator.js";

describe("summary generator", () => {
  it("returns deterministic summary metadata", async () => {
    const result = await generateSummaryWithGuardrails({
      symbolName: "buildSlice",
      heuristicSummary: "Builds a graph slice from entry symbols.",
      provider: "mock",
    });

    assert.ok(result.summary.length > 0);
    assert.ok(result.costUsd >= 0);
    assert.ok(result.divergenceScore >= 0 && result.divergenceScore <= 1);
  });
});
