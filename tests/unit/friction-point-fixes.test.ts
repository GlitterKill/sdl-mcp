import { describe, it } from "node:test";
import assert from "node:assert";
import { sortByExactMatch } from "../../dist/mcp/tools/symbol.js";
import { generateSummary, splitCamelCase } from "../../dist/indexer/summaries.js";

// Fix #1: exactMatchFound field
describe("sortByExactMatch", () => {
  it("places exact matches first", () => {
    const results = [
      { name: "buildSlice", file: "a.ts" },
      { name: "MCPServer", file: "b.ts" },
    ];
    const sorted = sortByExactMatch(results, "MCPServer");
    assert.strictEqual(sorted[0].name, "MCPServer");
  });

  it("places starts-with matches before others", () => {
    const results = [
      { name: "rebuildAll", file: "a.ts" },
      { name: "buildSlice", file: "b.ts" },
    ];
    const sorted = sortByExactMatch(results, "build");
    assert.strictEqual(sorted[0].name, "buildSlice");
  });
});

// Fix #5: Auto-generated summary quality (behavioral summaries)
describe("generateSummary behavioral improvements", () => {
  const makeSymbol = (name, params, returns) => ({
    name,
    kind: "function",
    range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
    exported: true,
    signature: {
      params: params || [{ name: "arg", type: ": string" }],
      returns: returns,
    },
  });

  it("returns null for functions with empty body (no tautology)", () => {
    const summary = generateSummary(
      makeSymbol("buildSlice", [{ name: "graph", type: ": Graph" }]),
      "",
    );
    // With no body to analyze, behavioral generator returns null (better than tautology)
    assert.strictEqual(summary, null);
  });

  it("detects validation patterns in function body", () => {
    const body = "function validateInput(input: string) {\n  if (!input) throw new Error(\"missing\");\n  return input.trim();\n}";
    const sym = makeSymbol("validateInput", [{ name: "input", type: ": string" }]);
    sym.range = { startLine: 1, startCol: 0, endLine: 4, endCol: 1 };
    const summary = generateSummary(sym, body);
    assert.ok(summary, "should not be null");
    assert.ok(summary.startsWith("Validates"), "Expected Validates, got: " + summary);
  });

  it("detects iteration patterns in function body", () => {
    const body = "function processItems(items: Item[]) {\n  for (const item of items) {\n    item.process();\n  }\n}";
    const sym = makeSymbol("processItems", [{ name: "items", type: ": Item[]" }]);
    sym.range = { startLine: 1, startCol: 0, endLine: 5, endCol: 1 };
    const summary = generateSummary(sym, body);
    assert.ok(summary, "should not be null");
    assert.ok(summary.startsWith("Iterates over"), "Expected Iterates over, got: " + summary);
  });

  it("detects transform patterns in function body", () => {
    const body = "function mapItems(items: Item[]) {\n  return items.map(i => i.name);\n}";
    const sym = makeSymbol("mapItems", [{ name: "items", type: ": Item[]" }]);
    sym.range = { startLine: 1, startCol: 0, endLine: 3, endCol: 1 };
    const summary = generateSummary(sym, body);
    assert.ok(summary, "should not be null");
    assert.ok(summary.includes("Transforms"), "Expected Transforms, got: " + summary);
  });

  it("uses JSDoc when available over heuristic", () => {
    const code = "/** Performs the main action. */\nfunction doSomething(arg) {}";
    const sym = {
      name: "doSomething",
      kind: "function",
      range: { startLine: 2, startCol: 0, endLine: 2, endCol: 40 },
      exported: true,
      signature: { params: [{ name: "arg", type: ": string" }] },
    };
    const summary = generateSummary(sym, code);
    assert.ok(summary, "summary should not be null");
    assert.strictEqual(summary, "Performs the main action");
  });
});

// splitCamelCase tests
describe("splitCamelCase", () => {
  it("splits camelCase correctly", () => {
    assert.deepStrictEqual(splitCamelCase("buildGraphSlice"), ["build", "Graph", "Slice"]);
  });

  it("handles acronyms", () => {
    assert.deepStrictEqual(splitCamelCase("MCPServer"), ["MCP", "Server"]);
  });

  it("handles snake_case", () => {
    assert.deepStrictEqual(splitCamelCase("build_graph_slice"), ["build", "graph", "slice"]);
  });
});