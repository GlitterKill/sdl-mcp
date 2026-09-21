import assert from "node:assert/strict";
import { after, test } from "node:test";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { pythonOccurrenceKey } from "../../dist/indexer/provider-first/python-lexical-bindings.js";
import type { ScipDocument, ScipOccurrence } from "../../dist/scip/types.js";

const pool = new ParserWorkerPool(1);
after(() => pool.shutdown());
const target = "scip-python python pkg 1 original/first().";
const other = "scip-python python pkg 1 original/second().";

// Synthetic SCIP identities intentionally omit writes: AST scope proof must
// reject shadowing even when the provider did not emit assignment occurrences.
async function check(
  source: string,
  expected: boolean[],
  targets = [target],
  aliasName = "alias",
) {
  const calls: ScipOccurrence[] = [];
  let importIndex = 0;
  const occurrences: ScipOccurrence[] = [];
  for (const [row, line] of source.split("\n").entries()) {
    for (const match of line.matchAll(new RegExp(`\\b${aliasName}\\b`, "g"))) {
      if (
        !line.includes("from ") &&
        line.slice(
          match.index + aliasName.length,
          match.index + aliasName.length + 1,
        ) !== "("
      )
        continue;
      const o: ScipOccurrence = {
        symbol: line.includes("from ")
          ? (targets[importIndex++] ?? target)
          : target,
        symbolRoles: 8,
        range: {
          startLine: row,
          endLine: row,
          startCol: match.index,
          endCol: match.index + aliasName.length,
        },
        diagnostics: [],
        overrideDocumentation: [],
        syntaxKind: 0,
      };
      occurrences.push(o);
      if (!line.includes("from ")) calls.push(o);
    }
  }
  const document: ScipDocument = {
    language: "python",
    relativePath: "test.py",
    symbols: [],
    occurrences,
  };
  const before = structuredClone(document);
  const result = await pool.parse("test.py", source, ".py", document);
  assert.ok(result.pythonBindings, "worker must return lexical proof");
  assert.deepEqual(document, before);
  assert.deepEqual(
    calls.map((o) => result.pythonBindings!.has(pythonOccurrenceKey(o))),
    expected,
    source,
  );
  const owner = "scip-python python pkg 1 test/run().";
  const normalizedDocument: ScipDocument = {
    ...document,
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
        symbol: owner,
        symbolRoles: 1,
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
        enclosingRange: {
          startLine: 0,
          startCol: 0,
          endLine: source.split("\n").length,
          endCol: 0,
        },
        diagnostics: [],
        overrideDocumentation: [],
        syntaxKind: 0,
      },
      ...document.occurrences,
    ],
  };
  const sourceLines = selectNeededLines(
    source,
    collectNeededSourceLines([document]).get("test.py")!,
  );
  const facts = normalizeScipProviderFacts({
    repoId: "test",
    generationId: "test",
    providerId: "scip-python",
    documents: [normalizedDocument],
    externalSymbols: [target, other].map((symbol) => ({
      symbol,
      displayName: "original",
      kind: 17,
      documentation: [],
      relationships: [],
    })),
    sourceLinesByPath: new Map([["test.py", sourceLines]]),
    pythonBindingsByPath: new Map([["test.py", result.pythonBindings!]]),
  });
  assert.equal(
    facts.coverage[0].callProofUnavailableReferences,
    expected.filter((ok) => !ok).length,
    source,
  );
  assert.equal(
    facts.edges.filter((e) => e.edgeType === "call").length,
    expected.some(Boolean) ? 1 : 0,
    source,
  );
  assert.ok(
    facts.edges
      .filter((e) => e.edgeType === "call")
      .every((e) => e.resolution === "exact"),
  );
}
test("immutable lexical imports survive unrelated helpers and enter closures", async () => {
  await check(
    "def outer():\n    from facade import alias\n    def unrelated():\n        pass\n    alias()\n    def inner():\n        alias()",
    [true, true],
  );
  await check(
    "from facade import alias\nclass C:\n    def method(self):\n        alias()",
    [true],
  );
});
test("closure locals, parameters, late owner writes and nonlocal mutation fail closed", async () => {
  for (const tail of [
    "    def inner(alias):\n        alias()",
    "    def inner():\n        alias()\n        alias = replacement",
    "    def inner():\n        alias()\n    alias = replacement",
    "    def inner():\n        alias()\n    def mutate():\n        nonlocal alias\n        alias = replacement",
    "    class C:\n        from facade import alias\n        def method(self):\n            alias()",
  ]) {
    const prefix = tail.includes("class C")
      ? "def outer():\n"
      : "def outer():\n    from facade import alias\n";
    await check(prefix + tail, [false]);
  }
});
test("comprehension targets shadow only their own scope and first iterable uses outer scope", async () => {
  await check(
    "def outer():\n    from facade import alias\n    return [alias(x) for x in xs]",
    [true],
  );
  await check(
    "def outer():\n    from facade import alias\n    values = [alias() for alias in xs]\n    alias()",
    [false, true],
  );
  await check(
    "def outer():\n    from facade import alias\n    values = [x for alias in alias() for x in alias()]",
    [true, false],
  );
});
test("exhaustive conditional imports prove only an existing reachable provider identity", async () => {
  await check(
    "def outer():\n    if condition:\n        from first import alias\n    elif other:\n        from second import alias\n    else:\n        from third import alias\n    for x in xs:\n        pass\n    alias()",
    [true],
    [target, other, other],
  );
  await check(
    "def outer():\n    if condition:\n        from first import alias\n    alias()",
    [true],
  );
  await check(
    "def outer():\n    if condition:\n        from first import alias\n    else:\n        alias = replacement\n    alias()",
    [false],
  );
  await check(
    "def outer():\n    if condition:\n        from first import alias\n    else:\n        from second import alias\n    alias()",
    [false],
    [other, other],
  );
});
test("writes, malformed syntax and deferred generators never retain stale proof", async () => {
  for (const write of [
    "alias <<= value",
    "alias: Callable = value",
    "alias, x = values",
    "del alias",
    'marker = "#"; alias = value',
  ]) {
    await check(
      "def outer():\n    from facade import alias\n    " +
        write +
        "\n    alias()",
      [false],
    );
  }
  await check(
    "def outer():\n    from facade import alias\n    values = (alias(x) for x in xs)\n    alias = replacement",
    [false],
  );
  await check("def outer(:\n    from facade import alias\n    alias()", [
    false,
  ]);
});

