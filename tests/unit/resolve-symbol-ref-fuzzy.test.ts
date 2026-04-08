import { describe, it } from "node:test";
import assert from "node:assert";
import { getFileMatchLevel } from "../../dist/util/resolve-symbol-ref.js";

// Regression tests for fuzzy extension-stripping file match.
// Covers the 2026-04-08 fix where "src/graph/slice" (no extension)
// should resolve to "src/graph/slice.ts" at level-2 fuzzy match.
//
// Signature: getFileMatchLevel(requestedFile, candidateFile)
// Returns: 3 exact / 2 suffix-or-ext-strip / 1 basename / 0 none

describe("getFileMatchLevel extension stripping", () => {
  it("returns level 3 for exact match", () => {
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice.ts", "src/graph/slice.ts"),
      3,
    );
  });

  it("returns level 2 when requested file has no extension and candidate adds .ts", () => {
    // requested="src/graph/slice", candidate="src/graph/slice.ts"
    // Extension strip path: candidateNoExt===requested
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice", "src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 2 when no-ext requested is a suffix of candidate", () => {
    // requested="graph/slice", candidate="packages/core/src/graph/slice.ts"
    // candidateNoExt ends with "/graph/slice" → level 2
    assert.strictEqual(
      getFileMatchLevel("graph/slice", "packages/core/src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 2 for direct suffix match (pre-existing behavior)", () => {
    // requested="src/graph/slice.ts", candidate="packages/core/src/graph/slice.ts"
    // candidate endsWith "/src/graph/slice.ts" → level 2 (no extension strip needed)
    assert.strictEqual(
      getFileMatchLevel("src/graph/slice.ts", "packages/core/src/graph/slice.ts"),
      2,
    );
  });

  it("returns level 1 for basename-only match", () => {
    // Different directories, same basename
    assert.strictEqual(
      getFileMatchLevel("other/dir/slice.ts", "src/graph/slice.ts"),
      1,
    );
  });

  it("returns 0 for unrelated paths", () => {
    assert.strictEqual(
      getFileMatchLevel("src/db/queries.ts", "src/graph/slice.ts"),
      0,
    );
  });

  it("returns 0 for undefined requested file", () => {
    assert.strictEqual(
      getFileMatchLevel(undefined, "src/graph/slice.ts"),
      0,
    );
  });

  it("does not match different basenames after extension strip", () => {
    // requested="src/graph/sliced" (no ext), candidate="src/graph/slice.ts"
    // candidateNoExt="src/graph/slice" != requested → level 0
    assert.strictEqual(
      getFileMatchLevel("src/graph/sliced", "src/graph/slice.ts"),
      0,
    );
  });

  it("handles dots in directory components without misclassifying as extension", () => {
    // requested="src.v2/graph/slice" — the ".v2" is in a directory, not the last component.
    // The regex /\.[a-zA-Z0-9]+$/ checks only the END, so requestedHasExt=false.
    // candidateNoExt="src.v2/graph/slice" equals requested → level 2.
    assert.strictEqual(
      getFileMatchLevel("src.v2/graph/slice", "src.v2/graph/slice.ts"),
      2,
    );
  });
});
