import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RustPass2Resolver } from "../../dist/indexer/pass2/resolvers/rust-pass2-resolver.js";

describe("RustPass2Resolver", () => {
  it("supports rust files only", () => {
    const resolver = new RustPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/lib.rs",
        extension: ".rs",
        language: "rust",
      }),
      true,
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

  it("exposes pass2-rust resolver id", () => {
    const resolver = new RustPass2Resolver();

    assert.equal(resolver.id, "pass2-rust");
  });

  it("requires repoId on the target", async () => {
    const resolver = new RustPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/lib.rs",
          extension: ".rs",
          language: "rust",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["rust"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
