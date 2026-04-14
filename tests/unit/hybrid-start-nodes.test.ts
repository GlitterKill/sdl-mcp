/**
 * hybrid-start-nodes.test.ts
 *
 * Stage 2 tests for the hybrid retrieval integration in start-node
 * resolution, auto-flip logic, and fallback decision-making.
 *
 * Like the existing retrieval-fallback.test.ts, we use inline
 * re-implementations and source-text verification because the real
 * modules pull in OpenTelemetry transitive imports that are
 * incompatible with the tsx unit-test environment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RetrievalCapabilities } from "../../dist/retrieval/types.js";

// ---------------------------------------------------------------------------
// Minimal types (mirrors config/types.ts SemanticRetrievalConfig shape)
// ---------------------------------------------------------------------------

interface MinimalRetrievalConfig {
  mode: "legacy" | "hybrid";
}

// ---------------------------------------------------------------------------
// Inline re-implementation of shouldFallbackToLegacy with auto-flip
// (mirrors the Stage 2 implementation in src/retrieval/fallback.ts)
// ---------------------------------------------------------------------------

/**
 * Inline mirror of shouldFallbackToLegacy for unit testing.
 *
 * Returns true (use legacy) when:
 *  - mode is "legacy"
 *  - mode is "hybrid" but FTS is unavailable
 *
 * Returns false (use hybrid) when:
 *  - mode is "hybrid" and FTS is available
 *
 * Note: auto-flip from legacy to hybrid is now handled by
 * isHybridRetrievalAvailable() separately, not by shouldFallbackToLegacy.
 */
function shouldFallbackToLegacy(
  caps: RetrievalCapabilities,
  config: MinimalRetrievalConfig,
): boolean {
  // Explicit legacy mode -- always fall back.
  if (config.mode === "legacy") {
    return true;
  }

  // Hybrid mode requested but FTS is unavailable.
  if (!caps.fts) {
    return true;
  }

  // Hybrid mode with at least FTS available -- proceed with hybrid.
  return false;
}

/**
 * Inline mirror of isHybridRetrievalAvailable decision logic.
 * The real function calls loadConfig(), getExtensionCapabilities(), and
 * checkRetrievalHealth() internally.  We test the decision tree directly.
 */
function isHybridRetrievalAvailableLogic(opts: {
  semanticEnabled: boolean;
  retrievalMode?: "legacy" | "hybrid";
  extensionCaps: { fts: boolean; vector: boolean };
  health: RetrievalCapabilities;
}): boolean {
  if (!opts.semanticEnabled) return false;

  // Explicit hybrid mode -- just check basic FTS capability.
  if (opts.retrievalMode === "hybrid") {
    return opts.extensionCaps.fts;
  }

  // Legacy mode (default) -- auto-promote when infrastructure is healthy.
  return opts.health.fts && (opts.health.vectorJinaCode || opts.health.vectorNomic);
}

function makeCaps(
  overrides: Partial<RetrievalCapabilities> = {},
): RetrievalCapabilities {
  return { fts: true, vectorJinaCode: true, vectorNomic: true, ...overrides };
}

// ---------------------------------------------------------------------------
// isHybridRetrievalAvailable — logic tests
// ---------------------------------------------------------------------------

