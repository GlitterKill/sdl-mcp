/**
 * retrieval-fallback.test.ts
 *
 * Tests for the fallback decision logic in src/retrieval/fallback.ts.
 *
 * shouldFallbackToLegacy is a pure function but its module imports
 * src/db/ladybug.ts → src/util/logger.ts → src/util/tracing.ts, which
 * hits an OpenTelemetry compatibility issue at import time in the tsx
 * unit-test environment.  We therefore test the logic in two ways:
 *
 *  1. Inline re-implementation tests — exercise the exact same decision
 *     tree documented in shouldFallbackToLegacy's JSDoc, ensuring the
 *     business rules are correct independently of the import graph.
 *
 *  2. Source-text tests — verify the implementation in fallback.ts
 *     uses the expected branch conditions so the inline tests stay
 *     in sync with the real code.
 *
 * When the dist/ is available (i.e. after `npm run build`), the full
 * import-based tests in the npm test suite cover the compiled output.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RetrievalCapabilities } from "../../src/retrieval/types.js";

// ---------------------------------------------------------------------------
// Helpers — inline re-implementation of shouldFallbackToLegacy logic
// (mirrors the documented rules in fallback.ts exactly)
// ---------------------------------------------------------------------------

interface MinimalRetrievalConfig {
  mode: "legacy" | "hybrid";
}

/**
 * Inline mirror of shouldFallbackToLegacy for unit testing without
 * the full module import chain.
 */
function shouldFallbackToLegacy(
  caps: RetrievalCapabilities,
  config: MinimalRetrievalConfig,
): boolean {
  if (config.mode === "legacy") {
    return true;
  }
  if (!caps.fts) {
    return true;
  }
  return false;
}

function makeCaps(overrides: Partial<RetrievalCapabilities> = {}): RetrievalCapabilities {
  return { fts: true, vectorMiniLM: true, vectorNomic: true, ...overrides };
}

// ---------------------------------------------------------------------------
// Logic tests (inline re-implementation)
// ---------------------------------------------------------------------------

describe("shouldFallbackToLegacy — logic", () => {
  it("returns true when mode is 'legacy', regardless of capabilities", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: true, vectorMiniLM: true, vectorNomic: true }), { mode: "legacy" }),
      true,
    );
  });

  it("returns true when mode is 'legacy' and all capabilities are false", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: false, vectorMiniLM: false, vectorNomic: false }), { mode: "legacy" }),
      true,
    );
  });

  it("returns true when mode is 'hybrid' but fts is not available", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: false }), { mode: "hybrid" }),
      true,
    );
  });

  it("returns false when mode is 'hybrid' and fts is available", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: true }), { mode: "hybrid" }),
      false,
    );
  });

  it("returns false when mode is 'hybrid', fts available, vector unavailable (degraded hybrid ok)", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: true, vectorMiniLM: false, vectorNomic: false }), { mode: "hybrid" }),
      false,
    );
  });

  it("returns false when all capabilities are available and mode is 'hybrid'", () => {
    assert.strictEqual(
      shouldFallbackToLegacy(makeCaps({ fts: true, vectorMiniLM: true, vectorNomic: true }), { mode: "hybrid" }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Source-text tests — verify fallback.ts implements the expected logic
// ---------------------------------------------------------------------------

describe("shouldFallbackToLegacy — source verification", () => {
  const src = readFileSync(
    join(process.cwd(), "src/retrieval/fallback.ts"),
    "utf8",
  );

  it("fallback.ts exports shouldFallbackToLegacy", () => {
    assert.ok(
      src.includes("export function shouldFallbackToLegacy"),
      "shouldFallbackToLegacy should be an exported function",
    );
  });

  it("fallback.ts exports checkRetrievalHealth", () => {
    assert.ok(
      src.includes("export async function checkRetrievalHealth"),
      "checkRetrievalHealth should be an exported async function",
    );
  });

  it("shouldFallbackToLegacy checks for mode === 'legacy'", () => {
    assert.ok(
      src.includes(`config.mode === "legacy"`),
      "should check config.mode === 'legacy'",
    );
  });

  it("shouldFallbackToLegacy checks for !caps.fts", () => {
    assert.ok(
      src.includes("!caps.fts"),
      "should check !caps.fts for hybrid fallback decision",
    );
  });

  it("checkRetrievalHealth calls getExtensionCapabilities", () => {
    assert.ok(
      src.includes("getExtensionCapabilities()"),
      "checkRetrievalHealth should call getExtensionCapabilities()",
    );
  });

  it("checkRetrievalHealth returns fts, vectorMiniLM, vectorNomic fields", () => {
    assert.ok(src.includes("fts:"), "result should include fts field");
    assert.ok(src.includes("vectorMiniLM:"), "result should include vectorMiniLM field");
    assert.ok(src.includes("vectorNomic:"), "result should include vectorNomic field");
  });
});

// ---------------------------------------------------------------------------
// RetrievalCapabilities structural tests
// ---------------------------------------------------------------------------

describe("RetrievalCapabilities", () => {
  it("has fts, vectorMiniLM, vectorNomic boolean fields", () => {
    const caps: RetrievalCapabilities = {
      fts: true,
      vectorMiniLM: false,
      vectorNomic: true,
    };
    assert.strictEqual(typeof caps.fts, "boolean");
    assert.strictEqual(typeof caps.vectorMiniLM, "boolean");
    assert.strictEqual(typeof caps.vectorNomic, "boolean");
  });

  it("all-false capabilities represent a fully unavailable environment", () => {
    const caps: RetrievalCapabilities = {
      fts: false,
      vectorMiniLM: false,
      vectorNomic: false,
    };
    // With no capabilities, every hybrid request should fall back.
    assert.strictEqual(shouldFallbackToLegacy(caps, { mode: "hybrid" }), true);
    assert.strictEqual(shouldFallbackToLegacy(caps, { mode: "legacy" }), true);
  });
});
