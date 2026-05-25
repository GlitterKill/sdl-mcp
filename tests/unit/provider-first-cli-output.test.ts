import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatProviderFirstExecutionSummaryLines } from "../../dist/cli/commands/index.js";

describe("provider-first CLI output", () => {
  it("explains provider coverage and legacy fallback scope for executed runs", () => {
    const lines = formatProviderFirstExecutionSummaryLines({
      status: "executed",
      executor: "scipFull",
      generationId: "provider-first:test",
      reasons: [],
      filesProcessed: 0,
      symbolsIndexed: 0,
      edgesCreated: 0,
      externalSymbolsIndexed: 0,
      coverage: {
        scannedFiles: 1213,
        providerFiles: 543,
        fullyCoveredFiles: 0,
        partialFiles: 521,
        fullFallbackFiles: 22,
        uncoveredFiles: 670,
        fallbackFiles: 1213,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 0/1213 files fully covered; 543 provider fallback, 670 uncovered; legacy fallback parsed 1213 file(s)",
    ]);
  });
});
