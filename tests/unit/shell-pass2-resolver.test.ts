import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ShellPass2Resolver } from "../../src/indexer/pass2/resolvers/shell-pass2-resolver.js";

describe("ShellPass2Resolver", () => {
  it("supports shell files only", () => {
    const resolver = new ShellPass2Resolver();

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "scripts/deploy.sh",
        extension: ".sh",
        language: "shell",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "scripts/env.bash",
        extension: ".bash",
        language: "shell",
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
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/main.c",
        extension: ".c",
        language: "c",
      }),
      false,
    );
  });

  it("exposes pass2-shell resolver id", () => {
    const resolver = new ShellPass2Resolver();

    assert.equal(resolver.id, "pass2-shell");
  });

  it("requires repoId on the target", async () => {
    const resolver = new ShellPass2Resolver();

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "scripts/deploy.sh",
          extension: ".sh",
          language: "shell",
        },
        {
          repoRoot: "F:/repo",
          symbolIndex: new Map(),
          tsResolver: null,
          languages: ["sh", "bash"],
          createdCallEdges: new Set<string>(),
          globalNameToSymbolIds: new Map(),
        },
      ),
      /requires target\.repoId/,
    );
  });
});
