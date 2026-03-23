import assert from "node:assert";
import { describe, it } from "node:test";

import { extractConfigEdgesFromTree } from "../../dist/indexer/configEdges.js";

describe("config edge extraction", () => {
  it("skips express route traversal for non-js files", () => {
    let traversed = false;

    const rootNode = {
      type: "translation_unit",
      get namedChildren() {
        traversed = true;
        throw new Error("should not traverse non-js trees");
      },
    };

    const result = extractConfigEdgesFromTree({
      repoId: "repo",
      repoRoot: process.cwd(),
      relPath: "src/generated.cpp",
      config: {
        repoId: "repo",
        rootPath: process.cwd(),
        languages: ["cpp"],
      },
      tree: {
        rootNode,
      },
      fileSymbols: [],
      allSymbolsByName: new Map(),
    } as never);

    assert.deepStrictEqual(result, []);
    assert.strictEqual(traversed, false);
  });
});
