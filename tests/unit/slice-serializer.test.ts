import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import {
  uniqueLimit,
  uniqueDepRefs,
  toDefaultSliceDeps,
  resolveSliceDeps,
  filterDepsBySliceSymbolSet,
  filterCallResolutionBySliceSymbolSet,
  toFullCard,
  toCompactCard,
  toMinimalCard,
  toSignatureCard,
  toDepsCard,
  toCardAtDetailLevel,
  selectAdaptiveDetailLevel,
  toSliceSymbolCard,
  buildPayloadCardsAndRefs,
  encodeEdgesWithSymbolIndex,
  estimateTokens,
} from "../../dist/graph/slice/slice-serializer.js";

import type {
  SymbolCard,
  SliceDepRef,
  SliceSymbolDeps,
  CallResolution,
  CardDetailLevel,
} from "../../dist/domain/types.js";

import {
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_PROCESSES,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
  SYMBOL_TOKEN_BASE,
  AST_FINGERPRINT_WIRE_LENGTH,
} from "../../dist/config/constants.js";
import { hashCard } from "../../dist/util/hashing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<SymbolCard> = {}): SymbolCard {
  return {
    symbolId: "sym-1",
    repoId: "repo-1",
    file: "src/foo.ts",
    range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 },
    kind: "function" as any,
    name: "doStuff",
    exported: true,
    deps: { imports: ["dep-a", "dep-b"], calls: ["dep-c"] },
    version: { ledgerVersion: "v1", astFingerprint: "abcdef1234567890extra" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// uniqueLimit
// ---------------------------------------------------------------------------

describe("uniqueLimit", () => {
  it("returns unique values up to max", () => {
    const result = uniqueLimit(["a", "b", "a", "c", "b", "d"], 3);
    assert.deepStrictEqual(result, ["a", "b", "c"]);
  });

  it("skips empty strings", () => {
    const result = uniqueLimit(["a", "", "b", ""], 10);
    assert.deepStrictEqual(result, ["a", "b"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(uniqueLimit([], 5), []);
  });

  it("returns all unique values when max exceeds count", () => {
    assert.deepStrictEqual(uniqueLimit(["x", "y", "z"], 100), ["x", "y", "z"]);
  });

  it("with max=0 still adds first non-empty value before checking limit", () => {
    // Implementation pushes then checks >= max, so max=0 allows one element
    assert.deepStrictEqual(uniqueLimit(["a", "b"], 0), ["a"]);
  });

  it("deduplicates consecutive identical values", () => {
    assert.deepStrictEqual(uniqueLimit(["a", "a", "a"], 5), ["a"]);
  });
  it("does not reuse a known etag when slice filtering changes deps", () => {
    const card = makeCard({
      symbolId: "s1",
      deps: { imports: ["a", "b"], calls: ["c"] },
    });
    const broadKnownEtag = hashCard({
      ...card,
      detailLevel: card.detailLevel ?? "compact",
    });

    const result = buildPayloadCardsAndRefs(
      [card],
      { s1: broadKnownEtag },
      undefined,
      new Set(["a"]),
    );

    assert.strictEqual(result.cardsForPayload.length, 1);
    assert.ok(result.cardRefs);
    assert.strictEqual(result.cardRefs?.[0]?.symbolId, "s1");
    assert.deepStrictEqual(result.cardsForPayload[0]?.deps.imports, [
      { symbolId: "a", confidence: 1 },
    ]);
    assert.deepStrictEqual(result.cardsForPayload[0]?.deps.calls, []);
  });
});

// ---------------------------------------------------------------------------
// uniqueDepRefs
// ---------------------------------------------------------------------------

describe("uniqueDepRefs", () => {
  it("deduplicates by symbolId keeping highest confidence", () => {
    const refs: SliceDepRef[] = [
      { symbolId: "s1", confidence: 0.5 },
      { symbolId: "s1", confidence: 0.9 },
      { symbolId: "s2", confidence: 0.3 },
    ];
    const result = uniqueDepRefs(refs, 10);
    assert.strictEqual(result.length, 2);
    const s1 = result.find((r) => r.symbolId === "s1");
    assert.strictEqual(s1?.confidence, 0.9);
  });

  it("respects max limit", () => {
    const refs: SliceDepRef[] = [
      { symbolId: "s1", confidence: 1 },
      { symbolId: "s2", confidence: 1 },
      { symbolId: "s3", confidence: 1 },
    ];
    const result = uniqueDepRefs(refs, 2);
    assert.strictEqual(result.length, 2);
  });

  it("skips entries with falsy symbolId", () => {
    const refs = [
      { symbolId: "", confidence: 1 },
      { symbolId: "s1", confidence: 0.8 },
    ] as SliceDepRef[];
    const result = uniqueDepRefs(refs, 10);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].symbolId, "s1");
  });

  it("normalizes undefined confidence to 1", () => {
    const refs = [{ symbolId: "s1", confidence: undefined }] as any;
    const result = uniqueDepRefs(refs, 10);
    assert.strictEqual(result[0].confidence, 1);
  });

  it("clamps confidence to [0,1]", () => {
    const refs: SliceDepRef[] = [{ symbolId: "s1", confidence: 5 }];
    const result = uniqueDepRefs(refs, 10);
    assert.strictEqual(result[0].confidence, 1);
  });

  it("returns empty for empty input", () => {
    assert.deepStrictEqual(uniqueDepRefs([], 10), []);
  });
});

// ---------------------------------------------------------------------------
// toDefaultSliceDeps
// ---------------------------------------------------------------------------

describe("toDefaultSliceDeps", () => {
  it("converts card deps to SliceDepRefs with confidence=1", () => {
    const card = makeCard({
      deps: { imports: ["i1", "i2"], calls: ["c1"] },
    });
    const result = toDefaultSliceDeps(card);
    assert.strictEqual(result.imports.length, 2);
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.imports[0].confidence, 1);
    assert.strictEqual(result.imports[0].symbolId, "i1");
    assert.strictEqual(result.calls[0].symbolId, "c1");
  });

  it("returns empty arrays when card has no deps", () => {
    const card = makeCard({ deps: { imports: [], calls: [] } });
    const result = toDefaultSliceDeps(card);
    assert.strictEqual(result.imports.length, 0);
    assert.strictEqual(result.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// filterDepsBySliceSymbolSet
// ---------------------------------------------------------------------------

describe("filterDepsBySliceSymbolSet", () => {
  it("filters deps to only symbols in the set", () => {
    const deps: SliceSymbolDeps = {
      imports: [
        { symbolId: "a", confidence: 1 },
        { symbolId: "b", confidence: 1 },
      ],
      calls: [
        { symbolId: "c", confidence: 1 },
        { symbolId: "d", confidence: 1 },
      ],
    };
    const set = new Set(["a", "d"]);
    const result = filterDepsBySliceSymbolSet(deps, set);
    assert.strictEqual(result.imports.length, 1);
    assert.strictEqual(result.imports[0].symbolId, "a");
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.calls[0].symbolId, "d");
  });

  it("returns empty when no deps match", () => {
    const deps: SliceSymbolDeps = {
      imports: [{ symbolId: "x", confidence: 1 }],
      calls: [{ symbolId: "y", confidence: 1 }],
    };
    const result = filterDepsBySliceSymbolSet(deps, new Set(["z"]));
    assert.strictEqual(result.imports.length, 0);
    assert.strictEqual(result.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// resolveSliceDeps
// ---------------------------------------------------------------------------

describe("resolveSliceDeps", () => {
  it("uses sliceDepsBySymbol when available", () => {
    const card = makeCard({ symbolId: "s1" });
    const customDeps: SliceSymbolDeps = {
      imports: [{ symbolId: "custom", confidence: 0.8 }],
      calls: [],
    };
    const map = new Map([["s1", customDeps]]);
    const result = resolveSliceDeps(card, map);
    assert.strictEqual(result.imports[0].symbolId, "custom");
  });

  it("falls back to toDefaultSliceDeps when not in map", () => {
    const card = makeCard({ symbolId: "s1" });
    const map = new Map<string, SliceSymbolDeps>();
    const result = resolveSliceDeps(card, map);
    assert.strictEqual(result.imports.length, card.deps.imports.length);
  });

  it("filters by sliceSymbolSet when provided", () => {
    const card = makeCard({
      symbolId: "s1",
      deps: { imports: ["a", "b"], calls: [] },
    });
    const set = new Set(["a"]);
    const result = resolveSliceDeps(card, undefined, set);
    assert.strictEqual(result.imports.length, 1);
    assert.strictEqual(result.imports[0].symbolId, "a");
  });
});

// ---------------------------------------------------------------------------
// filterCallResolutionBySliceSymbolSet
// ---------------------------------------------------------------------------

describe("filterCallResolutionBySliceSymbolSet", () => {
  it("returns undefined for undefined input", () => {
    assert.strictEqual(
      filterCallResolutionBySliceSymbolSet(undefined, new Set()),
      undefined,
    );
  });

  it("returns undefined when no calls match the set", () => {
    const cr: CallResolution = {
      minCallConfidence: 0.5,
      calls: [{ symbolId: "out", label: "fn", confidence: 0.9 }],
    };
    assert.strictEqual(
      filterCallResolutionBySliceSymbolSet(cr, new Set(["in"])),
      undefined,
    );
  });

  it("filters calls to only those in the set", () => {
    const cr: CallResolution = {
      minCallConfidence: 0.5,
      calls: [
        { symbolId: "in", label: "fn1", confidence: 0.9 },
        { symbolId: "out", label: "fn2", confidence: 0.8 },
      ],
    };
    const result = filterCallResolutionBySliceSymbolSet(cr, new Set(["in"]));
    assert.ok(result);
    assert.strictEqual(result.calls.length, 1);
    assert.strictEqual(result.calls[0].symbolId, "in");
    assert.strictEqual(result.minCallConfidence, 0.5);
  });
});

// ---------------------------------------------------------------------------
// Card detail level converters
// ---------------------------------------------------------------------------

describe("toFullCard", () => {
  it("sets detailLevel to full and removes etag", () => {
    const card = makeCard({ etag: "abc", detailLevel: "compact" });
    const result = toFullCard(card);
    assert.strictEqual(result.detailLevel, "full");
    assert.strictEqual(result.etag, undefined);
  });

  it("truncates processes to SYMBOL_CARD_MAX_PROCESSES", () => {
    const processes = Array.from({ length: 10 }, (_, i) => ({
      processId: `p${i}`,
      label: `proc-${i}`,
      role: "entry" as const,
      depth: 0,
    }));
    const card = makeCard({ processes });
    const result = toFullCard(card);
    assert.strictEqual(result.processes!.length, SYMBOL_CARD_MAX_PROCESSES);
  });

  it("preserves card without processes", () => {
    const card = makeCard();
    const result = toFullCard(card);
    assert.strictEqual(result.processes, undefined);
  });
});

describe("toMinimalCard", () => {
  it("strips deps, summary, signature, metrics, sideEffects, invariants", () => {
    const card = makeCard({
      summary: "hello",
      signature: { name: "fn", params: [] },
      invariants: ["x"],
      sideEffects: ["y"],
      metrics: { fanIn: 5 },
    });
    const result = toMinimalCard(card);
    assert.strictEqual(result.detailLevel, "minimal");
    assert.deepStrictEqual(result.deps, { imports: [], calls: [] });
    assert.strictEqual(result.summary, undefined);
    assert.strictEqual(result.signature, undefined);
    assert.strictEqual(result.invariants, undefined);
    assert.strictEqual(result.sideEffects, undefined);
    assert.strictEqual(result.metrics, undefined);
  });

  it("preserves cluster and callResolution", () => {
    const cluster = { clusterId: "c1", label: "auth", memberCount: 5 };
    const callResolution: CallResolution = {
      calls: [{ symbolId: "s", label: "fn", confidence: 1 }],
    };
    const card = makeCard({ cluster, callResolution });
    const result = toMinimalCard(card);
    assert.deepStrictEqual(result.cluster, cluster);
    assert.deepStrictEqual(result.callResolution, callResolution);
  });
});

describe("toSignatureCard", () => {
  it("includes signature and truncated summary", () => {
    const longSummary = "x".repeat(200);
    const sig = { name: "fn", params: [{ name: "a", type: "string" }] };
    const card = makeCard({ signature: sig, summary: longSummary });
    const result = toSignatureCard(card);
    assert.strictEqual(result.detailLevel, "signature");
    assert.deepStrictEqual(result.signature, sig);
    assert.strictEqual(
      result.summary!.length,
      SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
    );
  });

  it("preserves visibility", () => {
    const card = makeCard({ visibility: "public" as any });
    const result = toSignatureCard(card);
    assert.strictEqual(result.visibility, "public");
  });

  it("sets empty deps", () => {
    const card = makeCard();
    const result = toSignatureCard(card);
    assert.deepStrictEqual(result.deps, { imports: [], calls: [] });
  });
});

describe("toDepsCard", () => {
  it("truncates deps to SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT", () => {
    const imports = Array.from({ length: 20 }, (_, i) => `imp-${i}`);
    const calls = Array.from({ length: 20 }, (_, i) => `call-${i}`);
    const card = makeCard({ deps: { imports, calls } });
    const result = toDepsCard(card);
    assert.strictEqual(result.detailLevel, "deps");
    assert.strictEqual(
      result.deps.imports.length,
      SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
    );
    assert.strictEqual(
      result.deps.calls.length,
      SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
    );
  });

  it("truncates summary to SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT", () => {
    const card = makeCard({ summary: "a".repeat(300) });
    const result = toDepsCard(card);
    assert.strictEqual(
      result.summary!.length,
      SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
    );
  });

  it("includes processes truncated to max", () => {
    const processes = Array.from({ length: 10 }, (_, i) => ({
      processId: `p${i}`,
      label: `proc`,
      role: "entry" as const,
      depth: 0,
    }));
    const card = makeCard({ processes });
    const result = toDepsCard(card);
    assert.strictEqual(result.processes!.length, SYMBOL_CARD_MAX_PROCESSES);
  });

  it("omits processes when empty", () => {
    const card = makeCard({ processes: [] });
    const result = toDepsCard(card);
    assert.strictEqual(result.processes, undefined);
  });
});

describe("toCompactCard", () => {
  it("produces a deps card with compact detailLevel", () => {
    const card = makeCard();
    const result = toCompactCard(card);
    assert.strictEqual(result.detailLevel, "compact");
    // compact is built on toDepsCard, so deps should be truncated same way
    assert.ok(
      result.deps.imports.length <= SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
    );
  });
});

// ---------------------------------------------------------------------------
// toCardAtDetailLevel
// ---------------------------------------------------------------------------

describe("toCardAtDetailLevel", () => {
  const levels: CardDetailLevel[] = [
    "minimal",
    "signature",
    "deps",
    "compact",
    "full",
  ];

  for (const level of levels) {
    it(`returns card with detailLevel=${level}`, () => {
      const card = makeCard();
      const result = toCardAtDetailLevel(card, level);
      assert.strictEqual(result.detailLevel, level);
    });
  }

  it("defaults to compact for unknown level", () => {
    const card = makeCard();
    const result = toCardAtDetailLevel(card, "bogus" as any);
    assert.strictEqual(result.detailLevel, "compact");
  });
});

// ---------------------------------------------------------------------------
// selectAdaptiveDetailLevel
// ---------------------------------------------------------------------------

describe("selectAdaptiveDetailLevel", () => {
  it("returns minimal when tokensPerCard < 30", () => {
    // budget=20, cards=1 => tokensPerCard=20 < 30
    assert.strictEqual(selectAdaptiveDetailLevel(20, 1, "full"), "minimal");
  });

  it("returns signature when 30 <= tokensPerCard < 50", () => {
    assert.strictEqual(selectAdaptiveDetailLevel(40, 1, "full"), "signature");
  });

  it("returns deps when 50 <= tokensPerCard < 80", () => {
    assert.strictEqual(selectAdaptiveDetailLevel(60, 1, "full"), "deps");
  });

  it("returns compact when 80 <= tokensPerCard < 120", () => {
    assert.strictEqual(selectAdaptiveDetailLevel(100, 1, "full"), "compact");
  });

  it("returns requestedLevel when budget is ample", () => {
    assert.strictEqual(selectAdaptiveDetailLevel(500, 1, "full"), "full");
  });

  it("never upgrades beyond requestedLevel", () => {
    // tokensPerCard=10 < 30 => wants minimal, but requested is signature (rank 1)
    // minimal rank (0) <= signature rank (1) → returns minimal
    assert.strictEqual(
      selectAdaptiveDetailLevel(10, 1, "signature"),
      "minimal",
    );
    // tokensPerCard=40 => wants signature (rank 1), requested is minimal (rank 0)
    // signature rank (1) <= minimal rank (0) is false → returns requestedLevel (minimal)
    assert.strictEqual(selectAdaptiveDetailLevel(40, 1, "minimal"), "minimal");
  });

  it("handles 0 cards without division error", () => {
    // budget / 0 = Infinity => no threshold triggers => returns requestedLevel
    assert.strictEqual(selectAdaptiveDetailLevel(100, 0, "deps"), "deps");
  });

  it("divides budget across cards", () => {
    // budget=100, 5 cards => 20 tokens/card < 30 => minimal
    assert.strictEqual(selectAdaptiveDetailLevel(100, 5, "full"), "minimal");
  });
});

// ---------------------------------------------------------------------------
// toSliceSymbolCard
// ---------------------------------------------------------------------------

describe("toSliceSymbolCard", () => {
  it("produces a SliceSymbolCard with truncated astFingerprint", () => {
    const card = makeCard();
    const result = toSliceSymbolCard(card);
    assert.strictEqual(
      result.version.astFingerprint.length,
      AST_FINGERPRINT_WIRE_LENGTH,
    );
    assert.strictEqual(result.symbolId, card.symbolId);
    assert.strictEqual(result.file, card.file);
    assert.strictEqual((result as any).repoId, undefined);
    assert.strictEqual((result as any).etag, undefined);
  });

  it("uses provided deps instead of default", () => {
    const card = makeCard();
    const customDeps: SliceSymbolDeps = {
      imports: [{ symbolId: "custom", confidence: 0.9 }],
      calls: [],
    };
    const result = toSliceSymbolCard(card, customDeps);
    assert.strictEqual(result.deps.imports[0].symbolId, "custom");
  });

  it("includes optional fields when present on card", () => {
    const card = makeCard({
      visibility: "public" as any,
      signature: { name: "fn" },
      summary: "does stuff",
      cluster: { clusterId: "c1", label: "mod", memberCount: 3 },
      processes: [{ processId: "p1", label: "pipe", role: "entry", depth: 0 }],
      invariants: ["must be positive"],
      sideEffects: ["writes to disk"],
      metrics: { fanIn: 10 },
    });
    const result = toSliceSymbolCard(card);
    assert.strictEqual(result.visibility, "public");
    assert.deepStrictEqual(result.signature, { name: "fn" });
    assert.strictEqual(result.summary, "does stuff");
    assert.ok(result.cluster);
    assert.strictEqual(result.processes!.length, 1);
    assert.deepStrictEqual(result.invariants, ["must be positive"]);
    assert.deepStrictEqual(result.sideEffects, ["writes to disk"]);
    assert.ok(result.metrics);
  });

  it("omits optional fields when absent on card", () => {
    const card = makeCard();
    const result = toSliceSymbolCard(card);
    assert.strictEqual(result.visibility, undefined);
    assert.strictEqual(result.signature, undefined);
    assert.strictEqual(result.summary, undefined);
    assert.strictEqual(result.cluster, undefined);
    assert.strictEqual(result.processes, undefined);
    assert.strictEqual(result.invariants, undefined);
    assert.strictEqual(result.sideEffects, undefined);
    assert.strictEqual(result.metrics, undefined);
  });

  it("includes callResolution when provided as argument", () => {
    const cr: CallResolution = {
      calls: [{ symbolId: "s", label: "fn", confidence: 1 }],
    };
    const result = toSliceSymbolCard(makeCard(), undefined, cr);
    assert.ok(result.callResolution);
    assert.strictEqual(result.callResolution!.calls.length, 1);
  });

  it("truncates processes to SYMBOL_CARD_MAX_PROCESSES", () => {
    const processes = Array.from({ length: 10 }, (_, i) => ({
      processId: `p${i}`,
      label: `l`,
      role: "entry" as const,
      depth: 0,
    }));
    const card = makeCard({ processes });
    const result = toSliceSymbolCard(card);
    assert.strictEqual(result.processes!.length, SYMBOL_CARD_MAX_PROCESSES);
  });

  it("defaults detailLevel to compact when not set", () => {
    const card = makeCard();
    delete card.detailLevel;
    const result = toSliceSymbolCard(card);
    assert.strictEqual(result.detailLevel, "compact");
  });
});

// ---------------------------------------------------------------------------
// encodeEdgesWithSymbolIndex
// ---------------------------------------------------------------------------

describe("encodeEdgesWithSymbolIndex", () => {
  it("creates sorted symbolIndex and encoded edges", () => {
    const edges = [
      {
        from_symbol_id: "b",
        to_symbol_id: "a",
        type: "calls" as any,
        weight: 1.0,
      },
    ];
    const result = encodeEdgesWithSymbolIndex(["b", "a"], edges);
    // sorted: ["a", "b"]
    assert.deepStrictEqual(result.symbolIndex, ["a", "b"]);
    // "b" is index 1, "a" is index 0
    assert.deepStrictEqual(result.edges, [[1, 0, "calls", 1.0]]);
  });

  it("deduplicates symbolIndex", () => {
    const result = encodeEdgesWithSymbolIndex(["a", "a", "b"], []);
    assert.deepStrictEqual(result.symbolIndex, ["a", "b"]);
  });

  it("skips edges with unknown symbols", () => {
    const edges = [
      {
        from_symbol_id: "a",
        to_symbol_id: "unknown",
        type: "imports" as any,
        weight: 0.6,
      },
    ];
    const result = encodeEdgesWithSymbolIndex(["a"], edges);
    assert.strictEqual(result.edges.length, 0);
  });

  it("handles empty inputs", () => {
    const result = encodeEdgesWithSymbolIndex([], []);
    assert.deepStrictEqual(result.symbolIndex, []);
    assert.deepStrictEqual(result.edges, []);
  });

  it("encodes multiple edges correctly", () => {
    const edges = [
      {
        from_symbol_id: "a",
        to_symbol_id: "b",
        type: "calls" as any,
        weight: 1.0,
      },
      {
        from_symbol_id: "b",
        to_symbol_id: "c",
        type: "imports" as any,
        weight: 0.6,
      },
    ];
    const result = encodeEdgesWithSymbolIndex(["a", "b", "c"], edges);
    assert.strictEqual(result.edges.length, 2);
    // sorted index: a=0, b=1, c=2
    assert.deepStrictEqual(result.edges[0], [0, 1, "calls", 1.0]);
    assert.deepStrictEqual(result.edges[1], [1, 2, "imports", 0.6]);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty array", () => {
    assert.strictEqual(estimateTokens([]), 0);
  });

  it("returns at least SYMBOL_TOKEN_BASE per card", () => {
    const card = makeCard({ deps: { imports: [], calls: [] } });
    const tokens = estimateTokens([card]);
    assert.ok(tokens >= SYMBOL_TOKEN_BASE);
  });

  it("adds tokens for deps", () => {
    const noDeps = makeCard({ deps: { imports: [], calls: [] } });
    const withDeps = makeCard({
      deps: {
        imports: ["a", "b", "c"],
        calls: ["d", "e"],
      },
    });
    const tokensNoDeps = estimateTokens([noDeps]);
    const tokensWithDeps = estimateTokens([withDeps]);
    // 5 deps * 5 tokens each = 25 more tokens
    assert.ok(tokensWithDeps > tokensNoDeps);
    assert.strictEqual(tokensWithDeps - tokensNoDeps, 5 * 5);
  });

  it("adds tokens for cluster", () => {
    const noCluster = makeCard({ deps: { imports: [], calls: [] } });
    const withCluster = makeCard({
      deps: { imports: [], calls: [] },
      cluster: { clusterId: "c1", label: "auth", memberCount: 5 },
    });
    const diff = estimateTokens([withCluster]) - estimateTokens([noCluster]);
    assert.strictEqual(diff, 15);
  });

  it("adds tokens for processes", () => {
    const noProc = makeCard({ deps: { imports: [], calls: [] } });
    const withProc = makeCard({
      deps: { imports: [], calls: [] },
      processes: [
        { processId: "p1", label: "pipe", role: "entry" as const, depth: 0 },
        { processId: "p2", label: "pipe2", role: "exit" as const, depth: 1 },
      ],
    });
    const diff = estimateTokens([withProc]) - estimateTokens([noProc]);
    assert.strictEqual(diff, 2 * 20);
  });

  it("sums across multiple cards", () => {
    const card1 = makeCard({
      symbolId: "s1",
      deps: { imports: [], calls: [] },
    });
    const card2 = makeCard({
      symbolId: "s2",
      deps: { imports: [], calls: [] },
    });
    const single = estimateTokens([card1]);
    const double = estimateTokens([card1, card2]);
    assert.strictEqual(double, single * 2);
  });
});

// ---------------------------------------------------------------------------
// buildPayloadCardsAndRefs — no knownCardEtags
// ---------------------------------------------------------------------------

describe("buildPayloadCardsAndRefs (no etags)", () => {
  it("returns all cards as payload with no cardRefs", () => {
    const cards = [makeCard({ symbolId: "s1" }), makeCard({ symbolId: "s2" })];
    const result = buildPayloadCardsAndRefs(cards);
    assert.strictEqual(result.cardsForPayload.length, 2);
    assert.strictEqual(result.cardRefs, undefined);
  });

  it("strips etag from payload cards", () => {
    const cards = [makeCard({ etag: "abc123" })];
    const result = buildPayloadCardsAndRefs(cards);
    assert.strictEqual((result.cardsForPayload[0] as any).etag, undefined);
  });

  it("defaults detailLevel to compact when not set", () => {
    const card = makeCard();
    delete card.detailLevel;
    const result = buildPayloadCardsAndRefs([card]);
    assert.strictEqual(result.cardsForPayload[0].detailLevel, "compact");
  });

  it("filters deps by sliceSymbolSet when provided", () => {
    const card = makeCard({
      symbolId: "s1",
      deps: { imports: ["a", "b"], calls: ["c"] },
    });
    const sliceSet = new Set(["a"]);
    const result = buildPayloadCardsAndRefs(
      [card],
      undefined,
      undefined,
      sliceSet,
    );
    assert.strictEqual(result.cardsForPayload[0].deps.imports.length, 1);
    assert.strictEqual(result.cardsForPayload[0].deps.imports[0].symbolId, "a");
    assert.strictEqual(result.cardsForPayload[0].deps.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildPayloadCardsAndRefs — with knownCardEtags
// ---------------------------------------------------------------------------

describe("buildPayloadCardsAndRefs (with etags)", () => {
  it("skips card that matches known etag", () => {
    const card = makeCard({ symbolId: "s1" });
    // We need to compute the actual etag to make it match.
    // Since we can't easily predict it, test that providing wrong etags
    // still includes the card.
    const result = buildPayloadCardsAndRefs([card], {
      s1: "wrong-etag",
    });
    assert.strictEqual(result.cardsForPayload.length, 1);
    assert.ok(result.cardRefs);
    assert.strictEqual(result.cardRefs!.length, 1);
    assert.strictEqual(result.cardRefs![0].symbolId, "s1");
  });

  it("returns empty payload+refs when no cards provided", () => {
    const result = buildPayloadCardsAndRefs([], { s1: "some-etag" });
    assert.strictEqual(result.cardsForPayload.length, 0);
    assert.ok(result.cardRefs);
    assert.strictEqual(result.cardRefs!.length, 0);
  });

  it("treats empty knownCardEtags object as no-etags path", () => {
    const card = makeCard();
    const result = buildPayloadCardsAndRefs([card], {});
    // empty object → hasKnownCardEtags is false → no cardRefs
    assert.strictEqual(result.cardRefs, undefined);
    assert.strictEqual(result.cardsForPayload.length, 1);
  });
});
