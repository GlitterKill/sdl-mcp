import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGraphLabels,
  deriveSearchTerms,
  evaluateSummaryFreshness,
  fallbackLabel,
  normalizeAndCap,
  parseJsonArray,
  parseUnresolvedTarget,
  prepareSymbolEmbeddingInputs,
} from "../../dist/indexer/symbol-embedding-context.js";
import type { GraphLabel } from "../../dist/indexer/symbol-embedding-context.js";
import { hashContent } from "../../dist/util/hashing.js";

describe("parseUnresolvedTarget", () => {
  it("parses unresolved call targets", () => {
    assert.deepEqual(parseUnresolvedTarget("unresolved:call:doThing"), {
      kind: "call",
      label: "doThing",
    });
  });

  it("parses unresolved named imports", () => {
    assert.deepEqual(parseUnresolvedTarget("unresolved:lodash:debounce"), {
      kind: "import",
      label: "debounce (from lodash)",
    });
  });

  it("parses unresolved namespace imports", () => {
    assert.deepEqual(parseUnresolvedTarget("unresolved:node:path:* as path"), {
      kind: "import",
      label: "path (* from node:path)",
    });
  });

  it("returns null for non-unresolved targets", () => {
    assert.equal(parseUnresolvedTarget("abc123"), null);
  });

  it("returns null for malformed unresolved strings", () => {
    assert.equal(parseUnresolvedTarget("unresolved:"), null);
    assert.equal(parseUnresolvedTarget("unresolved:nocolon"), null);
    assert.equal(parseUnresolvedTarget("unresolved:call:"), null);
    assert.equal(parseUnresolvedTarget("unresolved:foo:"), null);
  });
});

describe("parseJsonArray", () => {
  it("returns [] for null/undefined/empty", () => {
    assert.deepEqual(parseJsonArray(null), []);
    assert.deepEqual(parseJsonArray(undefined), []);
    assert.deepEqual(parseJsonArray(""), []);
  });

  it("returns [] for malformed JSON", () => {
    assert.deepEqual(parseJsonArray("{not json"), []);
    assert.deepEqual(parseJsonArray('"scalar"'), []);
    assert.deepEqual(parseJsonArray("42"), []);
    assert.deepEqual(parseJsonArray("null"), []);
  });

  it("filters non-string elements and trims strings", () => {
    assert.deepEqual(
      parseJsonArray('["  read fs ", 42, null, "writes db", ""]'),
      ["read fs", "writes db"],
    );
  });
});

describe("deriveSearchTerms", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(deriveSearchTerms(null), []);
    assert.deepEqual(deriveSearchTerms(""), []);
  });

  it("splits on whitespace, lowercases, dedupes, caps at 16", () => {
    const terms = deriveSearchTerms(
      "Foo Bar foo bar BAZ one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
    );
    assert.ok(terms.length <= 16);
    assert.equal(terms[0], "foo");
    assert.equal(terms[1], "bar");
    assert.equal(terms[2], "baz");
    assert.equal(new Set(terms).size, terms.length);
  });

  it("drops overly long terms", () => {
    const long = "x".repeat(100);
    const terms = deriveSearchTerms(`short ${long} alsoshort`);
    assert.deepEqual(terms, ["short", "alsoshort"]);
  });
});

describe("fallbackLabel", () => {
  it("returns trailing path segment", () => {
    assert.equal(fallbackLabel("some/deep/path/thing"), "thing");
  });

  it("preserves dotted names (only splits on /)", () => {
    assert.equal(fallbackLabel("some.dotted.name"), "some.dotted.name");
    assert.equal(fallbackLabel("path/to/some.dotted.name"), "some.dotted.name");
  });

  it("truncates to 64 chars", () => {
    const raw = "x".repeat(200);
    assert.equal(fallbackLabel(raw).length, 64);
  });

  it("returns empty on empty input", () => {
    assert.equal(fallbackLabel("   "), "");
  });
});

