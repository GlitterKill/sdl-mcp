import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enforceCodeWindow } from "../../../dist/code/enforce.js";
import type { CodeAccessApprove } from "../../../dist/policy/code-access.js";
import {
  FakeWindowLoader,
  buildFakeSymbol,
  buildFakeWindow,
} from "../../fixtures/fake-window-loader.ts";

const APPROVE_DECISION: CodeAccessApprove = {
  kind: "approve",
  effectiveCaps: { maxWindowLines: 180, maxWindowTokens: 1400 },
  evidenceUsed: [],
  auditHash: "test-audit-hash",
};

function makeLoader(args: {
  symbolId: string;
  symbolName: string;
  code: string;
  signatureParams?: string[];
}) {
  const symbol = buildFakeSymbol(args.symbolId, args.symbolName, {
    signatureParams: args.signatureParams,
  });
  const window = buildFakeWindow(args.symbolId, args.code);
  return new FakeWindowLoader({
    windows: new Map([[args.symbolId, window]]),
    symbols: new Map([[args.symbolId, symbol]]),
  });
}

describe("enforceCodeWindow — window loading", () => {
  it("denies when the loader cannot extract a window", async () => {
    const loader = new FakeWindowLoader({
      failLoadFor: new Set(["sym-1"]),
      symbols: new Map([["sym-1", buildFakeSymbol("sym-1", "demo")]]),
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "investigate",
        expectedLines: 20,
        identifiersToFind: ["demo"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Unexpected approval");
    assert.ok(
      response.whyDenied.some((m) =>
        m.includes("Code window could not be extracted"),
      ),
    );
  });

  it("denies when the symbol is not found", async () => {
    const loader = new FakeWindowLoader({
      windows: new Map([
        ["sym-1", buildFakeWindow("sym-1", "function demo() {}")],
      ]),
      // No symbols registered → getSymbol returns null
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "investigate",
        expectedLines: 20,
        identifiersToFind: ["demo"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Unexpected approval");
    assert.deepEqual(response.whyDenied, ["Symbol not found"]);
  });
});

describe("enforceCodeWindow — identifier verification", () => {
  it("approves when all requested identifiers appear in the window", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "handleRequest",
      code: "function handleRequest(req) {\n  return req.id;\n}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "verify identifier",
        expectedLines: 20,
        identifiersToFind: ["handleRequest"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.match(
      response.whyApproved.join("\n"),
      /Identifiers matched: handleRequest/,
    );
  });

  it("approves when at least one of multiple identifiers matches", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "calc",
      code: "function calc() { return totalSum; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "verify identifier",
        expectedLines: 20,
        identifiersToFind: ["totalSum", "missingIdent"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, true);
  });

  it("denies and proposes hotPath when no identifiers match", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demoFn",
      code: "function demoFn() { return 42; }",
      signatureParams: ["alpha", "beta"],
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "investigate",
        expectedLines: 20,
        identifiersToFind: ["nowhere"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.ok(
      response.whyDenied.includes("Identifiers not found in code window"),
    );
    assert.ok(response.nextBestAction);
    assert.equal(response.nextBestAction!.tool, "sdl.code.getHotPath");
    assert.deepEqual(response.suggestedNextRequest?.identifiersToFind, [
      "alpha",
      "beta",
    ]);
  });

  it("falls back to symbol name when signature has no params", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "loneFn",
      code: "function loneFn() { return 0; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "investigate",
        expectedLines: 20,
        identifiersToFind: ["missing"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.deepEqual(response.suggestedNextRequest?.identifiersToFind, [
      "loneFn",
    ]);
  });
});

describe("enforceCodeWindow — fallback paths (no identifiers)", () => {
  it("approves when symbol is in slice cards and no identifiers requested", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: {
          cards: [{ symbolId: "sym-1" }],
          frontier: [],
        } as any,
      },
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.ok(response.whyApproved.some((m) => m.includes("slice context")));
  });

  it("approves when symbol is in slice frontier (string entry)", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: {
          cards: [],
          frontier: ["sym-1"],
        } as any,
      },
    );
    assert.equal(response.approved, true);
  });

  it("approves when break-glass override is set", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "audit",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      { breakGlass: true },
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.ok(response.whyApproved.some((m) => m.includes("Break-glass")));
  });

  it("denies when no identifiers, no slice match, no break-glass, low utility", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
    if (response.approved) throw new Error("Expected denial");
    assert.ok(
      response.whyDenied.includes("Request does not meet approval criteria"),
    );
    assert.ok(response.nextBestAction);
    assert.equal(response.nextBestAction!.tool, "sdl.code.getSkeleton");
  });
});

/**
 * Identifier-match contract.
 *
 * The proof-of-need gate's whole guarantee is that requested identifiers
 * actually appear as token-bounded matches in the loaded window text.
 * The behaviors below are load-bearing for the gate's promise:
 *   - case-sensitive (TS/JS identifiers are case-sensitive)
 *   - token-bounded (substring inside larger token must NOT match)
 *   - underscore is part of the identifier-character class
 *   - regex metacharacters are escaped (no regex injection)
 */
