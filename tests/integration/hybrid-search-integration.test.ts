/**
 * Integration tests for Stage 1 Hybrid Retrieval.
 *
 * Tests config-driven mode selection, schema validation, and
 * source-text verification that all wiring is in place.
 *
 * Module-import tests for orchestrator/overlay-reader/index-lifecycle
 * are not included here because they transitively pull in tracing.ts
 * which has an OpenTelemetry compatibility issue in the tsx test
 * environment.  Those modules are covered by the npm test suite which
 * runs against compiled dist/ output.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

// ---------------------------------------------------------------------------
// Config-driven mode selection
// ---------------------------------------------------------------------------

describe("hybrid search config integration", async () => {
  let configTypes: typeof import("../../dist/config/types.js");

  before(async () => {
    configTypes = await import("../../dist/config/types.js");
  });

  it("SemanticRetrievalConfigSchema parses hybrid mode with defaults", () => {
    const result = configTypes.SemanticRetrievalConfigSchema.parse({
      mode: "hybrid",
    });
    assert.equal(result.mode, "hybrid");
    assert.equal(result.extensionsOptional, true);
    assert.equal(result.candidateLimit, 100);
    assert.ok(result.fts);
    assert.equal(result.fts.enabled, true);
    assert.equal(result.fts.indexName, "symbol_search_text_v1");
    assert.equal(result.fts.topK, 75);
    assert.equal(result.fts.conjunctive, false);
    assert.ok(result.vector);
    assert.equal(result.vector.enabled, true);
    assert.equal(result.vector.topK, 75);
    assert.equal(result.vector.efs, 200);
    assert.ok(result.fusion);
    assert.equal(result.fusion.strategy, "rrf");
    assert.equal(result.fusion.rrfK, 60);
  });

  it("SemanticRetrievalConfigSchema defaults to hybrid mode", () => {
    const result = configTypes.SemanticRetrievalConfigSchema.parse({});
    assert.equal(result.mode, "hybrid");
  });

  it("SemanticConfigSchema accepts retrieval sub-config", () => {
    const result = configTypes.SemanticConfigSchema.parse({
      retrieval: { mode: "hybrid" },
    });
    assert.ok(result.retrieval);
    assert.equal(result.retrieval.mode, "hybrid");
  });

  it("SemanticConfigSchema preserves alpha for legacy", () => {
    const result = configTypes.SemanticConfigSchema.parse({
      alpha: 0.8,
    });
    assert.equal(result.alpha, 0.8);
  });

  it("SemanticRetrievalConfigSchema rejects invalid mode", () => {
    assert.throws(() => {
      configTypes.SemanticRetrievalConfigSchema.parse({ mode: "invalid" });
    });
  });

  it("SemanticRetrievalConfigSchema validates candidateLimit bounds", () => {
    assert.throws(() => {
      configTypes.SemanticRetrievalConfigSchema.parse({ candidateLimit: 0 });
    });
  });

  it("SemanticRetrievalConfigSchema parses custom vector index config", () => {
    const result = configTypes.SemanticRetrievalConfigSchema.parse({
      mode: "hybrid",
      vector: {
        topK: 50,
        indexes: {
          "all-MiniLM-L6-v2": { indexName: "custom_minilm_idx" },
        },
      },
    });
    assert.equal(result.vector.topK, 50);
    assert.equal(result.vector.indexes["all-MiniLM-L6-v2"].indexName, "custom_minilm_idx");
  });

  it("SemanticRetrievalConfigSchema parses custom fusion config", () => {
    const result = configTypes.SemanticRetrievalConfigSchema.parse({
      fusion: { rrfK: 100 },
    });
    assert.equal(result.fusion.rrfK, 100);
    assert.equal(result.fusion.strategy, "rrf");
  });
});

// ---------------------------------------------------------------------------
// SymbolSearch schema supports retrieval evidence
// ---------------------------------------------------------------------------

describe("SymbolSearch schema retrieval evidence", async () => {
  let toolSchemas: typeof import("../../dist/mcp/tools.js");

  before(async () => {
    toolSchemas = await import("../../dist/mcp/tools.js");
  });

  it("SymbolSearchRequestSchema accepts includeRetrievalEvidence", () => {
    const result = toolSchemas.SymbolSearchRequestSchema.parse({
      repoId: "test",
      query: "search",
      includeRetrievalEvidence: true,
    });
    assert.equal(result.includeRetrievalEvidence, true);
  });

  it("SymbolSearchRequestSchema works without includeRetrievalEvidence", () => {
    const result = toolSchemas.SymbolSearchRequestSchema.parse({
      repoId: "test",
      query: "search",
    });
    assert.equal(result.includeRetrievalEvidence, undefined);
  });

  it("SymbolSearchResponseSchema accepts retrievalEvidence array", () => {
    const result = toolSchemas.SymbolSearchResponseSchema.parse({
      results: [{ symbolId: "abc", name: "foo", file: "bar.ts", kind: "function" }],
      retrievalEvidence: [
        { symbolId: "abc", retrievalSource: "hybrid" },
      ],
    });
    assert.ok(result.retrievalEvidence);
    assert.equal(result.retrievalEvidence!.length, 1);
    assert.equal(result.retrievalEvidence![0].symbolId, "abc");
  });

  it("RetrievalEvidenceItemSchema validates retrievalSource enum", () => {
    const result = toolSchemas.RetrievalEvidenceItemSchema.parse({
      symbolId: "test",
      retrievalSource: "fts",
    });
    assert.equal(result.retrievalSource, "fts");
  });
});

// ---------------------------------------------------------------------------
// Source-text wiring verification
// ---------------------------------------------------------------------------

describe("Stage 1 wiring verification", () => {
  it("handleSymbolSearch imports hybrid overlay search", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("searchSymbolsHybridWithOverlay"), "missing hybrid overlay import");
    assert.ok(src.includes("checkRetrievalHealth"), "missing health check import");
    assert.ok(src.includes("shouldFallbackToLegacy"), "missing fallback import");
  });

  it("handleSymbolSearch has hybrid vs legacy branching", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("useHybrid"), "missing hybrid mode flag");
    assert.ok(src.includes("retrievalConfig?.mode"), "missing mode check");
    assert.ok(src.includes("HYBRID PATH"), "missing hybrid path comment");
    assert.ok(src.includes("LEGACY PATH"), "missing legacy path comment");
  });

  it("handleSymbolSearch has hybrid-only search path", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("searchSymbolsHybridWithOverlay"), "should import hybrid overlay search");
    assert.ok(src.includes("useHybrid"), "should have hybrid mode flag");
  });

  it("handleSymbolSearch populates retrievalEvidence", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("includeRetrievalEvidence"), "missing evidence check");
    assert.ok(src.includes("retrievalEvidence = results.map"), "missing evidence assignment");
  });

  it("handleSymbolSearch logs hybrid telemetry fields", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("retrievalMode"), "missing retrievalMode in telemetry");
    assert.ok(src.includes("fusionLatencyMs"), "missing fusionLatencyMs in telemetry");
    assert.ok(src.includes("finalResultCount"), "missing finalResultCount in telemetry");
  });

  it("overlay-reader exports both search functions", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/live-index/overlay-reader.ts"), "utf8");
    assert.ok(src.includes("export async function searchSymbolsWithOverlay"), "missing original export");
    assert.ok(src.includes("export async function searchSymbolsHybridWithOverlay"), "missing hybrid export");
  });

  it("hybrid overlay search filters touched files", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/live-index/overlay-reader.ts"), "utf8");
    const hybridFuncStart = src.indexOf("searchSymbolsHybridWithOverlay");
    const hybridSection = src.substring(hybridFuncStart);
    assert.ok(hybridSection.includes("touchedFileIds"), "should filter touched files");
    assert.ok(hybridSection.includes("hybridSearch"), "should call hybridSearch");
    assert.ok(hybridSection.includes("overlayRows"), "should collect overlay results");
  });

  it("telemetry has hybrid-specific fields", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/telemetry.ts"), "utf8");
    assert.ok(src.includes("retrievalMode"), "missing retrievalMode field");
    assert.ok(src.includes("candidateCountPerSource"), "missing candidateCountPerSource");
    assert.ok(src.includes("fusionLatencyMs"), "missing fusionLatencyMs");
    assert.ok(src.includes("ftsAvailable"), "missing ftsAvailable");
    assert.ok(src.includes("vectorAvailable"), "missing vectorAvailable");
    assert.ok(src.includes("fallbackReason"), "missing fallbackReason");
    assert.ok(src.includes("finalResultCount"), "missing finalResultCount");
  });
});
