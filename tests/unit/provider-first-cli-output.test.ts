import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatProviderFirstExecutionSummaryLines,
  formatSemanticReadinessLines,
} from "../../dist/cli/commands/index.js";

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
        providerPrimaryFiles: 521,
        fullyCoveredFiles: 0,
        partialFiles: 521,
        fullFallbackFiles: 22,
        uncoveredFiles: 670,
        fallbackFiles: 692,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 521/1213 files provider-primary (0 full, 521 partial); 22 provider unusable, 670 uncovered; legacy fallback parsed 692 file(s)",
    ]);
  });

  it("surfaces deferred semantic readiness separately from index readiness", () => {
    assert.deepEqual(formatSemanticReadinessLines(true), [
      "  Semantic readiness: deferred",
    ]);
    assert.deepEqual(formatSemanticReadinessLines(false), []);
  });

  it("surfaces provider call-proof incompleteness in coverage output", () => {
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
        scannedFiles: 2,
        providerFiles: 2,
        providerPrimaryFiles: 2,
        fullyCoveredFiles: 2,
        partialFiles: 0,
        callProofIncompleteFiles: 1,
        fullFallbackFiles: 0,
        uncoveredFiles: 0,
        fallbackFiles: 0,
      },
    });

    assert.deepEqual(lines, [
      "  Provider-first: scipFull (provider-first:test)",
      "  Provider-first coverage: 2/2 files provider-primary (2 full, 0 partial); 1 call-proof incomplete",
    ]);
  });
});