describe("enforceCodeWindow — identifier match contract", () => {
  it("is case-sensitive: lowercase query against camelCase code denies", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "handleRequest",
      code: "function handleRequest(req) { return req; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "match contract",
        expectedLines: 20,
        identifiersToFind: ["handlerequest"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
  });

  it("respects word boundaries: 'foo' does NOT match inside 'fooBar'", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "fooBar",
      code: "function fooBar() { return fooBarBaz(); }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "match contract",
        expectedLines: 20,
        identifiersToFind: ["foo"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
  });

  it("respects underscore boundary: 'myVar' does NOT match '_myVar'", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() { const _myVar = 1; return _myVar; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "match contract",
        expectedLines: 20,
        identifiersToFind: ["myVar"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
  });

  it("matches identifier when adjacent to operators and punctuation", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() { return (foo + 1) * foo; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "match contract",
        expectedLines: 20,
        identifiersToFind: ["foo"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.match(response.whyApproved.join("\n"), /Identifiers matched: foo/);
  });

  it("escapes regex metacharacters: '.*' is treated as literal, not wildcard", async () => {
    // If metachars were unescaped, '.*' would match any character run and
    // every request would be approved. Confirm denial when the literal
    // sequence '.*' is absent from the window.
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() { return 42; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "regex injection check",
        expectedLines: 20,
        identifiersToFind: [".*"],
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, false);
  });

  it("approves when at least one of multiple identifiers matches with strict boundaries", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "calc",
      code: "function calc() { const totalSum = 0; return totalSum; }",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "match contract",
        expectedLines: 20,
        identifiersToFind: ["sum", "totalSum"], // 'sum' should NOT match (inside totalSum); 'totalSum' should
      },
      APPROVE_DECISION,
      loader,
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.match(
      response.whyApproved.join("\n"),
      /Identifiers matched: totalSum/,
    );
  });
});

/**
 * Slice frontier — object-shape branch.
 *
 * The deleted gate.ts only handled the legacy string-frontier shape; the
 * new enforce.ts handles both `string` and `{symbolId, score, reason}`
 * object entries. Production frontier rows are objects (per the slice
 * builder), so the object branch must be covered.
 */
describe("enforceCodeWindow — frontier object branch", () => {
  it("approves when the frontier contains an object entry whose symbolId matches the request", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: {
          cards: [],
          frontier: [{ symbolId: "sym-1", score: 0.7, reason: "neighbor" }],
        } as any,
      },
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.ok(response.whyApproved.some((m) => m.includes("slice context")));
  });

  it("does not approve via frontier when the object's symbolId is for a different symbol", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: {
          cards: [],
          frontier: [{ symbolId: "other-sym", score: 0.7, reason: "x" }],
        } as any,
      },
    );
    // No identifier match, no slice/frontier match, default scorer is low,
    // no break-glass → deny.
    assert.equal(response.approved, false);
  });

  it("ignores malformed frontier entries (non-string, non-object) and continues evaluating", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: {
          cards: [],
          // Garbage entries must not throw and must not approve.
          frontier: [42, null, { score: 0.5 }, { symbolId: "other" }],
        } as any,
      },
    );
    assert.equal(response.approved, false);
  });
});

/**
 * Utility-fallback approve path.
 *
 * When no identifiers are requested AND no slice match AND no break-glass,
 * enforce.ts falls back to a utility score. UTILITY_SCORE_THRESHOLD = 0.3.
 * The injected scoreFn lets these tests pin down the threshold contract
 * without depending on the real scorer's heuristics.
 */
describe("enforceCodeWindow — utility-fallback approve path", () => {
  it("approves when no identifiers requested but utility score is above threshold", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      { scoreFn: () => 0.5 },
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.match(response.whyApproved.join("\n"), /utility score/i);
  });

  it("denies when utility score is exactly at the threshold (0.3)", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      { scoreFn: () => 0.3 },
    );
    // Threshold is strict greater-than, so 0.3 must NOT approve.
    assert.equal(response.approved, false);
  });

  it("denies when utility score is just below the threshold", async () => {
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      { scoreFn: () => 0.299 },
    );
    assert.equal(response.approved, false);
  });

  it("approves via slice cards even when injected scoreFn would deny", async () => {
    // Slice membership is checked before the utility fallback, so an
    // in-slice symbol must approve regardless of the score value.
    const loader = makeLoader({
      symbolId: "sym-1",
      symbolName: "demo",
      code: "function demo() {}",
    });
    const response = await enforceCodeWindow(
      {
        repoId: "test-repo",
        symbolId: "sym-1",
        reason: "explore",
        expectedLines: 20,
        identifiersToFind: [],
      },
      APPROVE_DECISION,
      loader,
      {
        slice: { cards: [{ symbolId: "sym-1" }], frontier: [] } as any,
        scoreFn: () => 0.0,
      },
    );
    assert.equal(response.approved, true);
    if (!response.approved) throw new Error("Expected approval");
    assert.ok(response.whyApproved.some((m) => m.includes("slice context")));
  });
});
