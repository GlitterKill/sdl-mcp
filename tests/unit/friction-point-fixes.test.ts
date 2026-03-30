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

// Fix #5: Auto-generated summary quality
describe("generateSummary verbify improvements", () => {
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

  it("generates Converts to for toXxx functions", () => {
    const summary = generateSummary(
      makeSymbol("toAgentGraphSlice", [{ name: "slice", type: ": GraphSlice" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Converts to"), "Expected Converts to, got: " + summary);
  });

  it("generates Builds for build functions", () => {
    const summary = generateSummary(
      makeSymbol("buildToolPresentation", [{ name: "name", type: ": string" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Builds"), "Expected Builds, got: " + summary);
  });

  it("generates Logs warning for warn functions", () => {
    const summary = generateSummary(
      makeSymbol("warnUser", [{ name: "message", type: ": string" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Logs warning for"), "Expected Logs warning for, got: " + summary);
  });

  it("generates Handles for handle functions", () => {
    const summary = generateSummary(
      makeSymbol("handleRequest", [{ name: "req", type: ": Request" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Handles"), "Expected Handles, got: " + summary);
  });

  it("generates Parses for parse functions", () => {
    const summary = generateSummary(
      makeSymbol("parseConfig", [{ name: "raw", type: ": string" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Parses"), "Expected Parses, got: " + summary);
  });

  it("generates Performs beam for beam functions", () => {
    const summary = generateSummary(
      makeSymbol("beamSearch", [{ name: "graph", type: ": Graph" }]),
      "",
    );
    assert.ok(summary, "summary should not be null");
    assert.ok(summary.startsWith("Performs beam"), "Expected Performs beam, got: " + summary);
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