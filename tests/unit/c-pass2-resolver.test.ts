import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CPass2Resolver,
  deriveCRepoIndexFromCppIncludeIndex,
} from "../../dist/indexer/pass2/resolvers/c-pass2-resolver.js";

describe("CPass2Resolver", () => {
  it("supports c files only", () => {
    const resolver = new CPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.c",
        extension: ".c",
        language: "c",
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
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.cpp",
        extension: ".cpp",
        language: "cpp",
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

  it("exposes pass2-c resolver id", () => {
    const resolver = new CPass2Resolver();

    assert.equal(resolver.id, "pass2-c");
  });

  it("requires repoId on the target", async () => {
    const resolver = new CPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/main.c",
          extension: ".c",
          language: "c",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["c"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });

  it("derives C repo index from C++ include-index rows using language only", () => {
    const filesByRelPath = new Map([
      [
        "src/main.c",
        {
          fileId: "file:c-source",
          repoId: "repo",
          relPath: "src/main.c",
          contentHash: "hash-c",
          language: "c",
          byteSize: 10,
          lastIndexedAt: null,
          directory: "src",
        },
      ],
      [
        "include/shared.h",
        {
          fileId: "file:c-header",
          repoId: "repo",
          relPath: "include/shared.h",
          contentHash: "hash-h",
          language: "c",
          byteSize: 12,
          lastIndexedAt: null,
          directory: "include",
        },
      ],
      [
        "include/cpp-header.h",
        {
          fileId: "file:cpp-header",
          repoId: "repo",
          relPath: "include/cpp-header.h",
          contentHash: "hash-cpp-h",
          language: "cpp",
          byteSize: 14,
          lastIndexedAt: null,
          directory: "include",
        },
      ],
    ]);
    const makeSymbol = (
      symbolId: string,
      fileId: string,
      name: string,
    ) => ({
      symbolId,
      repoId: "repo",
      fileId,
      kind: "function",
      name,
      exported: true,
      visibility: null,
      language: "c",
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
      relPath: fileId,
    });
    const cSourceSymbol = makeSymbol("symbol:c-source", "file:c-source", "main");
    const cHeaderSymbol = makeSymbol(
      "symbol:c-header",
      "file:c-header",
      "shared",
    );
    const cppHeaderSymbol = makeSymbol(
      "symbol:cpp-header",
      "file:cpp-header",
      "cppOnly",
    );
    const index = deriveCRepoIndexFromCppIncludeIndex({
      includedSymbolsByFilePath: new Map(),
      symbolsByFilePath: new Map([
        ["src/main.c", [cSourceSymbol]],
        ["include/shared.h", [cHeaderSymbol]],
        ["include/cpp-header.h", [cppHeaderSymbol]],
      ]),
      filesByRelPath,
      symbolById: new Map(),
      namespaceByFilePath: new Map(),
      namespaceMembersByNamespace: new Map(),
    });

    assert.deepEqual([...index.fileByRelPath.keys()].sort(), [
      "include/shared.h",
      "src/main.c",
    ]);
    assert.deepEqual([...index.cFileIds].sort(), [
      "file:c-header",
      "file:c-source",
    ]);
    assert.deepEqual(
      (index.symbolsByRelPath.get("src/main.c") ?? []).map(
        (symbol) => symbol.symbolId,
      ),
      ["symbol:c-source"],
    );
    assert.deepEqual(
      (index.symbolsByFileId.get("file:c-header") ?? []).map(
        (symbol) => symbol.symbolId,
      ),
      ["symbol:c-header"],
    );
    assert.equal(index.fileByRelPath.has("include/cpp-header.h"), false);
    assert.equal(index.symbolsByFileId.has("file:cpp-header"), false);
  });

});
