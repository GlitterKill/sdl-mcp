import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CardDetailLevel,
  normalizeCardDetailLevel,
  legacyDetailLevelToWire,
  cardDetailLevelOrder,
  CARD_DETAIL_LEVEL_RANK,
  CARD_DETAIL_LEVELS,
  isLegacyDetailLevel,
} from "../../src/mcp/types.js";
import {
  toMinimalCard,
  toSignatureCard,
  toDepsCard,
  toCompactCard,
  toFullCard,
  toCardAtDetailLevel,
  selectAdaptiveDetailLevel,
  estimateTokens,
} from "../../src/graph/slice/slice-serializer.js";
import type { SymbolCard } from "../../src/mcp/types.js";

const FULL_CARD: SymbolCard = {
  symbolId: "sym-test-1",
  repoId: "repo-1",
  file: "src/example.ts",
  range: { startLine: 10, startCol: 0, endLine: 50, endCol: 1 },
  kind: "function",
  name: "processData",
  exported: true,
  visibility: "public",
  signature: {
    name: "processData",
    params: [{ name: "input", type: "string" }],
    returns: "Promise<void>",
    generics: ["T"],
  },
  summary:
    "Processes the input data and returns a promise that resolves when complete. This is a longer summary that should be truncated for lighter detail levels.",
  invariants: ["input must be non-empty", "output is always valid"],
  sideEffects: ["writes to disk", "sends network request"],
  deps: {
    imports: ["sym-import-1", "sym-import-2", "sym-import-3"],
    calls: ["sym-call-1", "sym-call-2", "sym-call-3"],
  },
  metrics: {
    fanIn: 15,
    fanOut: 8,
    churn30d: 12,
    testRefs: ["test-1", "test-2"],
  },
  detailLevel: "full",
  version: {
    ledgerVersion: "v1",
    astFingerprint: "abc123def456",
  },
};

describe("card detail levels - type definitions", () => {
  it("defines all expected detail levels", () => {
    assert.deepStrictEqual(CARD_DETAIL_LEVELS, [
      "minimal",
      "signature",
      "deps",
      "compact",
      "full",
    ]);
  });

  it("provides correct rank ordering for detail levels", () => {
    assert.strictEqual(CARD_DETAIL_LEVEL_RANK.minimal, 0);
    assert.strictEqual(CARD_DETAIL_LEVEL_RANK.signature, 1);
    assert.strictEqual(CARD_DETAIL_LEVEL_RANK.deps, 2);
    assert.strictEqual(CARD_DETAIL_LEVEL_RANK.compact, 3);
    assert.strictEqual(CARD_DETAIL_LEVEL_RANK.full, 4);
  });

  it("cardDetailLevelOrder returns correct rank", () => {
    assert.strictEqual(cardDetailLevelOrder("minimal"), 0);
    assert.strictEqual(cardDetailLevelOrder("signature"), 1);
    assert.strictEqual(cardDetailLevelOrder("deps"), 2);
    assert.strictEqual(cardDetailLevelOrder("compact"), 3);
    assert.strictEqual(cardDetailLevelOrder("full"), 4);
  });

  it("isLegacyDetailLevel identifies compact and full", () => {
    assert.strictEqual(isLegacyDetailLevel("compact"), true);
    assert.strictEqual(isLegacyDetailLevel("full"), true);
    assert.strictEqual(isLegacyDetailLevel("minimal"), false);
    assert.strictEqual(isLegacyDetailLevel("signature"), false);
    assert.strictEqual(isLegacyDetailLevel("deps"), false);
  });
});

describe("card detail levels - normalization", () => {
  it("normalizeCardDetailLevel returns deps for undefined", () => {
    assert.strictEqual(normalizeCardDetailLevel(undefined), "deps");
  });

  it("normalizeCardDetailLevel maps compact to deps for compatibility", () => {
    assert.strictEqual(normalizeCardDetailLevel("compact"), "deps");
  });

  it("normalizeCardDetailLevel returns full unchanged", () => {
    assert.strictEqual(normalizeCardDetailLevel("full"), "full");
  });

  it("normalizeCardDetailLevel returns minimal unchanged", () => {
    assert.strictEqual(normalizeCardDetailLevel("minimal"), "minimal");
  });

  it("normalizeCardDetailLevel returns signature unchanged", () => {
    assert.strictEqual(normalizeCardDetailLevel("signature"), "signature");
  });

  it("normalizeCardDetailLevel returns deps unchanged", () => {
    assert.strictEqual(normalizeCardDetailLevel("deps"), "deps");
  });

  it("legacyDetailLevelToWire returns compact for undefined", () => {
    assert.strictEqual(legacyDetailLevelToWire(undefined), "compact");
  });

  it("legacyDetailLevelToWire preserves original level for wire format", () => {
    assert.strictEqual(legacyDetailLevelToWire("compact"), "compact");
    assert.strictEqual(legacyDetailLevelToWire("full"), "full");
    assert.strictEqual(legacyDetailLevelToWire("minimal"), "minimal");
  });
});

