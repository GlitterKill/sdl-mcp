import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyPprBoost, PPR_BOOST_CAP } from "../../../dist/retrieval/ppr.js";
import type { HybridSearchResultItem } from "../../../dist/retrieval/types.js";

/**
 * applyPprBoost composition + cap behaviour.
 *
 * Run: node --import tsx --test tests/unit/retrieval/applyPprBoost.test.ts
 */

function items(rows: Array<[string, number]>): HybridSearchResultItem[] {
  return rows.map(([symbolId, score]) => ({
    symbolId,
    score,
    source: "fts",
  }));
}

describe("applyPprBoost", () => {
  it("reorders by combined score and caps multiplier at PPR_BOOST_CAP per call", () => {
    const fused = items([
      ["a", 1.0],
      ["b", 0.9],
      ["c", 0.8],
      ["d", 0.5],
      ["e", 0.4],
    ]);
    const ppr = new Map([
      ["d", 1.0],
      ["e", 0.5],
    ]);

    const { items: out, symbolsBoosted } = applyPprBoost(fused, ppr, {
      pprWeight: 2.0, // would yield 1+2*1=3 but cap is 2
    });

    assert.equal(out.length, fused.length);
    assert.ok(symbolsBoosted >= 2, "d and e should be marked boosted");

    const finalForD = out.find((r) => r.symbolId === "d")!;
    // raw multiplier 1+2*1=3, capped at PPR_BOOST_CAP, so final ≤ 0.5 * cap
    assert.ok(
      finalForD.score <= 0.5 * PPR_BOOST_CAP + 1e-9,
      `d boosted past per-call cap: ${finalForD.score}`,
    );

    // d (boosted by full PPR) should now sort ahead of c (unboosted, 0.8)
    const positions = new Map(out.map((r, i) => [r.symbolId, i] as const));
    assert.ok(
      positions.get("d")! < positions.get("c")!,
      "d should outrank c after boost",
    );
  });

  it("is identity passthrough when ppr map is empty", () => {
    const fused = items([
      ["a", 1.0],
      ["b", 0.5],
    ]);
    const { items: out, symbolsBoosted } = applyPprBoost(fused, new Map(), {
      pprWeight: 1.0,
    });
    assert.equal(symbolsBoosted, 0);
    assert.deepEqual(
      out.map((r) => r.symbolId),
      ["a", "b"],
    );
  });

  it("is identity passthrough when pprWeight is 0", () => {
    const fused = items([
      ["a", 1.0],
      ["b", 0.5],
    ]);
    const ppr = new Map([["b", 1.0]]);
    const { items: out, symbolsBoosted } = applyPprBoost(fused, ppr, {
      pprWeight: 0,
    });
    assert.equal(symbolsBoosted, 0);
    assert.equal(out[0].symbolId, "a");
  });

  it("enforces combinedCap × originalScore when supplied", () => {
    const fused = items([["a", 1.0]]);
    const ppr = new Map([["a", 1.0]]);
    const originals = new Map([["a", 1.0]]);
    const { items: out } = applyPprBoost(fused, ppr, {
      pprWeight: 2.0,
      combinedCap: 1.5,
      originalScores: originals,
    });
    // Per-call cap 2.0 would normally allow 2.0 final score; combinedCap clamps to 1.5.
    assert.ok(
      out[0].score <= 1.5 + 1e-9,
      `combined cap not enforced: ${out[0].score}`,
    );
  });

  it("preserves item identity for non-boosted entries", () => {
    const fused = items([
      ["a", 1.0],
      ["b", 0.5],
    ]);
    const ppr = new Map([["a", 0.5]]);
    const { items: out } = applyPprBoost(fused, ppr, { pprWeight: 0.5 });
    const b = out.find((r) => r.symbolId === "b")!;
    assert.equal(b.score, 0.5, "b should be unchanged");
    assert.equal(b.source, "fts");
  });
});
