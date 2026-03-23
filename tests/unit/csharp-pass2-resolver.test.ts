import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CSharpPass2Resolver } from "../../dist/indexer/pass2/resolvers/csharp-pass2-resolver.js";

describe("CSharpPass2Resolver", () => {
  it("supports csharp files only", () => {
    const resolver = new CSharpPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/Program.cs",
        extension: ".cs",
        language: "csharp",
      }),
      true,
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

  it("exposes pass2-csharp resolver id", () => {
    const resolver = new CSharpPass2Resolver();

    assert.equal(resolver.id, "pass2-csharp");
  });

  it("requires repoId on the target", async () => {
    const resolver = new CSharpPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/Program.cs",
          extension: ".cs",
          language: "csharp",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["csharp"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
