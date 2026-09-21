import assert from "node:assert/strict";
import { after, test } from "node:test";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { pythonOccurrenceKey } from "../../dist/indexer/provider-first/python-lexical-bindings.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import type { ScipDocument, ScipOccurrence } from "../../dist/scip/types.js";

const pool = new ParserWorkerPool(1);
after(() => pool.shutdown());

async function bindings(document: ScipDocument, source: string) {
  const result = await pool.parse(
    document.relativePath,
    source,
    ".py",
    document,
  );
  assert.ok(result.pythonBindings, "worker must return lexical proof");
  return result.pythonBindings;
}

const target = "scip-python python pkg 1 typing/stringify().";
const other = "scip-python python pkg 1 typing/other().";
const caller = "scip-python python pkg 1 consumer/run().";
const occ = (
  symbol: string,
  line: number,
  col: number,
  text: string,
  roles = 8,
): ScipOccurrence => ({
  symbol,
  symbolRoles: roles,
  range: {
    startLine: line,
    endLine: line,
    startCol: col,
    endCol: col + text.length,
  },
  diagnostics: [],
  overrideDocumentation: [],
  syntaxKind: 0,
});
async function run(importText: string, imported: string, callTarget = target) {
  const lines = [
    ...importText.split("\n"),
    "def run():",
    "    stringify_annotation()",
  ];
  const line = lines.findIndex((s) => s.includes(imported));
  const documents: ScipDocument[] = [
    {
      relativePath: "typing.py",
      language: "python",
      symbols: [target, other].map((symbol) => ({
        symbol,
        displayName: symbol === target ? "stringify" : "other",
        documentation: [],
        relationships: [],
        kind: 17,
      })),
      occurrences: [
        occ(target, 0, 4, "stringify", 1),
        occ(other, 2, 4, "other", 1),
      ],
    },
    {
      relativePath: "consumer.py",
      language: "python",
      symbols: [
        {
          symbol: caller,
          displayName: "run",
          kind: 17,
          documentation: [],
          relationships: [],
        },
      ],
      occurrences: [
        occ(target, line, lines[line].indexOf(imported), imported),
        {
          ...occ(caller, lines.length - 2, 4, "run", 1),
          enclosingRange: {
            startLine: lines.length - 2,
            startCol: 0,
            endLine: lines.length - 1,
            endCol: 26,
          },
        },
        occ(callTarget, lines.length - 1, 4, "stringify_annotation"),
      ],
    },
  ];
  const original = structuredClone(documents);
  const facts = normalizeScipProviderFacts({
    repoId: "repo",
    generationId: "test",
    providerId: "scip-python",
    documents,
    pythonBindingsByPath: new Map([
      ["consumer.py", await bindings(documents[1], lines.join("\n"))],
    ]),
    sourceLinesByPath: new Map([
      [
        "consumer.py",
        selectNeededLines(
          lines.join("\n"),
          collectNeededSourceLines(documents).get("consumer.py")!,
        ),
      ],
    ]),
  });
  assert.deepEqual(documents, original);
  return facts;
}
test("Python re-export and explicit/multiline aliases prove the exact target call", async () => {
  for (const [source, token] of [
    ["from facade import stringify_annotation", "stringify_annotation"],
    ["from typing import stringify as stringify_annotation", "stringify"],
    [
      "from typing import (\n    stringify as stringify_annotation,\n)",
      "stringify",
    ],
    [
      "from facade import (\n    stringify_annotation,\n)",
      "stringify_annotation",
    ],
    [
      "from facade import ( # ) in a comment\n    stringify_annotation,\n)",
      "stringify_annotation",
    ],
  ]) {
    const facts = await run(source, token);
    assert.equal(
      facts.coverage.find((c) => c.relPath === "consumer.py")
        ?.callProofUnavailableReferences,
      0,
      source,
    );
    const calls = facts.edges.filter((e) => e.edgeType === "call");
    assert.equal(calls.length, 1, source);
    assert.equal(
      calls[0].targetSymbolId,
      facts.symbols.find((s) => s.providerSymbolId === target)?.symbolId,
    );
  }
});
test("conflicting identities across an alias clause cannot prove either target", async () => {
  const line = "from typing import stringify as stringify_annotation";
  const document: ScipDocument = {
    language: "python",
    relativePath: "consumer.py",
    symbols: [],
    occurrences: [
      occ(target, 0, line.indexOf("stringify"), "stringify"),
      occ(
        other,
        0,
        line.indexOf("stringify_annotation"),
        "stringify_annotation",
      ),
    ],
  };
  assert.equal((await bindings(document, line)).size, 0);
});
test("Python binding evidence cannot excuse a different target or leak from nested scopes", async () => {
  for (const [source, token, symbol] of [
    ["from facade import stringify_annotation", "stringify_annotation", other],
    [
      "def hidden():\n    from facade import stringify_annotation",
      "stringify_annotation",
      target,
    ],
    [
      "# from facade import stringify_annotation",
      "stringify_annotation",
      target,
    ],
    [
      "value = 'from facade import stringify_annotation'",
      "stringify_annotation",
      target,
    ],
  ])
    assert.equal(
      (await run(source, token, symbol)).coverage.find(
        (c) => c.relPath === "consumer.py",
      )?.callProofUnavailableReferences,
      1,
    );
});

