import { describe, it } from "node:test";
import assert from "node:assert";
import {
  collectTaskTextSeedTokens,
  getTaskTextTokenRank,
  commonPrefixLength,
  computeStartNodeLimits,
  buildSymbolsByFile,
  collectEntryFirstHopSymbols,
  collectEntrySiblingSymbols,
  getStartNodeWhy,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
  TASK_TEXT_STOP_WORDS,
} from "../../src/graph/slice/start-node-resolver.js";

describe("getTaskTextTokenRank", () => {
  it("adds +4 for path separators", () => {
    assert.ok(getTaskTextTokenRank("src/foo") >= 4);
    assert.ok(getTaskTextTokenRank("src\\foo") >= 4);
  });

  it("adds +3 for dots/underscores/hyphens", () => {
    assert.ok(getTaskTextTokenRank("foo.bar") >= 3);
    assert.ok(getTaskTextTokenRank("foo_bar") >= 3);
    assert.ok(getTaskTextTokenRank("foo-bar") >= 3);
  });

  it("adds +2 for digits", () => {
    assert.ok(getTaskTextTokenRank("abc123") >= 2);
  });

  it("adds +1 for length >= 8", () => {
    assert.ok(getTaskTextTokenRank("longtoken") >= 1);
  });

  it("returns 0 for short plain token", () => {
    assert.strictEqual(getTaskTextTokenRank("foo"), 0);
  });
});

describe("commonPrefixLength", () => {
  it("returns 0 for no common prefix", () => {
    assert.strictEqual(commonPrefixLength("abc", "xyz"), 0);
  });

  it("returns full length for identical strings", () => {
    assert.strictEqual(commonPrefixLength("hello", "hello"), 5);
  });

  it("returns correct prefix count", () => {
    assert.strictEqual(commonPrefixLength("abcdef", "abcxyz"), 3);
  });

  it("handles empty strings", () => {
    assert.strictEqual(commonPrefixLength("", "abc"), 0);
    assert.strictEqual(commonPrefixLength("abc", ""), 0);
    assert.strictEqual(commonPrefixLength("", ""), 0);
  });
});

describe("collectTaskTextSeedTokens", () => {
  it("filters out stop words", () => {
    const tokens = collectTaskTextSeedTokens("the function is not working");
    for (const token of tokens) {
      assert.ok(!TASK_TEXT_STOP_WORDS.has(token), `stop word leaked: ${token}`);
    }
  });

  it("filters out numeric-only tokens", () => {
    const tokens = collectTaskTextSeedTokens("item 123 foobar");
    assert.ok(!tokens.includes("123"));
  });

  it("deduplicates tokens", () => {
    const tokens = collectTaskTextSeedTokens(
      "validateAuth validateAuth validateAuth foobar",
    );
    const unique = new Set(tokens);
    assert.strictEqual(tokens.length, unique.size);
  });

  it("ranks path-like tokens higher", () => {
    const tokens = collectTaskTextSeedTokens(
      "src/auth.ts handleRequest foobar",
    );
    // src/auth.ts has path separators and dots, should rank highly
    if (tokens.length >= 2) {
      const firstRank = getTaskTextTokenRank(tokens[0]);
      const lastRank = getTaskTextTokenRank(tokens[tokens.length - 1]);
      assert.ok(firstRank >= lastRank);
    }
  });
});

describe("computeStartNodeLimits", () => {
  it("returns default limits with no entries", () => {
    const limits = computeStartNodeLimits({}, 0);
    assert.ok(limits.maxTotalStartNodes >= 12);
    assert.ok(limits.maxTaskTextStartNodes > 0);
    assert.ok(limits.maxFirstHopPerEntry > 0);
    assert.ok(limits.maxSiblingPerEntry > 0);
  });

  it("scales maxTotalStartNodes with budget", () => {
    const small = computeStartNodeLimits({ budget: { maxCards: 10 } }, 0);
    const large = computeStartNodeLimits({ budget: { maxCards: 100 } }, 0);
    assert.ok(large.maxTotalStartNodes >= small.maxTotalStartNodes);
  });

  it("reduces taskText budget when strong signals present and entries > 0", () => {
    const withSignals = computeStartNodeLimits(
      { stackTrace: "Error at...", budget: { maxCards: 50 } },
      3,
    );
    const withoutSignals = computeStartNodeLimits(
      { budget: { maxCards: 50 } },
      3,
    );
    assert.ok(
      withSignals.maxTaskTextStartNodes <= withoutSignals.maxTaskTextStartNodes,
    );
  });
});

