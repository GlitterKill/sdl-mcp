import { describe, it } from "node:test";
import assert from "node:assert";

import type { ExtractedCall } from "../../dist/indexer/treesitter/extractCalls.js";
import { resolveCallTarget } from "../../dist/indexer/edge-builder/call-resolution.js";

function makeCall(overrides: Partial<ExtractedCall> = {}): ExtractedCall {
  return {
    callerNodeId: "caller",
    calleeIdentifier: "target",
    isResolved: false,
    callType: "function",
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 6 },
    ...overrides,
  };
}

describe("resolveCallTarget", () => {
  it("resolves direct calleeSymbolId through nodeIdToSymbolId", () => {
    const call = makeCall({
      calleeSymbolId: "node-1",
      calleeIdentifier: "ignored",
    });
    const result = resolveCallTarget(
      call,
      new Map([["node-1", "sym-1"]]),
      new Map(),
      new Map(),
      new Map(),
    );

    assert.deepStrictEqual(result, {
      symbolId: "sym-1",
      isResolved: true,
      confidence: 0.85,
      strategy: "exact",
      candidateCount: undefined,
      targetName: undefined,
    });
  });

  it("resolves imported name when exactly one imported candidate exists", () => {
    const call = makeCall({ calleeIdentifier: "parseConfig" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map([["parseConfig", ["sym-import"]]]),
      new Map(),
    );

    assert.strictEqual(result?.symbolId, "sym-import");
    assert.strictEqual(result?.isResolved, true);
    assert.strictEqual(result?.strategy, "exact");
    assert.strictEqual(result?.confidence, 0.9);
  });

  it("returns unresolved result for ambiguous imported name", () => {
    const call = makeCall({ calleeIdentifier: "parseConfig" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map([["parseConfig", ["sym-1", "sym-2"]]]),
      new Map(),
    );

    assert.strictEqual(result?.symbolId, null);
    assert.strictEqual(result?.isResolved, false);
    assert.strictEqual(result?.strategy, "unresolved");
    assert.strictEqual(result?.candidateCount, 2);
    assert.strictEqual(result?.targetName, "parseConfig");
    assert.strictEqual(result?.confidence, 0.12000000000000001);
  });

  it("resolves namespace member calls like ns.fn via namespaceImports", () => {
    const call = makeCall({ calleeIdentifier: "ns.fn" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map([["ns", new Map([["fn", "sym-ns-fn"]])]]),
    );

    assert.strictEqual(result?.symbolId, "sym-ns-fn");
    assert.strictEqual(result?.isResolved, true);
    assert.strictEqual(result?.strategy, "exact");
    assert.strictEqual(result?.confidence, 0.92);
  });

  it("resolves local symbols heuristically when one local candidate exists", () => {
    const call = makeCall({ calleeIdentifier: "localFn" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map([["localFn", ["sym-local"]]]),
      new Map(),
      new Map(),
    );

    assert.strictEqual(result?.symbolId, "sym-local");
    assert.strictEqual(result?.isResolved, true);
    assert.strictEqual(result?.strategy, "heuristic");
    assert.strictEqual(result?.confidence, 0.9);
  });

  it("resolves global names as fallback when local/imported maps miss", () => {
    const call = makeCall({ calleeIdentifier: "globalFn" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      undefined,
      new Map([["globalFn", ["sym-global"]]]),
    );

    assert.strictEqual(result?.symbolId, "sym-global");
    assert.strictEqual(result?.isResolved, true);
    assert.strictEqual(result?.strategy, "heuristic");
    assert.strictEqual(result?.confidence, 0.9);
  });

  it("uses preferred global symbol for ambiguous global matches", () => {
    const call = makeCall({ calleeIdentifier: "sharedName" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      undefined,
      new Map([["sharedName", ["sym-a", "sym-b", "sym-c"]]]),
      new Map([["sharedName", "sym-b"]]),
    );

    assert.strictEqual(result?.symbolId, "sym-b");
    assert.strictEqual(result?.isResolved, true);
    assert.strictEqual(result?.strategy, "heuristic");
    assert.strictEqual(result?.candidateCount, 3);
    assert.strictEqual(result?.confidence, 0.6);
  });

  it("returns unresolved metadata for unknown non-dynamic identifier", () => {
    const call = makeCall({ calleeIdentifier: "externalLibraryCall" });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    assert.strictEqual(result?.symbolId, null);
    assert.strictEqual(result?.isResolved, false);
    assert.strictEqual(result?.strategy, "unresolved");
    assert.strictEqual(result?.candidateCount, 0);
    assert.strictEqual(result?.targetName, "externalLibraryCall");
    assert.strictEqual(result?.confidence, 0.2);
  });

  it("returns null for dynamic unknown calls", () => {
    const call = makeCall({
      calleeIdentifier: "dynamicExpr",
      callType: "dynamic",
    });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    assert.strictEqual(result, null);
  });

  it("returns null when no callee identifier or symbol id is available", () => {
    const call = makeCall({ calleeIdentifier: "", calleeSymbolId: undefined });
    const result = resolveCallTarget(
      call,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
    );

    assert.strictEqual(result, null);
  });
});
