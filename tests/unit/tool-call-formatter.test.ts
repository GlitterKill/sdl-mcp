import { describe, it } from "node:test";
import assert from "node:assert";

import { formatToolCallForUser } from "../../dist/mcp/tool-call-formatter.js";

describe("formatToolCallForUser", () => {
  it("returns null for unknown tool name", () => {
    const result = formatToolCallForUser("sdl.nonexistent.tool", {}, {});
    assert.strictEqual(result, null);
  });

  it("returns null (not throws) for malformed result objects", () => {
    // Even with a registered tool, bad data should not throw
    const result = formatToolCallForUser("sdl.symbol.search", {}, null);
    assert.strictEqual(result, null);
  });

  // --- symbol.search ---

  it("formats symbol.search with results", () => {
    const result = formatToolCallForUser("sdl.symbol.search", { query: "foo" }, {
      results: [
        { name: "fooBar", kind: "function", file: "src/util/foo.ts" },
        { name: "fooBaz", kind: "class", file: "src/lib/baz.ts" },
      ],
    });
    assert.ok(result !== null);
    assert.ok(result.includes('symbol.search "foo"'));
    assert.ok(result.includes("2 results"));
    assert.ok(result.includes("fooBar"));
    assert.ok(result.includes("fooBaz"));
  });

  it("formats symbol.search with single result (no plural)", () => {
    const result = formatToolCallForUser("sdl.symbol.search", { query: "bar" }, {
      results: [{ name: "bar", kind: "function", file: "src/bar.ts" }],
    });
    assert.ok(result !== null);
    assert.ok(result.includes("1 result"));
    assert.ok(!result.includes("1 results"));
  });

  it("formats symbol.search truncates beyond 5 results", () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      name: `sym${i}`, kind: "function", file: `src/s${i}.ts`,
    }));
    const result = formatToolCallForUser("sdl.symbol.search", { query: "sym" }, { results });
    assert.ok(result !== null);
    assert.ok(result.includes("8 results"));
    assert.ok(result.includes("…and 3 more"));
  });

  // --- symbol.getCard ---

  it("formats symbol.getCard with card data", () => {
    const result = formatToolCallForUser("sdl.symbol.getCard", {}, {
      card: {
        name: "handleRequest",
        kind: "function",
        file: "src/server/handler.ts",
        range: { startLine: 10, endLine: 50 },
        deps: { imports: [1, 2], calls: [3] },
      },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("symbol.getCard"));
    assert.ok(result.includes("handleRequest"));
    assert.ok(result.includes("function"));
    assert.ok(result.includes("L10–50"));
    assert.ok(result.includes("2 imports"));
    assert.ok(result.includes("1 calls"));
  });

  it("formats symbol.getCard ETag hit", () => {
    const result = formatToolCallForUser("sdl.symbol.getCard", {}, { notModified: true });
    assert.ok(result !== null);
    assert.ok(result.includes("not modified"));
    assert.ok(result.includes("ETag hit"));
  });

  it("formats symbol.getCard with missing range (no crash)", () => {
    const result = formatToolCallForUser("sdl.symbol.getCard", {}, {
      card: { name: "test", kind: "function", file: "src/test.ts" },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("test"));
  });

  // --- symbol.getCards ---

  it("formats symbol.getCards", () => {
    const result = formatToolCallForUser("sdl.symbol.getCards", {}, {
      cards: [{}, {}, {}],
    });
    assert.ok(result !== null);
    assert.ok(result.includes("3 cards"));
  });

  // --- code.getSkeleton ---

  it("formats code.getSkeleton", () => {
    const result = formatToolCallForUser("sdl.code.getSkeleton", {}, {
      file: "src/mcp/server.ts",
      originalLines: 200,
      estimatedTokens: 1500,
      range: { startLine: 1, endLine: 200 },
      truncated: false,
    });
    assert.ok(result !== null);
    assert.ok(result.includes("code.getSkeleton"));
    assert.ok(result.includes("server.ts"));
    assert.ok(result.includes("L1–200"));
    assert.ok(result.includes("1.5k"));
  });

  it("formats code.getSkeleton truncated", () => {
    const result = formatToolCallForUser("sdl.code.getSkeleton", {}, {
      file: "src/big.ts",
      originalLines: 500,
      estimatedTokens: 3000,
      range: { startLine: 1, endLine: 180 },
      truncated: true,
    });
    assert.ok(result !== null);
    assert.ok(result.includes("(truncated)"));
  });

  // --- code.getHotPath ---

  it("formats code.getHotPath", () => {
    const result = formatToolCallForUser("sdl.code.getHotPath", {
      identifiersToFind: ["foo", "bar", "baz"],
    }, {
      matchedIdentifiers: ["foo", "bar"],
      range: { startLine: 10, endLine: 30 },
      estimatedTokens: 450,
      truncated: false,
    });
    assert.ok(result !== null);
    assert.ok(result.includes("matched 2/3"));
    assert.ok(result.includes("L10–30"));
  });

  // --- code.needWindow ---

  it("formats code.needWindow approved", () => {
    const result = formatToolCallForUser("sdl.code.needWindow", {}, {
      approved: true,
      estimatedTokens: 800,
      range: { startLine: 1, endLine: 50 },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("[approved]"));
    assert.ok(result.includes("L1–50"));
  });

  it("formats code.needWindow denied with suggestion", () => {
    const result = formatToolCallForUser("sdl.code.needWindow", {}, {
      approved: false,
      nextBestAction: "Try sdl.code.getSkeleton first",
    });
    assert.ok(result !== null);
    assert.ok(result.includes("[denied]"));
    assert.ok(result.includes("Suggestion:"));
    assert.ok(result.includes("getSkeleton"));
  });

  it("formats code.needWindow with downgrade", () => {
    const result = formatToolCallForUser("sdl.code.needWindow", {}, {
      approved: true,
      downgradedFrom: "raw-code",
      estimatedTokens: 500,
      range: { startLine: 5, endLine: 40 },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("downgraded from raw-code"));
  });

  // --- slice.build ---

  it("formats slice.build", () => {
    const result = formatToolCallForUser("sdl.slice.build", {}, {
      cards: Array(15).fill({}),
      sliceHandle: "abcdef1234567890",
      spilloverCount: 3,
      budgetUsed: { estimatedTokens: 2500 },
    });
    assert.ok(result !== null);
    assert.ok(result.includes("15 cards"));
    assert.ok(result.includes("abcdef12"));
    assert.ok(result.includes("3 in spillover"));
    assert.ok(result.includes("2.5k"));
  });

  // --- repo.status ---

  it("formats repo.status", () => {
    const result = formatToolCallForUser("sdl.repo.status", {}, {
      filesIndexed: 100,
      symbolsIndexed: 5000,
      healthScore: 85,
    });
    assert.ok(result !== null);
    assert.ok(result.includes("100 files"));
    assert.ok(result.includes("5000 symbols"));
    assert.ok(result.includes("health 85/100"));
  });

  // --- chain ---

  it("formats chain results", () => {
    const result = formatToolCallForUser("sdl.chain", {}, {
      results: [
        { status: "ok" },
        { status: "ok" },
        { status: "error" },
      ],
      totalTokens: 1200,
    });
    assert.ok(result !== null);
    assert.ok(result.includes("3 steps"));
    assert.ok(result.includes("2 ok"));
    assert.ok(result.includes("1 errors"));
    assert.ok(result.includes("1.2k"));
  });

  // --- memory tools ---

  it("formats memory.store", () => {
    const result = formatToolCallForUser("sdl.memory.store", {
      title: "Use MERGE not CREATE for Cypher upserts",
    }, {});
    assert.ok(result !== null);
    assert.ok(result.includes("memory.store"));
    assert.ok(result.includes("MERGE"));
  });

  it("formats memory.query", () => {
    const result = formatToolCallForUser("sdl.memory.query", {}, {
      memories: [{}, {}, {}],
    });
    assert.ok(result !== null);
    assert.ok(result.includes("3 results"));
  });

  // --- pr.risk.analyze ---

  it("formats pr.risk.analyze", () => {
    const result = formatToolCallForUser("sdl.pr.risk.analyze", {}, {
      overallRisk: 45,
      riskItems: [{}, {}, {}],
    });
    assert.ok(result !== null);
    assert.ok(result.includes("risk 45/100"));
    assert.ok(result.includes("3 items"));
  });
});
