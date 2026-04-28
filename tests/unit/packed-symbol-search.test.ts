import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodePackedSymbolSearch,
  decodePacked,
} from "../../dist/mcp/wire/packed/index.js";

test("ss1 round-trip — small result set", () => {
  const payload = encodePackedSymbolSearch({
    query: "foo",
    total: 2,
    results: [
      {
        symbolId: "abc123",
        file: "src/a.ts",
        line: 10,
        kind: "function",
        score: 0.92,
        name: "fooBar",
      },
      {
        symbolId: "def456",
        file: "src/b.ts",
        line: 32,
        kind: "class",
        score: 0.71,
        name: "FooClass",
      },
    ],
  });
  const decoded = decodePacked(payload);
  assert.equal(decoded.encoderId, "ss1");
  assert.equal(decoded.data.query, "foo");
  assert.equal(decoded.data.total, 2);
  const hits = decoded.data.results as Array<Record<string, unknown>>;
  assert.equal(hits.length, 2);
  assert.equal(hits[0].symbolId, "abc123");
  assert.equal(hits[0].line, 10);
  assert.ok(typeof hits[0].score === "number");
});

test("ss1 round-trip — empty results", () => {
  const payload = encodePackedSymbolSearch({
    query: "nothing",
    total: 0,
    results: [],
  });
  const decoded = decodePacked(payload);
  assert.equal(decoded.data.total, 0);
  assert.deepEqual(decoded.data.results ?? [], []);
});

test("ss1 round-trip — query string with special chars", () => {
  const payload = encodePackedSymbolSearch({
    query: "type=string, exported",
    total: 1,
    results: [
      {
        symbolId: "x",
        file: "p/q.ts",
        line: 1,
        kind: "function",
        score: 0.5,
        name: "fn",
      },
    ],
  });
  const decoded = decodePacked(payload);
  assert.equal(decoded.data.query, "type=string, exported");
});
