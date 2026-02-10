import { describe, it } from "node:test";
import assert from "node:assert";
import { encodeEdgesWithSymbolIndex } from "../../src/graph/slice.js";

describe("slice edge wire format", () => {
  it("encodes edges as index tuples with a deduplicated symbol index", () => {
    const symbolIds = ["sym-b", "sym-a", "sym-c", "sym-a"];
    const dbEdges = [
      { from_symbol_id: "sym-a", to_symbol_id: "sym-c", type: "call", weight: 1 },
      { from_symbol_id: "sym-b", to_symbol_id: "sym-a", type: "import", weight: 0.6 },
      { from_symbol_id: "sym-x", to_symbol_id: "sym-a", type: "call", weight: 1 },
      { from_symbol_id: "sym-a", to_symbol_id: "sym-y", type: "call", weight: 1 },
    ] as const;

    const encoded = encodeEdgesWithSymbolIndex(symbolIds as any, dbEdges as any);

    assert.deepStrictEqual(encoded.symbolIndex, ["sym-a", "sym-b", "sym-c"]);
    assert.deepStrictEqual(encoded.edges, [
      [0, 2, "call", 1],
      [1, 0, "import", 0.6],
    ]);
  });
});
