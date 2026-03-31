import { describe, it } from "node:test";
import assert from "node:assert";
import { generateDenialGuidance } from "../../dist/code/gate.js";
import type { DenialGuidance } from "../../dist/code/gate.js";

/**
 * Unit tests for generateDenialGuidance nextBestAction logic.
 *
 * These tests exercise the pure-function behaviour of generateDenialGuidance
 * by supplying a symbolHint so the function never needs to hit the database.
 */

const BASE_POLICY = {
  maxWindowLines: 180,
  maxWindowTokens: 1400,
  requireIdentifiers: true,
  allowBreakGlass: false,
};

/** Minimal SymbolRow-compatible object used as symbolHint in tests. */
function makeSymbol(name: string, params?: Array<{ name: string }>) {
  return {
    symbol_id: "sym-test",
    repo_id: "repo-test",
    file_id: 1,
    name,
    kind: "function" as const,
    signature_json: params ? JSON.stringify({ params }) : null,
    summary: null,
    invariants_json: null,
    side_effects_json: null,
    range_start_line: 1,
    range_start_col: 0,
    range_end_line: 50,
    range_end_col: 0,
    ast_fingerprint: "abc",
    exported: true,
    visibility: "public" as const,
    is_async: false,
    created_at: 0,
    updated_at: 0,
    churn_30d: 0,
    fan_in: 0,
    fan_out: 0,
    test_refs_json: null,
    embedding: null,
    embedding_model: null,
  };
}

describe("generateDenialGuidance - nextBestAction", () => {
  it("suggests getSkeleton when window is too broad", () => {
    const symbol = makeSymbol("parseConfig", [{ name: "input" }, { name: "opts" }]);
    const request = {
      repoId: "repo-test",
      symbolId: "sym-test",
      reason: "need full implementation",
      expectedLines: 400, // exceeds maxWindowLines of 180
      identifiersToFind: ["parseConfig"],
    };

    const guidance: DenialGuidance = generateDenialGuidance(
      request,
      "general",
      BASE_POLICY,
      symbol as any,
    );

    assert.strictEqual(
      guidance.nextBestAction.tool,
      "sdl.code.getSkeleton",
      "should suggest getSkeleton when window exceeds line limit",
    );
    assert.ok(
      guidance.nextBestAction.rationale.includes("parseConfig"),
      "rationale should mention the symbol name",
    );
  });

  it("suggests getHotPath when identifiers are provided (non-broad request)", () => {
    const symbol = makeSymbol("handleError");
    const request = {
      repoId: "repo-test",
      symbolId: "sym-test",
      reason: "investigate error handling",
      expectedLines: 80, // within limit
      identifiersToFind: ["errorCode", "throwError"],
    };

    const guidance: DenialGuidance = generateDenialGuidance(
      request,
      "general",
      BASE_POLICY,
      symbol as any,
    );

    assert.strictEqual(
      guidance.nextBestAction.tool,
      "sdl.code.getHotPath",
      "should suggest getHotPath when identifiers are provided but window denied",
    );
    assert.deepStrictEqual(
      (guidance.nextBestAction.args as any).identifiersToFind,
      ["errorCode", "throwError"],
      "getHotPath args should include the original identifiersToFind",
    );
    assert.ok(
      guidance.nextBestAction.rationale.includes("handleError"),
      "rationale should mention the symbol name",
    );
  });

  it("suggests getSkeleton with signature identifiers when identifiersToFind is empty", () => {
    const symbol = makeSymbol("buildGraph", [
      { name: "nodes" },
      { name: "edges" },
      { name: "opts" },
    ]);
    const request = {
      repoId: "repo-test",
      symbolId: "sym-test",
      reason: "explore implementation",
      expectedLines: 80, // within limit
      identifiersToFind: [], // empty — triggers sig extraction
    };

    const guidance: DenialGuidance = generateDenialGuidance(
      request,
      "general",
      BASE_POLICY,
      symbol as any,
    );

    assert.strictEqual(
      guidance.nextBestAction.tool,
      "sdl.code.getSkeleton",
      "should suggest getSkeleton when identifiersToFind is empty",
    );
    const args = guidance.nextBestAction.args as any;
    assert.ok(
      Array.isArray(args.identifiersToFind) && args.identifiersToFind.length > 0,
      "getSkeleton args should include identifiers derived from signature",
    );
    assert.ok(
      guidance.nextBestAction.rationale.includes("buildGraph"),
      "rationale should mention the symbol name",
    );
  });

  it("nextBestAction.args contains symbolId and repoId from the request", () => {
    const symbol = makeSymbol("myFunc");
    const request = {
      repoId: "my-repo",
      symbolId: "my-sym-123",
      reason: "debug",
      expectedLines: 50,
      identifiersToFind: ["myParam"],
    };

    const guidance: DenialGuidance = generateDenialGuidance(
      request,
      "general",
      BASE_POLICY,
      symbol as any,
    );

    const args = guidance.nextBestAction.args as Record<string, unknown>;
    assert.strictEqual(args.repoId, "my-repo", "args.repoId should match request.repoId");
    assert.strictEqual(args.symbolId, "my-sym-123", "args.symbolId should match request.symbolId");
  });

  it("nextBestAction.rationale mentions the symbol name", () => {
    const symbol = makeSymbol("computeDelta", [{ name: "a" }, { name: "b" }]);
    const request = {
      repoId: "repo-test",
      symbolId: "sym-test",
      reason: "understand diff logic",
      expectedLines: 300, // too broad
      identifiersToFind: ["a"],
    };

    const guidance: DenialGuidance = generateDenialGuidance(
      request,
      "general",
      BASE_POLICY,
      symbol as any,
    );

    assert.ok(
      guidance.nextBestAction.rationale.includes("computeDelta"),
      `rationale "${guidance.nextBestAction.rationale}" should mention "computeDelta"`,
    );
  });

  it("nextBestAction.tool is a non-empty string on every denial path", () => {
    const scenarios = [
      // Too broad
      {
        request: {
          repoId: "r",
          symbolId: "s",
          reason: "x",
          expectedLines: 999,
          identifiersToFind: ["foo"],
        },
        symbol: makeSymbol("foo"),
      },
      // Identifiers provided, normal lines
      {
        request: {
          repoId: "r",
          symbolId: "s",
          reason: "x",
          expectedLines: 50,
          identifiersToFind: ["bar"],
        },
        symbol: makeSymbol("bar"),
      },
      // Empty identifiers, normal lines
      {
        request: {
          repoId: "r",
          symbolId: "s",
          reason: "x",
          expectedLines: 50,
          identifiersToFind: [],
        },
        symbol: makeSymbol("baz"),
      },
      // Token cap exceeded
      {
        request: {
          repoId: "r",
          symbolId: "s",
          reason: "x",
          expectedLines: 50,
          maxTokens: 9999,
          identifiersToFind: [],
        },
        symbol: makeSymbol("qux"),
      },
    ];

    for (const { request, symbol } of scenarios) {
      const guidance = generateDenialGuidance(
        request,
        "general",
        BASE_POLICY,
        symbol as any,
      );
      assert.ok(
        typeof guidance.nextBestAction.tool === "string" &&
          guidance.nextBestAction.tool.length > 0,
        `nextBestAction.tool must be non-empty for request with ${JSON.stringify(request)}`,
      );
    }
  });
});
