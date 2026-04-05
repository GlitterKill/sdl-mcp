import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diffSymbols,
  type ExistingSymbol,
  type NewSymbol,
  type SymbolSource,
} from "../../dist/live-index/symbol-diff.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeExisting(
  overrides: Partial<ExistingSymbol> & { name: string; kind: string },
): ExistingSymbol {
  return {
    symbolId:
      overrides.symbolId ?? `existing-${overrides.name}-${overrides.kind}`,
    name: overrides.name,
    kind: overrides.kind,
    rangeStartLine: overrides.rangeStartLine ?? 0,
    rangeStartCol: overrides.rangeStartCol ?? 0,
    rangeEndLine: overrides.rangeEndLine ?? 10,
    rangeEndCol: overrides.rangeEndCol ?? 0,
    source: overrides.source ?? "treesitter",
  };
}

function makeNew(
  overrides: Partial<NewSymbol> & { name: string; kind: string },
): NewSymbol {
  return {
    symbolId: overrides.symbolId ?? `new-${overrides.name}-${overrides.kind}`,
    name: overrides.name,
    kind: overrides.kind,
    rangeStartLine: overrides.rangeStartLine ?? 0,
    rangeStartCol: overrides.rangeStartCol ?? 0,
    rangeEndLine: overrides.rangeEndLine ?? 10,
    rangeEndCol: overrides.rangeEndCol ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diffSymbols", () => {
  it("matches symbols by (name, kind) and updates properties", () => {
    const existing = [
      makeExisting({
        name: "foo",
        kind: "function",
        symbolId: "old-foo",
        rangeStartLine: 1,
        rangeEndLine: 5,
      }),
    ];
    const newer = [
      makeNew({
        name: "foo",
        kind: "function",
        symbolId: "new-foo",
        rangeStartLine: 2,
        rangeEndLine: 8,
      }),
    ];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 1);
    assert.strictEqual(result.matched[0].old.symbolId, "old-foo");
    assert.strictEqual(result.matched[0].new.symbolId, "new-foo");
    assert.strictEqual(result.added.length, 0);
    assert.strictEqual(result.removed.length, 0);
    assert.strictEqual(result.preserved.length, 0);
  });

  it("identifies added symbols that have no match in existing set", () => {
    const existing: ExistingSymbol[] = [];
    const newer = [
      makeNew({ name: "bar", kind: "function" }),
      makeNew({ name: "baz", kind: "class" }),
    ];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 0);
    assert.strictEqual(result.added.length, 2);
    assert.deepStrictEqual(result.added.map((s) => s.name).sort(), [
      "bar",
      "baz",
    ]);
    assert.strictEqual(result.removed.length, 0);
    assert.strictEqual(result.preserved.length, 0);
  });

  it("removes treesitter symbols that are not in the new parse", () => {
    const existing = [
      makeExisting({ name: "alpha", kind: "function", source: "treesitter" }),
      makeExisting({ name: "beta", kind: "function", source: "treesitter" }),
    ];
    const newer = [makeNew({ name: "alpha", kind: "function" })];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 1);
    assert.strictEqual(result.matched[0].old.name, "alpha");
    assert.strictEqual(result.removed.length, 1);
    assert.strictEqual(result.removed[0].name, "beta");
    assert.strictEqual(result.preserved.length, 0);
  });

  it("preserves SCIP-only symbols when not in new parse", () => {
    const existing = [
      makeExisting({ name: "tsFunc", kind: "function", source: "treesitter" }),
      makeExisting({
        name: "scipOnlyFunc",
        kind: "function",
        source: "scip",
        symbolId: "scip-only-id",
      }),
    ];
    const newer = [makeNew({ name: "tsFunc", kind: "function" })];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 1);
    assert.strictEqual(result.matched[0].old.name, "tsFunc");
    assert.strictEqual(result.removed.length, 0);
    assert.strictEqual(result.preserved.length, 1);
    assert.strictEqual(result.preserved[0].symbolId, "scip-only-id");
    assert.strictEqual(result.preserved[0].name, "scipOnlyFunc");
  });

  it("removes 'both' source symbols when not in new parse", () => {
    const existing = [
      makeExisting({
        name: "bothFunc",
        kind: "function",
        source: "both",
        symbolId: "both-id",
      }),
    ];
    const newer: NewSymbol[] = [];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 0);
    assert.strictEqual(result.removed.length, 1);
    assert.strictEqual(result.removed[0].symbolId, "both-id");
    assert.strictEqual(result.preserved.length, 0);
  });

  it("treats symbols without source field as treesitter (backward compat)", () => {
    // Simulate pre-SCIP data where source is undefined
    const existing: ExistingSymbol[] = [
      {
        symbolId: "legacy-id",
        name: "legacy",
        kind: "function",
        rangeStartLine: 0,
        rangeStartCol: 0,
        rangeEndLine: 5,
        rangeEndCol: 0,
        source: "treesitter", // toExistingSymbol defaults to "treesitter"
      },
    ];
    const newer: NewSymbol[] = [];

    const result = diffSymbols(existing, newer);

    // Should be removed (not preserved), since source defaults to "treesitter"
    assert.strictEqual(result.removed.length, 1);
    assert.strictEqual(result.preserved.length, 0);
  });

  it("handles empty file cleared -- ts symbols deleted, SCIP preserved", () => {
    const existing = [
      makeExisting({ name: "a", kind: "function", source: "treesitter" }),
      makeExisting({ name: "b", kind: "class", source: "scip" }),
      makeExisting({ name: "c", kind: "function", source: "both" }),
    ];
    const newer: NewSymbol[] = [];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 0);
    assert.strictEqual(result.added.length, 0);
    // "a" (treesitter) and "c" (both) should be removed
    assert.strictEqual(result.removed.length, 2);
    assert.deepStrictEqual(result.removed.map((s) => s.name).sort(), [
      "a",
      "c",
    ]);
    // "b" (scip) should be preserved
    assert.strictEqual(result.preserved.length, 1);
    assert.strictEqual(result.preserved[0].name, "b");
  });

  it("uses range overlap as tiebreaker for ambiguous (name, kind) matches", () => {
    // Two overloads of the same function name
    const existing = [
      makeExisting({
        name: "handler",
        kind: "function",
        symbolId: "old-handler-1",
        rangeStartLine: 1,
        rangeEndLine: 10,
      }),
      makeExisting({
        name: "handler",
        kind: "function",
        symbolId: "old-handler-2",
        rangeStartLine: 20,
        rangeEndLine: 30,
      }),
    ];
    const newer = [
      makeNew({
        name: "handler",
        kind: "function",
        symbolId: "new-handler-1",
        rangeStartLine: 2,
        rangeEndLine: 12,
      }),
      makeNew({
        name: "handler",
        kind: "function",
        symbolId: "new-handler-2",
        rangeStartLine: 22,
        rangeEndLine: 32,
      }),
    ];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 2);
    assert.strictEqual(result.added.length, 0);
    assert.strictEqual(result.removed.length, 0);

    // The first old handler (lines 1-10) should match the first new handler (lines 2-12)
    const match1 = result.matched.find(
      (m) => m.old.symbolId === "old-handler-1",
    );
    assert.ok(match1);
    assert.strictEqual(match1!.new.symbolId, "new-handler-1");

    // The second old handler (lines 20-30) should match the second new handler (lines 22-32)
    const match2 = result.matched.find(
      (m) => m.old.symbolId === "old-handler-2",
    );
    assert.ok(match2);
    assert.strictEqual(match2!.new.symbolId, "new-handler-2");
  });

  it("handles mixed add/match/remove/preserve in a single diff", () => {
    const existing = [
      makeExisting({ name: "kept", kind: "function", source: "treesitter" }),
      makeExisting({ name: "removed", kind: "function", source: "treesitter" }),
      makeExisting({ name: "scipSurvives", kind: "class", source: "scip" }),
      makeExisting({ name: "bothRemoved", kind: "variable", source: "both" }),
    ];
    const newer = [
      makeNew({ name: "kept", kind: "function" }),
      makeNew({ name: "brand_new", kind: "interface" }),
    ];

    const result = diffSymbols(existing, newer);

    assert.strictEqual(result.matched.length, 1);
    assert.strictEqual(result.matched[0].old.name, "kept");

    assert.strictEqual(result.added.length, 1);
    assert.strictEqual(result.added[0].name, "brand_new");

    // "removed" (treesitter) and "bothRemoved" (both) should be removed
    assert.strictEqual(result.removed.length, 2);
    assert.deepStrictEqual(result.removed.map((s) => s.name).sort(), [
      "bothRemoved",
      "removed",
    ]);

    // "scipSurvives" should be preserved
    assert.strictEqual(result.preserved.length, 1);
    assert.strictEqual(result.preserved[0].name, "scipSurvives");
  });

  it("does not match across different kinds", () => {
    const existing = [
      makeExisting({ name: "Foo", kind: "class", source: "treesitter" }),
    ];
    const newer = [makeNew({ name: "Foo", kind: "function" })];

    const result = diffSymbols(existing, newer);

    // Should NOT match because kinds differ
    assert.strictEqual(result.matched.length, 0);
    assert.strictEqual(result.added.length, 1);
    assert.strictEqual(result.added[0].name, "Foo");
    assert.strictEqual(result.removed.length, 1);
    assert.strictEqual(result.removed[0].name, "Foo");
  });

  it("handles ambiguous group with more old than new symbols", () => {
    const existing = [
      makeExisting({
        name: "init",
        kind: "function",
        symbolId: "old-init-1",
        rangeStartLine: 1,
        rangeEndLine: 5,
      }),
      makeExisting({
        name: "init",
        kind: "function",
        symbolId: "old-init-2",
        rangeStartLine: 10,
        rangeEndLine: 15,
        source: "treesitter",
      }),
      makeExisting({
        name: "init",
        kind: "function",
        symbolId: "old-init-3",
        rangeStartLine: 20,
        rangeEndLine: 25,
        source: "scip",
      }),
    ];
    const newer = [
      makeNew({
        name: "init",
        kind: "function",
        symbolId: "new-init-1",
        rangeStartLine: 1,
        rangeEndLine: 6,
      }),
    ];

    const result = diffSymbols(existing, newer);

    // One match (best overlap with old-init-1)
    assert.strictEqual(result.matched.length, 1);
    assert.strictEqual(result.matched[0].old.symbolId, "old-init-1");

    // old-init-2 (treesitter) should be removed
    assert.ok(result.removed.some((s) => s.symbolId === "old-init-2"));

    // old-init-3 (scip) should be preserved
    assert.ok(result.preserved.some((s) => s.symbolId === "old-init-3"));
  });
});
