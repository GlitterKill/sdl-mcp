import { describe, it } from "node:test";
import assert from "node:assert";
import Parser from "tree-sitter";
import { parseFile } from "../../dist/code/skeleton.js";
import { createHotPathSourceMatcher } from "../../dist/code/hotpath.js";

interface ReferenceMatches {
  matchedLines: Set<number>;
  confirmedIdentifiers: Set<string>;
  targetNodeCount: number;
}

function referenceFindLinesMatchingIdentifiers(
  tree: Parser.Tree,
  identifiersToFind: string[],
): ReferenceMatches {
  const matchedLines = new Set<number>();
  const confirmedIdentifiers = new Set<string>();
  const identifierSet = new Set(identifiersToFind);
  let targetNodeCount = 0;

  function recordMatch(text: string, line: number): void {
    matchedLines.add(line);
    if (identifierSet.has(text)) confirmedIdentifiers.add(text);
  }

  function matchesAsMemberExpression(text: string, line: number): boolean {
    const parts = text.split(/[.?\[\]]+/).filter(Boolean);
    for (const part of parts) {
      if (identifierSet.has(part)) {
        recordMatch(part, line);
        return true;
      }
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode): void {
    if (
      node.type === "identifier" ||
      node.type === "property_identifier" ||
      node.type === "call_expression" ||
      node.type === "throw_statement"
    ) {
      targetNodeCount++;
    }

    if (node.type === "identifier" || node.type === "property_identifier") {
      if (identifierSet.has(node.text)) {
        recordMatch(node.text, node.startPosition.row + 1);
      }
    }

    if (node.type === "call_expression") {
      const funcNode = node.childForFieldName("function");
      if (funcNode) {
        if (funcNode.type === "identifier") {
          if (identifierSet.has(funcNode.text)) {
            recordMatch(funcNode.text, node.startPosition.row + 1);
          }
        } else if (funcNode.type === "member_expression") {
          matchesAsMemberExpression(funcNode.text, node.startPosition.row + 1);
        }
      }
    }

    if (node.type === "throw_statement") {
      const thrown = node.childForFieldName("value");
      if (thrown) {
        if (thrown.type === "new_expression") {
          const constructorNode = thrown.childForFieldName("constructor");
          if (constructorNode && constructorNode.type === "identifier") {
            if (identifierSet.has(constructorNode.text)) {
              recordMatch(constructorNode.text, node.startPosition.row + 1);
            }
          }
        } else if (thrown.type === "identifier") {
          if (identifierSet.has(thrown.text)) {
            recordMatch(thrown.text, node.startPosition.row + 1);
          }
        }
      }
    }

    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);
  return { matchedLines, confirmedIdentifiers, targetNodeCount };
}

interface TraversalCounters {
  childCountReads: number;
  childCalls: number;
  cursorCurrentNodeReads: number;
}

function withTraversalCounters<T>(run: (counters: TraversalCounters) => T): T {
  const counters: TraversalCounters = {
    childCountReads: 0,
    childCalls: 0,
    cursorCurrentNodeReads: 0,
  };
  const syntaxNodePrototype = Reflect.get(
    Reflect.get(Parser, "SyntaxNode"),
    "prototype",
  ) as object;
  const cursorPrototype = Reflect.get(
    Reflect.get(Parser, "TreeCursor"),
    "prototype",
  ) as object;
  const childCountDescriptor = Object.getOwnPropertyDescriptor(
    syntaxNodePrototype,
    "childCount",
  );
  const childDescriptor = Object.getOwnPropertyDescriptor(
    syntaxNodePrototype,
    "child",
  );
  const currentNodeDescriptor = Object.getOwnPropertyDescriptor(
    cursorPrototype,
    "currentNode",
  );
  assert.ok(childCountDescriptor?.get);
  assert.ok(childDescriptor?.value);
  assert.ok(currentNodeDescriptor?.get);
  const originalChild = childDescriptor.value as (
    this: object,
    index: number,
  ) => unknown;

  Object.defineProperty(syntaxNodePrototype, "childCount", {
    ...childCountDescriptor,
    get: function (this: object): number {
      counters.childCountReads++;
      return Reflect.apply(childCountDescriptor.get!, this, []) as number;
    },
  });
  Object.defineProperty(syntaxNodePrototype, "child", {
    ...childDescriptor,
    value: function (this: object, index: number): unknown {
      counters.childCalls++;
      return Reflect.apply(originalChild, this, [index]);
    },
  });
  Object.defineProperty(cursorPrototype, "currentNode", {
    ...currentNodeDescriptor,
    get: function (this: object): unknown {
      counters.cursorCurrentNodeReads++;
      return Reflect.apply(currentNodeDescriptor.get!, this, []);
    },
  });

  try {
    return run(counters);
  } finally {
    Object.defineProperty(
      syntaxNodePrototype,
      "childCount",
      childCountDescriptor,
    );
    Object.defineProperty(syntaxNodePrototype, "child", childDescriptor);
    Object.defineProperty(cursorPrototype, "currentNode", currentNodeDescriptor);
  }
}

function parseTypeScript(source: string): Parser.Tree {
  const tree = parseFile(source, ".ts");
  assert.ok(tree, "expected TypeScript fixture to parse");
  return tree;
}

function hasMissingNode(node: Parser.SyntaxNode): boolean {
  if (node.isMissing) return true;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child && hasMissingNode(child)) return true;
  }
  return false;
}

