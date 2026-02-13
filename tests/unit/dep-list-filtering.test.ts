import { describe, it } from "node:test";
import assert from "node:assert";
import { filterDepsBySliceSymbolSet } from "../../src/graph/slice.js";

describe("dep-list relevance filtering", () => {
  it("keeps only deps whose target symbol is in the slice symbol set", () => {
    const deps = {
      imports: [
        { symbolId: "sym-in-1", confidence: 0.9 },
        { symbolId: "sym-out-1", confidence: 0.9 },
      ],
      calls: [
        { symbolId: "sym-in-2", confidence: 1.0 },
        { symbolId: "sym-out-2", confidence: 0.6 },
      ],
    };

    const filtered = filterDepsBySliceSymbolSet(
      deps,
      new Set(["sym-in-1", "sym-in-2"]),
    );

    assert.deepStrictEqual(filtered, {
      imports: [{ symbolId: "sym-in-1", confidence: 0.9 }],
      calls: [{ symbolId: "sym-in-2", confidence: 1.0 }],
    });
  });
});
