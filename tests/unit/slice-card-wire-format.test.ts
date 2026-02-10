import { describe, it } from "node:test";
import assert from "node:assert";
import { hashCard } from "../../src/util/hashing.js";
import {
  buildPayloadCardsAndRefs,
  toSliceSymbolCard,
} from "../../src/graph/slice.js";

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

  it("preserves full-card etag semantics for cardRefs", () => {
    const knownEtag = hashCard(fullCard);
    const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs([fullCard], {
      [fullCard.symbolId]: knownEtag,
    });

    assert.strictEqual(cardsForPayload.length, 0);
    assert.ok(cardRefs, "expected cardRefs to be present");
    assert.strictEqual(cardRefs?.length, 1);
    assert.strictEqual(cardRefs?.[0].symbolId, fullCard.symbolId);
    assert.strictEqual(cardRefs?.[0].etag, knownEtag);
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
});
