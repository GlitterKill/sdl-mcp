import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCppNamespaceIndexFromRows,
  CppPass2Resolver,
  extractUsingNamespaces,
  groupCallsByCallerSymbol,
} from "../../dist/indexer/pass2/resolvers/cpp-pass2-resolver.js";
import { getAdapterForExtension } from "../../dist/indexer/adapter/registry.js";

describe("CppPass2Resolver", () => {
  it("supports cpp files only", () => {
    const resolver = new CppPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.cpp",
        extension: ".cpp",
        language: "cpp",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "include/utils.hpp",
        extension: ".hpp",
        language: "cpp",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.cc",
        extension: ".cc",
        language: "cpp",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.cxx",
        extension: ".cxx",
        language: "cpp",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "include/utils.hxx",
        extension: ".hxx",
        language: "cpp",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "include/utils.h",
        extension: ".h",
        language: "c",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.c",
        extension: ".c",
        language: "c",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/Main.java",
        extension: ".java",
        language: "java",
      }),
      false,
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

  it("exposes pass2-cpp resolver id", () => {
    const resolver = new CppPass2Resolver();

    assert.equal(resolver.id, "pass2-cpp");
  });

  it("requires repoId on the target", async () => {
    const resolver = new CppPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/main.cpp",
          extension: ".cpp",
          language: "cpp",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["cpp", "c"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });

  it("groups call sites by caller symbol once", () => {
    const symbols = [
      {
        extractedSymbol: {
          nodeId: "outer",
          kind: "function",
          name: "outer",
          exported: true,
          range: {
            startLine: 1,
            startCol: 0,
            endLine: 20,
            endCol: 1,
          },
        },
        symbolId: "symbol:outer",
      },
      {
        extractedSymbol: {
          nodeId: "inner",
          kind: "function",
          name: "inner",
          exported: true,
          range: {
            startLine: 5,
            startCol: 2,
            endLine: 10,
            endCol: 3,
          },
        },
        symbolId: "symbol:inner",
      },
    ];
    const calls = [
      {
        callerNodeId: "outer",
        calleeIdentifier: "directCall",
        isResolved: false,
        callType: "function",
        range: {
          startLine: 3,
          startCol: 2,
          endLine: 3,
          endCol: 14,
        },
      },
      {
        calleeIdentifier: "nestedCall",
        isResolved: false,
        callType: "function",
        range: {
          startLine: 7,
          startCol: 4,
          endLine: 7,
          endCol: 14,
        },
      },
      {
        calleeIdentifier: "outsideCall",
        isResolved: false,
        callType: "function",
        range: {
          startLine: 30,
          startCol: 0,
          endLine: 30,
          endCol: 11,
        },
      },
    ];

    const grouped = groupCallsByCallerSymbol(calls, symbols);

    assert.deepEqual(
      (grouped.get("outer") ?? []).map((call) => call.calleeIdentifier),
      ["directCall"],
    );
    assert.deepEqual(
      (grouped.get("inner") ?? []).map((call) => call.calleeIdentifier),
      ["nestedCall"],
    );
    assert.equal(grouped.has("outside"), false);
  });

  it("groups namespace members by namespace prefixes", () => {
    type NamespaceRows = Parameters<typeof buildCppNamespaceIndexFromRows>[0];
    const files: NamespaceRows["files"] = [
      {
        fileId: "file:cpp",
        repoId: "repo",
        relPath: "src/example.cpp",
        contentHash: "hash",
        language: "cpp",
        byteSize: 100,
        lastIndexedAt: null,
        directory: "src",
      },
      {
        fileId: "file:ts",
        repoId: "repo",
        relPath: "src/example.ts",
        contentHash: "hash",
        language: "typescript",
        byteSize: 100,
        lastIndexedAt: null,
        directory: "src",
      },
    ];
    const makeSymbol = (
      symbolId: string,
      fileId: string,
      kind: string,
      name: string,
    ): NamespaceRows["symbols"][number] => ({
      symbolId,
      repoId: "repo",
      fileId,
      kind,
      name,
      exported: true,
      visibility: null,
      language: "cpp",
      rangeStartLine: 1,
      rangeStartCol: 0,
      rangeEndLine: 1,
      rangeEndCol: 1,
      astFingerprint: symbolId,
      signatureJson: null,
      summary: null,
      invariantsJson: null,
      sideEffectsJson: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const index = buildCppNamespaceIndexFromRows({
      files,
      symbols: [
        makeSymbol("ns:outer", "file:cpp", "module", "outer"),
        makeSymbol("ns:inner", "file:cpp", "module", "outer::inner"),
        makeSymbol("fn:deep", "file:cpp", "function", "outer::inner::deep"),
        makeSymbol("fn:outer", "file:cpp", "function", "outer::top"),
        makeSymbol("fn:ts", "file:ts", "function", "outer::ignored"),
      ],
    });

    assert.deepEqual(index.namespaceByFilePath.get("src/example.cpp"), [
      "outer",
      "outer::inner",
    ]);
    assert.deepEqual(
      (index.symbolsByNamespace.get("outer") ?? []).map(
        (symbol) => symbol.symbolId,
      ),
      ["ns:outer", "ns:inner", "fn:deep", "fn:outer"],
    );
    assert.deepEqual(
      (index.symbolsByNamespace.get("outer::inner") ?? []).map(
        (symbol) => symbol.symbolId,
      ),
      ["ns:inner", "fn:deep"],
    );
  });

  it("extracts using namespace declarations through tree-sitter node lookup", () => {
    const adapter = getAdapterForExtension(".cpp");
    assert.ok(adapter);
    const tree = adapter.parse(
      `
        using namespace llvm;
        using namespace clang::tooling;
        using Alias = llvm::StringRef;
        void run() {}
      `,
      "src/example.cpp",
    );
    assert.ok(tree);
    try {
      assert.deepEqual(Array.from(extractUsingNamespaces(tree)), [
        "llvm",
        "clang::tooling",
      ]);
    } finally {
      tree.delete?.();
    }
  });

});
