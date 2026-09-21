import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ParserWorkerPool } from "../../dist/indexer/workerPool.js";
import { normalizeScipProviderFacts } from "../../dist/indexer/provider-first/scip-normalizer.js";
import {
  collectNeededSourceLines,
  selectNeededLines,
} from "../../dist/indexer/provider-first/scip-source-lines.js";
import type { ScipDocument, ScipOccurrence } from "../../dist/scip/types.js";

const pool = new ParserWorkerPool(1);
after(() => pool.shutdown());
const moduleId = "scip-python python pkg 1 facade/__init__:";
const target = "scip-python python pkg 1 original/original().";
const other = "scip-python python pkg 1 original/other().";
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
async function check(
  caller: string,
  expected: number,
  exporter = "from original import original as alias",
  callTarget = target,
  qualifierTarget = moduleId,
  duplicate = false,
) {
  const docs: ScipDocument[] = [];
  const sources = new Map<string, string>();
  function add(path: string, source: string, exporting: boolean) {
    sources.set(path, source);
    const occurrences: ScipOccurrence[] = [];
    for (const [row, line] of source.split("\n").entries()) {
      if (exporting && line.startsWith("from original import "))
        occurrences.push(
          occurrence(target, row, 21, "original as alias".length),
        );
      if (!exporting) {
        for (const m of line.matchAll(/\bfacade\b/g))
          occurrences.push(occurrence(qualifierTarget, row, m.index, 6));
        for (const m of line.matchAll(/\balias(?=\()/g))
          occurrences.push(occurrence(callTarget, row, m.index, 5));
      }
    }
    const owner = exporting
      ? moduleId
      : "scip-python python pkg 1 caller/run().";
    occurrences.unshift({
      ...occurrence(owner, 0, 0, 0, 1),
      enclosingRange: {
        startLine: 0,
        startCol: 0,
        endLine: source.split("\n").length,
        endCol: 0,
      },
    });
    docs.push({
      relativePath: path,
      language: "python",
      occurrences,
      symbols: [
        {
          symbol: owner,
          displayName: exporting ? "facade" : "run",
          kind: 0,
          documentation: [],
          relationships: [],
        },
      ],
    });
  }
  add("facade.py", exporter, true);
  if (duplicate) add("duplicate.py", "alias = replacement", true);
  add("caller.py", caller, false);
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
    if (parsed.pythonModuleBindings)
      members.set(doc.relativePath, parsed.pythonModuleBindings);
  }
  const needed = collectNeededSourceLines(docs);
  const result = normalizeScipProviderFacts({
    repoId: "test",
    generationId: "test",
    providerId: "scip-python",
    documents: docs,
    externalSymbols: [target, other].map((symbol) => ({
      symbol,
      displayName: "original",
      kind: 17,
      documentation: [],
      relationships: [],
    })),
    sourceLinesByPath: new Map(
      [...sources].map(([p, s]) => [
        p,
        selectNeededLines(s, needed.get(p) ?? new Set()),
      ]),
    ),
    pythonBindingsByPath: bindings,
    pythonModuleBindingsByPath: members,
  });
  assert.equal(
    result.coverage.find((c) => c.relPath === "caller.py")
      ?.callProofUnavailableReferences,
    expected,
    caller + "\nEXPORT: " + exporter,
  );
}
test("module re-export proof is specific to a scoped qualifier and exact member target", async () => {
  await check("from pkg import facade\ndef run():\n    facade.alias()", 0);
  await check("def run():\n    from pkg import facade\n    facade.alias()", 0);
  await check(
    "from pkg import facade\ndef run(facade):\n    facade.alias()",
    1,
  );
  await check(
    "from pkg import facade\nfacade = replacement\nfacade.alias()",
    1,
  );
  await check(
    "from pkg import facade\ndef run():\n    facade.alias()\nfacade = replacement",
    1,
  );
  await check("from pkg import facade\nfacade.alias()", 1, undefined, other);
  await check(
    "from pkg import facade\nfacade.alias()",
    1,
    undefined,
    target,
    "scip-python python pkg 1 unrelated/__init__:",
  );
});
test("conflicting exports, unknown objects and member mutations fail closed", async () => {
  await check(
    "from pkg import facade\nfacade.alias()",
    1,
    "from original import original as alias\nalias = replacement",
  );
  await check(
    "from pkg import facade\nfacade.alias()",
    1,
    undefined,
    target,
    moduleId,
    true,
  );
  await check("facade = object()\nfacade.alias()", 1);
  for (const mutation of [
    "facade.alias = replacement",
    "del facade.alias",
    "facade.alias += replacement",
    'setattr(facade, "alias", replacement)',
  ]) {
    await check("from pkg import facade\n" + mutation + "\nfacade.alias()", 1);
  }
});

test("loop, context-manager and escaped module writes reject member proof", async () => {
  for (const mutation of [
    "for facade.alias in [replacement]:\n    pass",
    "with manager() as facade.alias:\n    pass",
    "proxy = facade\nproxy.alias = replacement",
    "proxy = (facade)\nproxy.alias = replacement",
    "proxy, = (facade,)\nproxy.alias = replacement",
  ]) {
    await check("from pkg import facade\n" + mutation + "\nfacade.alias()", 1);
  }
});

test("writes to another exported member do not invalidate the requested member", async () => {
  await check(
    "from pkg import facade\nfacade.settings.flag = True\nfacade.alias()",
    0,
  );
  await check(
    "from pkg import facade\nfacade.__dict__['alias'] = replacement\nfacade.alias()",
    1,
  );
});

test("module dictionary escapes cannot retain member proof", async () => {
  for (const mutation of [
    "proxy = facade.__dict__\nproxy['alias'] = replacement",
    "facade.__dict__.update(alias=replacement)",
  ])
    await check("from pkg import facade\n" + mutation + "\nfacade.alias()", 1);
});
test("module member evidence stays on its own occurrence and comprehension scope", async () => {
  await check(
    "from pkg import facade\nfacade.alias()\nfacade = replacement\nfacade.alias()",
    1,
  );
  await check(
    "from pkg import facade\n[facade.alias() for facade in others]\nfacade.alias()",
    1,
  );
  await check(
    "from pkg import facade\nfacade.alias()",
    1,
    "if enabled:\n    from original import original as alias",
  );
});
