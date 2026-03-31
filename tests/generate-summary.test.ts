/**
 * Tests for summary generation quality improvements.
 * Verifies that name-only summaries are detected and type-based summaries are generated.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateSummary,
  isNameOnlySummary,
} from "../dist/indexer/summaries.js";

describe("isNameOnlySummary", () => {
  it("detects title-cased function name", () => {
    assert.strictEqual(isNameOnlySummary("Build Beam Search Result", "buildBeamSearchResult"), true);
  });

  it("detects verbified function name", () => {
    assert.strictEqual(isNameOnlySummary("Builds beam search result", "buildBeamSearchResult"), true);
  });

  it("detects simple title-cased method", () => {
    assert.strictEqual(isNameOnlySummary("To Heap Array", "toHeapArray"), true);
  });

  it("detects Class prefix pattern", () => {
    assert.strictEqual(isNameOnlySummary("Class My Widget", "MyWidget"), true);
  });

  it("detects Interface for pattern", () => {
    assert.strictEqual(isNameOnlySummary("Interface for symbol card", "SymbolCard"), true);
  });

  it("detects Type alias for pattern", () => {
    assert.strictEqual(isNameOnlySummary("Type alias for config options", "ConfigOptions"), true);
  });

  it("rejects JSDoc-derived summary", () => {
    assert.strictEqual(
      isNameOnlySummary("Extracts first 1-2 sentences from JSDoc comments", "extractJSDoc"),
      false,
    );
  });

  it("rejects type-enriched summary", () => {
    assert.strictEqual(
      isNameOnlySummary("Builds beam search result from BeamCoreState and SliceBudget", "buildBeamSearchResult"),
      false,
    );
  });

  it("handles single-word name", () => {
    assert.strictEqual(isNameOnlySummary("Handles", "handle"), true);
  });

  it("handles empty summary", () => {
    assert.strictEqual(isNameOnlySummary("", "foo"), true);
  });

  it("detects name-plus-types tautology via TYPE_NOISE", () => {
    assert.strictEqual(
      isNameOnlySummary("Builds tool presentation from string and Partial", "buildToolPresentation"),
      true,
    );
  });

  it("detects name-plus-return-type tautology", () => {
    assert.strictEqual(
      isNameOnlySummary("Gets config returning Record", "getConfig"),
      true,
    );
  });

  it("accepts behavioral summary for same function", () => {
    assert.strictEqual(
      isNameOnlySummary("Delegates to store.get for config", "getConfig"),
      false,
    );
  });
});

describe("generateSummary", () => {
  const makeSymbol = (overrides: Record<string, unknown>) => ({
    name: "testFunc",
    kind: "function",
    range: { startLine: 10, startCol: 0, endLine: 20, endCol: 1 },
    exported: true,
    signature: null,
    ...overrides,
  });

  it("returns JSDoc description when available", () => {
    const symbol = makeSymbol({ name: "doStuff", range: { startLine: 3, startCol: 0, endLine: 10, endCol: 1 } });
    const fileContent = "\n/** Does important stuff. */\nfunction doStuff() {}";
    const result = generateSummary(symbol as any, fileContent);
    assert.strictEqual(result, "Does important stuff");
  });

  it("returns null for function with no JSDoc and no typed params", () => {
    const symbol = makeSymbol({ name: "doStuff" });
    const result = generateSummary(symbol as any, "function doStuff() {}");
    assert.strictEqual(result, null);
  });

  it("returns null for function with untyped params", () => {
    const symbol = makeSymbol({
      name: "doStuff",
      signature: { params: [{ name: "x" }, { name: "y" }] },
    });
    const result = generateSummary(symbol as any, "function doStuff(x, y) {}");
    assert.strictEqual(result, null);
  });

  it("returns null for function with empty body (no tautology)", () => {
    const symbol = makeSymbol({
      name: "buildSlice",
      signature: {
        params: [
          { name: "graph", type: ": Graph" },
          { name: "budget", type: ": SliceBudget" },
        ],
        returns: ": GraphSlice",
      },
    });
    // With empty body, behavioral analysis has no signals — returns null instead of tautology
    const result = generateSummary(symbol as any, "function buildSlice() {}");
    assert.strictEqual(result, null);
  });

  it("generates behavioral summary when body has detectable patterns", () => {
    const symbol = makeSymbol({
      name: "buildSlice",
      signature: {
        params: [
          { name: "graph", type: ": Graph" },
          { name: "budget", type: ": SliceBudget" },
        ],
        returns: ": GraphSlice",
      },
    });
    const body = "function buildSlice(graph, budget) {\n  return graph.nodes.map(n => n.card).filter(c => c.score > 0);\n}";
    symbol.range = { startLine: 1, startCol: 0, endLine: 3, endCol: 1 };
    const result = generateSummary(symbol as any, body);
    assert.ok(result !== null, "should produce behavioral summary");
    assert.ok(result!.includes("Transforms"), "Expected transform-based summary, got: " + result);
  });

  it("returns null for class without JSDoc or role suffix", () => {
    const symbol = makeSymbol({ name: "MyWidget", kind: "class" });
    const result = generateSummary(symbol as any, "class MyWidget {}");
    assert.strictEqual(result, null);
  });

  it("returns null for interface without JSDoc or suffix pattern", () => {
    const symbol = makeSymbol({ name: "SymbolCard", kind: "interface" });
    const result = generateSummary(symbol as any, "interface SymbolCard {}");
    assert.strictEqual(result, null);
  });

  it("returns heuristic summary for constant variable without JSDoc", () => {
    const symbol = makeSymbol({ name: "MAX_SIZE", kind: "variable" });
    const result = generateSummary(symbol as any, "const MAX_SIZE = 100;");
    assert.strictEqual(result, "Constant defining max size");
  });

  it("returns null for simple function with no body signals", () => {
    const symbol = makeSymbol({
      name: "merge",
      signature: {
        params: [
          { name: "a", type: ": string" },
          { name: "b", type: ": string" },
        ],
      },
    });
    // No body signals = null (no tautological type restating)
    const result = generateSummary(symbol as any, "function merge() {}");
    assert.strictEqual(result, null);
  });
});
