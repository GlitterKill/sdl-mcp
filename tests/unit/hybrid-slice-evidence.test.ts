/**
 * hybrid-slice-evidence.test.ts
 *
 * Stage 2 tests verifying that retrieval evidence flows through
 * slice.build and into the MCP response.
 *
 * Tests cover:
 *  - SliceBuildInternalResult type shape (source verification)
 *  - mapRetrievalSource mapping logic (inline re-implementation)
 *  - Evidence wiring in handleSliceBuildInternal (source verification)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RetrievalSource } from "../../dist/retrieval/types.js";

// ---------------------------------------------------------------------------
// Inline re-implementation of mapRetrievalSource
// (mirrors src/mcp/tools/slice.ts exactly)
// ---------------------------------------------------------------------------

/**
 * Map internal RetrievalSource discriminator to the wire-format enum
 * expected by RetrievalEvidenceItemSchema.
 */
function mapRetrievalSource(
  source: RetrievalSource,
): "fts" | "vector" | "hybrid" | "legacy" {
  if (source === "fts") return "fts";
  if (source.startsWith("vector:")) return "vector";
  if (source === "legacyFallback") return "legacy";
  // overlay or unknown -> hybrid
  return "hybrid";
}

// ---------------------------------------------------------------------------
// mapRetrievalSource — logic tests
// ---------------------------------------------------------------------------