describe("isHybridRetrievalAvailable — logic", () => {
  it("returns true when FTS + vector healthy (auto-flip from legacy)", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "legacy",
      extensionCaps: { fts: true, vector: true },
      health: { fts: true, vectorJinaCode: true, vectorNomic: false },
    });
    assert.strictEqual(result, true);
  });

  it("returns false when semantic disabled", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: false,
      retrievalMode: "legacy",
      extensionCaps: { fts: true, vector: true },
      health: { fts: true, vectorJinaCode: true, vectorNomic: false },
    });
    assert.strictEqual(result, false);
  });

  it("returns false when no vector indexes available", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "legacy",
      extensionCaps: { fts: true, vector: false },
      health: { fts: true, vectorJinaCode: false, vectorNomic: false },
    });
    assert.strictEqual(result, false);
  });

  it("returns true for explicit hybrid mode with FTS", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "hybrid",
      extensionCaps: { fts: true, vector: true },
      health: { fts: false, vectorJinaCode: false, vectorNomic: false },
    });
    assert.strictEqual(result, true);
  });

  it("returns false for explicit hybrid mode without FTS", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "hybrid",
      extensionCaps: { fts: false, vector: true },
      health: { fts: true, vectorJinaCode: true, vectorNomic: true },
    });
    assert.strictEqual(result, false);
  });

  it("returns true when only vectorNomic is available (legacy auto-promote)", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "legacy",
      extensionCaps: { fts: true, vector: true },
      health: { fts: true, vectorJinaCode: false, vectorNomic: true },
    });
    assert.strictEqual(result, true);
  });

  it("returns false when FTS healthy but no vector models (legacy mode)", () => {
    const result = isHybridRetrievalAvailableLogic({
      semanticEnabled: true,
      retrievalMode: "legacy",
      extensionCaps: { fts: true, vector: true },
      health: { fts: true, vectorJinaCode: false, vectorNomic: false },
    });
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// shouldFallbackToLegacy — auto-flip tests (Stage 2 addition)
// ---------------------------------------------------------------------------

describe("shouldFallbackToLegacy — no auto-flip (Stage 2)", () => {
  it("returns true when mode is legacy (no auto-flip in shouldFallbackToLegacy)", () => {
    const caps = makeCaps({ fts: true, vectorJinaCode: true });
    const config: MinimalRetrievalConfig = { mode: "legacy" };
    assert.strictEqual(shouldFallbackToLegacy(caps, config), true);
  });

  it("returns true when mode is legacy, regardless of full capabilities", () => {
    const caps = makeCaps({ fts: true, vectorJinaCode: true, vectorNomic: true });
    const config: MinimalRetrievalConfig = { mode: "legacy" };
    assert.strictEqual(shouldFallbackToLegacy(caps, config), true);
  });

  it("returns false when mode is hybrid and FTS is available", () => {
    const caps = makeCaps({ fts: true });
    const config: MinimalRetrievalConfig = { mode: "hybrid" };
    assert.strictEqual(shouldFallbackToLegacy(caps, config), false);
  });

  it("returns true when mode is hybrid but FTS is unavailable", () => {
    const caps = makeCaps({ fts: false });
    const config: MinimalRetrievalConfig = { mode: "hybrid" };
    assert.strictEqual(shouldFallbackToLegacy(caps, config), true);
  });
});

// ---------------------------------------------------------------------------
// Source-text verification — shouldFallbackToLegacy auto-flip
// ---------------------------------------------------------------------------

describe("shouldFallbackToLegacy — source verification (Stage 2)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/retrieval/fallback.ts"),
    "utf8",
  );

  it("shouldFallbackToLegacy takes caps and config parameters", () => {
    assert.ok(
      src.includes("caps: RetrievalCapabilities"),
      "shouldFallbackToLegacy should accept a caps parameter",
    );
    assert.ok(
      src.includes("config: SemanticRetrievalConfig"),
      "shouldFallbackToLegacy should accept a config parameter",
    );
  });

  it("shouldFallbackToLegacy checks mode and fts", () => {
    assert.ok(
      src.includes('config.mode === "legacy"'),
      "should check for legacy mode",
    );
    assert.ok(
      src.includes("!caps.fts"),
      "should check FTS availability",
    );
  });

  it("isHybridRetrievalAvailable is exported", () => {
    assert.ok(
      src.includes("export async function isHybridRetrievalAvailable"),
      "isHybridRetrievalAvailable should be an exported async function",
    );
  });

  it("isHybridRetrievalAvailable checks semantic.enabled", () => {
    assert.ok(
      src.includes("semanticConfig?.enabled"),
      "should check semantic enabled flag",
    );
  });

  it("isHybridRetrievalAvailable checks explicit hybrid mode caps", () => {
    assert.ok(
      src.includes('retrievalConfig?.mode === "hybrid"'),
      "should check for explicit hybrid mode",
    );
    assert.ok(
      src.includes("caps.fts"),
      "should check FTS capability for explicit hybrid mode",
    );
  });

  it("isHybridRetrievalAvailable auto-promotes from legacy when healthy", () => {
    assert.ok(
      src.includes("health.fts && (health.vectorNomic || health.vectorJinaCode)"),
      "should auto-promote from legacy when FTS + vector healthy",
    );
  });

  it("isHybridRetrievalAvailable catches exceptions and returns false", () => {
    assert.ok(
      src.includes("catch"),
      "should have try/catch",
    );
    assert.ok(
      src.includes("return false"),
      "should return false on exception",
    );
  });
});

// ---------------------------------------------------------------------------
// Source-text verification — start-node-resolver hybrid integration
// ---------------------------------------------------------------------------

describe("start-node-resolver — hybrid retrieval integration (Stage 2)", () => {
  const src = readFileSync(
    join(process.cwd(), "src/graph/slice/start-node-resolver.ts"),
    "utf8",
  );

  it("imports hybrid retrieval types", () => {
    assert.ok(
      src.includes("HybridSearchResultItem") || src.includes("hybridSearch"),
      "should reference hybrid search types or functions",
    );
  });

  it("imports or references isHybridRetrievalAvailable or shouldFallbackToLegacy", () => {
    const hasHybridCheck =
      src.includes("isHybridRetrievalAvailable") ||
      src.includes("shouldFallbackToLegacy") ||
      src.includes("hybridSearch");
    assert.ok(
      hasHybridCheck,
      "should reference hybrid retrieval availability check or hybrid search",
    );
  });

  it("references retrieval evidence in start node resolution", () => {
    const hasEvidence =
      src.includes("retrievalEvidence") ||
      src.includes("RetrievalEvidence") ||
      src.includes("evidence");
    assert.ok(
      hasEvidence,
      "should reference retrieval evidence gathering",
    );
  });
});
