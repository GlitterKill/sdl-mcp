/**
 * Golden snapshot test for the SCIP ingest response shape.
 *
 * Validates that the ScipIngestResponse interface has all expected fields
 * with correct types, ensuring the contract remains stable across versions.
 *
 * This is a structural golden test that does not require a running DB.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScipIngestResponse } from "../../src/scip/types.js";

describe("SCIP Ingest Response Golden", () => {
  it("should have the expected response shape for a successful ingest", () => {
    const response: ScipIngestResponse = {
      status: "ingested",
      decoderBackend: "typescript",
      documentsProcessed: 5,
      documentsSkipped: 1,
      symbolsMatched: 20,
      externalSymbolsCreated: 10,
      edgesCreated: 30,
      edgesUpgraded: 5,
      edgesReplaced: 2,
      unresolvedOccurrences: 8,
      skippedSymbols: 4,
      truncated: false,
      durationMs: 150,
    };

    assert.equal(response.status, "ingested");
    assert.equal(response.decoderBackend, "typescript");
    assert.ok(typeof response.documentsProcessed === "number");
    assert.ok(typeof response.documentsSkipped === "number");
    assert.ok(typeof response.symbolsMatched === "number");
    assert.ok(typeof response.externalSymbolsCreated === "number");
    assert.ok(typeof response.edgesCreated === "number");
    assert.ok(typeof response.edgesUpgraded === "number");
    assert.ok(typeof response.edgesReplaced === "number");
    assert.ok(typeof response.unresolvedOccurrences === "number");
    assert.ok(typeof response.skippedSymbols === "number");
    assert.ok(typeof response.truncated === "boolean");
    assert.ok(typeof response.durationMs === "number");

    // Verify all 13 fields are present
    const keys = Object.keys(response);
    assert.equal(keys.length, 13);
  });

  it("should accept all valid status values", () => {
    const statuses: ScipIngestResponse["status"][] = [
      "ingested",
      "alreadyIngested",
      "dryRun",
    ];

    for (const status of statuses) {
      const response: ScipIngestResponse = {
        status,
        decoderBackend: "typescript",
        documentsProcessed: 0,
        documentsSkipped: 0,
        symbolsMatched: 0,
        externalSymbolsCreated: 0,
        edgesCreated: 0,
        edgesUpgraded: 0,
        edgesReplaced: 0,
        unresolvedOccurrences: 0,
        skippedSymbols: 0,
        truncated: false,
        durationMs: 0,
      };
      assert.equal(response.status, status);
    }
  });

  it("should accept all valid decoder backend values", () => {
    const backends: ScipIngestResponse["decoderBackend"][] = [
      "rust",
      "typescript",
    ];

    for (const backend of backends) {
      const response: ScipIngestResponse = {
        status: "ingested",
        decoderBackend: backend,
        documentsProcessed: 0,
        documentsSkipped: 0,
        symbolsMatched: 0,
        externalSymbolsCreated: 0,
        edgesCreated: 0,
        edgesUpgraded: 0,
        edgesReplaced: 0,
        unresolvedOccurrences: 0,
        skippedSymbols: 0,
        truncated: false,
        durationMs: 0,
      };
      assert.equal(response.decoderBackend, backend);
    }
  });

  it("should have the expected field names in alphabetical order", () => {
    const response: ScipIngestResponse = {
      status: "ingested",
      decoderBackend: "typescript",
      documentsProcessed: 10,
      documentsSkipped: 2,
      symbolsMatched: 50,
      externalSymbolsCreated: 15,
      edgesCreated: 80,
      edgesUpgraded: 10,
      edgesReplaced: 3,
      unresolvedOccurrences: 12,
      skippedSymbols: 7,
      truncated: false,
      durationMs: 250,
    };

    const expectedFields = [
      "decoderBackend",
      "documentsProcessed",
      "documentsSkipped",
      "durationMs",
      "edgesCreated",
      "edgesReplaced",
      "edgesUpgraded",
      "externalSymbolsCreated",
      "skippedSymbols",
      "status",
      "symbolsMatched",
      "truncated",
      "unresolvedOccurrences",
    ];

    const actualFields = Object.keys(response).sort();
    assert.deepEqual(actualFields, expectedFields);
  });

  it("should represent a truncated response", () => {
    const response: ScipIngestResponse = {
      status: "ingested",
      decoderBackend: "rust",
      documentsProcessed: 100,
      documentsSkipped: 0,
      symbolsMatched: 5000,
      externalSymbolsCreated: 1000,
      edgesCreated: 8000,
      edgesUpgraded: 500,
      edgesReplaced: 100,
      unresolvedOccurrences: 300,
      skippedSymbols: 50,
      truncated: true,
      durationMs: 5000,
    };

    assert.equal(response.truncated, true);
    assert.ok(response.documentsProcessed > 0);
  });

  it("should represent a dry-run response with zero mutations", () => {
    const response: ScipIngestResponse = {
      status: "dryRun",
      decoderBackend: "typescript",
      documentsProcessed: 10,
      documentsSkipped: 0,
      symbolsMatched: 45,
      externalSymbolsCreated: 0,
      edgesCreated: 0,
      edgesUpgraded: 0,
      edgesReplaced: 0,
      unresolvedOccurrences: 5,
      skippedSymbols: 2,
      truncated: false,
      durationMs: 50,
    };

    assert.equal(response.status, "dryRun");
    // In dry-run mode, no mutations should occur
    assert.equal(response.externalSymbolsCreated, 0);
    assert.equal(response.edgesCreated, 0);
    assert.equal(response.edgesUpgraded, 0);
    assert.equal(response.edgesReplaced, 0);
  });

  it("should represent an already-ingested response", () => {
    const response: ScipIngestResponse = {
      status: "alreadyIngested",
      decoderBackend: "rust",
      documentsProcessed: 0,
      documentsSkipped: 0,
      symbolsMatched: 0,
      externalSymbolsCreated: 0,
      edgesCreated: 0,
      edgesUpgraded: 0,
      edgesReplaced: 0,
      unresolvedOccurrences: 0,
      skippedSymbols: 0,
      truncated: false,
      durationMs: 5,
    };

    assert.equal(response.status, "alreadyIngested");
    // All counts should be zero for already-ingested
    assert.equal(response.documentsProcessed, 0);
    assert.equal(response.symbolsMatched, 0);
  });

  it("should have non-negative numeric fields", () => {
    const response: ScipIngestResponse = {
      status: "ingested",
      decoderBackend: "typescript",
      documentsProcessed: 0,
      documentsSkipped: 0,
      symbolsMatched: 0,
      externalSymbolsCreated: 0,
      edgesCreated: 0,
      edgesUpgraded: 0,
      edgesReplaced: 0,
      unresolvedOccurrences: 0,
      skippedSymbols: 0,
      truncated: false,
      durationMs: 0,
    };

    const numericKeys: (keyof ScipIngestResponse)[] = [
      "documentsProcessed",
      "documentsSkipped",
      "symbolsMatched",
      "externalSymbolsCreated",
      "edgesCreated",
      "edgesUpgraded",
      "edgesReplaced",
      "unresolvedOccurrences",
      "skippedSymbols",
      "durationMs",
    ];

    for (const key of numericKeys) {
      const value = response[key];
      assert.ok(
        typeof value === "number" && value >= 0,
        `${key} should be a non-negative number`,
      );
    }
  });
});