async function nestedFacts(
  source: string,
  calls: number[],
  importedTarget = target,
) {
  const lines = source.split("\n");
  const importLine = lines.findIndex((line) =>
    line.trimStart().startsWith("from "),
  );
  const documents: ScipDocument[] = [
    {
      relativePath: "typing.py",
      language: "python",
      symbols: [target, other].map((symbol) => ({
        symbol,
        displayName: symbol === target ? "stringify" : "other",
        kind: 17,
        documentation: [],
        relationships: [],
      })),
      occurrences: [
        occ(target, 0, 4, "stringify", 1),
        occ(other, 2, 4, "other", 1),
      ],
    },
    {
      relativePath: "consumer.py",
      language: "python",
      symbols: [
        {
          symbol: caller,
          displayName: "run",
          kind: 17,
          documentation: [],
          relationships: [],
        },
      ],
      occurrences: [
        {
          ...occ(caller, 0, 4, "run", 1),
          enclosingRange: {
            startLine: 0,
            startCol: 0,
            endLine: lines.length - 1,
            endCol: lines.at(-1)!.length,
          },
        },
        occ(
          importedTarget,
          importLine,
          lines[importLine].indexOf("stringify_annotation"),
          "stringify_annotation",
        ),
        ...calls.map((line) =>
          occ(
            target,
            line,
            lines[line].indexOf("stringify_annotation"),
            "stringify_annotation",
          ),
        ),
      ],
    },
  ];
  const original = structuredClone(documents);
  const facts = normalizeScipProviderFacts({
    repoId: "repo",
    generationId: "test",
    providerId: "scip-python",
    documents,
    pythonBindingsByPath: new Map([
      ["consumer.py", await bindings(documents[1], source)],
    ]),
    sourceLinesByPath: new Map([
      [
        "consumer.py",
        selectNeededLines(
          source,
          collectNeededSourceLines(documents).get("consumer.py")!,
        ),
      ],
    ]),
  });
  assert.deepEqual(documents, original);
  return facts;
}

test("nested import proves the following call in its own exception suite", async () => {
  const facts = await nestedFacts(
    "def run():\n    try:\n        pass\n    except ValueError:\n        from facade import stringify_annotation\n        stringify_annotation()",
    [5],
  );
  assert.equal(
    facts.coverage.find((c) => c.relPath === "consumer.py")
      ?.callProofUnavailableReferences,
    0,
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 1);
});

