import assert from "node:assert/strict";
import { describe, it } from "node:test";

function detail(nodeId: string, kind = "function") {
  return {
    extractedSymbol: {
      nodeId,
      kind,
      name: nodeId,
      exported: true,
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 1 },
    },
    astFingerprint: nodeId,
    symbolId: `sym:${nodeId}`,
  };
}

describe("buildSymbolAndEdgeRows import fanout", () => {
  it("collapses high-fanout C++ pass-1 imports to module symbols", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: new Set(["module", "fn1", "fn2"]),
      importTargetCount: 200,
      languageId: "cpp",
      skipCallResolution: true,
    });

    assert.deepEqual(Array.from(selected), ["module"]);
  });

  it("keeps ordinary non-C++ import fanout unchanged", async () => {
    const { selectImportEdgeSourceNodeIds } = await import(
      "../../dist/indexer/parser/build-rows.js"
    );
    const sourceIds = new Set(["module", "fn1", "fn2"]);
    const selected = selectImportEdgeSourceNodeIds({
      symbolDetails: [
        detail("module", "module"),
        detail("fn1"),
        detail("fn2"),
      ],
      edgeSourceNodeIds: sourceIds,
      importTargetCount: 200,
      languageId: "typescript",
      skipCallResolution: true,
    });

    assert.equal(selected, sourceIds);
  });
});