describe("normalizeAndCap", () => {
  const base: GraphLabel[] = [
    { label: "Alpha", confidence: 0.9, resolved: true },
    { label: "alpha", confidence: 0.5, resolved: true },
    { label: "Beta", confidence: 0.8, resolved: true },
    { label: "zeta", confidence: 0.95, resolved: false },
  ];

  it("dedupes case-insensitively keeping highest confidence", () => {
    const out = normalizeAndCap(base, 10, "alpha");
    const alphas = out.filter((l) => l.label.toLowerCase() === "alpha");
    assert.equal(alphas.length, 1);
    assert.equal(alphas[0].confidence, 0.9);
  });

  it("sorts alphabetically when sortMode=alpha", () => {
    const out = normalizeAndCap(base, 10, "alpha");
    assert.deepEqual(
      out.map((l) => l.label),
      ["Alpha", "Beta", "zeta"],
    );
  });

  it("sorts by confidence desc then label asc when sortMode=confidenceThenAlpha", () => {
    const candidates: GraphLabel[] = [
      { label: "b", confidence: 0.8, resolved: true },
      { label: "a", confidence: 0.8, resolved: true },
      { label: "c", confidence: 0.9, resolved: true },
    ];
    const out = normalizeAndCap(candidates, 10, "confidenceThenAlpha");
    assert.deepEqual(
      out.map((l) => l.label),
      ["c", "a", "b"],
    );
  });

  it("caps results", () => {
    const many: GraphLabel[] = Array.from({ length: 20 }, (_, i) => ({
      label: `label${i.toString().padStart(2, "0")}`,
      confidence: 1 - i * 0.01,
      resolved: true,
    }));
    const out = normalizeAndCap(many, 5, "alpha");
    assert.equal(out.length, 5);
  });
});

describe("evaluateSummaryFreshness", () => {
  const symbol = {
    symbolId: "s1",
    name: "doThing",
    kind: "function",
    astFingerprint: "abc",
    signatureJson: '{"text":"(x: number) => number"}',
  } as unknown as Parameters<typeof evaluateSummaryFreshness>[0];

  const freshHash = hashContent(
    [
      "doThing",
      "function",
      "(x: number) => number",
      "abc",
      "anthropic",
      "claude-sonnet-4-6",
    ].join("|"),
  );

  it("returns absent when no cached summary", () => {
    assert.deepEqual(
      evaluateSummaryFreshness(symbol, "(x: number) => number", undefined),
      { freshness: "absent", summaryText: null },
    );
  });

  it("returns absent when cached provider is mock", () => {
    const cached = {
      symbolId: "s1",
      summary: "old",
      provider: "mock",
      model: "mock",
      cardHash: "whatever",
      costUsd: 0,
      createdAt: "",
      updatedAt: "",
    };
    assert.deepEqual(
      evaluateSummaryFreshness(symbol, "(x: number) => number", cached),
      { freshness: "absent", summaryText: null },
    );
  });

  it("returns fresh when cardHash matches current symbol state", () => {
    const cached = {
      symbolId: "s1",
      summary: "returns x doubled",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cardHash: freshHash,
      costUsd: 0.001,
      createdAt: "",
      updatedAt: "",
    };
    assert.deepEqual(
      evaluateSummaryFreshness(symbol, "(x: number) => number", cached),
      { freshness: "fresh", summaryText: "returns x doubled" },
    );
  });

  it("returns stale when cardHash disagrees with current symbol state", () => {
    const cached = {
      symbolId: "s1",
      summary: "outdated",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cardHash: "stalehash",
      costUsd: 0.001,
      createdAt: "",
      updatedAt: "",
    };
    assert.deepEqual(
      evaluateSummaryFreshness(symbol, "(x: number) => number", cached),
      { freshness: "stale", summaryText: null },
    );
  });
});

