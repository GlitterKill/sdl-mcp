import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";

const symbol = "scip-python python example 1.0 ops/Item#";
function normalize(paths: string[]) {
  return normalizeScipProviderFacts({
    repoId: "repo",
    generationId: "gen",
    providerId: "scip-python",
    documents: paths.map((relativePath) => ({
      relativePath,
      language: "Python",
      symbols:
        relativePath === "consumer.py"
          ? []
          : [
              {
                symbol,
                documentation: ["class Item"],
                relationships: [],
                kind: 0,
                displayName: "Item",
              },
            ],
      occurrences: [
        {
          symbol,
          range: { startLine: 0, startCol: 6, endLine: 0, endCol: 10 },
          symbolRoles: relativePath === "consumer.py" ? 0 : 1,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
        },
      ],
    })),
  });
}

test("Python stub pairs retain both definitions without guessing a cross-file target", () => {
  for (const paths of [
    ["ops.py", "ops.pyi"],
    ["ops.pyi", "ops.py"],
  ]) {
    const facts = normalize([...paths, "consumer.py"]);
    assert.equal(facts.symbols.length, 2);
    assert.equal(new Set(facts.symbols.map((s) => s.symbolId)).size, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(facts.occurrences[i].symbolId, facts.symbols[i].symbolId);
      assert.equal(facts.symbols[i].relPath, paths[i]);
    }
    assert.equal(facts.occurrences[2].symbolId, undefined);
  }
});

test("Python unrelated or multiply defined files still fail closed", () => {
  for (const paths of [
    ["ops.py", "other.py"],
    ["ops.py", "other.pyi"],
    ["ops.py", "ops.pyi", "extra.py"],
  ]) {
    assert.equal(normalize(paths).symbols.length, 0);
  }
});

test("Python stub variants keep local references and inheritance independent of document order", () => {
  const symbols = [
    "Item#",
    "Base#",
    "Item#read().",
    "Item#value.",
    "__init__:",
  ].map((suffix) => `scip-python python example 1.0 ops/${suffix}`);
  const infos = symbols.map((id, i) => ({
    symbol: id,
    documentation: [],
    kind: 0,
    displayName: "",
    relationships:
      i === 0
        ? [
            {
              symbol: symbols[1],
              isImplementation: true,
              isReference: false,
              isTypeDefinition: false,
              isDefinition: false,
            },
          ]
        : [],
  }));
  function run(paths: string[]) {
    return normalizeScipProviderFacts({
      repoId: "repo",
      generationId: "gen",
      providerId: "scip-python",
      externalSymbols: infos,
      documents: paths.map((relativePath) => ({
        relativePath,
        language: "Python",
        symbols: infos,
        occurrences: symbols.flatMap((id, i) =>
          [1, 0].map((role) => ({
            symbol: id,
            symbolRoles: relativePath === "consumer.py" ? 0 : role,
            range: {
              startLine: i * 2 + (1 - role),
              startCol: 0,
              endLine: i * 2 + (1 - role),
              endCol: 4,
            },
            overrideDocumentation: [],
            syntaxKind: 0,
            diagnostics: [],
          })),
        ),
      })),
    });
  }
  const a = run(["ops.py", "ops.pyi", "consumer.py"]);
  const b = run(["consumer.py", "ops.pyi", "ops.py"]);
  const mapping = (facts: ReturnType<typeof run>) =>
    facts.symbols
      .map((s) => [s.relPath, s.providerSymbolId, s.symbolId])
      .sort();
  assert.deepEqual(mapping(a), mapping(b));
  assert.equal(a.symbols.length, 10);
  for (const o of a.occurrences) {
    const own = a.symbols.find(
      (s) =>
        s.relPath === o.relPath && s.providerSymbolId === o.providerSymbolId,
    );
    assert.equal(o.symbolId, own?.symbolId);
  }
  assert.equal(a.externalSymbols.length, 0);
  assert.equal(a.edges.length, 2);
  for (const edge of a.edges) {
    const source = a.symbols.find((s) => s.symbolId === edge.sourceSymbolId);
    const target = a.symbols.find((s) => s.symbolId === edge.targetSymbolId);
    assert.ok(source && target);
    assert.equal(source.relPath, target.relPath);
  }
});