test("nested import proof cannot leak into siblings, children, parents or later rebindings", async () => {
  const prefix = "def run():\n    from facade import stringify_annotation\n";
  for (const tail of [
    "def sibling():\n    stringify_annotation()",
    "    def child(stringify_annotation):\n        stringify_annotation()",
    "stringify_annotation()",
    "    stringify_annotation = replacement\n    stringify_annotation()",
    "    del stringify_annotation\n    stringify_annotation()",
  ]) {
    const source = prefix + tail;
    const facts = await nestedFacts(source, [source.split("\n").length - 1]);
    assert.equal(
      facts.edges.filter((e) => e.edgeType === "call").length,
      0,
      tail,
    );
    assert.equal(
      facts.coverage.find((c) => c.relPath === "consumer.py")
        ?.callProofUnavailableReferences,
      1,
      tail,
    );
  }
});

test("nested binding proof stays attached to one use and exact target", async () => {
  const source =
    "def run():\n    from facade import stringify_annotation\n    stringify_annotation()\ndef sibling():\n    stringify_annotation()";
  const facts = await nestedFacts(source, [2, 4]);
  assert.equal(
    facts.coverage.find((c) => c.relPath === "consumer.py")
      ?.callProofUnavailableReferences,
    1,
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 1);
  const mismatch = await nestedFacts(source, [2], other);
  assert.equal(mismatch.edges.filter((e) => e.edgeType === "call").length, 0);
});

test("whole-clause Python aliases cannot bypass nested scope isolation", async () => {
  const facts = await run(
    "def hidden():\n    from typing import stringify as stringify_annotation",
    "stringify as stringify_annotation",
  );
  assert.equal(
    facts.coverage.find((c) => c.relPath === "consumer.py")
      ?.callProofUnavailableReferences,
    1,
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 0);
});

test("module-level whole-clause aliases retain exact target proof", async () => {
  const facts = await run(
    "from typing import stringify as stringify_annotation",
    "stringify as stringify_annotation",
  );
  assert.equal(
    facts.coverage.find((c) => c.relPath === "consumer.py")
      ?.callProofUnavailableReferences,
    0,
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 1);
});

test("repeated aliases in one nested import fail closed", async () => {
  const line = "    from facade import first as alias, second as alias";
  const use = occ(target, 2, 4, "alias");
  const document: ScipDocument = {
    language: "python",
    relativePath: "consumer.py",
    symbols: [],
    occurrences: [
      occ(target, 1, line.indexOf("first"), "first"),
      occ(other, 1, line.indexOf("second"), "second"),
      use,
    ],
  };
  const proof = await bindings(
    document,
    ["def run():", line, "    alias()"].join("\n"),
  );
  assert.equal(proof.get(pythonOccurrenceKey(use)), undefined);
});

test("module aliases in explicit continuation imports keep their call proof", async () => {
  const facts = await run(
    "from typing import stringify as stringify_annotation, \\\n    other",
    "stringify as stringify_annotation",
  );
  assert.equal(
    facts.coverage.find((c) => c.relPath === "consumer.py")
      ?.callProofUnavailableReferences,
    0,
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 1);
});

test("nested bindings prove later expressions in a retained suite", async () => {
  for (const tail of [
    "    pass\n    return stringify_annotation()",
    "    unrelated = 1\n    result = stringify_annotation()",
    "    if condition:\n        stringify_annotation()",
  ]) {
    const source =
      "def run():\n    from facade import stringify_annotation\n" + tail;
    const facts = await nestedFacts(source, [source.split("\n").length - 1]);
    assert.equal(
      facts.coverage.find((c) => c.relPath === "consumer.py")
        ?.callProofUnavailableReferences,
      0,
      tail,
    );
    assert.equal(
      facts.edges.filter((e) => e.edgeType === "call").length,
      1,
      tail,
    );
  }
});

