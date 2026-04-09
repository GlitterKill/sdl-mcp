import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildScopeWalker,
  findEnclosingByType,
  getScopeAt,
  type ScopeNode,
  type ScopeRule,
} from "../../src/indexer/pass2/scope-walker.ts";

/**
 * Builds a synthetic ScopeNode tree for tests. The factory keeps the
 * boilerplate of the minimal ScopeNode interface contained.
 */
function n(
  type: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  text = "",
  children: ScopeNode[] = [],
): ScopeNode {
  return {
    type,
    startPosition: { row: startRow, column: startCol },
    endPosition: { row: endRow, column: endCol },
    children,
    text,
  };
}

describe("Phase 2: scope walker (Task 2.0.4)", () => {
  it("returns an empty scope for a tree with no rules", () => {
    const root = n("module", 0, 0, 10, 0);
    const map = getScopeAt(root, [], 5, 0);
    assert.equal(map.size, 0);
  });

  it("collects names defined at module scope", () => {
    // Synthetic Python-like fixture:
    //   def foo(): pass
    //   def bar(): pass
    const fooName = n("identifier", 0, 4, 0, 7, "foo");
    const foo = n("function_definition", 0, 0, 0, 14, "def foo(): pass", [
      fooName,
    ]);
    const barName = n("identifier", 1, 4, 1, 7, "bar");
    const bar = n("function_definition", 1, 0, 1, 14, "def bar(): pass", [
      barName,
    ]);
    const root = n("module", 0, 0, 1, 14, "", [foo, bar]);

    const rules: ScopeRule[] = [
      {
        nodeKind: "function_definition",
        introducesScope: true,
        defines: (node) => {
          const id = node.children.find((c) => c.type === "identifier");
          return id ? [{ name: id.text, node: id }] : [];
        },
      },
    ];

    const map = getScopeAt(root, rules, 0, 0);
    assert.ok(map.has("foo"));
    assert.ok(map.has("bar"));
  });

  it("inner scope sees outer bindings (lexical visibility)", () => {
    // class Foo:
    //   def bar(self): pass
    const barName = n("identifier", 1, 6, 1, 9, "bar");
    const bar = n("function_definition", 1, 2, 1, 24, "def bar(self): pass", [
      barName,
    ]);
    const fooName = n("identifier", 0, 6, 0, 9, "Foo");
    const foo = n("class_definition", 0, 0, 1, 24, "class Foo:", [
      fooName,
      bar,
    ]);
    const root = n("module", 0, 0, 1, 24, "", [foo]);

    const rules: ScopeRule[] = [
      {
        nodeKind: "class_definition",
        introducesScope: true,
        defines: (node) => {
          const id = node.children.find((c) => c.type === "identifier");
          return id ? [{ name: id.text, node: id }] : [];
        },
      },
      {
        nodeKind: "function_definition",
        introducesScope: true,
        defines: (node) => {
          const id = node.children.find((c) => c.type === "identifier");
          return id ? [{ name: id.text, node: id }] : [];
        },
      },
    ];

    // Inside bar at line 1 col 10: should see Foo (outer) and bar (sibling).
    const inner = getScopeAt(root, rules, 1, 10);
    assert.ok(inner.has("Foo"), "Foo should be visible inside bar");
    assert.ok(inner.has("bar"), "bar should be visible inside its own scope");
  });

  it("findEnclosingByType walks up to the nearest matching parent", () => {
    // class Foo:
    //   def bar(self):
    //     baz()
    const callId = n("identifier", 2, 4, 2, 7, "baz");
    const call = n("call", 2, 4, 2, 9, "baz()", [callId]);
    const bar = n("function_definition", 1, 2, 2, 9, "", [
      n("identifier", 1, 6, 1, 9, "bar"),
      call,
    ]);
    const foo = n("class_definition", 0, 0, 2, 9, "", [
      n("identifier", 0, 6, 0, 9, "Foo"),
      bar,
    ]);
    const root = n("module", 0, 0, 2, 9, "", [foo]);

    const enclosingClass = findEnclosingByType(root, 2, 5, "class_definition");
    assert.ok(enclosingClass);
    assert.equal(enclosingClass.text, "");
    assert.equal(enclosingClass.startPosition.row, 0);

    const enclosingFn = findEnclosingByType(root, 2, 5, "function_definition");
    assert.ok(enclosingFn);
    assert.equal(enclosingFn.startPosition.row, 1);
  });

  it("buildScopeWalker is reusable across multiple lookups", () => {
    const a = n("function_definition", 0, 0, 0, 14, "", [
      n("identifier", 0, 4, 0, 5, "a"),
    ]);
    const b = n("function_definition", 1, 0, 1, 14, "", [
      n("identifier", 1, 4, 1, 5, "b"),
    ]);
    const root = n("module", 0, 0, 1, 14, "", [a, b]);

    const rules: ScopeRule[] = [
      {
        nodeKind: "function_definition",
        introducesScope: true,
        defines: (node) => {
          const id = node.children.find((c) => c.type === "identifier");
          return id ? [{ name: id.text, node: id }] : [];
        },
      },
    ];

    const walker = buildScopeWalker(root, rules);
    const m1 = walker(0, 0);
    const m2 = walker(1, 0);
    assert.ok(m1.has("a"));
    assert.ok(m1.has("b"));
    assert.ok(m2.has("a"));
    assert.ok(m2.has("b"));
  });
});
