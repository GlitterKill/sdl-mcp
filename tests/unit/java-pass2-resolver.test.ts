import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JavaPass2Resolver } from "../../dist/indexer/pass2/resolvers/java-pass2-resolver.js";
import {
  resolveJavaPass2CallTarget,
  filterByArity,
  computeJavaCallArity,
  buildStaticImportMap,
} from "../../dist/indexer/pass2/resolvers/java-pass2-resolver.js";

describe("JavaPass2Resolver", () => {
  it("supports java files only", () => {
    const resolver = new JavaPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/Main.java",
        extension: ".java",
        language: "java",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/Main.kt",
        extension: ".kt",
        language: "kotlin",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/Main.java",
        extension: ".java",
        language: "typescript",
      }),
      false,
    );
  });

  it("exposes pass2-java resolver id", () => {
    const resolver = new JavaPass2Resolver();

    assert.equal(resolver.id, "pass2-java");
  });

  it("requires repoId on the target", async () => {
    const resolver = new JavaPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/Main.java",
          extension: ".java",
          language: "java",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["java"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});

function makeCall(overrides = {}) {
  return {
    callerNodeId: "caller-node",
    calleeIdentifier: "foo",
    isResolved: false,
    callType: "method",
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
    ...overrides,
  };
}

describe("JavaPass2Resolver - Task 2.2.1 (overload disambiguation)", () => {
  it("resolves overload by argument arity", () => {
    // class C { void foo(int a) {} void foo(int a, int b) {} void caller() { foo(1); foo(1,2); } }
    const classMethodsByName = new Map([
      ["C", new Map([["foo", ["sym-foo-1", "sym-foo-2"]]])],
    ]);
    const paramCountBySymbolId = new Map([
      ["sym-foo-1", 1],
      ["sym-foo-2", 2],
    ]);
    const callerClassNameByNodeId = new Map([["caller-node", "C"]]);

    const call1 = makeCall({ calleeIdentifier: "this.foo" });
    const resolved1 = resolveJavaPass2CallTarget({
      call: call1,
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      wildcardNameToSymbolIds: new Map(),
      samePackageNameToSymbolIds: new Map(),
      classMethodsByName,
      callerClassNameByNodeId,
      localExtendsByClassName: new Map(),
      callArity: 1,
      paramCountBySymbolId,
      resolverId: "java-pass2-resolver",
    });
    assert.ok(resolved1);
    assert.equal(resolved1?.symbolId, "sym-foo-1");
    assert.equal(resolved1?.isResolved, true);

    const call2 = makeCall({ calleeIdentifier: "this.foo" });
    const resolved2 = resolveJavaPass2CallTarget({
      call: call2,
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      wildcardNameToSymbolIds: new Map(),
      samePackageNameToSymbolIds: new Map(),
      classMethodsByName,
      callerClassNameByNodeId,
      localExtendsByClassName: new Map(),
      callArity: 2,
      paramCountBySymbolId,
      resolverId: "java-pass2-resolver",
    });
    assert.ok(resolved2);
    assert.equal(resolved2?.symbolId, "sym-foo-2");
    // Two distinct resolved edges for foo(1) vs foo(1,2)
    assert.notEqual(resolved1?.symbolId, resolved2?.symbolId);
  });

  it("filterByArity leaves candidates untouched when arity unknown", () => {
    const out = filterByArity(["a", "b"], undefined, new Map([["a", 1], ["b", 2]]));
    assert.deepEqual(out, ["a", "b"]);
  });

  it("computeJavaCallArity counts top-level commas (foo(1,2) -> 2)", () => {
    const content = "void f() { foo(1, 2); }\n";
    // foo( starts at col 11 (0-indexed)
    const arity = computeJavaCallArity(content, {
      callerNodeId: "x",
      calleeIdentifier: "foo",
      isResolved: false,
      callType: "method",
      range: { startLine: 1, startCol: 11, endLine: 1, endCol: 14 },
    });
    assert.equal(arity, 2);
  });

  it("computeJavaCallArity returns 0 for empty arg list", () => {
    const content = "void f() { foo(); }\n";
    const arity = computeJavaCallArity(content, {
      callerNodeId: "x",
      calleeIdentifier: "foo",
      isResolved: false,
      callType: "method",
      range: { startLine: 1, startCol: 11, endLine: 1, endCol: 14 },
    });
    assert.equal(arity, 0);
  });
});

describe("JavaPass2Resolver - Task 2.2.2 (import static resolution)", () => {
  it("resolves bare-name call via static import", () => {
    // import static some.pkg.Util.helper; helper()
    const classMethodsByName = new Map([
      ["Util", new Map([["helper", ["sym-helper"]]])],
    ]);
    const staticImportClassByMember = new Map([["helper", "Util"]]);
    const call = makeCall({ calleeIdentifier: "helper" });

    const resolved = resolveJavaPass2CallTarget({
      call,
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      wildcardNameToSymbolIds: new Map(),
      samePackageNameToSymbolIds: new Map(),
      classMethodsByName,
      callerClassNameByNodeId: new Map(),
      localExtendsByClassName: new Map(),
      staticImportClassByMember,
    });

    assert.ok(resolved);
    assert.equal(resolved?.symbolId, "sym-helper");
    assert.equal(resolved?.isResolved, true);
    assert.equal(resolved?.resolution, "import-static");
  });

  it("buildStaticImportMap extracts member->className from adapter imports", () => {
    const map = buildStaticImportMap([
      {
        specifier: "some.pkg.Util.helper",
        isRelative: false,
        isExternal: true,
        imports: ["helper"],
        isReExport: false,
        namespaceImport: "Util",
      },
      {
        specifier: "java.util.List",
        isRelative: false,
        isExternal: false,
        imports: ["List"],
        isReExport: false,
      },
    ]);
    assert.equal(map.get("helper"), "Util");
    assert.equal(map.has("List"), false);
  });

  it("buildStaticImportMap skips wildcard static imports", () => {
    const map = buildStaticImportMap([
      {
        specifier: "some.pkg.Util.*",
        isRelative: false,
        isExternal: true,
        imports: ["*"],
        isReExport: false,
        namespaceImport: "Util",
      },
    ]);
    assert.equal(map.size, 0);
  });
});

describe("JavaPass2Resolver - Task 2.2.3 (inheritance method resolution)", () => {
  it("resolves inherited method via class hierarchy", () => {
    // class Base { void greet() {} }
    // class Derived extends Base { void say() { greet(); } }
    const classMethodsByName = new Map([
      ["Base", new Map([["greet", ["sym-base-greet"]]])],
      ["Derived", new Map([["say", ["sym-derived-say"]]])],
    ]);
    const callerClassNameByNodeId = new Map([["caller-node", "Derived"]]);
    const localExtendsByClassName = new Map([["Derived", "Base"]]);

    const call = makeCall({ calleeIdentifier: "this.greet" });
    const resolved = resolveJavaPass2CallTarget({
      call,
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      wildcardNameToSymbolIds: new Map(),
      samePackageNameToSymbolIds: new Map(),
      classMethodsByName,
      callerClassNameByNodeId,
      localExtendsByClassName,
      resolverId: "java-pass2-resolver",
    });

    assert.ok(resolved);
    assert.equal(resolved?.symbolId, "sym-base-greet");
    assert.equal(resolved?.isResolved, true);
    assert.equal(resolved?.resolution, "inheritance-method");
  });

  it("prefers direct class method over ancestor (receiver-this, depth 0)", () => {
    const classMethodsByName = new Map([
      ["Base", new Map([["greet", ["sym-base-greet"]]])],
      ["Derived", new Map([["greet", ["sym-derived-greet"]]])],
    ]);
    const callerClassNameByNodeId = new Map([["caller-node", "Derived"]]);
    const localExtendsByClassName = new Map([["Derived", "Base"]]);

    const call = makeCall({ calleeIdentifier: "this.greet" });
    const resolved = resolveJavaPass2CallTarget({
      call,
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      wildcardNameToSymbolIds: new Map(),
      samePackageNameToSymbolIds: new Map(),
      classMethodsByName,
      callerClassNameByNodeId,
      localExtendsByClassName,
      resolverId: "java-pass2-resolver",
    });

    assert.equal(resolved?.symbolId, "sym-derived-greet");
    assert.equal(resolved?.resolution, "receiver-this");
  });
});
