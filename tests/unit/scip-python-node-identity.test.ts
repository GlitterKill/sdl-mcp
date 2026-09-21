import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyntaxNode } from "tree-sitter";
import { getAdapterForExtension } from "../../dist/indexer/adapter/registry.js";
import {
  provePythonLexicalBindings,
  pythonOccurrenceKey,
} from "../../dist/indexer/provider-first/python-lexical-bindings.js";

// Return fresh wrappers with the same native node IDs, making wrapper lifetime
// irrelevant to the regression rather than relying on garbage collection timing.
function fresh(node: SyntaxNode): SyntaxNode {
  const wrap = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(wrap);
    if (
      value &&
      typeof value === "object" &&
      "id" in value &&
      "startIndex" in value
    )
      return fresh(value as SyntaxNode);
    return value;
  };
  return new Proxy(node, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]) => wrap(value.apply(target, args))
        : wrap(value);
    },
  });
}
test("Python scope proof uses native node identity across fresh wrappers", () => {
  const source =
    "from facade import alias\ndef shadow():\n    alias()\n    alias = 0\nalias()\n";
  const target = "scip-python python pkg 1 original/run().";
  const occurrences = [...source.split("\n").entries()].flatMap(
    ([row, line]) => {
      const col = line.indexOf("alias");
      return col < 0 || line.includes("= 0")
        ? []
        : [
            {
              symbol: target,
              symbolRoles: 8,
              range: {
                startLine: row,
                startCol: col,
                endLine: row,
                endCol: col + 5,
              },
              diagnostics: [],
              overrideDocumentation: [],
              syntaxKind: 0,
            },
          ];
    },
  );
  const tree = getAdapterForExtension(".py")!.parse(source, "identity.py")!;
  const document = {
    language: "python",
    relativePath: "identity.py",
    symbols: [],
    occurrences,
  };
  const proof = provePythonLexicalBindings(document, fresh(tree.rootNode));
  assert.equal(
    proof.has(pythonOccurrenceKey(occurrences[1])),
    false,
    "local assignment shadows alias",
  );
  assert.equal(
    proof.has(pythonOccurrenceKey(occurrences[2])),
    true,
    "function body must not execute in module scope",
  );
});
