import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import type { ScipDocument, ScipOccurrence } from "../../dist/scip/types.js";

const pool = new ParserWorkerPool(1);
after(() => pool.shutdown());
const moduleId = "scip-python python pkg 1 facade/__init__:";
const otherModule = "scip-python python pkg 1 othermod/__init__:";
const target = "scip-python python pkg 1 original/original().";
function occurrence(
  symbol: string,
  row: number,
  col: number,
  length: number,
  symbolRoles = 8,
): ScipOccurrence {
  return {
    symbol,
    symbolRoles,
    range: {
      startLine: row,
      endLine: row,
      startCol: col,
      endCol: col + length,
    },
    diagnostics: [],
    overrideDocumentation: [],
    syntaxKind: 0,
  };
}
// Reuse local 1 even on shadowed/written names: syntax must reject stale identity.
async function check(
  source: string,
  expected: number,
  second?: string,
  secondExpected = 1,
  customize?: (docs: ScipDocument[]) => void,
) {
  const sources = new Map([
    ["facade.py", "from original import original as alias"],
    ["caller.py", source],
  ]);
  if (second !== undefined) sources.set("second.py", second);
  const docs: ScipDocument[] = [...sources].map(([path, text]) => {
    const owner =
      path === "facade.py"
        ? moduleId
        : `scip-python python pkg 1 ${path}/run().`;
    const occurrences = [occurrence(owner, 0, 0, 0, 1)];
    occurrences[0].enclosingRange = {
      startLine: 0,
      startCol: 0,
      endLine: text.split("\n").length,
      endCol: 0,
    };
    if (path === "facade.py") occurrences.push(occurrence(target, 0, 21, 17));
    else
      for (const [row, line] of text.split("\n").entries()) {
        for (const match of line.matchAll(
          /\b(facade|othermod|api|alias)(?=\b)/g,
        )) {
          const name = match[0];
          if (name === "alias" && line[match.index + name.length] !== "(")
            continue;
          occurrences.push(
            occurrence(
              name === "api"
                ? "local 1"
                : name === "facade"
                  ? moduleId
                  : name === "othermod"
                    ? otherModule
                    : target,
              row,
              match.index,
              name.length,
            ),
          );
        }
      }
    return {
      relativePath: path,
      language: "python",
      occurrences,
      symbols: [
        {
          symbol: owner,
          kind: 0,
          displayName: path === "facade.py" ? "facade" : "run",
          documentation: [],
          relationships: [],
        },
      ],
    };
  });
  customize?.(docs);
  const before = structuredClone(docs);
  const bindings = new Map(),
    members = new Map();
  for (const doc of docs) {
    const parsed = await pool.parse(
      doc.relativePath,
      sources.get(doc.relativePath)!,
      ".py",
      doc,
    );
    bindings.set(doc.relativePath, parsed.pythonBindings);
    members.set(doc.relativePath, parsed.pythonModuleBindings);
  }
  const result = normalizeScipProviderFacts({
    repoId: "test",
    generationId: "test",
    providerId: "scip-python",
    documents: docs,
    externalSymbols: [
      {
        symbol: target,
        kind: 17,
        displayName: "original",
        documentation: [],
        relationships: [],
      },
    ],
    sourceLinesByPath: new Map(
      [...sources].map(([p, s]) => [
        p,
        new Map(s.split("\n").map((line, i) => [i, line])),
      ]),
    ),
    pythonBindingsByPath: bindings,
    pythonModuleBindingsByPath: members,
  });
  assert.deepEqual(docs, before, "raw SCIP must remain unchanged");
  assert.equal(
    result.coverage.find((c) => c.relPath === "caller.py")
      ?.callProofUnavailableReferences,
    expected,
    source,
  );
  if (second !== undefined)
    assert.equal(
      result.coverage.find((c) => c.relPath === "second.py")
        ?.callProofUnavailableReferences,
      secondExpected,
      second,
    );
  if (expected === 0)
    assert.ok(
      result.edges.some(
        (e) => e.edgeType === "call" && e.resolution === "exact",
      ),
      "accepted binding must emit an exact call edge",
    );
}