describe("card detail levels - minimal card", () => {
  it("contains only minimal fields", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.symbolId, FULL_CARD.symbolId);
    assert.strictEqual(card.file, FULL_CARD.file);
    assert.deepStrictEqual(card.range, FULL_CARD.range);
    assert.strictEqual(card.kind, FULL_CARD.kind);
    assert.strictEqual(card.name, FULL_CARD.name);
    assert.strictEqual(card.exported, FULL_CARD.exported);
    assert.strictEqual(card.detailLevel, "minimal");
  });

  it("omits signature in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.signature, undefined);
  });

  it("omits summary in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.summary, undefined);
  });

  it("has empty deps in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.deepStrictEqual(card.deps.imports, []);
    assert.deepStrictEqual(card.deps.calls, []);
  });

  it("omits invariants in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.invariants, undefined);
  });

  it("omits sideEffects in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.sideEffects, undefined);
  });

  it("omits metrics in minimal card", () => {
    const card = toMinimalCard(FULL_CARD);
    assert.strictEqual(card.metrics, undefined);
  });
});

describe("card detail levels - signature card", () => {
  it("contains minimal fields plus signature and summary", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.strictEqual(card.symbolId, FULL_CARD.symbolId);
    assert.strictEqual(card.file, FULL_CARD.file);
    assert.strictEqual(card.name, FULL_CARD.name);
    assert.strictEqual(card.detailLevel, "signature");
    assert.ok(card.signature, "signature should be present");
    assert.ok(card.summary, "summary should be present");
  });

  it("includes signature in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.deepStrictEqual(card.signature, FULL_CARD.signature);
  });

  it("includes truncated summary in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.ok(card.summary);
    assert.ok(
      card.summary.length <= 90,
      `summary should be truncated to 90 chars, got ${card.summary.length}`,
    );
  });

  it("includes visibility in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.strictEqual(card.visibility, FULL_CARD.visibility);
  });

  it("has empty deps in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.deepStrictEqual(card.deps.imports, []);
    assert.deepStrictEqual(card.deps.calls, []);
  });

  it("omits invariants in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.strictEqual(card.invariants, undefined);
  });

  it("omits sideEffects in signature card", () => {
    const card = toSignatureCard(FULL_CARD);
    assert.strictEqual(card.sideEffects, undefined);
  });
});

describe("card detail levels - deps card", () => {
  it("contains signature fields plus deps", () => {
    const card = toDepsCard(FULL_CARD);
    assert.strictEqual(card.symbolId, FULL_CARD.symbolId);
    assert.strictEqual(card.name, FULL_CARD.name);
    assert.strictEqual(card.detailLevel, "deps");
    assert.ok(card.signature, "signature should be present");
    assert.ok(card.summary, "summary should be present");
    assert.ok(card.deps.imports.length > 0, "imports should be present");
    assert.ok(card.deps.calls.length > 0, "calls should be present");
  });

  it("includes signature in deps card", () => {
    const card = toDepsCard(FULL_CARD);
    assert.deepStrictEqual(card.signature, FULL_CARD.signature);
  });

  it("includes truncated summary in deps card", () => {
    const card = toDepsCard(FULL_CARD);
    assert.ok(card.summary);
    assert.ok(
      card.summary.length <= 90,
      `summary should be truncated to 90 chars, got ${card.summary.length}`,
    );
  });

  it("includes deps in deps card (limited to 6 each)", () => {
    const card = toDepsCard(FULL_CARD);
    assert.ok(card.deps.imports.length <= 6);
    assert.ok(card.deps.calls.length <= 6);
  });

  it("omits invariants in deps card", () => {
    const card = toDepsCard(FULL_CARD);
    assert.strictEqual(card.invariants, undefined);
  });

  it("omits sideEffects in deps card", () => {
    const card = toDepsCard(FULL_CARD);
    assert.strictEqual(card.sideEffects, undefined);
  });

  it("omits metrics in deps card", () => {
    const card = toDepsCard(FULL_CARD);
    assert.strictEqual(card.metrics, undefined);
  });
});

