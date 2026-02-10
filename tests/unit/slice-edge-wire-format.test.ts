import { describe, it } from "node:test";
import assert from "node:assert";
import { encodeEdgesWithSymbolIndex } from "../../src/graph/slice.js";
import { toCompactGraphSliceV2 } from "../../src/mcp/tools/slice.js";

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

  it("uses integer edge type indices in compact v2 format", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1", "sym-2", "sym-3"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/a.ts",
          range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
          kind: "function",
          name: "alpha",
          exported: true,
          deps: { imports: [], calls: [] },
          detailLevel: "compact",
          version: { astFingerprint: "abcdef01" },
        },
      ],
      edges: [
        [0, 1, "import", 0.6],
        [0, 2, "call", 1],
        [1, 2, "config", 0.8],
      ] as Array<[number, number, "import" | "call" | "config", number]>,
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);

    // Edge types: import=0, call=1, config=2
    assert.deepStrictEqual(compact.et, ["import", "call", "config"]);
    assert.deepStrictEqual(compact.e, [
      [0, 1, 0, 0.6],  // import -> 0
      [0, 2, 1, 1],    // call -> 1
      [1, 2, 2, 0.8],  // config -> 2
    ]);
  });
});
