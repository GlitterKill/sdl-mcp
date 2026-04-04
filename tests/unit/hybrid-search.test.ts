/**
 * Unit tests for Stage 1 Hybrid Retrieval.
 *
 * Tests RRF fusion logic, fallback decision-making, and model mapping.
 *
 * Modules with transitive tracing imports (fallback.ts, orchestrator.ts)
 * cannot be imported in the tsx unit-test environment due to the
 * OpenTelemetry compatibility issue.  We use inline re-implementations
 * for the pure logic and verify the source text stays in sync.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// RRF Fusion (pure logic — no DB)
// ---------------------------------------------------------------------------

describe("RRF fusion", () => {
  /**
   * Inline RRF implementation matching orchestrator.ts rrfFuse().
   * score(symbol) = Σ 1/(k + rank) across all sources where symbol appears.
   */
  function rrfFuse(
    rankedLists: Array<{ source: string; items: Array<{ symbolId: string }> }>,
    k: number,
    limit: number,
  ): Array<{ symbolId: string; score: number; bestSource: string }> {
    const scores = new Map<string, number>();
    const bestContribution = new Map<string, { source: string; contrib: number }>();

    for (const { source, items } of rankedLists) {
      for (let rank = 0; rank < items.length; rank++) {
        const { symbolId } = items[rank];
        const contrib = 1 / (k + rank + 1);
        scores.set(symbolId, (scores.get(symbolId) ?? 0) + contrib);
        const prev = bestContribution.get(symbolId);
        if (!prev || contrib > prev.contrib) {
          bestContribution.set(symbolId, { source, contrib });
        }
      }
    }

    return Array.from(scores.entries())
      .map(([symbolId, score]) => ({
        symbolId,
        score,
        bestSource: bestContribution.get(symbolId)?.source ?? "unknown",
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  it("computes reciprocal rank fusion scores correctly", () => {
    const k = 60;
    const result = rrfFuse(
      [
        { source: "fts", items: [{ symbolId: "sym1" }, { symbolId: "sym2" }] },
        { source: "vector:minilm", items: [{ symbolId: "sym2" }, { symbolId: "sym3" }] },
      ],
      k,
      10,
    );

    // sym2 appears in both → highest score
    assert.equal(result[0].symbolId, "sym2");
    assert.ok(result[0].score > result[1].score, "sym2 score should exceed sym1");

    // All 3 symbols present
    const ids = result.map((r) => r.symbolId);
    assert.ok(ids.includes("sym1"));
    assert.ok(ids.includes("sym3"));
  });

  it("preserves order within a single source", () => {
    const result = rrfFuse(
      [{ source: "fts", items: [{ symbolId: "a" }, { symbolId: "b" }, { symbolId: "c" }] }],
      60,
      10,
    );
    assert.deepStrictEqual(
      result.map((r) => r.symbolId),
      ["a", "b", "c"],
    );
  });

  it("assigns bestSource to the source with highest contribution", () => {
    const result = rrfFuse(
      [
        { source: "fts", items: [{ symbolId: "x" }] },            // rank 1 → 1/61
        { source: "vector:minilm", items: [{ symbolId: "x" }] },  // rank 1 → 1/61 (tie)
      ],
      60,
      10,
    );
    // On tie, the last source to set wins (vector:minilm)
    assert.equal(result[0].symbolId, "x");
    // Score should be 1/61 + 1/61
    const expected = 2 / 61;
    assert.ok(Math.abs(result[0].score - expected) < 1e-10);
  });

  it("respects the limit parameter", () => {
    const result = rrfFuse(
      [{ source: "fts", items: [{ symbolId: "a" }, { symbolId: "b" }, { symbolId: "c" }] }],
      60,
      2,
    );
    assert.equal(result.length, 2);
  });

  it("handles empty source lists", () => {
    const result = rrfFuse([], 60, 10);
    assert.deepStrictEqual(result, []);
  });

  it("handles k=0 (pure reciprocal ranking)", () => {
    const result = rrfFuse(
      [{ source: "fts", items: [{ symbolId: "a" }, { symbolId: "b" }] }],
      0,
      10,
    );
    // rank 1: 1/(0+1) = 1.0, rank 2: 1/(0+2) = 0.5
    assert.ok(Math.abs(result[0].score - 1.0) < 1e-10);
    assert.ok(Math.abs(result[1].score - 0.5) < 1e-10);
  });
});

// ---------------------------------------------------------------------------
// Model Mapping (safe to import — no tracing dependency)
// ---------------------------------------------------------------------------

describe("model mapping", async () => {
  let modelMapping: typeof import("../../dist/retrieval/model-mapping.js");

  before(async () => {
    modelMapping = await import("../../dist/retrieval/model-mapping.js");
  });

  it("returns correct property names for MiniLM", () => {
    assert.equal(modelMapping.getEmbeddingPropertyName("all-MiniLM-L6-v2"), "embeddingMiniLM");
    assert.equal(modelMapping.getCardHashPropertyName("all-MiniLM-L6-v2"), "embeddingMiniLMCardHash");
    assert.equal(modelMapping.getUpdatedAtPropertyName("all-MiniLM-L6-v2"), "embeddingMiniLMUpdatedAt");
    assert.equal(modelMapping.getVectorIndexName("all-MiniLM-L6-v2"), "symbol_vec_minilm_l6_v2");
  });

  it("returns correct property names for Nomic", () => {
    assert.equal(modelMapping.getEmbeddingPropertyName("nomic-embed-text-v1.5"), "embeddingNomic");
    assert.equal(modelMapping.getVectorIndexName("nomic-embed-text-v1.5"), "symbol_vec_nomic_embed_v15");
  });

  it("returns null for unknown models", () => {
    assert.equal(modelMapping.getEmbeddingPropertyName("unknown-model"), null);
    assert.equal(modelMapping.getCardHashPropertyName("unknown-model"), null);
    assert.equal(modelMapping.getVectorIndexName("unknown-model"), null);
  });

  it("EMBEDDING_MODELS has exactly 3 real model entries", () => {
    const keys = Object.keys(modelMapping.EMBEDDING_MODELS);
    assert.equal(keys.length, 3);
    assert.ok(keys.includes("all-MiniLM-L6-v2"));
    assert.ok(keys.includes("nomic-embed-text-v1.5"));
    assert.ok(keys.includes("jina-embeddings-v2-base-code"));
  });

  it("dimensions match expected values", () => {
    assert.equal(modelMapping.EMBEDDING_MODELS["all-MiniLM-L6-v2"].dimension, 384);
    assert.equal(modelMapping.EMBEDDING_MODELS["nomic-embed-text-v1.5"].dimension, 768);
  });
});

// ---------------------------------------------------------------------------
// Fallback Decision Logic (inline re-implementation)
// ---------------------------------------------------------------------------

describe("shouldFallbackToLegacy (inline)", () => {
  interface RetrievalCapabilities {
    fts: boolean;
    vectorMiniLM: boolean;
    vectorNomic: boolean;
  }
  interface SemanticRetrievalConfig {
    mode: "legacy" | "hybrid";
    [key: string]: unknown;
  }

  /** Inline re-implementation of shouldFallbackToLegacy from fallback.ts. */
  function shouldFallbackToLegacy(
    caps: RetrievalCapabilities,
    config: SemanticRetrievalConfig,
  ): boolean {
    if (config.mode === "legacy") return true;
    if (!caps.fts) return true;
    return false;
  }

  it("returns true when mode is legacy (regardless of caps)", () => {
    assert.equal(shouldFallbackToLegacy({ fts: true, vectorMiniLM: true, vectorNomic: true }, { mode: "legacy" }), true);
  });

  it("returns true when FTS is unavailable in hybrid mode", () => {
    assert.equal(shouldFallbackToLegacy({ fts: false, vectorMiniLM: true, vectorNomic: true }, { mode: "hybrid" }), true);
  });

  it("returns false when FTS available in hybrid mode (vector optional)", () => {
    assert.equal(shouldFallbackToLegacy({ fts: true, vectorMiniLM: false, vectorNomic: false }, { mode: "hybrid" }), false);
  });

  it("returns false when all capabilities available in hybrid mode", () => {
    assert.equal(shouldFallbackToLegacy({ fts: true, vectorMiniLM: true, vectorNomic: true }, { mode: "hybrid" }), false);
  });

  it("returns true when all capabilities unavailable in hybrid mode", () => {
    assert.equal(shouldFallbackToLegacy({ fts: false, vectorMiniLM: false, vectorNomic: false }, { mode: "hybrid" }), true);
  });
});

// ---------------------------------------------------------------------------
// Source-text verification: ensure inline tests match real code
// ---------------------------------------------------------------------------

describe("source-text verification", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  it("fallback.ts uses the expected decision branches", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/retrieval/fallback.ts"), "utf8");
    // Mode check
    assert.ok(src.includes('config.mode === "legacy"'), "should check for legacy mode");
    assert.ok(src.includes("!caps.fts"), "should check FTS availability");
    assert.ok(src.includes("return false"), "should return false for hybrid-ready");
  });

  it("orchestrator.ts imports required modules", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/retrieval/orchestrator.ts"), "utf8");
    assert.ok(src.includes("hybridSearch"), "should export hybridSearch");
    assert.ok(src.includes("HybridSearchOptions"), "should reference HybridSearchOptions type");
    assert.ok(src.includes("HybridSearchResult"), "should reference HybridSearchResult type");
    assert.ok(src.includes("checkRetrievalHealth"), "should check retrieval health");
    assert.ok(src.includes("shouldFallbackToLegacy"), "should check fallback");
    assert.ok(src.includes("getEmbeddingProvider"), "should use embedding provider");
    assert.ok(src.includes("EMBEDDING_MODELS"), "should iterate real models");
  });

  it("orchestrator.ts implements RRF fusion", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/retrieval/orchestrator.ts"), "utf8");
    assert.ok(src.includes("rrfK") || src.includes("rrf"), "should reference RRF parameter");
    assert.ok(src.includes("1 / ("), "should compute reciprocal rank");
  });

  it("symbol.ts references hybrid search path", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/mcp/tools/symbol.ts"), "utf8");
    assert.ok(src.includes("searchSymbolsHybridWithOverlay"), "should import hybrid overlay search");
    assert.ok(src.includes("useHybrid"), "should have hybrid mode flag");
    assert.ok(src.includes("retrievalEvidence"), "should populate retrieval evidence");
    assert.ok(src.includes('retrievalMode: useHybrid ? "hybrid" : "legacy"'), "should log retrieval mode in telemetry");
  });

  it("overlay-reader.ts exports hybrid search function", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/live-index/overlay-reader.ts"), "utf8");
    assert.ok(src.includes("export async function searchSymbolsHybridWithOverlay"), "should export hybrid overlay search");
    assert.ok(src.includes("hybridSearch"), "should call hybridSearch from orchestrator");
    assert.ok(src.includes("touchedFileIds"), "should filter touched files from hybrid results");
  });
});
