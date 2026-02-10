import { describe, it } from "node:test";
import assert from "node:assert";
import { scoreSymbolWithMetrics } from "../../src/graph/score.js";

describe("scoreSymbolWithMetrics structural specificity", () => {
  it("de-prioritizes broad aggregator files versus domain files", () => {
    const context = {
      query: "handle slice refresh budget",
      queryTokens: ["handle", "slice", "refresh", "budget"],
      stackTrace: "",
    };

    const symbol = {
      symbol_id: "sym-1",
      file_id: 1,
      name: "handleSliceRefresh",
      range_start_line: 10,
      range_end_line: 80,
    } as any;

    const metrics = {
      fan_in: 8,
      fan_out: 5,
      churn_30d: 1,
    } as any;

    const domainScore = scoreSymbolWithMetrics(symbol, context, metrics, {
      rel_path: "src/mcp/tools/slice.ts",
    } as any);

    const aggregatorScore = scoreSymbolWithMetrics(symbol, context, metrics, {
      rel_path: "src/mcp/tools.ts",
    } as any);

    assert.ok(
      domainScore > aggregatorScore,
      `expected domain score (${domainScore}) > aggregator score (${aggregatorScore})`,
    );
  });

  it("penalizes generated and test paths compared to source paths", () => {
    const context = {
      query: "policy downgrade skeleton hotpath",
      queryTokens: ["policy", "downgrade", "skeleton", "hotpath"],
      stackTrace: "",
    };

    const symbol = {
      symbol_id: "sym-2",
      file_id: 2,
      name: "handleCodeNeedWindow",
      range_start_line: 1,
      range_end_line: 200,
    } as any;

    const metrics = {
      fan_in: 6,
      fan_out: 4,
      churn_30d: 2,
    } as any;

    const sourceScore = scoreSymbolWithMetrics(symbol, context, metrics, {
      rel_path: "src/mcp/tools/code.ts",
    } as any);

    const distTestScore = scoreSymbolWithMetrics(symbol, context, metrics, {
      rel_path: "dist-tests/unit/policy-engine.test.js",
    } as any);

    assert.ok(
      sourceScore > distTestScore,
      `expected source score (${sourceScore}) > dist/test score (${distTestScore})`,
    );
  });
});