test("plain imports prove local aliases, nested captures and decorator calls", async () => {
  for (const source of [
    "import facade as api\napi.alias()",
    "import facade\nfacade.alias()",
    "def outer():\n    import facade as api\n    def inner():\n        api.alias()",
    "import facade as api\n@decorate(api.alias())\ndef run():\n    pass",
  ])
    await check(source, 0);
});
test("reassignment and parameter/local shadowing reject plain-import proof", async () => {
  for (const tail of [
    "api = replacement\napi.alias()",
    "del api\napi.alias()",
    "def run(api):\n    api.alias()",
    "def run():\n    api.alias()\n    api = replacement",
    "def run():\n    api.alias()\napi = replacement",
    "[api.alias() for api in others]",
  ])
    await check("import facade as api\n" + tail, 1);
  await check(
    "import facade as api\napi.alias()\napi = replacement\napi.alias()",
    1,
  );
  await check(
    "import facade as api\n[api.alias() for api in others]\napi.alias()",
    1,
  );
});
test("conditional, dotted root and unrelated module bindings fail closed", async () => {
  for (const source of [
    "if condition:\n    import facade as api\napi.alias()",
    "if condition:\n    import facade as api\nelse:\n    import othermod as api\napi.alias()",
    "import facade.child\nfacade.alias()",
    "import othermod as api\napi.alias()",
  ])
    await check(source, 1);
});
test("plain-import mutations and escapes invalidate only trusted member proof", async () => {
  for (const mutation of [
    "api.alias = replacement",
    "del api.alias",
    "setattr(api, 'alias', replacement)",
    "proxy = api",
    "api.__dict__.update(alias=replacement)",
  ]) {
    await check("import facade as api\n" + mutation + "\napi.alias()", 1);
  }
  await check("import facade as api\napi.settings.flag = True\napi.alias()", 0);
  await check(
    "import facade as api\napi.alias()",
    1,
    "import facade as api\napi.alias = replacement",
    0,
  );
});
test("local IDs never borrow module identities across documents", async () => {
  await check("import facade as api\napi.alias()", 0, "api.alias()");
  await check(
    "import facade as api\napi.alias()",
    0,
    "import othermod as api\napi.alias()",
  );
});

test("import and receiver identity evidence must be unique and present", async () => {
  for (const row of [0, 1])
    for (const mode of ["missing", "wrong", "conflicting"]) {
      await check(
        "import facade as api\napi.alias()",
        1,
        undefined,
        1,
        (docs) => {
          const doc = docs[1];
          const o = doc.occurrences.find(
            (o) => o.symbol === "local 1" && o.range.startLine === row,
          )!;
          if (mode === "missing")
            doc.occurrences = doc.occurrences.filter((x) => x !== o);
          else if (mode === "wrong") o.symbol = "local 99";
          else doc.occurrences.push({ ...o, symbol: "local 99" });
        },
      );
    }
});
test("aliased dotted imports use the exact imported module span", async () => {
  await check(
    "import facade.child as api\napi.alias()",
    0,
    undefined,
    1,
    (docs) => {
      const child = "scip-python python pkg 1 `facade.child`/__init__:";
      docs[0].occurrences[0].symbol = child;
      docs[0].symbols[0].symbol = child;
      const o = docs[1].occurrences.find((o) => o.symbol === moduleId)!;
      o.symbol = child;
      o.range.endCol = o.range.startCol + "facade.child".length;
    },
  );
});
test("same document local IDs stay bound to their own import sites", async () => {
  await check(
    "def first():\n    import facade as api\n    api.alias()\ndef second():\n    import othermod as api\n    api.alias()",
    1,
  );
});
