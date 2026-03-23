import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JavaPass2Resolver } from "../../dist/indexer/pass2/resolvers/java-pass2-resolver.js";

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
