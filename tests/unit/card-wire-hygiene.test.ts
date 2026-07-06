import { test } from "node:test";
import assert from "node:assert/strict";

import { compactCardForWire } from "../../dist/mcp/tools/symbol-utils.js";

test("omits empty deps arrays and callsNote", () => {
  const card = {
    symbolId: "abc",
    file: "src/x.ts",
    kind: "class",
    name: "X",
    exported: true,
    range: { startLine: 14, startCol: 0, endLine: 21, endCol: 1 },
    signature: { text: "class X" },
    deps: {
      imports: [],
      calls: [],
      callsNote: "See method cards for call dependencies",
    },
  };

  const out = compactCardForWire(card);

  assert.equal(out.deps, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "deps"), false);
});

test("keeps non-empty deps and strips only empty arrays", () => {
  const card = {
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "f",
    exported: true,
    range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    signature: { text: "function f()" },
    deps: { imports: ["a"], calls: [] },
  };

  const out = compactCardForWire(card);

  assert.deepEqual(out.deps, { imports: ["a"] });
});

test("omits null/empty summary", () => {
  const card = {
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "f",
    exported: true,
    range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    signature: { text: "function f()" },
    summary: "",
    deps: { imports: ["a"], calls: [] },
  };

  const out = compactCardForWire(card);

  assert.equal(Object.prototype.hasOwnProperty.call(out, "summary"), false);
});
