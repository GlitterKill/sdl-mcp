import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSearchResults } from "../../dist/live-index/overlay-merge.js";

describe("mergeSearchResults", () => {
  it("prefers overlay rows over durable rows with the same symbol id", () => {
    const merged = mergeSearchResults(
      [
        {
          symbolId: "sym-1",
          name: "alpha",
          fileId: "file-1",
          kind: "function",
          filePath: "src/example.ts",
        },
      ],
      [
        {
          symbolId: "sym-1",
          name: "alphaDraft",
          fileId: "file-1",
          kind: "function",
          filePath: "src/example.ts",
        },
      ],
      "alphaDraft",
      10,
    );

    assert.deepStrictEqual(
      merged.map((row) => row.name),
      ["alphaDraft"],
    );
  });
});