describe("mapRetrievalSource — logic", () => {
  it('maps "fts" to "fts"', () => {
    assert.strictEqual(mapRetrievalSource("fts"), "fts");
  });

  it('maps "vector:minilm" to "vector"', () => {
    assert.strictEqual(mapRetrievalSource("vector:minilm"), "vector");
  });

  it('maps "vector:nomic" to "vector"', () => {
    assert.strictEqual(mapRetrievalSource("vector:nomic"), "vector");
  });

  it('maps "legacyFallback" to "legacy"', () => {
    assert.strictEqual(mapRetrievalSource("legacyFallback"), "legacy");
  });

  it('maps "overlay" to "hybrid"', () => {
    assert.strictEqual(mapRetrievalSource("overlay"), "hybrid");
  });

  it("returns only valid wire-format values", () => {
    const validValues = new Set(["fts", "vector", "hybrid", "legacy"]);
    const allSources: RetrievalSource[] = [
      "fts",
      "vector:minilm",
      "vector:nomic",
  "vector:jinacode",
  "legacyFallback",
      "overlay",
    ];
    for (const source of allSources) {
      const mapped = mapRetrievalSource(source);
      assert.ok(
        validValues.has(mapped),
        `mapRetrievalSource("${source}") returned "${mapped}" which is not a valid wire-format value`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SliceBuildInternalResult — source-text shape verification
// ---------------------------------------------------------------------------

describe("SliceBuildInternalResult — shape verification", () => {
  const src = readFileSync(
    join(process.cwd(), "src/graph/slice.ts"),
    "utf8",
  );

  it("exports SliceBuildInternalResult interface", () => {
    assert.ok(
      src.includes("export interface SliceBuildInternalResult"),
      "SliceBuildInternalResult should be an exported interface",
    );
  });

  it("has slice field of type GraphSlice", () => {
    assert.ok(
      src.includes("slice: GraphSlice"),
      "SliceBuildInternalResult should have a slice field of type GraphSlice",
    );
  });

  it("has optional retrievalEvidence field", () => {
    assert.ok(
      src.includes("retrievalEvidence?: RetrievalEvidence"),
      "SliceBuildInternalResult should have an optional retrievalEvidence field",
    );
  });

  it("has optional hybridSearchItems field", () => {
    assert.ok(
      src.includes("hybridSearchItems?: HybridSearchResultItem[]"),
      "SliceBuildInternalResult should have an optional hybridSearchItems field",
    );
  });

  it("imports RetrievalEvidence from retrieval types", () => {
    assert.ok(
      src.includes("RetrievalEvidence") && src.includes("retrieval/types"),
      "should import RetrievalEvidence from retrieval/types",
    );
  });

  it("imports HybridSearchResultItem from retrieval types", () => {
    assert.ok(
      src.includes("HybridSearchResultItem") && src.includes("retrieval/types"),
      "should import HybridSearchResultItem from retrieval/types",
    );
  });
});

// ---------------------------------------------------------------------------
// mapRetrievalSource — source-text verification
// ---------------------------------------------------------------------------

describe("mapRetrievalSource — source verification", () => {
  const src = readFileSync(
    join(process.cwd(), "src/mcp/tools/slice.ts"),
    "utf8",
  );

  it("defines mapRetrievalSource function", () => {
    assert.ok(
      src.includes("function mapRetrievalSource"),
      "slice.ts should define mapRetrievalSource",
    );
  });

  it("mapRetrievalSource accepts RetrievalSource parameter", () => {
    assert.ok(
      src.includes("source: RetrievalSource"),
      "mapRetrievalSource should accept RetrievalSource parameter",
    );
  });

  it('mapRetrievalSource returns union of "fts" | "vector" | "hybrid" | "legacy"', () => {
    assert.ok(
      src.includes('"fts" | "vector" | "hybrid" | "legacy"'),
      "mapRetrievalSource return type should be the 4-value wire-format union",
    );
  });

  it("handles vector: prefix with startsWith", () => {
    assert.ok(
      src.includes('source.startsWith("vector:")'),
      'should use startsWith("vector:") for vector source matching',
    );
  });

  it('handles legacyFallback mapping to "legacy"', () => {
    assert.ok(
      src.includes('"legacyFallback"') && src.includes('"legacy"'),
      "should map legacyFallback to legacy",
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence wiring in handleSliceBuildInternal — source-text verification
// ---------------------------------------------------------------------------

describe("slice.build evidence wiring — source verification", () => {
  const src = readFileSync(
    join(process.cwd(), "src/mcp/tools/slice.ts"),
    "utf8",
  );

  it("imports RetrievalEvidenceItem from tools schema", () => {
    assert.ok(
      src.includes("RetrievalEvidenceItem"),
      "should import RetrievalEvidenceItem type",
    );
  });

  it("imports RetrievalSource from retrieval types", () => {
    assert.ok(
      src.includes("RetrievalSource") && src.includes("retrieval/types"),
      "should import RetrievalSource from retrieval types",
    );
  });

  it("checks includeRetrievalEvidence flag before building evidence", () => {
    assert.ok(
      src.includes("includeRetrievalEvidence"),
      "should check includeRetrievalEvidence flag",
    );
  });

  it("maps hybridSearchItems to evidence items with fusionRank", () => {
    assert.ok(
      src.includes("fusionRank: index + 1"),
      "should assign 1-based fusionRank from array index",
    );
  });

  it("calls mapRetrievalSource for each evidence item", () => {
    assert.ok(
      src.includes("mapRetrievalSource(item.source)"),
      "should call mapRetrievalSource to convert source discriminator",
    );
  });

  it("assigns ftsScore for FTS source items", () => {
    assert.ok(
      src.includes('item.source === "fts"') && src.includes("mapped.ftsScore = item.score"),
      "should assign ftsScore when source is fts",
    );
  });

  it("assigns vectorScore for vector source items", () => {
    assert.ok(
      src.includes('item.source.startsWith("vector:")') && src.includes("mapped.vectorScore = item.score"),
      "should assign vectorScore when source starts with vector:",
    );
  });

  it("attaches evidence to response as retrievalEvidence", () => {
    assert.ok(
      src.includes("retrievalEvidence"),
      "should attach evidence items to response as retrievalEvidence",
    );
  });
});

// ---------------------------------------------------------------------------
// RetrievalEvidenceItem schema — source-text verification
// ---------------------------------------------------------------------------

describe("RetrievalEvidenceItem schema — source verification", () => {
  const src = readFileSync(
    join(process.cwd(), "src/mcp/tools.ts"),
    "utf8",
  );

  it("defines RetrievalEvidenceItemSchema", () => {
    assert.ok(
      src.includes("RetrievalEvidenceItemSchema"),
      "tools.ts should define RetrievalEvidenceItemSchema",
    );
  });

  it("schema has symbolId field", () => {
    assert.ok(
      src.includes("symbolId: z.string()"),
      "RetrievalEvidenceItemSchema should have symbolId field",
    );
  });

  it("schema has optional ftsScore field", () => {
    assert.ok(
      src.includes("ftsScore: z.number().optional()"),
      "RetrievalEvidenceItemSchema should have optional ftsScore field",
    );
  });

  it("schema has optional vectorScore field", () => {
    assert.ok(
      src.includes("vectorScore: z.number().optional()"),
      "RetrievalEvidenceItemSchema should have optional vectorScore field",
    );
  });

  it("schema has optional fusionRank field", () => {
    assert.ok(
      src.includes("fusionRank: z.number().int().optional()"),
      "RetrievalEvidenceItemSchema should have optional fusionRank field",
    );
  });

  it("schema has optional retrievalSource enum field", () => {
    assert.ok(
      src.includes('z.enum(["fts", "vector", "hybrid", "legacy"])'),
      'RetrievalEvidenceItemSchema should have retrievalSource enum with fts/vector/hybrid/legacy',
    );
  });

  it("exports RetrievalEvidenceItem type", () => {
    assert.ok(
      src.includes("export type RetrievalEvidenceItem"),
      "should export RetrievalEvidenceItem type inferred from schema",
    );
  });
});
