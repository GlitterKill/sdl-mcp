import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KotlinPass2Resolver } from "../../src/indexer/pass2/resolvers/kotlin-pass2-resolver.js";

describe("KotlinPass2Resolver", () => {
  it("supports kotlin .kt and .kts files", () => {
    const resolver = new KotlinPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.kt",
        extension: ".kt",
        language: "kotlin",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "scripts/build.kts",
        extension: ".kts",
        language: "kotlin",
      }),
      true,
    );
  });

  it("does not support non-kotlin extensions", () => {
    const resolver = new KotlinPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.ts",
        extension: ".ts",
        language: "typescript",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.java",
        extension: ".java",
        language: "java",
      }),
      false,
    );
  });

  it("exposes pass2-kotlin resolver id", () => {
    const resolver = new KotlinPass2Resolver();

    assert.equal(resolver.id, "pass2-kotlin");
  });

  it("requires repoId on the target", async () => {
    const resolver = new KotlinPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/main.kt",
          extension: ".kt",
          language: "kotlin",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["kotlin"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
