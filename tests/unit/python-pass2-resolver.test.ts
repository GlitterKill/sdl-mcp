import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PythonPass2Resolver } from "../../dist/indexer/pass2/resolvers/python-pass2-resolver.js";
// Phase 2 Tasks 2.1.1-2.1.3 tests -- import helpers directly from source.
// Use .ts extension because tests run under --experimental-strip-types.
import {
  extractDecoratorName,
  resolveDecoratorTargets,
  parsePythonReExports,
  resolveSelfMethodWithScope,
} from "../../src/indexer/pass2/resolvers/python-pass2-helpers.ts";
import type { ScopeNode } from "../../src/indexer/pass2/resolvers/python-pass2-helpers.ts";


describe("PythonPass2Resolver", () => {
  it("supports python files only", () => {
    const resolver = new PythonPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.py",
        extension: ".py",
        language: "python",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.ts",
        extension: ".ts",
        language: "typescript",
      }),
      false,
    );
  });

  it("exposes pass2-python resolver id", () => {
    const resolver = new PythonPass2Resolver();

    assert.equal(resolver.id, "pass2-python");
  });

  it("requires repoId on the target", async () => {
    const resolver = new PythonPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/main.py",
          extension: ".py",
          language: "python",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["python"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});

describe("Phase 2 Task 2.1.1: decorator chain resolution", () => {
  it("extractDecoratorName strips @, args, and dotted prefixes", () => {
    assert.equal(extractDecoratorName("@my_decorator"), "my_decorator");
    assert.equal(extractDecoratorName("@my_decorator(x)"), "my_decorator");
    assert.equal(extractDecoratorName("@pkg.wrapper"), "wrapper");
    assert.equal(extractDecoratorName("@pkg.wrapper(1,2)"), "wrapper");
    assert.equal(extractDecoratorName("@staticmethod"), "staticmethod");
    assert.equal(extractDecoratorName(""), null);
    assert.equal(extractDecoratorName("@"), null);
  });

  it("resolves decorator chain to wrapper function", () => {
    // Same-file lookup: @my_decorator on `target` finds `my_decorator`.
    const localIndex = new Map<string, string[]>();
    localIndex.set("my_decorator", ["sym:my_decorator"]);
    localIndex.set("target", ["sym:target"]);
    const importedIndex = new Map<string, string[]>();

    const resolved = resolveDecoratorTargets({
      decorators: ["@my_decorator"],
      localFunctionNameIndex: localIndex,
      importedNameToSymbolIds: importedIndex,
    });
    assert.deepEqual(resolved, ["sym:my_decorator"]);
  });

  it("resolves decorator with arguments via imported name", () => {
    const localIndex = new Map<string, string[]>();
    const importedIndex = new Map<string, string[]>();
    importedIndex.set("cache", ["sym:cache"]);

    const resolved = resolveDecoratorTargets({
      decorators: ["@cache(maxsize=16)"],
      localFunctionNameIndex: localIndex,
      importedNameToSymbolIds: importedIndex,
    });
    assert.deepEqual(resolved, ["sym:cache"]);
  });

  it("skips Python built-in decorators", () => {
    const localIndex = new Map<string, string[]>();
    const importedIndex = new Map<string, string[]>();
    const resolved = resolveDecoratorTargets({
      decorators: ["@staticmethod", "@classmethod", "@property"],
      localFunctionNameIndex: localIndex,
      importedNameToSymbolIds: importedIndex,
    });
    assert.deepEqual(resolved, []);
  });

  it("skips ambiguous decorator names with multiple candidates", () => {
    const localIndex = new Map<string, string[]>();
    localIndex.set("wrap", ["sym:a", "sym:b"]);
    const importedIndex = new Map<string, string[]>();
    const resolved = resolveDecoratorTargets({
      decorators: ["@wrap"],
      localFunctionNameIndex: localIndex,
      importedNameToSymbolIds: importedIndex,
    });
    assert.deepEqual(resolved, []);
  });
});

describe("Phase 2 Task 2.1.2: __init__.py re-export parsing", () => {
  it("parses `from .real import Foo` re-exports", () => {
    const initContent = ["from .real import Foo", "from .real import helper as helper_alias"].join("\n");
    const re = parsePythonReExports("pkg/__init__.py", initContent);
    assert.equal(re.length, 2);
    const foo = re.find((r) => r.exportedName === "Foo")!;
    assert.equal(foo.targetFile, "pkg/real");
    assert.equal(foo.targetName, "Foo");
    const alias = re.find((r) => r.exportedName === "helper_alias")!;
    assert.equal(alias.targetFile, "pkg/real");
    assert.equal(alias.targetName, "helper");
  });

  it("handles multi-name imports on a single line", () => {
    const initContent = "from .sub import A, B, C";
    const re = parsePythonReExports("p/__init__.py", initContent);
    assert.deepEqual(
      re.map((r) => r.exportedName).sort(),
      ["A", "B", "C"],
    );
    assert.equal(re[0].targetFile, "p/sub");
  });

  it("ignores wildcard and absolute imports", () => {
    const initContent = ["from .sub import *", "from other import Thing"].join("\n");
    const re = parsePythonReExports("p/__init__.py", initContent);
    assert.equal(re.length, 0);
  });

  it("resolves call through __init__.py barrel re-export (parser end-to-end)", () => {
    // This test exercises the parser + exported ReExport shape that the
    // resolver hands to followBarrelChain. Full DB round-trip is covered
    // by the harness integration tests.
    const initContent = "from .real import Foo";
    const re = parsePythonReExports("barrel-package/__init__.py", initContent);
    assert.equal(re.length, 1);
    assert.equal(re[0].exportedName, "Foo");
    assert.equal(re[0].targetFile, "barrel-package/real");
    assert.equal(re[0].targetName, "Foo");
  });
});

describe("Phase 2 Task 2.1.3: self.method() scope-walker fallback", () => {
  // Build a synthetic ScopeNode tree that mimics two classes at different
  // line ranges. findEnclosingByType from scope-walker only needs start/
  // end position, children, and type -- not any tree-sitter specifics.
  function mkNode(type: string, sl: number, sc: number, el: number, ec: number, children: ScopeNode[] = []): ScopeNode {
    return {
      type,
      startPosition: { row: sl, column: sc },
      endPosition: { row: el, column: ec },
      children,
      text: "",
    };
  }

  it("resolves self.method() to enclosing class method", () => {
    // Class Alpha at lines 0..5, class Beta at lines 6..11.
    const alphaNode = mkNode("class_definition", 0, 0, 5, 0);
    const betaNode = mkNode("class_definition", 6, 0, 11, 0);
    const root = mkNode("module", 0, 0, 20, 0, [alphaNode, betaNode]);

    const alphaDetail = {
      symbolId: "sym:Alpha",
      extractedSymbol: {
        nodeId: "n:Alpha",
        kind: "class" as const,
        name: "Alpha",
        exported: true,
        range: { startLine: 0, startCol: 0, endLine: 5, endCol: 0 },
      },
    };
    const betaDetail = {
      symbolId: "sym:Beta",
      extractedSymbol: {
        nodeId: "n:Beta",
        kind: "class" as const,
        name: "Beta",
        exported: true,
        range: { startLine: 6, startCol: 0, endLine: 11, endCol: 0 },
      },
    };

    // Both classes define a `handle` method -- flat index would be ambiguous.
    const methodsByClass = new Map<string, Map<string, string[]>>();
    methodsByClass.set("sym:Alpha", new Map([["handle", ["sym:Alpha.handle"]]]));
    methodsByClass.set("sym:Beta", new Map([["handle", ["sym:Beta.handle"]]]));

    // Caller position inside Alpha (line 3).
    const alphaResolved = resolveSelfMethodWithScope({
      methodName: "handle",
      callerRange: { startLine: 3, startCol: 4 },
      treeRoot: root,
      classes: [alphaDetail, betaDetail] as any,
      methodsByClass,
    });
    assert.equal(alphaResolved, "sym:Alpha.handle");

    // Caller position inside Beta (line 8).
    const betaResolved = resolveSelfMethodWithScope({
      methodName: "handle",
      callerRange: { startLine: 8, startCol: 4 },
      treeRoot: root,
      classes: [alphaDetail, betaDetail] as any,
      methodsByClass,
    });
    assert.equal(betaResolved, "sym:Beta.handle");
  });

  it("returns null when caller is not inside any class", () => {
    const alphaNode = mkNode("class_definition", 0, 0, 5, 0);
    const root = mkNode("module", 0, 0, 20, 0, [alphaNode]);

    const alphaDetail = {
      symbolId: "sym:Alpha",
      extractedSymbol: {
        nodeId: "n:Alpha",
        kind: "class" as const,
        name: "Alpha",
        exported: true,
        range: { startLine: 0, startCol: 0, endLine: 5, endCol: 0 },
      },
    };
    const methodsByClass = new Map<string, Map<string, string[]>>();
    methodsByClass.set("sym:Alpha", new Map([["handle", ["sym:Alpha.handle"]]]));

    // Caller at line 15 -- outside Alpha.
    const result = resolveSelfMethodWithScope({
      methodName: "handle",
      callerRange: { startLine: 15, startCol: 0 },
      treeRoot: root,
      classes: [alphaDetail] as any,
      methodsByClass,
    });
    assert.equal(result, null);
  });

  it("returns null when treeRoot is null", () => {
    const result = resolveSelfMethodWithScope({
      methodName: "handle",
      callerRange: { startLine: 0, startCol: 0 },
      treeRoot: null,
      classes: [],
      methodsByClass: new Map(),
    });
    assert.equal(result, null);
  });
});