describe("buildSymbolsByFile", () => {
  it("groups symbols by file_id", () => {
    const graph = {
      repoId: "test",
      symbols: new Map([
        ["s1", { file_id: 1, name: "a" }],
        ["s2", { file_id: 1, name: "b" }],
        ["s3", { file_id: 2, name: "c" }],
      ] as any),
      edges: [],
      adjacencyOut: new Map(),
      adjacencyIn: new Map(),
    } as any;

    const result = buildSymbolsByFile(graph);
    assert.deepStrictEqual(result.get(1), ["s1", "s2"]);
    assert.deepStrictEqual(result.get(2), ["s3"]);
  });

  it("returns empty map for empty graph", () => {
    const graph = {
      repoId: "test",
      symbols: new Map(),
      edges: [],
      adjacencyOut: new Map(),
      adjacencyIn: new Map(),
    } as any;
    const result = buildSymbolsByFile(graph);
    assert.strictEqual(result.size, 0);
  });
});

describe("collectEntryFirstHopSymbols", () => {
  it("returns empty for no outgoing edges", () => {
    const graph = {
      repoId: "test",
      symbols: new Map([
        ["entry", { name: "entry", kind: "function", exported: 1 }],
      ] as any),
      edges: [],
      adjacencyOut: new Map([["entry", []]] as any),
      adjacencyIn: new Map(),
    } as any;
    assert.deepStrictEqual(collectEntryFirstHopSymbols(graph, "entry", 5), []);
  });

  it("ranks call edges higher than import edges", () => {
    const graph = {
      repoId: "test",
      symbols: new Map([
        ["entry", { name: "entry", kind: "function", exported: 1 }],
        ["callTarget", { name: "callTarget", kind: "function", exported: 0 }],
        [
          "importTarget",
          { name: "importTarget", kind: "function", exported: 0 },
        ],
      ] as any),
      edges: [],
      adjacencyOut: new Map([
        [
          "entry",
          [
            {
              type: "call",
              to_symbol_id: "callTarget",
              from_symbol_id: "entry",
            },
            {
              type: "import",
              to_symbol_id: "importTarget",
              from_symbol_id: "entry",
            },
          ],
        ],
      ] as any),
      adjacencyIn: new Map(),
    } as any;

    const result = collectEntryFirstHopSymbols(graph, "entry", 5);
    assert.ok(result.length === 2);
    assert.strictEqual(result[0], "callTarget");
  });

  it("respects maxPerSymbol limit", () => {
    const graph = {
      repoId: "test",
      symbols: new Map([
        ["entry", { name: "entry", kind: "function", exported: 1 }],
        ["t1", { name: "t1", kind: "function", exported: 0 }],
        ["t2", { name: "t2", kind: "function", exported: 0 }],
        ["t3", { name: "t3", kind: "function", exported: 0 }],
      ] as any),
      edges: [],
      adjacencyOut: new Map([
        [
          "entry",
          [
            { type: "call", to_symbol_id: "t1" },
            { type: "call", to_symbol_id: "t2" },
            { type: "call", to_symbol_id: "t3" },
          ],
        ],
      ] as any),
      adjacencyIn: new Map(),
    } as any;

    const result = collectEntryFirstHopSymbols(graph, "entry", 2);
    assert.strictEqual(result.length, 2);
  });
});

describe("getStartNodeWhy", () => {
  it("returns correct strings for all source types", () => {
    assert.strictEqual(getStartNodeWhy("entrySymbol"), "entry symbol");
    assert.strictEqual(getStartNodeWhy("entrySibling"), "entry sibling");
    assert.strictEqual(getStartNodeWhy("entryFirstHop"), "entry dependency");
    assert.strictEqual(getStartNodeWhy("stackTrace"), "stack trace");
    assert.strictEqual(getStartNodeWhy("failingTestPath"), "failing test");
    assert.strictEqual(getStartNodeWhy("editedFile"), "edited file");
    assert.strictEqual(getStartNodeWhy("taskText"), "task text");
  });
});

describe("START_NODE_SOURCE_PRIORITY", () => {
  it("entrySymbol has highest priority (lowest value)", () => {
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.entrySymbol, 0);
  });

  it("taskText has lowest priority (highest value)", () => {
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.taskText, 6);
  });
});

describe("START_NODE_SOURCE_SCORE", () => {
  it("entrySymbol has lowest (most negative) score", () => {
    assert.ok(
      START_NODE_SOURCE_SCORE.entrySymbol < START_NODE_SOURCE_SCORE.taskText,
    );
  });
});
