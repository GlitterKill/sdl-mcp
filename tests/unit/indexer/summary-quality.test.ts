import assert from "node:assert";
import { describe, it } from "node:test";
import { generateSummary } from "../../../dist/indexer/summaries.js";

/**
 * Tests that behavioral function summaries are specific and actionable,
 * not vague patterns like "Iterates over X" or "Aggregates Y" when
 * the subject is just derived from the function name.
 */
describe("Summary Quality — Anti-Vagueness", () => {
  function makeSymbol(
    name: string,
    kind: string,
    bodyLines: number,
    bodyContent: string,
  ) {
    return {
      name,
      kind,
      range: { startLine: 1, startCol: 0, endLine: 1 + bodyLines, endCol: 0 },
      params: [],
      modifiers: [],
      bodyContent,
    };
  }

  it("returns null for name-only iteration subjects", () => {
    // beamSearchLadybug with iteration — should NOT produce "Iterates over search ladybug"
    const sym = makeSymbol(
      "beamSearchLadybug",
      "function",
      50,
      `
      for (const item of collection) {
        result.push(item);
      }
    `,
    );
    const summary = generateSummary(sym as never, sym.bodyContent);
    assert.strictEqual(summary, null, "Name-only iteration subject should return null");
  });

  it("returns null for name-only aggregation subjects", () => {
    // rankSymbols with reduce — should NOT produce "Aggregates symbols"
    const sym = makeSymbol(
      "rankSymbols",
      "function",
      50,
      `
      const total = items.reduce((sum, item) => sum + item.score, 0);
      return total;
    `,
    );
    const summary = generateSummary(sym as never, sym.bodyContent);
    assert.strictEqual(summary, null, "Name-only aggregation subject should return null");
  });

  it("returns null for name-only transform subjects", () => {
    // mapExtractedSymbolsToExisting with map — should NOT produce "Transforms each extracted symbols to existing"
    const sym = makeSymbol(
      "mapExtractedSymbolsToExisting",
      "function",
      30,
      `
      return items.map(item => transformItem(item));
    `,
    );
    const summary = generateSummary(sym as never, sym.bodyContent);
    assert.strictEqual(summary, null, "Name-only transform subject should return null");
  });

  it("does not delegate to common built-in methods", () => {
    // Function that calls Date.now() — should NOT produce "Delegates to now"
    const sym = makeSymbol(
      "captureTimestamp",
      "function",
      5,
      `
      return Date.now();
    `,
    );
    const summary = generateSummary(sym as never, sym.bodyContent);
    // captureTimestamp with only Date.now() should return null (built-in delegate)
    assert.strictEqual(summary, null, "Built-in delegate should return null");
  });

  it("does not delegate to array built-in methods", () => {
    const sym = makeSymbol(
      "customItems",
      "function",
      10,
      `
      return items.map(x => x.value).filter(Boolean);
    `,
    );
    const summary = generateSummary(sym as never, sym.bodyContent);
    // processItems with .map/.filter should return null (built-in delegate)
    assert.strictEqual(summary, null, "Built-in array delegates should return null");
  });

  it("returns null rather than vague summary when no JSDoc available", () => {
    // Without JSDoc, functions with generic signals should return null
    // rather than a vague "Aggregates X" or "Iterates over X" summary
    const sym = makeSymbol("customWorkflow", "function", 20, `
      for (const item of items) {
        total += item.value;
      }
      return total;
    `);
    const summary = generateSummary(sym as never, sym.bodyContent);
    // processData has no type info, so subject comes from name only.
    // The summary should be null rather than "Iterates over workflow"
    assert.strictEqual(summary, null, "Name-only subjects should return null");
  });

  it("returns null for large functions with only one generic signal", () => {
    // >100 line function with just iteration — name alone is more honest
    const longBody =
      "const x = 1;\n".repeat(120) +
      "for (const item of items) { process(item); }";
    const sym = makeSymbol("handleComplexWorkflow", "function", 125, longBody);
    const summary = generateSummary(sym as never, sym.bodyContent);
    // Should return null because body > 100 lines with only 1 active signal
    // OR if it returns something, it should not be a vague single-signal summary
    if (summary !== null) {
      const vaguePatterns = [
        /^Iterates over /,
        /^Aggregates /,
        /^Transforms /,
        /^Caches /,
        /^Sorts /,
        /^Merges /,
      ];
      for (const pattern of vaguePatterns) {
        assert.ok(
          !pattern.test(summary),
          `Large function should not get vague summary: "${summary}"`,
        );
      }
    }
  });
});