describe("card detail levels - compact card (backward compatibility)", () => {
  it("has same content as deps card but marked as compact", () => {
    const compactCard = toCompactCard(FULL_CARD);
    const depsCard = toDepsCard(FULL_CARD);

    assert.strictEqual(compactCard.detailLevel, "compact");
    assert.strictEqual(depsCard.detailLevel, "deps");

    assert.deepStrictEqual(compactCard.signature, depsCard.signature);
    assert.strictEqual(compactCard.summary, depsCard.summary);
    assert.deepStrictEqual(compactCard.deps, depsCard.deps);
  });

  it("includes signature for backward compatibility with deps behavior", () => {
    const card = toCompactCard(FULL_CARD);
    assert.ok(
      card.signature,
      "compact should include signature (deps behavior)",
    );
  });

  it("includes deps for backward compatibility", () => {
    const card = toCompactCard(FULL_CARD);
    assert.ok(card.deps.imports.length > 0, "imports should be present");
    assert.ok(card.deps.calls.length > 0, "calls should be present");
  });
});

describe("card detail levels - full card", () => {
  it("contains all fields from original card", () => {
    const card = toFullCard(FULL_CARD);
    assert.strictEqual(card.symbolId, FULL_CARD.symbolId);
    assert.strictEqual(card.repoId, FULL_CARD.repoId);
    assert.strictEqual(card.file, FULL_CARD.file);
    assert.deepStrictEqual(card.range, FULL_CARD.range);
    assert.strictEqual(card.kind, FULL_CARD.kind);
    assert.strictEqual(card.name, FULL_CARD.name);
    assert.strictEqual(card.exported, FULL_CARD.exported);
    assert.strictEqual(card.detailLevel, "full");
  });

  it("includes full signature", () => {
    const card = toFullCard(FULL_CARD);
    assert.deepStrictEqual(card.signature, FULL_CARD.signature);
  });

  it("includes full summary (not truncated)", () => {
    const card = toFullCard(FULL_CARD);
    assert.strictEqual(card.summary, FULL_CARD.summary);
  });

  it("includes invariants", () => {
    const card = toFullCard(FULL_CARD);
    assert.deepStrictEqual(card.invariants, FULL_CARD.invariants);
  });

  it("includes sideEffects", () => {
    const card = toFullCard(FULL_CARD);
    assert.deepStrictEqual(card.sideEffects, FULL_CARD.sideEffects);
  });

  it("includes metrics", () => {
    const card = toFullCard(FULL_CARD);
    assert.deepStrictEqual(card.metrics, FULL_CARD.metrics);
  });

  it("includes full deps (up to 24 each)", () => {
    const card = toFullCard(FULL_CARD);
    assert.deepStrictEqual(card.deps, FULL_CARD.deps);
  });

  it("removes etag from full card", () => {
    const cardWithEtag = { ...FULL_CARD, etag: "test-etag" };
    const card = toFullCard(cardWithEtag);
    assert.strictEqual(card.etag, undefined);
  });
});

describe("card detail levels - toCardAtDetailLevel", () => {
  it("returns minimal card for minimal level", () => {
    const card = toCardAtDetailLevel(FULL_CARD, "minimal");
    assert.strictEqual(card.detailLevel, "minimal");
    assert.strictEqual(card.signature, undefined);
    assert.strictEqual(card.summary, undefined);
  });

  it("returns signature card for signature level", () => {
    const card = toCardAtDetailLevel(FULL_CARD, "signature");
    assert.strictEqual(card.detailLevel, "signature");
    assert.ok(card.signature);
    assert.strictEqual(card.deps.imports.length, 0);
  });

  it("returns deps card for deps level", () => {
    const card = toCardAtDetailLevel(FULL_CARD, "deps");
    assert.strictEqual(card.detailLevel, "deps");
    assert.ok(card.signature);
    assert.ok(card.deps.imports.length > 0);
  });

  it("returns compact card for compact level", () => {
    const card = toCardAtDetailLevel(FULL_CARD, "compact");
    assert.strictEqual(card.detailLevel, "compact");
  });

  it("returns full card for full level", () => {
    const card = toCardAtDetailLevel(FULL_CARD, "full");
    assert.strictEqual(card.detailLevel, "full");
    assert.ok(card.invariants);
    assert.ok(card.sideEffects);
    assert.ok(card.metrics);
  });
});

