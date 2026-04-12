import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RustPass2Resolver } from "../../dist/indexer/pass2/resolvers/rust-pass2-resolver.js";

describe("RustPass2Resolver", () => {
  it("supports rust files only", () => {
    const resolver = new RustPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/lib.rs",
        extension: ".rs",
        language: "rust",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.py",
        extension: ".py",
        language: "python",
      }),
      false,
    );
  });

  it("exposes pass2-rust resolver id", () => {
    const resolver = new RustPass2Resolver();

    assert.equal(resolver.id, "pass2-rust");
  });

  it("requires repoId on the target", async () => {
    const resolver = new RustPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/lib.rs",
          extension: ".rs",
          language: "rust",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["rust"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});

// ============================================================================
// Phase 2 Task 2.4.x — extended unit tests for the Rust Pass-2 resolver.
// ============================================================================

import {
  buildRustUseAliasMap,
  parseRustUseDeclarations,
  resolveTraitDefaultMethod,
  resolveRustPass2CallTarget,
  type RustUseBinding,
  type TraitDefaultMap,
} from "../../dist/indexer/pass2/resolvers/rust-pass2-resolver.js";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filenameAbs = fileURLToPath(import.meta.url);
const __dirnameAbs = dirname(__filenameAbs);
const FIXTURE_DIR = join(__dirnameAbs, "../fixtures/rust");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Task 2.4.2 — parseRustUseDeclarations + buildRustUseAliasMap
// ---------------------------------------------------------------------------

describe("RustPass2Resolver: parseRustUseDeclarations (Task 2.4.2)", () => {
  it("parses grouped imports with an alias clause", () => {
    const source = loadFixture("use-grouped-caller.rs");
    const bindings = parseRustUseDeclarations(source);
    const byLocal = new Map<string, RustUseBinding>(
      bindings.map((b) => [b.localName, b]),
    );
    assert.ok(byLocal.has("foo"), "foo binding missing");
    assert.equal(byLocal.get("foo")?.sourceName, "foo");
    assert.equal(byLocal.get("foo")?.specifier, "crate::utils");
    assert.ok(byLocal.has("renamed"), "renamed binding missing");
    assert.equal(byLocal.get("renamed")?.sourceName, "bar");
    assert.equal(byLocal.get("renamed")?.specifier, "crate::utils");
  });

  it("populates the alias->source map only for renamed bindings", () => {
    const aliasMap = buildRustUseAliasMap(loadFixture("use-grouped-caller.rs"));
    assert.equal(aliasMap.get("renamed"), "bar");
    // Unaliased names should not appear as keys.
    assert.equal(aliasMap.has("foo"), false);
  });

  it("records `pub use` bindings as re-exports", () => {
    const bindings = parseRustUseDeclarations(loadFixture("use-grouped.rs"));
    const reExports = bindings.filter((b) => b.isReExport);
    assert.equal(reExports.length, 1);
    assert.equal(reExports[0].localName, "reexport_name");
    assert.equal(reExports[0].sourceName, "renamed");
  });
});

describe("RustPass2Resolver: resolves grouped use and aliased import (Task 2.4.2)", () => {
  it("translates an alias back to the source name before lookup", () => {
    // Simulate the state the resolver is in once `resolveImportTargets`
    // has populated `importedNameToSymbolIds` under the SOURCE name
    // (`bar`) because the target file exports `bar`, not `renamed`.
    const importedNameToSymbolIds = new Map<string, string[]>([
      ["bar", ["sym-bar"]],
      ["foo", ["sym-foo"]],
    ]);
    const aliasToSourceName = new Map<string, string>([["renamed", "bar"]]);

    const resolvedAlias = resolveRustPass2CallTarget({
      call: {
        calleeIdentifier: "renamed",
        isResolved: false,
        callType: "function",
        range: { startLine: 8, startCol: 4, endLine: 8, endCol: 14 },
      },
      callerSymbol: {
        nodeId: "caller",
        kind: "function",
        name: "caller",
        exported: false,
        range: { startLine: 6, startCol: 0, endLine: 9, endCol: 1 },
      },
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds,
      namespaceImports: new Map(),
      localImplMethodsByType: new Map(),
      receiverNamespaces: new Map(),
      explicitImportedNames: new Set(["foo", "renamed"]),
      sameModuleNameToSymbolIds: new Map(),
      cratePathToSymbolIds: new Map(),
      aliasToSourceName,
    });
    assert.ok(resolvedAlias);
    assert.equal(resolvedAlias?.symbolId, "sym-bar");
    assert.equal(resolvedAlias?.resolution, "use-import-aliased");
    assert.ok(resolvedAlias && resolvedAlias.confidence > 0);

    const resolvedDirect = resolveRustPass2CallTarget({
      call: {
        calleeIdentifier: "foo",
        isResolved: false,
        callType: "function",
        range: { startLine: 7, startCol: 4, endLine: 7, endCol: 9 },
      },
      callerSymbol: {
        nodeId: "caller",
        kind: "function",
        name: "caller",
        exported: false,
        range: { startLine: 6, startCol: 0, endLine: 9, endCol: 1 },
      },
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds,
      namespaceImports: new Map(),
      localImplMethodsByType: new Map(),
      receiverNamespaces: new Map(),
      explicitImportedNames: new Set(["foo", "renamed"]),
      sameModuleNameToSymbolIds: new Map(),
      cratePathToSymbolIds: new Map(),
      aliasToSourceName,
    });
    assert.equal(resolvedDirect?.symbolId, "sym-foo");
    assert.equal(resolvedDirect?.resolution, "use-import");
  });
});

// ---------------------------------------------------------------------------
// Task 2.4.1 — trait default method dispatch
// ---------------------------------------------------------------------------

describe("RustPass2Resolver: resolves trait method via default impl path (Task 2.4.1)", () => {
  it("falls back to the trait's default method when the type has no override", () => {
    const traitDefaults: TraitDefaultMap = {
      traitDefaultMethods: new Map([
        ["Greeter", new Map([["greet", "sym-Greeter.greet"]])],
      ]),
      implementedTraitsByType: new Map([["A", ["Greeter"]]]),
    };
    const localImplMethodsByType = new Map<string, Map<string, string>>([
      // `impl Greeter for A {}` has no body, so `A` has no local methods.
      ["A", new Map()],
    ]);

    const hit = resolveTraitDefaultMethod(
      "A",
      "greet",
      localImplMethodsByType,
      traitDefaults,
    );
    assert.equal(hit, "sym-Greeter.greet");
  });

  it("prefers a local impl method over a trait default when both exist", () => {
    const traitDefaults: TraitDefaultMap = {
      traitDefaultMethods: new Map([
        ["Greeter", new Map([["greet", "sym-Greeter.greet"]])],
      ]),
      implementedTraitsByType: new Map([["A", ["Greeter"]]]),
    };
    const localImplMethodsByType = new Map<string, Map<string, string>>([
      ["A", new Map([["greet", "sym-A.greet"]])],
    ]);

    const hit = resolveTraitDefaultMethod(
      "A",
      "greet",
      localImplMethodsByType,
      traitDefaults,
    );
    assert.equal(hit, null);
  });

  it("returns the trait default via the resolver's dot-receiver path", () => {
    const traitDefaults: TraitDefaultMap = {
      traitDefaultMethods: new Map([
        ["Greeter", new Map([["greet", "sym-Greeter.greet"]])],
      ]),
      implementedTraitsByType: new Map([["A", ["Greeter"]]]),
    };
    const receiverTypes = new Map<string, string>([["a", "A"]]);
    const localImplMethodsByType = new Map<string, Map<string, string>>([
      ["A", new Map()],
    ]);

    const resolved = resolveRustPass2CallTarget({
      call: {
        calleeIdentifier: "a.greet",
        isResolved: false,
        callType: "method",
        range: { startLine: 15, startCol: 4, endLine: 15, endCol: 13 },
      },
      callerSymbol: {
        nodeId: "use_a",
        kind: "function",
        name: "use_a",
        exported: false,
        range: { startLine: 14, startCol: 0, endLine: 16, endCol: 1 },
      },
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      localImplMethodsByType,
      receiverNamespaces: new Map(),
      explicitImportedNames: new Set(),
      sameModuleNameToSymbolIds: new Map(),
      cratePathToSymbolIds: new Map(),
      traitDefaults,
      receiverTypes,
    });
    assert.ok(resolved);
    assert.equal(resolved?.symbolId, "sym-Greeter.greet");
    assert.equal(resolved?.resolution, "trait-default");
  });
});

// ---------------------------------------------------------------------------
// Task 2.4.3 — Self::method inside impl blocks
// ---------------------------------------------------------------------------

describe("RustPass2Resolver: resolves Self::method to enclosing impl (Task 2.4.3)", () => {
  it("binds `Self::helper` to the enclosing impl's helper method", () => {
    const localImplMethodsByType = new Map<string, Map<string, string>>([
      ["A", new Map([["helper", "sym-A.helper"]])],
    ]);

    const resolved = resolveRustPass2CallTarget({
      call: {
        calleeIdentifier: "Self::helper",
        isResolved: false,
        callType: "function",
        range: { startLine: 10, startCol: 8, endLine: 10, endCol: 22 },
      },
      callerSymbol: {
        nodeId: "A::caller",
        kind: "method",
        name: "caller",
        exported: false,
        range: { startLine: 9, startCol: 4, endLine: 11, endCol: 5 },
      },
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      localImplMethodsByType,
      receiverNamespaces: new Map(),
      explicitImportedNames: new Set(),
      sameModuleNameToSymbolIds: new Map(),
      cratePathToSymbolIds: new Map(),
      selfImplType: "A",
    });
    assert.ok(resolved);
    assert.equal(resolved?.symbolId, "sym-A.helper");
    assert.equal(resolved?.resolution, "self-impl-method");
  });

  it("returns null (falls through) when Self resolves but the method is unknown", () => {
    const localImplMethodsByType = new Map<string, Map<string, string>>([
      ["A", new Map([["other", "sym-A.other"]])],
    ]);
    const resolved = resolveRustPass2CallTarget({
      call: {
        calleeIdentifier: "Self::helper",
        isResolved: false,
        callType: "function",
        range: { startLine: 10, startCol: 8, endLine: 10, endCol: 22 },
      },
      callerSymbol: {
        nodeId: "A::caller",
        kind: "method",
        name: "caller",
        exported: false,
        range: { startLine: 9, startCol: 4, endLine: 11, endCol: 5 },
      },
      nodeIdToSymbolId: new Map(),
      importedNameToSymbolIds: new Map(),
      namespaceImports: new Map(),
      localImplMethodsByType,
      receiverNamespaces: new Map(),
      explicitImportedNames: new Set(),
      sameModuleNameToSymbolIds: new Map(),
      cratePathToSymbolIds: new Map(),
      selfImplType: "A",
    });
    // The unresolved fallback record should be returned.
    assert.ok(resolved);
    assert.equal(resolved?.isResolved, false);
  });
});