describe("hotpath cursor traversal", () => {
  it("preserves pre-order match output while avoiding punctuation-node materialization", () => {
    const source = [
      "function inspect() {",
      "  runAction(",
      "    firstArgument,",
      "    nestedCall(secondArgument),",
      "  );",
      "  service",
      "    .fetchData(",
      "      requestPayload,",
      "    );",
      "  throw new DomainError(",
      "    failureDetail,",
      "  );",
      "  throw fallbackFailure;",
      "}",
      ...Array.from(
        { length: 12 },
        (_, index) => `const punctuation${index} = map.get(${index})?.value ?? 0;`,
      ),
    ].join("\n");
    const tree = parseTypeScript(source);
    const lines = source.split("\n");
    const identifiers = [
      "runAction",
      "firstArgument",
      "nestedCall",
      "secondArgument",
      "service",
      "fetchData",
      "requestPayload",
      "DomainError",
      "failureDetail",
      "fallbackFailure",
    ];

    withTraversalCounters((counters) => {
      const expected = referenceFindLinesMatchingIdentifiers(tree, identifiers);
      const referenceChildCountReads = counters.childCountReads;
      const referenceChildCalls = counters.childCalls;
      assert.ok(referenceChildCountReads > 0);
      assert.ok(referenceChildCalls > 0);
      counters.childCalls = 0;
      counters.childCountReads = 0;
      counters.cursorCurrentNodeReads = 0;

      const actual = createHotPathSourceMatcher()(tree, identifiers, lines);

      assert.deepStrictEqual(
        [...actual.matchedLines],
        [...expected.matchedLines],
      );
      assert.deepStrictEqual(
        [...actual.confirmedIdentifiers],
        [...expected.confirmedIdentifiers],
      );
      assert.strictEqual(counters.childCountReads, 0);
      assert.strictEqual(counters.childCalls, 0);
      assert.strictEqual(
        counters.cursorCurrentNodeReads,
        expected.targetNodeCount + 1,
        `materialized ${counters.cursorCurrentNodeReads} cursor nodes for ${expected.targetNodeCount} relevant nodes`,
      );
    });
  });

  it("returns the same empty matches when identifiers are absent", () => {
    const source = [
      "function inspect() {",
      "  service.fetchData({ value: 1 });",
      "  throw new DomainError('failure');",
      "}",
    ].join("\n");
    const tree = parseTypeScript(source);
    const identifiers = ["missingIdentifier"];
    const expected = referenceFindLinesMatchingIdentifiers(tree, identifiers);
    const actual = createHotPathSourceMatcher()(
      tree,
      identifiers,
      source.split("\n"),
    );

    assert.deepStrictEqual(
      [...actual.matchedLines],
      [...expected.matchedLines],
    );
    assert.deepStrictEqual(
      [...actual.confirmedIdentifiers],
      [...expected.confirmedIdentifiers],
    );
    assert.deepStrictEqual([...actual.matchedLines], []);
    assert.deepStrictEqual([...actual.confirmedIdentifiers], []);
  });

  it("preserves pre-order matches across a missing syntax node", () => {
    const source = [
      "function damaged() {",
      "  if (ready) }",
      "const afterError = recover();",
    ].join("\n");
    const tree = parseTypeScript(source);
    assert.ok(hasMissingNode(tree.rootNode), "fixture must contain a missing node");

    const identifiers = ["damaged", "ready", "afterError", "recover"];
    const expected = referenceFindLinesMatchingIdentifiers(tree, identifiers);
    const actual = createHotPathSourceMatcher()(
      tree,
      identifiers,
      source.split("\n"),
    );

    assert.deepStrictEqual(
      [...actual.matchedLines],
      [...expected.matchedLines],
    );
    assert.deepStrictEqual(
      [...actual.confirmedIdentifiers],
      [...expected.confirmedIdentifiers],
    );
  });
});
