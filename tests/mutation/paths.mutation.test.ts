import { describe, it } from "node:test";
import assert from "node:assert";

import { getRelativePath, normalizePath, safeJoin } from "../../dist/util/paths.js";

describe("Mutation: paths", () => {
  describe("normalizePath (Windows edge cases)", () => {
    it("normalizes Windows drive-letter absolute paths and removes dot segments", () => {
      const input = "C:\\\\project\\\\src\\\\..\\\\tests\\\\fixtures\\\\c\\\\symbols.c";
      assert.strictEqual(
        normalizePath(input),
        "C:/project/tests/fixtures/c/symbols.c",
      );
    });

    it("normalizes Windows drive-letter paths with mixed separators", () => {
      const input = "C:/project\\\\src/indexer\\\\adapter\\\\c.js";
      assert.strictEqual(normalizePath(input), "C:/project/src/indexer/adapter/c.js");
    });
  });

  describe("getRelativePath (Windows edge cases)", () => {
    it("returns absolute target when drives differ", () => {
      const from = "C:\\\\project\\\\src";
      const to = "D:\\\\other\\\\file.ts";
      assert.strictEqual(getRelativePath(from, to), "D:/other/file.ts");
    });
  });

  describe("safeJoin (Windows edge cases)", () => {
    it("joins UNC roots correctly", () => {
      const result = safeJoin("\\\\server\\\\share", "project", "src", "index.ts");
      assert.strictEqual(result, "//server/share/project/src/index.ts");
    });
  });
});
