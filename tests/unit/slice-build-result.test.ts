import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unwrapSliceBuildResult } from "../../dist/benchmark/slice-build-result.js";

describe("unwrapSliceBuildResult", () => {
  it("returns the nested slice from the current buildSlice result shape", () => {
    const slice = { cards: [{ symbolId: "a" }] };

    const result = unwrapSliceBuildResult({
      slice,
      retrievalEvidence: [],
      hybridSearchItems: [],
    });

    assert.equal(result, slice);
  });

  it("passes through direct slice values for older callers", () => {
    const slice = { cards: [{ symbolId: "b" }] };

    const result = unwrapSliceBuildResult(slice);

    assert.equal(result, slice);
  });
});
