import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import type { ScipDocument, ScipRange } from "../../dist/scip/types.js";

const pool = new ParserWorkerPool(1);
after(() => pool.shutdown());
const target = "scip-python python fixture 1 fixture/Thing#";
function range(source: string, text: string): ScipRange {
  const start = source.indexOf(text);
  assert.ok(start >= 0);
  const point = (offset: number) => {
    const lines = source.slice(0, offset).split("\n");
    return [lines.length - 1, Buffer.byteLength(lines.at(-1)!)];
  };
  const [startLine, startCol] = point(start),
    [endLine, endCol] = point(start + text.length);
  return { startLine, startCol, endLine, endCol };
}
async function check(
  source: string,
  text: string,
  expected: number,
  options: {
    symbol?: string;
    duplicate?: boolean;
    definitionAtSameRange?: boolean;
    malformedRange?: boolean;
    omitProof?: boolean;
  } = {},
) {
  const symbol = options.symbol ?? target;
  const r = range(source, text);
  if (options.malformedRange) r.startCol++;
  const occurrence = {
    symbol,
    range: r,
    symbolRoles: 8,
    syntaxKind: 0,
    diagnostics: [],
    overrideDocumentation: [],
  };
  const owner = "scip-python python fixture 1 fixture/run().";
  const doc: ScipDocument = {
    relativePath: "fixture.py",
    language: "python",
    symbols: [
      {
        symbol: owner,
        displayName: "run",
        kind: 17,
        documentation: [],
        relationships: [],
      },
    ],
    occurrences: [
      {
        ...occurrence,
        symbol: owner,
        symbolRoles: 1,
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        enclosingRange: {
          startLine: 0,
          startCol: 0,
          endLine: source.split("\n").length,
          endCol: 0,
        },
      },
      occurrence,
      ...(options.definitionAtSameRange
        ? [{ ...occurrence, symbolRoles: 1 }]
        : []),
      ...(options.duplicate
        ? [
            {
              ...occurrence,
              symbol: "scip-python python different 1 other/Thing#",
            },
          ]
        : []),
    ],
  };
  const parsed = await pool.parse(doc.relativePath, source, ".py", doc);
  const needed = collectNeededSourceLines([doc]);
  const facts = normalizeScipProviderFacts({
    repoId: "test",
    generationId: "test",
    providerId: "scip-python",
    documents: [doc],
    externalSymbols: [
      symbol,
      "scip-python python different 1 other/Thing#",
    ].map((symbol) => ({
      symbol,
      displayName: "Thing",
      kind: 7,
      documentation: [],
      relationships: [],
    })),
    sourceLinesByPath: new Map([
      [
        doc.relativePath,
        selectNeededLines(source, needed.get(doc.relativePath) ?? new Set()),
      ],
    ]),
    pythonBindingsByPath: new Map([
      [doc.relativePath, parsed.pythonBindings ?? new Map()],
    ]),
    ...(!options.omitProof
      ? {
          pythonNonCallsByPath: new Map([
            [doc.relativePath, parsed.pythonNonCalls ?? new Set()],
          ]),
        }
      : {}),
  });
  assert.equal(
    facts.coverage[0].callProofUnavailableReferences,
    expected,
    source,
  );
  return facts;
}
test("multiline import aliases and parenthesized assignment values are neutral", async () => {
  for (const [source, text] of [
    ["from fixture import (Thing as\n Alias)", "Thing as\n Alias"],
    ["obj.kind = (\n Thing\n)", "(\n Thing\n)"],
    ["value = ((\n Thing\n))", "((\n Thing\n))"],
  ]) {
    const f = await check(source, text, 0);
    assert.equal(f.edges.filter((e) => e.edgeType === "call").length, 0);
  }
});
test("real multiline calls and unknown expression contexts cannot become neutral", async () => {
  for (const [source, text] of [
    ["value = (\n Thing\n)()", "(\n Thing\n)"],
    ["value = (\n Thing()\n)", "(\n Thing()\n)"],
    ["consume(\n Thing\n)", "(\n Thing\n)"],
    [
      "value = (\n Thing if condition else Other\n)",
      "(\n Thing if condition else Other\n)",
    ],
    ["@(\n Thing\n)\ndef fn(): pass", "(\n Thing\n)"],
  ])
    await check(source, text, 1);
  const f = await check("value = Thing()", "Thing", 0);
  assert.equal(f.edges.filter((e) => e.edgeType === "call").length, 1);
});
test("missing, ambiguous, malformed or mismatched evidence fails closed", async () => {
  const source = "value = (\n Thing\n)",
    text = "(\n Thing\n)";
  await check(source, text, 1, { omitProof: true });
  await check(source, text, 2, { duplicate: true });
  await check(source, text, 1, { definitionAtSameRange: true });
  await check(source, text, 1, { malformedRange: true });
  await check(source, text, 1, {
    symbol: "scip-python python fixture 1 fixture/Wrong#",
  });
  await check(source + "\nif:", text, 1);
  await check(source, text, 1, {
    symbol: "scip-typescript npm fixture 1 fixture/Thing#",
  });
});

test("multiline function imports retain neutral proof for the actual descriptor form", async () => {
  const source = "from fixture import (Thing as\n Alias)",
    text = "Thing as\n Alias";
  const facts = await check(source, text, 0, {
    symbol: "scip-python python fixture 1 fixture/Thing().",
  });
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 0);
  await check(source, text, 1, {
    symbol: "scip-python python fixture 1 fixture/Wrong().",
  });
});

test("nested class assignment uses the normalizer's existing terminal-name rules", async () => {
  const source = "value = (\n Thing\n)",
    text = "(\n Thing\n)";
  await check(source, text, 0, {
    symbol: "scip-python python fixture 1 fixture/owner().Thing#",
  });
  await check(source, text, 1, {
    symbol: "scip-python python fixture 1 fixture/owner().Wrong#",
  });
  await check("value = (\n Thing\n)()", text, 1, {
    symbol: "scip-python python fixture 1 fixture/owner().Thing#",
  });
});

test("function declaration names are neutral even when SCIP references their class", async () => {
  for (const source of [
    "class ObjectProxy:\n    @property\n    def __doc__(self): return 'doc'",
    "async def __doc__(): pass",
    "def outer():\n    def __doc__(): pass",
  ]) {
    const facts = await check(source, "__doc__", 0);
    assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 0);
  }
});

test("declaration proof rejects incomplete evidence and cannot suppress nearby calls", async () => {
  const source =
    "class ObjectProxy:\n    @property\n    def __doc__(self): return 'doc'";
  await check(source, "__doc__", 1, { omitProof: true });
  await check(source, "__doc__", 2, { duplicate: true });
  await check(source, "__doc__", 1, { definitionAtSameRange: true });
  await check(source, "__doc__", 1, { malformedRange: true });
  await check(source + "\nif:", "__doc__", 1);
  await check(source, "__doc__", 1, {
    symbol: "scip-typescript npm fixture 1 fixture/Thing#",
  });
  for (const call of [
    "@Thing()\ndef fn(): pass",
    "def fn(value=Thing()): pass",
    "def fn() -> Thing(): pass",
    "def fn():\n    return Thing()",
  ]) {
    const facts = await check(call, "Thing", 0);
    assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 1);
  }
  await check("def fn():\n    return __doc__()", "__doc__", 1);
});
