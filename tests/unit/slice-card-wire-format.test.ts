import { describe, it } from "node:test";
import assert from "node:assert";
import { hashCard } from "../../src/util/hashing.js";
import {
  buildPayloadCardsAndRefs,
  toSliceSymbolCard,
} from "../../src/graph/slice.js";
import { toCompactGraphSliceV2 } from "../../src/mcp/tools/slice.js";

describe("slice card wire format", () => {
  const fullCard = {
    symbolId: "sym-1",
    repoId: "repo-1",
    file: "src/example.ts",
    range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
    kind: "function",
    name: "example",
    exported: true,
    deps: { imports: ["depA"], calls: ["depB"] },
    detailLevel: "compact",
    version: {
      ledgerVersion: "v1",
      astFingerprint: "fp-1",
    },
  } as const;

  it("omits repoId and version.ledgerVersion in slice cards", () => {
    const sliceCard = toSliceSymbolCard(fullCard);

    assert.ok(!("repoId" in sliceCard), "slice card should not include repoId");
    assert.ok(
      !("ledgerVersion" in sliceCard.version),
      "slice card version should not include ledgerVersion",
    );
    assert.strictEqual(sliceCard.version.astFingerprint, "fp-1");
    assert.strictEqual(sliceCard.symbolId, fullCard.symbolId);
    assert.strictEqual(sliceCard.file, fullCard.file);
    assert.ok(
      !("signature" in sliceCard),
      "slice card should omit undefined signature",
    );
    assert.ok(
      !("summary" in sliceCard),
      "slice card should omit undefined summary",
    );
    assert.ok(
      !("invariants" in sliceCard),
      "slice card should omit undefined invariants",
    );
    assert.ok(
      !("sideEffects" in sliceCard),
      "slice card should omit undefined sideEffects",
    );
    assert.ok(
      !("metrics" in sliceCard),
      "slice card should omit undefined metrics",
    );
  });

  it("skips both payload and cardRefs for unchanged cards (delta-only refs)", () => {
    const knownEtag = hashCard(fullCard);
    const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs([fullCard], {
      [fullCard.symbolId]: knownEtag,
    });

    assert.strictEqual(cardsForPayload.length, 0, "unchanged card should not appear in payload");
    assert.ok(cardRefs, "expected cardRefs to be present");
    assert.strictEqual(cardRefs?.length, 0, "unchanged card should not appear in cardRefs");
  });

  it("includes changed cards in both payload and cardRefs", () => {
    const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs([fullCard], {
      [fullCard.symbolId]: "stale-etag",
    });

    assert.strictEqual(cardsForPayload.length, 1, "changed card should appear in payload");
    assert.ok(cardRefs, "expected cardRefs to be present");
    assert.strictEqual(cardRefs?.length, 1, "changed card should appear in cardRefs");
    assert.strictEqual(cardRefs?.[0].symbolId, fullCard.symbolId);
  });

  it("truncates astFingerprint to 16 chars in slice wire format", () => {
    const longFingerprint =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const cardWithLongFingerprint = {
      ...fullCard,
      version: {
        ...fullCard.version,
        astFingerprint: longFingerprint,
      },
    };

    const sliceCard = toSliceSymbolCard(cardWithLongFingerprint);
    assert.strictEqual(sliceCard.version.astFingerprint.length, 16);
    assert.strictEqual(
      sliceCard.version.astFingerprint,
      longFingerprint.slice(0, 16),
    );
  });

  it("truncates astFingerprint to 8 chars in compact v2 wire format for full detail cards", () => {
    const longFingerprint =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/example.ts",
          range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
          kind: "function",
          name: "example",
          exported: true,
          deps: { imports: ["depA"], calls: ["depB"] },
          detailLevel: "full",
          version: { astFingerprint: longFingerprint },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.ok(compact.c[0].af, "af should be present for full detail cards");
    assert.strictEqual(compact.c[0].af!.length, 8);
    assert.strictEqual(compact.c[0].af, longFingerprint.slice(0, 8));
  });

  it("omits astFingerprint in compact v2 wire format for compact detail cards", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/example.ts",
          range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
          kind: "function",
          name: "example",
          exported: true,
          deps: { imports: ["depA"], calls: ["depB"] },
          detailLevel: "compact",
          version: { astFingerprint: "0123456789abcdef" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.ok(!("af" in compact.c[0]), "af should be omitted for compact detail cards");
  });

  it("serializes slice deps with confidence metadata", () => {
    const slice = {
      repoId: "repo-1",
      versionId: "v1",
      budget: { maxCards: 10, maxEstimatedTokens: 5000 },
      startSymbols: ["sym-1"],
      symbolIndex: ["sym-1"],
      cards: [
        {
          symbolId: "sym-1",
          file: "src/example.ts",
          range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
          kind: "function",
          name: "example",
          exported: true,
          deps: {
            imports: [{ symbolId: "sym-2", confidence: 0.9 }],
            calls: [{ symbolId: "sym-3", confidence: 0.6 }],
          },
          detailLevel: "compact",
          version: { astFingerprint: "0123456789abcdef" },
        },
      ],
      edges: [] as Array<[number, number, "import" | "call" | "config", number]>,
    } as const;

    const compact = toCompactGraphSliceV2(slice as any);
    assert.deepStrictEqual(compact.c[0].d.i, [{ symbolId: "sym-2", confidence: 0.9 }]);
    assert.deepStrictEqual(compact.c[0].d.c, [{ symbolId: "sym-3", confidence: 0.6 }]);
  });
});