test("a hash inside a string cannot hide a later rebinding", async () => {
  const facts = await nestedFacts(
    'def run():\n    from facade import stringify_annotation\n    marker = "#"; stringify_annotation = replacement\n    stringify_annotation()',
    [3],
  );
  assert.equal(facts.edges.filter((e) => e.edgeType === "call").length, 0);
});

test("incomplete SCIP writes cannot hide annotated, tuple, augmented or pattern rebinding", async () => {
  for (const write of [
    "    stringify_annotation: Callable = replacement",
    "    stringify_annotation, other = replacements",
    "    stringify_annotation **= replacement",
    "    match value:\n        case stringify_annotation:\n            pass",
  ]) {
    const source =
      "def run():\n    from facade import stringify_annotation\n" +
      write +
      "\n    stringify_annotation()";
    assert.equal(
      (await nestedFacts(source, [source.split("\n").length - 1])).edges.filter(
        (e) => e.edgeType === "call",
      ).length,
      0,
      write,
    );
  }
});
test("source selection retains a nested multiline import header and suite", async () => {
  const source =
    "def run():\n    from facade import (\n        stringify_annotation,\n    )\n    stringify_annotation()";
  const document: ScipDocument = {
    language: "python",
    relativePath: "consumer.py",
    symbols: [],
    occurrences: [
      occ(target, 2, 8, "stringify_annotation"),
      occ(target, 4, 4, "stringify_annotation"),
    ],
  };
  const lines = selectNeededLines(
    source,
    collectNeededSourceLines([document]).get("consumer.py")!,
  );
  assert.equal(lines.get(1), "    from facade import (");
  assert.equal(lines.get(3), "    )");
  assert.equal(lines.get(4), "    stringify_annotation()");
  const proof = await bindings(document, source);
  assert.deepEqual(proof.get(pythonOccurrenceKey(document.occurrences[1])), [
    "stringify_annotation",
  ]);
});

test("shift assignments with read/write reference roles end nested proof", async () => {
  for (const operator of ["<<=", ">>="]) {
    const source = [
      "def run():",
      "    from facade import alias",
      "    alias " + operator + " replacement",
      "    alias()",
    ];
    const call = occ(target, 3, 4, "alias");
    const document: ScipDocument = {
      language: "python",
      relativePath: "consumer.py",
      symbols: [],
      occurrences: [
        occ(target, 1, source[1].indexOf("alias"), "alias"),
        occ(target, 2, 4, "alias"),
        call,
      ],
    };
    assert.equal(
      (await bindings(document, source.join("\n"))).get(
        pythonOccurrenceKey(call),
      ),
      undefined,
      operator,
    );
  }
});

test("normalization without lexical proof cannot borrow a shadowed module import", () => {
  const source = [
    "from facade import stringify_annotation",
    "def run(stringify_annotation):",
    "    stringify_annotation()",
  ];
  const document: ScipDocument = {
    relativePath: "consumer.py",
    language: "python",
    symbols: [
      {
        symbol: caller,
        displayName: "run",
        kind: 17,
        documentation: [],
        relationships: [],
      },
    ],
    occurrences: [
      occ(target, 0, 19, "stringify_annotation"),
      {
        ...occ(caller, 1, 4, "run", 1),
        enclosingRange: {
          startLine: 1,
          startCol: 0,
          endLine: 2,
          endCol: source[2].length,
        },
      },
      occ(target, 2, 4, "stringify_annotation"),
    ],
  };
  const facts = normalizeScipProviderFacts({
    repoId: "repo",
    generationId: "test",
    providerId: "scip-python",
    documents: [document],
    externalSymbols: [
      {
        symbol: target,
        displayName: "stringify",
        kind: 17,
        documentation: [],
        relationships: [],
      },
    ],
    sourceLinesByPath: new Map([
      ["consumer.py", new Map(source.map((line, row) => [row, line]))],
    ]),
  });
  assert.equal(
    facts.edges.filter((edge) => edge.edgeType === "call").length,
    0,
  );
  assert.equal(facts.coverage[0].callProofUnavailableReferences, 1);
});
