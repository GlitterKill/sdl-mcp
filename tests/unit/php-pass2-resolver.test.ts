import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PhpPass2Resolver } from "../../dist/indexer/pass2/resolvers/php-pass2-resolver.js";

describe("PhpPass2Resolver", () => {
  it("supports php and phtml files when language is php", () => {
    const resolver = new PhpPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/index.php",
        extension: ".php",
        language: "php",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "templates/page.phtml",
        extension: ".phtml",
        language: "php",
      }),
      true,
    );
  });

  it("does not support non-php targets", () => {
    const resolver = new PhpPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/index.ts",
        extension: ".ts",
        language: "typescript",
      }),
      false,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/index.php",
        extension: ".php",
        language: "typescript",
      }),
      false,
    );
  });

  it("exposes pass2-php resolver id", () => {
    const resolver = new PhpPass2Resolver();

    assert.equal(resolver.id, "pass2-php");
  });

  it("requires repoId on the target", async () => {
    const resolver = new PhpPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/index.php",
          extension: ".php",
          language: "php",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["php"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
