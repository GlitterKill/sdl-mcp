import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CppPass2Resolver } from "../../src/indexer/pass2/resolvers/cpp-pass2-resolver.js";

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
});
