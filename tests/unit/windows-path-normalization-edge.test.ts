import { describe, it } from "node:test";
import assert from "node:assert";

import { getRelativePath, normalizePath, safeJoin } from "../../dist/util/paths.js";

describe("Windows path normalization – edge cases", () => {
  it("normalizePath should normalize drive-letter paths with dot segments", () => {
    const input = "C:\\\\Users\\\\user\\\\project\\\\..\\\\tests\\\\fixtures";
    assert.strictEqual(normalizePath(input), "C:/Users/user/tests/fixtures");
  });

  it("getRelativePath should return absolute target when drives differ", () => {
    const from = "C:\\\\project\\\\src";
    const to = "D:\\\\other\\\\file.ts";
    assert.strictEqual(getRelativePath(from, to), "D:/other/file.ts");
  });

  it("safeJoin should handle standard UNC roots", () => {
    const result = safeJoin("\\\\server\\share", "project", "src");
    assert.strictEqual(result, "//server/share/project/src");
  });

  it("normalizePath should handle standard UNC paths", () => {
    const input = "\\\\server\\share\\project\\src\\index.ts";
    assert.strictEqual(normalizePath(input), "//server/share/project/src/index.ts");
  });
});