describe("buildGraphLabels", () => {
  const resolved = new Map<
    string,
    { symbolId: string; name: string; kind: string; fileId?: string }
  >([
    [
      "sym-logger",
      { symbolId: "sym-logger", name: "logger", kind: "function" },
    ],
    ["sym-Cache", { symbolId: "sym-Cache", name: "Cache", kind: "class" }],
  ]);

  const mkEdge = (
    toSymbolId: string,
    edgeType: string,
    confidence: number,
  ): Parameters<typeof buildGraphLabels>[0][number] => ({
    repoId: "r",
    fromSymbolId: "src",
    toSymbolId,
    edgeType,
    weight: 1,
    confidence,
    resolution: "heuristic",
    provenance: null,
    createdAt: "",
  });

  it("separates imports from calls and caps each bucket", () => {
    const edges = [
      mkEdge("sym-logger", "call", 0.9),
      mkEdge("sym-Cache", "import", 0.8),
      mkEdge("unresolved:call:helper", "call", 0.7),
      mkEdge("unresolved:lodash:debounce", "import", 0.6),
    ];
    const out = buildGraphLabels(edges, resolved);
    assert.equal(out.imports.length, 2);
    assert.equal(out.calls.length, 2);
    assert.ok(
      out.imports.some((l) => l.label === "Cache (class)"),
      "resolved import label",
    );
    assert.ok(
      out.imports.some((l) => l.label === "debounce (from lodash)"),
      "unresolved import label",
    );
    assert.ok(
      out.calls.some((l) => l.label === "logger (function)"),
      "resolved call label",
    );
    assert.ok(
      out.calls.some((l) => l.label === "helper"),
      "unresolved call label",
    );
  });

  it("drops edges to unknown resolved targets", () => {
    const edges = [mkEdge("sym-ghost", "call", 0.9)];
    const out = buildGraphLabels(edges, resolved);
    assert.equal(out.calls.length, 0);
    assert.equal(out.imports.length, 0);
  });

  it("sorts calls by confidence desc", () => {
    const edges = [
      mkEdge("unresolved:call:a", "call", 0.5),
      mkEdge("unresolved:call:b", "call", 0.9),
      mkEdge("unresolved:call:c", "call", 0.7),
    ];
    const out = buildGraphLabels(edges, resolved);
    assert.deepEqual(
      out.calls.map((l) => l.label),
      ["b", "c", "a"],
    );
  });

  it("sorts imports alphabetically", () => {
    const edges = [
      mkEdge("unresolved:mod:zeta", "import", 0.9),
      mkEdge("unresolved:mod:alpha", "import", 0.5),
      mkEdge("unresolved:mod:beta", "import", 0.8),
    ];
    const out = buildGraphLabels(edges, resolved);
    assert.deepEqual(
      out.imports.map((l) => l.label),
      ["alpha (from mod)", "beta (from mod)", "zeta (from mod)"],
    );
  });

  it("uses fallback label when unresolved prefix does not match known format", () => {
    const edges = [mkEdge("unresolved:weirdformat", "call", 0.5)];
    const out = buildGraphLabels(edges, resolved);
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].resolved, false);
  });
});

describe("buildGraphLabels - import confidence filter", () => {
  const resolved = new Map<
    string,
    { symbolId: string; name: string; kind: string; fileId?: string }
  >();

  const mkEdge = (
    toSymbolId: string,
    edgeType: string,
    confidence: number,
  ): Parameters<typeof buildGraphLabels>[0][number] => ({
    repoId: "r",
    fromSymbolId: "src",
    toSymbolId,
    edgeType,
    weight: 1,
    confidence,
    resolution: "heuristic",
    provenance: null,
    createdAt: "",
  });

  it("filters out low-confidence import edges", () => {
    const edges = [
      mkEdge("unresolved:mod:high", "import", 0.9),
      mkEdge("unresolved:mod:low", "import", 0.3), // below MIN_IMPORT_CONFIDENCE
      mkEdge("unresolved:mod:boundary", "import", 0.5), // exactly at threshold
    ];
    const out = buildGraphLabels(edges, resolved);
    // Should include high (0.9) and boundary (0.5), exclude low (0.3)
    assert.equal(out.imports.length, 2);
    const labels = out.imports.map((l) => l.label);
    assert.ok(labels.includes("high (from mod)"));
    assert.ok(labels.includes("boundary (from mod)"));
    assert.ok(!labels.includes("low (from mod)"));
  });
});

describe("prepareSymbolEmbeddingInputs", () => {
  it("returns empty array for empty input (smoke test)", async () => {
    // prepareSymbolEmbeddingInputs expects a Connection, but with empty symbols
    // it should return early without querying the DB
    const result = await prepareSymbolEmbeddingInputs(
      null as unknown as import("kuzu").Connection, // not used for empty input
      [],
    );
    assert.deepEqual(result, []);
  });
});
