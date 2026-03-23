import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GoPass2Resolver } from "../../dist/indexer/pass2/resolvers/go-pass2-resolver.js";

describe("GoPass2Resolver", () => {
  it("supports go files only", () => {
    const resolver = new GoPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.go",
        extension: ".go",
        language: "go",
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

  it("requires repoId on the target", async () => {
    const resolver = new GoPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/main.go",
          extension: ".go",
          language: "go",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["go"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