test("control-flow alternatives and definition-time writes cannot leak aliases", async () => {
  for (const source of [
    "from facade import alias\ntry:\n    alias = replacement\n    raise Error\nexcept Error:\n    alias()",
    "from facade import alias\ntry:\n    alias = replacement\nexcept Error:\n    pass\nelse:\n    alias()",
    "class C:\n    from facade import alias\n    values = [alias() for x in xs]",
    "from facade import alias\nwhile alias():\n    alias = replacement",
    "from facade import alias\nif condition:\n    pass\nelif (alias := replacement):\n    pass\nelse:\n    alias()",
    "match value:\n    case 1:\n        from facade import alias\n    case 2:\n        alias()",
    "from facade import alias\ndef inner():\n    alias()\ndef later(x=(alias := replacement)):\n    pass",
  ])
    await check(source, [false]);
});

test("expression evaluation order and attribute names cannot borrow a lexical alias", async () => {
  for (const source of [
    "from facade import alias\nresult = alias() if (alias := replacement) else None",
    "from facade import alias\nresult = [alias() for x in xs if (alias := replacement)]",
    "from facade import alias\nalias = lambda: alias()",
    "from facade import alias\nobj.alias()",
    "from facade import alias\ntry:\n    pass\nexcept Error as alias:\n    from facade import alias\nalias()",
  ])
    await check(source, [false]);
});

