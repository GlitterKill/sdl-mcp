import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { proveSourceOccurrenceCall } from "../../dist/indexer/provider-first/source-call-proof.js";

describe("proveSourceOccurrenceCall", () => {
  it("maps SCIP UTF-8 byte columns before slicing source text", () => {
    const line = "const π = target();";
    const prefix = "const π = ";
    const expectedName = "target";
    const startCol = Buffer.byteLength(prefix, "utf8");
    const endCol = startCol + Buffer.byteLength(expectedName, "utf8");

    const result = proveSourceOccurrenceCall({
      providerSymbolId:
        "scip-typescript npm fixture 1.0.0 src/index.ts/target().",
      relPath: "src/index.ts",
      range: { startLine: 0, startCol, endLine: 0, endCol },
      expectedNames: [expectedName],
      sourceLines: new Map([[0, line]]),
    });

    assert.deepEqual(result, {
      matched: true,
      line,
      invocationEndLine: 0,
    });
  });
});
