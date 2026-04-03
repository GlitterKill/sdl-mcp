import { describe, it } from "node:test";
import assert from "node:assert";
import { buildContextSummary } from "../../dist/mcp/summary.js";

/**
 * Tests for the minimum budget enforcement in buildContextSummary.
 *
 * Budget floors per scope:
 *   repo:   800
 *   task:   500
 *   file:   300
 *   symbol: 150
 *
 * When a caller provides a budget below the floor, it is silently raised
 * to the minimum to prevent degenerate results.
 */

function makeSummaryInput(
  scope: "repo" | "task" | "file" | "symbol",
  budget: number,
) {
  return {
    repoId: "test-repo",
    query: "test query for budget enforcement",
    scope,
    budget,
    indexVersion: "v1",
    keySymbols: Array.from({ length: 5 }).map((_, idx) => ({
      symbolId: `sym-${idx}`,
      name: `testSymbol${idx}`,
      kind: "function" as const,
      signature: `testSymbol${idx}(a: string, b: number): boolean`,
      summary: `Test summary for symbol ${idx} with enough text to consume tokens.`,
    })),
    dependencyGraph: [
      { fromSymbolId: "sym-0", toSymbolIds: ["sym-1", "sym-2"] },
    ],
    riskAreas: [
      { symbolId: "sym-0", name: "testSymbol0", reasons: ["high fan-in"] },
    ],
    filesTouched: [{ file: "src/test.ts", symbolCount: 5 }],
  };
}

describe("summary minimum budget enforcement", () => {
  it("raises task budget from 100 to minimum 500", () => {
    const summary = buildContextSummary(makeSummaryInput("task", 100));
    assert.ok(
      summary.metadata.budget >= 500,
      `task budget should be at least 500, got ${summary.metadata.budget}`,
    );
  });

  it("raises repo budget from 200 to minimum 800", () => {
    const summary = buildContextSummary(makeSummaryInput("repo", 200));
    assert.ok(
      summary.metadata.budget >= 800,
      `repo budget should be at least 800, got ${summary.metadata.budget}`,
    );
  });

  it("raises file budget from 50 to minimum 300", () => {
    const summary = buildContextSummary(makeSummaryInput("file", 50));
    assert.ok(
      summary.metadata.budget >= 300,
      `file budget should be at least 300, got ${summary.metadata.budget}`,
    );
  });

  it("raises symbol budget from 10 to minimum 150", () => {
    const summary = buildContextSummary(makeSummaryInput("symbol", 10));
    assert.ok(
      summary.metadata.budget >= 150,
      `symbol budget should be at least 150, got ${summary.metadata.budget}`,
    );
  });

  it("does not reduce a budget already above the floor", () => {
    const summary = buildContextSummary(makeSummaryInput("task", 3000));
    assert.strictEqual(
      summary.metadata.budget,
      3000,
      "budget above floor should be preserved",
    );
  });

  it("uses default budget (2000) when no budget provided", () => {
    const input = makeSummaryInput("task", 0);
    // Remove budget to test the default path
    delete (input as Record<string, unknown>).budget;
    const summary = buildContextSummary(input);
    assert.strictEqual(
      summary.metadata.budget,
      2000,
      "default budget should be 2000",
    );
  });

  it("does not emit budgetWarning when budget meets threshold", () => {
    const summary = buildContextSummary(makeSummaryInput("task", 1000));
    assert.strictEqual(
      summary.metadata.budgetWarning,
      undefined,
      "no warning when budget is sufficient",
    );
  });
});