test("suppressed exceptions, cleared exception cells and wildcard writes fail closed", async () => {
  await check(
    "with manager:\n    from facade import alias\n    alias()\nalias()",
    [true, false],
  );
  await check(
    "try:\n    pass\nexcept Error as alias:\n    from facade import alias\n    def child():\n        alias()",
    [false],
  );
  await check(
    "from facade import alias\ndef child():\n    alias()\nfrom unknown import *",
    [false],
  );
});

test("comprehension filters cannot use an alias rewritten on previous iterations", async () => {
  await check(
    "from facade import alias\nresult = [(alias := replacement) for x in xs if alias()]",
    [false],
  );
});

test("failed match guards cannot preserve a binding in later cases", async () => {
  await check(
    "from facade import alias\nmatch value:\n    case _ if (alias := replacement):\n        pass\n    case _:\n        alias()",
    [false],
  );
});

test("conditional from-imports prove a singleton bound target across scopes and nested joins", async () => {
  for (const source of [
    "if condition:\n    from facade import alias\ndef run():\n    alias()",
    "if condition:\n    from facade import alias\ndef outer():\n    def inner():\n        alias()",
    "def outer():\n    if condition:\n        from facade import alias\n    def inner():\n        alias()",
    "if first:\n    from facade import alias\nif second:\n    from facade import alias\nalias()",
    "if first:\n    if second:\n        from facade import alias\nelse:\n    from facade import alias\nalias()",
    "def run():\n    if unrelated:\n        pass\n    if condition:\n        from facade import alias\n    alias()",
    "from outside import alias\ndef run():\n    if condition:\n        from facade import alias\n    alias()",
  ])
    await check(source, [true]);
});

test("conditional proof rejects unknown values, conflicting partial targets and stale bindings", async () => {
  for (const source of [
    "if condition:\n    from facade import alias\nelse:\n    alias = replacement\nalias()",
    "alias = replacement\nif condition:\n    from facade import alias\nalias()",
    "def run(alias):\n    if condition:\n        from facade import alias\n    alias()",
    "if condition:\n    from facade import alias\nalias = replacement\nalias()",
    "if condition:\n    from facade import alias\ndel alias\nalias()",
    "if condition:\n    from facade import alias\ndef run():\n    alias()\n    alias = replacement",
    "if condition:\n    from facade import alias\ndef run():\n    alias()\nalias = replacement",
    "from outside import alias\ndef run():\n    alias()\n    if condition:\n        from facade import alias",
    "if condition:\n    from facade import alias\nelse:\n    from unknown import *\nalias()",
    "from unknown import *\nif condition:\n    from facade import alias\nalias()",
    "if condition:\n    from facade import alias\nfrom unknown import *\nalias()",
    "for item in items:\n    from facade import alias\nalias()",
    "try:\n    from facade import alias\nexcept Error:\n    pass\nalias()",
    "with manager:\n    from facade import alias\nalias()",
  ])
    await check(source, [false]);
  for (const source of [
    "if first:\n    from facade import alias\nif second:\n    from facade import alias\nalias()",
    "if first:\n    if second:\n        from facade import alias\nelse:\n    from facade import alias\nalias()",
  ])
    await check(source, [false], [target, other]);
  await check(
    "if condition:\n    from facade import alias\nalias()",
    [false],
    [other],
  );
});

test("conditional imports cannot mistake Python fallback names for unbound values", async () => {
  for (const name of ["len", "open", "Exception", "WindowsError", "__file__"]) {
    await check(
      `if condition:\n    from facade import original as ${name}\n${name}()`,
      [false],
      [target],
      name,
    );
  }
});

test("conditional locals mask a different outer target and retain raw identity checks", async () => {
  await check(
    "from outside import alias\ndef run():\n    if condition:\n        from facade import alias\n    alias()",
    [true],
    [other, target],
  );
  await check("if condition:\n    from facade import alias\nalias()\nif:", [
    false,
  ]);
  await check(
    "if condition:\n    from facade import alias\nalias()",
    [false],
    ["scip-typescript npm pkg 1 original/first()."],
  );
});
