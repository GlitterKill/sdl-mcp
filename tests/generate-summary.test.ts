/**
 * Tests for summary generation quality improvements.
 * Verifies that name-only summaries are detected and type-based summaries are generated.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  generateSummary,
  isNameOnlySummary,
} from "../src/indexer/summaries.js";

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

  it("returns type-based summary when typed params exist", () => {
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
    const result = generateSummary(symbol as any, "function buildSlice() {}");
    assert.ok(result !== null, "should not be null");
    assert.ok(result!.includes("Graph"), "should mention Graph type");
    assert.ok(result!.includes("SliceBudget"), "should mention SliceBudget type");
    assert.ok(result!.includes("GraphSlice"), "should mention return type");
  });

  it("returns heuristic summary for class without JSDoc", () => {
    const symbol = makeSymbol({ name: "MyWidget", kind: "class" });
    const result = generateSummary(symbol as any, "class MyWidget {}");
    assert.strictEqual(result, "Class encapsulating my widget behavior");
  });

  it("returns heuristic summary for interface without JSDoc", () => {
    const symbol = makeSymbol({ name: "SymbolCard", kind: "interface" });
    const result = generateSummary(symbol as any, "interface SymbolCard {}");
    assert.strictEqual(result, "Interface defining symbol card contract");
  });

  it("returns heuristic summary for constant variable without JSDoc", () => {
    const symbol = makeSymbol({ name: "MAX_SIZE", kind: "variable" });
    const result = generateSummary(symbol as any, "const MAX_SIZE = 100;");
    assert.strictEqual(result, "Constant defining max size");
  });

  it("deduplicates repeated param types", () => {
    const symbol = makeSymbol({
      name: "merge",
      signature: {
        params: [
          { name: "a", type: ": string" },
          { name: "b", type: ": string" },
        ],
      },
    });
    const result = generateSummary(symbol as any, "function merge() {}");
    assert.ok(result !== null);
    const count = (result!.match(/string/g) || []).length;
    assert.strictEqual(count, 1, "should deduplicate param types");
  });
});