describe("card detail levels - adaptive selection", () => {
  it("selects minimal when tokens per card < 30", () => {
    const level = selectAdaptiveDetailLevel(250, 10, "full");
    assert.strictEqual(level, "minimal");
  });

  it("selects signature when tokens per card >= 30 and < 50", () => {
    const level = selectAdaptiveDetailLevel(400, 10, "full");
    assert.strictEqual(level, "signature");
  });

  it("selects deps when tokens per card >= 50 and < 80", () => {
    const level = selectAdaptiveDetailLevel(600, 10, "full");
    assert.strictEqual(level, "deps");
  });

  it("selects compact when tokens per card >= 80 and < 120", () => {
    const level = selectAdaptiveDetailLevel(1000, 10, "full");
    assert.strictEqual(level, "compact");
  });

  it("selects requested level when tokens per card >= 120", () => {
    const level = selectAdaptiveDetailLevel(1500, 10, "full");
    assert.strictEqual(level, "full");
  });

  it("does not upgrade level above requested", () => {
    const level = selectAdaptiveDetailLevel(5000, 10, "minimal");
    assert.strictEqual(level, "minimal");
  });

  it("does not upgrade level above requested (signature)", () => {
    const level = selectAdaptiveDetailLevel(5000, 10, "signature");
    assert.strictEqual(level, "signature");
  });

  it("respects requested level order when budget allows", () => {
    const levelMinimal = selectAdaptiveDetailLevel(1000, 10, "minimal");
    const levelSignature = selectAdaptiveDetailLevel(1000, 10, "signature");
    const levelDeps = selectAdaptiveDetailLevel(1000, 10, "deps");

    assert.strictEqual(levelMinimal, "minimal");
    assert.strictEqual(levelSignature, "signature");
    assert.strictEqual(levelDeps, "deps");
  });

  it("handles zero card count gracefully", () => {
    const level = selectAdaptiveDetailLevel(1000, 0, "full");
    assert.strictEqual(level, "full");
  });
});

describe("card detail levels - token estimation", () => {
  it("minimal cards use fewer tokens than full cards", () => {
    const minimalCard = toMinimalCard(FULL_CARD);
    const fullCard = toFullCard(FULL_CARD);

    const minimalTokens = estimateTokens([minimalCard]);
    const fullTokens = estimateTokens([fullCard]);

    assert.ok(
      minimalTokens < fullTokens,
      `minimal (${minimalTokens}) should use fewer tokens than full (${fullTokens})`,
    );
  });

  it("signature cards use fewer tokens than deps cards", () => {
    const signatureCard = toSignatureCard(FULL_CARD);
    const depsCard = toDepsCard(FULL_CARD);

    const signatureTokens = estimateTokens([signatureCard]);
    const depsTokens = estimateTokens([depsCard]);

    assert.ok(
      signatureTokens <= depsTokens,
      `signature (${signatureTokens}) should use fewer or equal tokens than deps (${depsTokens})`,
    );
  });

  it("deps cards use fewer tokens than full cards", () => {
    const depsCard = toDepsCard(FULL_CARD);
    const fullCard = toFullCard(FULL_CARD);

    const depsTokens = estimateTokens([depsCard]);
    const fullTokens = estimateTokens([fullCard]);

    assert.ok(
      depsTokens < fullTokens,
      `deps (${depsTokens}) should use fewer tokens than full (${fullTokens})`,
    );
  });

  it("token savings progression from minimal to full", () => {
    const minimal = toMinimalCard(FULL_CARD);
    const signature = toSignatureCard(FULL_CARD);
    const deps = toDepsCard(FULL_CARD);
    const full = toFullCard(FULL_CARD);

    const tokensMinimal = estimateTokens([minimal]);
    const tokensSignature = estimateTokens([signature]);
    const tokensDeps = estimateTokens([deps]);
    const tokensFull = estimateTokens([full]);

    assert.ok(
      tokensMinimal <= tokensSignature,
      `minimal (${tokensMinimal}) <= signature (${tokensSignature})`,
    );
    assert.ok(
      tokensSignature <= tokensDeps,
      `signature (${tokensSignature}) <= deps (${tokensDeps})`,
    );
    assert.ok(
      tokensDeps <= tokensFull,
      `deps (${tokensDeps}) <= full (${tokensFull})`,
    );
  });
});

describe("card detail levels - backward compatibility", () => {
  it("compact request maps to deps behavior internally", () => {
    const effectiveLevel = normalizeCardDetailLevel("compact");
    assert.strictEqual(effectiveLevel, "deps");
  });

  it("compact wire format preserves compact label", () => {
    const wireLevel = legacyDetailLevelToWire("compact");
    assert.strictEqual(wireLevel, "compact");
  });

  it("undefined request defaults to deps internally", () => {
    const effectiveLevel = normalizeCardDetailLevel(undefined);
    assert.strictEqual(effectiveLevel, "deps");
  });

  it("undefined request shows compact in wire format", () => {
    const wireLevel = legacyDetailLevelToWire(undefined);
    assert.strictEqual(wireLevel, "compact");
  });

  it("full request is unchanged", () => {
    const effectiveLevel = normalizeCardDetailLevel("full");
    const wireLevel = legacyDetailLevelToWire("full");
    assert.strictEqual(effectiveLevel, "full");
    assert.strictEqual(wireLevel, "full");
  });
});
