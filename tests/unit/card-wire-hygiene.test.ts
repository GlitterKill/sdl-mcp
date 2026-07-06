import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compactCardForWire,
  compactRange,
} from "../../dist/mcp/tools/symbol-utils.js";

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


test("compactRange drops zero cols", () => {
  assert.equal(
    compactRange({ startLine: 14, startCol: 0, endLine: 21, endCol: 0 }),
    "14-21",
  );
});

test("compactRange keeps nonzero cols", () => {
  assert.equal(
    compactRange({ startLine: 14, startCol: 3, endLine: 21, endCol: 1 }),
    "14:3-21:1",
  );
});


test("compactCardForWire keeps range object by default", () => {
  const range = { startLine: 14, startCol: 0, endLine: 21, endCol: 0 };
  const out = compactCardForWire({
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "f",
    exported: false,
    range,
  });

  assert.deepEqual(out.range, range);
});

test("compactCardForWire compacts ranges when requested", () => {
  const out = compactCardForWire(
    {
      symbolId: "abc",
      file: "src/x.ts",
      kind: "function",
      name: "f",
      exported: false,
      range: { startLine: 14, startCol: 0, endLine: 21, endCol: 0 },
    },
    { compactRanges: true },
  );

  assert.equal(out.range, "14-21");
});

test("compactCardForWire keeps false booleans and does not mutate input", () => {
  const card = {
    symbolId: "abc",
    file: "src/x.ts",
    kind: "function",
    name: "f",
    exported: false,
    truncated: false,
    range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
    deps: { imports: [], calls: [], callsNote: "See method cards for call dependencies" },
  };
  const original = structuredClone(card);

  const out = compactCardForWire(card);

  assert.deepEqual(card, original);
  assert.equal(out.exported, false);
  assert.equal(out.truncated, false);
});
