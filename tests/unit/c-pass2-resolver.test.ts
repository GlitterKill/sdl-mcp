import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CPass2Resolver } from "../../src/indexer/pass2/resolvers/c-pass2-resolver.js";

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
});
