import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TsPass2Resolver } from "../../dist/indexer/pass2/resolvers/ts-pass2-resolver.js";
import type { Pass2ResolverContext } from "../../dist/indexer/pass2/types.js";

function createContext(): Pass2ResolverContext {
  return {
    repoRoot: "F:/repo",
    symbolIndex: new Map(),
    tsResolver: null,
    languages: ["ts", "tsx", "js", "jsx"],
    createdCallEdges: new Set<string>(),
    globalNameToSymbolIds: new Map(),
  };
}

describe("TsPass2Resolver", () => {
  it("supports current ts and js pass2 file types", () => {
    const resolver = new TsPass2Resolver(async () => 0);

    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/index.ts",
        extension: ".ts",
        language: "typescript",
      }),
      true,
    );
    assert.equal(
      resolver.supports({
        repoId: "repo",
        filePath: "src/script.py",
        extension: ".py",
        language: "python",
      }),
      false,
    );
  });

  it("delegates to the compatibility pass2 implementation", async () => {
    let received: Record<string, unknown> | undefined;
    const resolver = new TsPass2Resolver(async (params) => {
      received = params;
      return 3;
    });

    const result = await resolver.resolve(
      {
        repoId: "repo-1",
        filePath: "src/index.ts",
        extension: ".ts",
        language: "typescript",
      },
      createContext(),
    );

    assert.equal(result.edgesCreated, 3);
    assert.equal(received?.repoId, "repo-1");
    assert.equal(
      (received?.fileMeta as { path: string }).path,
      "src/index.ts",
    );
    assert.equal(received?.repoRoot, "F:/repo");
  });

  it("requires repoId on the target", async () => {
    const resolver = new TsPass2Resolver(async () => 0);

    await assert.rejects(
      resolver.resolve(
        {
          filePath: "src/index.ts",
          extension: ".ts",
          language: "typescript",
        },
        createContext(),
      ),
      /requires target\.repoId/,
    );
  });
});
