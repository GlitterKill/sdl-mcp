import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PythonPass2Resolver } from "../../dist/indexer/pass2/resolvers/python-pass2-resolver.js";

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
