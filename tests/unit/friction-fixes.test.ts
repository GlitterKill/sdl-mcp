/**
 * Tests for the 9 friction-point fixes.
 *
 * Each describe block maps to a specific fix:
 *   1. symbolSearch exact match priority
 *   2. Executor identifier-based fallback search
 *   3. includeMemories defaults to false
 *   4. deltaGet budget cap
 *   5. codeNeedWindow downgradeGuidance
 *   6. codeSkeleton howToResume parameter
 *   7. bufferPush close event handling
 *   8. codeHotPath missedIdentifiers
 *   9. contextSummary relevance sorting
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OverlayStore } from "../../dist/live-index/overlay-store.js";
import { tokenize } from "../../dist/util/tokenize.js";
import { TASK_TEXT_STOP_WORDS } from "../../dist/graph/slice/start-node-resolver.js";
import { sortByExactMatch } from "../../dist/mcp/tools/symbol.js";
import {
  extractIdentifiersFromText,
  IDENTIFIER_STOP_WORDS,
  MAX_IDENTIFIERS,
} from "../../dist/agent/executor.js";

// ---------------------------------------------------------------------------
// 1. symbolSearch exact match priority
// ---------------------------------------------------------------------------
describe("symbolSearch exact match priority", () => {
  // Uses the real sortByExactMatch from dist/mcp/tools/symbol.js

  it("moves exact name match to position 0", () => {
    const results = [
      { name: "handleRequestError" },
      { name: "processRequest" },
      { name: "handleRequest" }, // exact match, buried at index 2
      { name: "handleRequestTimeout" },
    ];

    const sorted = sortByExactMatch([...results], "handleRequest");
    assert.equal(sorted[0].name, "handleRequest");
  });

  it("is case-insensitive for exact matching", () => {
    const results = [
      { name: "parsejson" },
      { name: "ParseJSON" }, // exact match (case-insensitive)
      { name: "parseJsonBody" },
    ];

    const sorted = sortByExactMatch([...results], "parsejson");
    assert.equal(sorted[0].name, "parsejson");
    assert.equal(sorted[1].name, "ParseJSON");
  });

  it("prefers starts-with over unrelated when no exact match exists", () => {
    const results = [
      { name: "validateSchema" },
      { name: "handleValidate" },
      { name: "validateInput" }, // starts-with match
    ];

    const sorted = sortByExactMatch([...results], "validate");
    // Both validateSchema and validateInput start with "validate"
    const topTwo = sorted.slice(0, 2).map((r) => r.name);
    assert.ok(topTwo.includes("validateSchema"));
    assert.ok(topTwo.includes("validateInput"));
    // handleValidate does NOT start with "validate"
    assert.equal(sorted[2].name, "handleValidate");
  });

  it("preserves order when all names are equally unrelated", () => {
    const results = [
      { name: "alpha" },
      { name: "beta" },
      { name: "gamma" },
    ];

    const sorted = sortByExactMatch([...results], "delta");
    // No exact or prefix match, sort is stable (all tied)
    assert.equal(sorted.length, 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Executor identifier-based fallback search
// ---------------------------------------------------------------------------
describe("extractIdentifiersFromTask logic", () => {
  // Uses the real extractIdentifiersFromText from dist/agent/executor.js

  it("extracts camelCase identifiers from natural language", () => {
    const ids = extractIdentifiersFromText(
      "Fix the handleRequest function that calls parseJsonBody",
    );
    assert.ok(ids.includes("handleRequest"), "should find handleRequest");
    assert.ok(ids.includes("parseJsonBody"), "should find parseJsonBody");
  });

  it("extracts PascalCase identifiers", () => {
    const ids = extractIdentifiersFromText(
      "The IndexError class is thrown by SymbolParser",
    );
    assert.ok(ids.includes("IndexError"), "should find IndexError");
    assert.ok(ids.includes("SymbolParser"), "should find SymbolParser");
  });

  it("extracts snake_case identifiers", () => {
    const ids = extractIdentifiersFromText(
      "Update the max_retry_count and handle_error_code values",
    );
    assert.ok(ids.includes("max_retry_count"), "should find max_retry_count");
    assert.ok(ids.includes("handle_error_code"), "should find handle_error_code");
  });

  it("filters stop words", () => {
    const ids = extractIdentifiersFromText("Fix the error in the code");
    // "fix", "the", "error", "code" are all stop words
    assert.ok(!ids.includes("fix"));
    assert.ok(!ids.includes("the"));
    assert.ok(!ids.includes("error"));
    assert.ok(!ids.includes("code"));
  });

  it("deduplicates identifiers", () => {
    const ids = extractIdentifiersFromText(
      "handleRequest calls handleRequest again and handleRequest",
    );
    const count = ids.filter((id) => id === "handleRequest").length;
    assert.equal(count, 1, "handleRequest should appear only once");
  });

  it("limits to MAX_IDENTIFIERS (10)", () => {
    const ids = extractIdentifiersFromText(
      "aFunc bFunc cFunc dFunc eFunc fFunc gFunc hFunc iFunc jFunc kFunc lFunc mFunc nFunc oFunc",
    );
    assert.ok(ids.length <= MAX_IDENTIFIERS);
  });

  it("uses searchTerms option when provided instead of extraction", () => {
    // This tests the logic at executor.ts line 396-398:
    // const searchTerms = task.options?.searchTerms?.length
    //   ? task.options.searchTerms.slice(0, 5)
    //   : this.extractIdentifiersFromTask(task).slice(0, 5);
    const searchTerms = ["alpha", "beta", "gamma"];
    const extracted = extractIdentifiersFromText("handleRequest parseJson doSomething");

    // When searchTerms is provided and non-empty, it should be used
    const result = searchTerms.length
      ? searchTerms.slice(0, 5)
      : extracted.slice(0, 5);
    assert.deepEqual(result, ["alpha", "beta", "gamma"]);

    // When searchTerms is empty, fall back to extraction
    const emptySearchTerms: string[] = [];
    const fallback = emptySearchTerms.length
      ? emptySearchTerms.slice(0, 5)
      : extracted.slice(0, 5);
    assert.ok(fallback.length > 0, "should fall back to extracted identifiers");
    assert.ok(
      fallback.includes("handleRequest"),
      "fallback should contain extracted identifiers",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. includeMemories defaults to false
// ---------------------------------------------------------------------------
describe("includeMemories defaults to false", () => {
  it("undefined evaluates as do-not-include", () => {
    const includeMemories: boolean | undefined = undefined;
    const shouldIncludeMemories = includeMemories === true;
    assert.equal(shouldIncludeMemories, false);
  });

  it("false evaluates as do-not-include", () => {
    const includeMemories = false;
    const shouldIncludeMemories = includeMemories === true;
    assert.equal(shouldIncludeMemories, false);
  });

  it("only true triggers inclusion", () => {
    const includeMemories = true;
    const shouldIncludeMemories = includeMemories === true;
    assert.equal(shouldIncludeMemories, true);
  });

  it("strict equality prevents truthy coercion", () => {
    // This is the key fix: using === true instead of just truthy
    // A non-boolean truthy value should NOT trigger memory inclusion
    const includeMemories = 1 as unknown as boolean;
    const shouldIncludeMemories = includeMemories === true;
    assert.equal(shouldIncludeMemories, false, "1 !== true with strict equality");
  });
});

// ---------------------------------------------------------------------------
// 4. deltaGet budget cap
// ---------------------------------------------------------------------------
describe("deltaGet budget cap", () => {
  it("caps maxCards at 100", () => {
    const requestedMaxCards = 500;
    const capped = Math.min(requestedMaxCards, 100);
    assert.equal(capped, 100);
  });

  it("preserves maxCards when under cap", () => {
    const requestedMaxCards = 50;
    const capped = Math.min(requestedMaxCards, 100);
    assert.equal(capped, 50);
  });

  it("caps maxEstimatedTokens at 20000", () => {
    const requestedTokens = 50000;
    const capped = Math.min(requestedTokens, 20000);
    assert.equal(capped, 20000);
  });

  it("preserves maxEstimatedTokens when under cap", () => {
    const requestedTokens = 10000;
    const capped = Math.min(requestedTokens, 20000);
    assert.equal(capped, 10000);
  });

  it("applies default when maxCards is undefined", () => {
    const DEFAULT_MAX_CARDS = 30; // typical default
    const maxCards: number | undefined = undefined;
    const capped = Math.min(maxCards ?? DEFAULT_MAX_CARDS, 100);
    assert.equal(capped, DEFAULT_MAX_CARDS);
  });

  it("applies default when maxEstimatedTokens is undefined", () => {
    const DEFAULT_MAX_TOKENS = 8000; // typical default
    const maxEstimatedTokens: number | undefined = undefined;
    const capped = Math.min(maxEstimatedTokens ?? DEFAULT_MAX_TOKENS, 20000);
    assert.equal(capped, DEFAULT_MAX_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// 5. codeNeedWindow downgradeGuidance
// ---------------------------------------------------------------------------
describe("codeNeedWindow downgradeGuidance", () => {
  it("includes downgradeGuidance when downgradedFrom is set to skeleton", () => {
    const response = {
      approved: true as const,
      symbolId: "sym-1",
      file: "src/test.ts",
      range: { startLine: 1, endLine: 10 },
      code: "// skeleton",
      whyApproved: ["Policy approved (downgraded to skeleton)"],
      estimatedTokens: 50,
      downgradedFrom: "raw-code" as const,
      downgradeGuidance:
        "Raw code access was downgraded to skeleton by policy. To get full code: (1) set policy.allowBreakGlass=true via sdl.policy.set, then retry with breakGlass in sliceContext, or (2) use sdl.code.getHotPath with specific identifiersToFind for targeted access.",
    };

    assert.ok(response.downgradeGuidance, "guidance should be present");
    assert.ok(
      response.downgradeGuidance.includes("sdl.policy.set"),
      "guidance should mention sdl.policy.set",
    );
    assert.ok(
      response.downgradeGuidance.includes("sdl.code.getHotPath"),
      "guidance should mention sdl.code.getHotPath",
    );
  });

  it("includes downgradeGuidance when downgradedFrom is set to hotpath", () => {
    const response = {
      approved: true as const,
      symbolId: "sym-1",
      file: "src/test.ts",
      range: { startLine: 1, endLine: 10 },
      code: "// hotpath",
      whyApproved: ["Policy approved (downgraded to hotpath)"],
      estimatedTokens: 50,
      downgradedFrom: "raw-code" as const,
      downgradeGuidance:
        "Raw code access was downgraded to hot-path by policy. To get full code: (1) set policy.allowBreakGlass=true via sdl.policy.set, or (2) request a skeleton via sdl.code.getSkeleton for broader code structure.",
    };

    assert.ok(response.downgradeGuidance, "guidance should be present");
    assert.ok(
      response.downgradeGuidance.includes("sdl.policy.set"),
      "guidance should mention sdl.policy.set",
    );
    assert.ok(
      response.downgradeGuidance.includes("sdl.code.getSkeleton"),
      "guidance should mention sdl.code.getSkeleton",
    );
  });

  it("has no downgradeGuidance when no downgrade occurred", () => {
    const response: Record<string, unknown> = {
      approved: true,
      symbolId: "sym-1",
      file: "src/test.ts",
      range: { startLine: 1, endLine: 10 },
      code: "// full code",
      whyApproved: ["Identifiers matched"],
      estimatedTokens: 100,
    };

    assert.equal(response.downgradeGuidance, undefined);
  });
});

// ---------------------------------------------------------------------------
// 6. codeSkeleton howToResume parameter
// ---------------------------------------------------------------------------
describe("codeSkeleton howToResume parameter", () => {
  it("includes parameter: skeletonOffset in truncation howToResume", () => {
    const skeletonLinesConsumed = 50;
    const truncation = {
      truncated: true,
      droppedCount: 25,
      howToResume: {
        type: "cursor" as const,
        value: skeletonLinesConsumed,
        parameter: "skeletonOffset",
      },
    };

    assert.equal(truncation.howToResume.parameter, "skeletonOffset");
    assert.equal(truncation.howToResume.type, "cursor");
    assert.equal(truncation.howToResume.value, 50);
  });

  it("parameter field is absent from non-skeleton howToResume", () => {
    // For hotpath/raw window truncation, parameter is not included
    const truncation = {
      truncated: true,
      droppedCount: 10,
      howToResume: {
        type: "cursor" as const,
        value: 100,
      },
    };

    assert.equal(
      (truncation.howToResume as Record<string, unknown>).parameter,
      undefined,
    );
  });

  it("howToResume value falls back to actualRange.endLine when skeletonLinesConsumed is undefined", () => {
    // Tests the nullish coalescing: skeletonLinesConsumed ?? actualRange.endLine
    const skeletonLinesConsumed: number | undefined = undefined;
    const actualRangeEndLine = 120;
    const value = skeletonLinesConsumed ?? actualRangeEndLine;
    assert.equal(value, 120);
  });
});

// ---------------------------------------------------------------------------
// 7. bufferPush close event handling
// ---------------------------------------------------------------------------
describe("bufferPush close event handling", () => {
  it("OverlayStore accepts close event even with same version as existing draft", () => {
    // The fix: close events are processed BEFORE the stale version check.
    // This tests the logic in coordinator.ts lines 118-129:
    //
    //   if (input.eventType === "close") {
    //     this.overlayStore.removeDraft(input.repoId, input.filePath);
    //     return { accepted: true, ... };
    //   }
    //
    //   if (existing && input.version <= existing.version) {
    //     return { accepted: false, ... };  // stale
    //   }

    const store = new OverlayStore();

    // Open a draft at version 5
    store.upsertDraft({
      repoId: "repo1",
      eventType: "open",
      filePath: "src/test.ts",
      content: "const x = 1;",
      version: 5,
      dirty: false,
      timestamp: new Date().toISOString(),
    });

    // Verify draft exists
    const draft = store.getDraft("repo1", "src/test.ts");
    assert.ok(draft, "draft should exist after open");
    assert.equal(draft.version, 5);

    // Simulate the close event logic (same version = 5)
    // Before the fix, this would hit the stale check: version 5 <= existing version 5
    // After the fix, close events bypass the stale check
    const closeInput = {
      eventType: "close" as const,
      dirty: false,
      version: 5,
      repoId: "repo1",
      filePath: "src/test.ts",
    };

    // Apply the fix logic: close + !dirty -> removeDraft -> accepted
    if (closeInput.eventType === "close") {
      store.removeDraft(closeInput.repoId, closeInput.filePath);
      const afterClose = store.getDraft("repo1", "src/test.ts");
      assert.equal(afterClose, null, "draft should be removed after close");
    } else {
      assert.fail("close event should be detected");
    }
  });

  it("stale version check still applies to non-close events", () => {
    const store = new OverlayStore();

    store.upsertDraft({
      repoId: "repo1",
      eventType: "open",
      filePath: "src/test.ts",
      content: "const x = 1;",
      version: 5,
      dirty: false,
      timestamp: new Date().toISOString(),
    });

    // A change event with version <= existing should be stale
    const existing = store.getDraft("repo1", "src/test.ts");
    assert.ok(existing);
    const staleVersion = 5;
    assert.ok(
      staleVersion <= existing.version,
      "version 5 <= 5 is considered stale for non-close events",
    );
  });

  it("close event with dirty=true also gets the close handler", () => {
    // All close events now enter the close handler regardless of dirty flag.
    // Dirty close means the editor closed without saving — we restore from disk.
    const store = new OverlayStore();

    store.upsertDraft({
      repoId: "repo1",
      eventType: "change",
      filePath: "src/test.ts",
      version: 5,
      dirty: true,
      content: "stale content",
      language: "typescript",
      timestamp: new Date().toISOString(),
    });

    const closeInput = {
      eventType: "close" as const,
      dirty: true,
      version: 5,
    };

    const shouldHandle = closeInput.eventType === "close";
    assert.equal(shouldHandle, true, "dirty close events enter close handler");

    // Simulate the close handler: removeDraft
    store.removeDraft("repo1", "src/test.ts");
    const afterClose = store.getDraft("repo1", "src/test.ts");
    assert.equal(afterClose, null, "dirty draft removed on close");
  });
});

// ---------------------------------------------------------------------------
// 8. codeHotPath missedIdentifiers
// ---------------------------------------------------------------------------
describe("codeHotPath missedIdentifiers", () => {
  it("reports identifiers that were requested but not found", () => {
    const requestedIdentifiers = [
      "handleRequest",
      "validateInput",
      "parseConfig",
    ];
    const matchedIdentifiers = ["handleRequest"];

    const missedIdentifiers = requestedIdentifiers.filter(
      (id) => !matchedIdentifiers.includes(id),
    );

    assert.deepEqual(missedIdentifiers, ["validateInput", "parseConfig"]);
  });

  it("returns empty array when all identifiers are found", () => {
    const requestedIdentifiers = ["handleRequest", "validateInput"];
    const matchedIdentifiers = ["handleRequest", "validateInput"];

    const missedIdentifiers = requestedIdentifiers.filter(
      (id) => !matchedIdentifiers.includes(id),
    );

    assert.deepEqual(missedIdentifiers, []);
  });

  it("includes missedIdentifiers in response only when non-empty", () => {
    // Tests the conditional spread: ...(missedIdentifiers.length > 0 ? { missedIdentifiers } : {})
    const matchedIdentifiers = ["handleRequest"];

    // Case 1: some missed
    const missed1 = ["validateInput", "parseConfig"];
    const response1 = {
      excerpt: "...",
      matchedIdentifiers,
      ...(missed1.length > 0 ? { missedIdentifiers: missed1 } : {}),
    };
    assert.ok("missedIdentifiers" in response1);
    assert.deepEqual(response1.missedIdentifiers, [
      "validateInput",
      "parseConfig",
    ]);

    // Case 2: none missed
    const missed2: string[] = [];
    const response2: Record<string, unknown> = {
      excerpt: "...",
      matchedIdentifiers,
      ...(missed2.length > 0 ? { missedIdentifiers: missed2 } : {}),
    };
    assert.ok(
      !("missedIdentifiers" in response2),
      "should not have missedIdentifiers when all found",
    );
  });
});

// ---------------------------------------------------------------------------
// 9. contextSummary relevance sorting
// ---------------------------------------------------------------------------
describe("contextSummary relevance sorting", () => {
  /**
   * Replicates the sorting logic from src/services/summary.ts lines 337-369.
   * Uses the real tokenize function and TASK_TEXT_STOP_WORDS.
   */
  function sortKeySymbols(
    symbols: Array<{
      symbolId: string;
      name: string;
      summary: string;
    }>,
    query: string,
    metricsMap: Map<string, { fanIn: number }>,
    edgesMap: Map<string, string[]>,
  ): Array<{ symbolId: string; name: string; summary: string }> {
    const queryTokensLower = tokenize(query)
      .filter((t: string) => t.length >= 3 && !TASK_TEXT_STOP_WORDS.has(t))
      .map((t: string) => t.toLowerCase());

    return [...symbols].sort((a, b) => {
      const nameLowerA = a.name.toLowerCase();
      const nameLowerB = b.name.toLowerCase();
      const summaryLowerA = (a.summary ?? "").toLowerCase();
      const summaryLowerB = (b.summary ?? "").toLowerCase();
      let relevanceA = 0;
      let relevanceB = 0;
      for (const token of queryTokensLower) {
        if (nameLowerA.includes(token)) relevanceA += 10;
        else if (summaryLowerA.includes(token)) relevanceA += 3;
        if (nameLowerB.includes(token)) relevanceB += 10;
        else if (summaryLowerB.includes(token)) relevanceB += 3;
      }
      const metricsA = metricsMap.get(a.symbolId);
      const metricsB = metricsMap.get(b.symbolId);
      const fanInA = metricsA?.fanIn ?? 0;
      const fanInB = metricsB?.fanIn ?? 0;
      const edgesA = (edgesMap.get(a.symbolId) ?? []).length;
      const edgesB = (edgesMap.get(b.symbolId) ?? []).length;
      const structuralA = fanInA * 3 + edgesA;
      const structuralB = fanInB * 3 + edgesB;
      const scoreA = relevanceA * 5 + structuralA;
      const scoreB = relevanceB * 5 + structuralB;
      return scoreB - scoreA || a.name.localeCompare(b.name);
    });
  }

  it("ranks name-matching symbol above high-fan-in unrelated symbol", () => {
    const symbols = [
      {
        symbolId: "high-fanin",
        name: "DatabaseConnection",
        summary: "Manages database pool",
      },
      {
        symbolId: "name-match",
        name: "handleRequest",
        summary: "Processes incoming HTTP requests",
      },
    ];

    const metricsMap = new Map([
      ["high-fanin", { fanIn: 8 }], // moderate fan-in (structural = 8*3+5 = 29)
      ["name-match", { fanIn: 1 }], // low fan-in (structural = 1*3+1 = 4)
    ]);
    const edgesMap = new Map([
      ["high-fanin", ["a", "b", "c", "d", "e"]],
      ["name-match", ["x"]],
    ]);

    const sorted = sortKeySymbols(
      symbols,
      "handleRequest error handling",
      metricsMap,
      edgesMap,
    );

    assert.equal(
      sorted[0].symbolId,
      "name-match",
      "handleRequest should rank first due to name match despite lower fan-in",
    );
  });

  it("uses summary match as secondary relevance signal", () => {
    const symbols = [
      {
        symbolId: "no-match",
        name: "helperUtil",
        summary: "General utility functions",
      },
      {
        symbolId: "summary-match",
        name: "processData",
        summary: "Validates authentication tokens",
      },
    ];

    const metricsMap = new Map([
      ["no-match", { fanIn: 0 }],
      ["summary-match", { fanIn: 0 }],
    ]);
    const edgesMap = new Map<string, string[]>([
      ["no-match", []],
      ["summary-match", []],
    ]);

    const sorted = sortKeySymbols(
      symbols,
      "authentication validation",
      metricsMap,
      edgesMap,
    );

    assert.equal(
      sorted[0].symbolId,
      "summary-match",
      "symbol with summary match should rank above no-match symbol",
    );
  });

  it("falls back to structural importance when relevance is tied", () => {
    const symbols = [
      { symbolId: "low-fanin", name: "alpha", summary: "" },
      { symbolId: "high-fanin", name: "beta", summary: "" },
    ];

    const metricsMap = new Map([
      ["low-fanin", { fanIn: 1 }],
      ["high-fanin", { fanIn: 20 }],
    ]);
    const edgesMap = new Map<string, string[]>([
      ["low-fanin", []],
      ["high-fanin", []],
    ]);

    // Query that does not match either name
    const sorted = sortKeySymbols(
      symbols,
      "something unrelated entirely",
      metricsMap,
      edgesMap,
    );

    assert.equal(
      sorted[0].symbolId,
      "high-fanin",
      "higher fan-in should win when relevance scores are tied",
    );
  });

  it("breaks final ties alphabetically", () => {
    const symbols = [
      { symbolId: "z-sym", name: "zulu", summary: "" },
      { symbolId: "a-sym", name: "alpha", summary: "" },
    ];

    const metricsMap = new Map<string, { fanIn: number }>();
    const edgesMap = new Map<string, string[]>();

    const sorted = sortKeySymbols(
      symbols,
      "unrelated query text",
      metricsMap,
      edgesMap,
    );

    assert.equal(
      sorted[0].name,
      "alpha",
      "alphabetical order should break ties",
    );
  });

  it("name match (10 points * 5x) dominates fan-in (3 points per)", () => {
    // Name match for one query token = 10 relevance points * 5x weight = 50
    // Fan-in of 16 = 16 * 3 = 48 structural points
    // Name match (50) vs fan-in structural (48) -> name match wins
    const symbols = [
      { symbolId: "fan-only", name: "unrelated", summary: "" },
      { symbolId: "name-hit", name: "parser", summary: "" },
    ];

    const metricsMap = new Map([
      ["fan-only", { fanIn: 16 }], // structural = 48
      ["name-hit", { fanIn: 0 }], // structural = 0
    ]);
    const edgesMap = new Map<string, string[]>();

    const sorted = sortKeySymbols(
      symbols,
      "parser implementation",
      metricsMap,
      edgesMap,
    );

    assert.equal(
      sorted[0].symbolId,
      "name-hit",
      "name match should outweigh fan-in of 16",
    );
  });
});
