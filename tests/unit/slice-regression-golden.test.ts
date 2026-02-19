/**
 * Golden Parity Tests for Slice Module Refactoring
 *
 * These tests verify that the refactored slice modules produce
 * identical outputs to the original behavior for fixed fixtures.
 *
 * @module tests/unit/slice-regression-golden
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  encodeEdgesWithSymbolIndex,
  buildPayloadCardsAndRefs,
  toSliceSymbolCard,
  filterDepsBySliceSymbolSet,
  estimateTokens,
} from "../../src/graph/slice.js";
import {
  encodeEdgesWithSymbolIndex as encodeEdgesFromSerializer,
  buildPayloadCardsAndRefs as buildPayloadFromSerializer,
  toSliceSymbolCard as toSliceFromSerializer,
  filterDepsBySliceSymbolSet as filterDepsFromSerializer,
  estimateTokens as estimateTokensFromSerializer,
} from "../../src/graph/slice/slice-serializer.js";
import {
  resolveStartNodes,
  collectTaskTextSeedTokens,
  getTaskTextTokenRank,
  computeStartNodeLimits,
  commonPrefixLength,
  START_NODE_SOURCE_PRIORITY,
  START_NODE_SOURCE_SCORE,
} from "../../src/graph/slice/start-node-resolver.js";
import {
  normalizeEdgeConfidence,
  applyEdgeConfidenceWeight,
  getAdaptiveMinConfidence,
  computeMinCardsForDynamicCap,
  shouldTightenDynamicCardCap,
  compareFrontierItems,
} from "../../src/graph/slice/beam-search-engine.js";
import { hashCard } from "../../src/util/hashing.js";
import type { SymbolCard, SliceSymbolDeps } from "../../src/mcp/types.js";

describe("Golden parity: slice.ts exports match slice-serializer.ts", () => {
  const baseCard: SymbolCard = {
    symbolId: "sym-parity-1",
    repoId: "repo-1",
    file: "src/parity.ts",
    range: { startLine: 1, startCol: 0, endLine: 20, endCol: 1 },
    kind: "function",
    name: "parityFunction",
    exported: true,
    deps: { imports: ["dep1", "dep2"], calls: ["call1"] },
    detailLevel: "compact",
    version: {
      ledgerVersion: "v1",
      astFingerprint: "0123456789abcdef0123456789abcdef",
    },
  };

  it("produces identical encodeEdgesWithSymbolIndex output", () => {
    const symbolIds = ["sym-b", "sym-a", "sym-c"];
    const dbEdges = [
      {
        from_symbol_id: "sym-a",
        to_symbol_id: "sym-c",
        type: "call" as const,
        weight: 1,
      },
      {
        from_symbol_id: "sym-b",
        to_symbol_id: "sym-a",
        type: "import" as const,
        weight: 0.6,
      },
    ];

    const fromMain = encodeEdgesWithSymbolIndex(symbolIds as any, dbEdges);
    const fromSerializer = encodeEdgesFromSerializer(symbolIds as any, dbEdges);

    assert.deepStrictEqual(fromMain, fromSerializer);
  });

  it("produces identical buildPayloadCardsAndRefs output", () => {
    const fromMain = buildPayloadCardsAndRefs([baseCard]);
    const fromSerializer = buildPayloadFromSerializer([baseCard]);

    assert.deepStrictEqual(
      fromMain.cardsForPayload,
      fromSerializer.cardsForPayload,
    );
    assert.deepStrictEqual(fromMain.cardRefs, fromSerializer.cardRefs);
  });

  it("produces identical toSliceSymbolCard output", () => {
    const fromMain = toSliceSymbolCard(baseCard);
    const fromSerializer = toSliceFromSerializer(baseCard);

    assert.deepStrictEqual(fromMain, fromSerializer);
  });

  it("produces identical filterDepsBySliceSymbolSet output", () => {
    const deps: SliceSymbolDeps = {
      imports: [
        { symbolId: "sym-a", confidence: 0.9 },
        { symbolId: "sym-b", confidence: 0.7 },
      ],
      calls: [{ symbolId: "sym-c", confidence: 1 }],
    };
    const sliceSet = new Set(["sym-a", "sym-c"]);

    const fromMain = filterDepsBySliceSymbolSet(deps, sliceSet);
    const fromSerializer = filterDepsFromSerializer(deps, sliceSet);

    assert.deepStrictEqual(fromMain, fromSerializer);
  });

  it("produces identical estimateTokens output", () => {
    const sliceCard = toSliceSymbolCard(baseCard);

    const fromMain = estimateTokens([sliceCard]);
    const fromSerializer = estimateTokensFromSerializer([sliceCard]);

    assert.strictEqual(fromMain, fromSerializer);
  });
});

describe("Golden parity: determinism tests", () => {
  it("produces byte-identical output for repeated edge encoding", () => {
    const symbolIds = ["sym-x", "sym-y", "sym-z"];
    const dbEdges = [
      {
        from_symbol_id: "sym-x",
        to_symbol_id: "sym-y",
        type: "call" as const,
        weight: 1,
      },
      {
        from_symbol_id: "sym-y",
        to_symbol_id: "sym-z",
        type: "import" as const,
        weight: 0.8,
      },
    ];

    const run1 = JSON.stringify(
      encodeEdgesWithSymbolIndex(symbolIds as any, dbEdges),
    );
    const run2 = JSON.stringify(
      encodeEdgesWithSymbolIndex(symbolIds as any, dbEdges),
    );
    const run3 = JSON.stringify(
      encodeEdgesWithSymbolIndex(symbolIds as any, dbEdges),
    );

    assert.strictEqual(run1, run2);
    assert.strictEqual(run2, run3);
  });

  it("produces byte-identical output for repeated payload building", () => {
    const card: SymbolCard = {
      symbolId: "sym-det",
      repoId: "repo-1",
      file: "src/determinism.ts",
      range: { startLine: 1, startCol: 0, endLine: 10, endCol: 1 },
      kind: "function",
      name: "deterministicFn",
      exported: true,
      deps: { imports: ["a", "b"], calls: ["c"] },
      detailLevel: "compact",
      version: { ledgerVersion: "v1", astFingerprint: "abcd1234" },
    };

    const run1 = JSON.stringify(buildPayloadCardsAndRefs([card]));
    const run2 = JSON.stringify(buildPayloadCardsAndRefs([card]));
    const run3 = JSON.stringify(buildPayloadCardsAndRefs([card]));

    assert.strictEqual(run1, run2);
    assert.strictEqual(run2, run3);
  });

  it("produces deterministic task text token ranking", () => {
    const taskText = "fix the bug in UserService.authenticate method";

    const run1 = collectTaskTextSeedTokens(taskText);
    const run2 = collectTaskTextSeedTokens(taskText);
    const run3 = collectTaskTextSeedTokens(taskText);

    assert.deepStrictEqual(run1, run2);
    assert.deepStrictEqual(run2, run3);
  });
});

describe("Golden parity: start node resolver exports", () => {
  it("has consistent START_NODE_SOURCE_PRIORITY values", () => {
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.entrySymbol, 0);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.entrySibling, 1);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.entryFirstHop, 2);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.stackTrace, 3);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.failingTestPath, 4);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.editedFile, 5);
    assert.strictEqual(START_NODE_SOURCE_PRIORITY.taskText, 6);
  });

  it("has consistent START_NODE_SOURCE_SCORE values", () => {
    assert.strictEqual(START_NODE_SOURCE_SCORE.entrySymbol, -1.4);
    assert.strictEqual(START_NODE_SOURCE_SCORE.entrySibling, -1.22);
    assert.strictEqual(START_NODE_SOURCE_SCORE.entryFirstHop, -1.18);
    assert.strictEqual(START_NODE_SOURCE_SCORE.stackTrace, -1.2);
    assert.strictEqual(START_NODE_SOURCE_SCORE.failingTestPath, -1.1);
    assert.strictEqual(START_NODE_SOURCE_SCORE.editedFile, -1.0);
    assert.strictEqual(START_NODE_SOURCE_SCORE.taskText, -0.6);
  });

  it("produces deterministic commonPrefixLength results", () => {
    assert.strictEqual(commonPrefixLength("getUserById", "getUserByName"), 9);
    assert.strictEqual(commonPrefixLength("handleError", "handleEvent"), 7);
    assert.strictEqual(commonPrefixLength("foo", "bar"), 0);
    assert.strictEqual(commonPrefixLength("exact", "exact"), 5);
  });

  it("produces deterministic task token ranking", () => {
    assert.strictEqual(getTaskTextTokenRank("UserService"), 1);
    assert.strictEqual(getTaskTextTokenRank("src/main.ts"), 8);
    assert.strictEqual(getTaskTextTokenRank("config"), 0);
    assert.strictEqual(getTaskTextTokenRank("abc"), 0);
    assert.strictEqual(getTaskTextTokenRank("test-file_name"), 4);
    assert.strictEqual(getTaskTextTokenRank("v2Service"), 3);
  });

  it("computes consistent start node limits", () => {
    const limitsNoEntry = computeStartNodeLimits({}, 0);
    assert.ok(limitsNoEntry.maxTotalStartNodes >= 12);
    assert.ok(limitsNoEntry.maxTaskTextStartNodes > 0);

    const limitsWithEntry = computeStartNodeLimits({ entrySymbols: ["s1"] }, 1);
    assert.ok(limitsWithEntry.maxTotalStartNodes >= 12);
  });
});

describe("Golden parity: beam search engine exports", () => {
  it("normalizes edge confidence consistently", () => {
    assert.strictEqual(normalizeEdgeConfidence(undefined), 1);
    assert.strictEqual(normalizeEdgeConfidence(NaN), 1);
    assert.strictEqual(normalizeEdgeConfidence(0.5), 0.5);
    assert.strictEqual(normalizeEdgeConfidence(1.5), 1);
    assert.strictEqual(normalizeEdgeConfidence(-0.5), 0);
  });

  it("applies edge confidence weight consistently", () => {
    assert.strictEqual(applyEdgeConfidenceWeight(1.0, 1), 1.0);
    assert.strictEqual(applyEdgeConfidenceWeight(0.8, 0.5), 0.4);
    assert.strictEqual(applyEdgeConfidenceWeight(1.0, undefined), 1.0);
  });

  it("computes adaptive min confidence consistently", () => {
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 0, 1000), 0.5);
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 950, 1000), 0.95);
    assert.strictEqual(getAdaptiveMinConfidence(0.5, 750, 1000), 0.8);
  });

  it("computes min cards for dynamic cap consistently", () => {
    assert.strictEqual(computeMinCardsForDynamicCap(100, 0), 6);
    assert.strictEqual(computeMinCardsForDynamicCap(100, 5), 7);
    assert.strictEqual(computeMinCardsForDynamicCap(5, 0), 5);
  });

  it("compares frontier items deterministically", () => {
    const item1 = {
      symbolId: "a",
      score: -1,
      why: "test",
      priority: 1,
      sequence: 0,
    };
    const item2 = {
      symbolId: "b",
      score: -2,
      why: "test",
      priority: 1,
      sequence: 1,
    };
    const item3 = {
      symbolId: "c",
      score: -1,
      why: "test",
      priority: 0,
      sequence: 2,
    };

    assert.ok(compareFrontierItems(item1, item2) > 0);
    assert.ok(compareFrontierItems(item2, item1) < 0);
    assert.ok(compareFrontierItems(item1, item3) > 0);
  });

  it("decides dynamic cap tightening consistently", () => {
    const state = {
      sliceSize: 10,
      minCardsForDynamicCap: 6,
      highConfidenceCards: 8,
      requiredEntryCoverage: 2,
      coveredEntrySymbols: 2,
      recentAcceptedScores: [0.8, 0.9, 0.85],
      nextFrontierScore: 0.1,
    };

    assert.strictEqual(shouldTightenDynamicCardCap(state), true);

    const stateLowCoverage = {
      ...state,
      coveredEntrySymbols: 1,
    };
    assert.strictEqual(shouldTightenDynamicCardCap(stateLowCoverage), false);
  });
});

describe("Golden parity: known etag behavior", () => {
  it("omits unchanged cards from payload when knownCardEtags matches", () => {
    const card: SymbolCard = {
      symbolId: "sym-etag",
      repoId: "repo-1",
      file: "src/etag.ts",
      range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
      kind: "function",
      name: "etagTest",
      exported: true,
      deps: { imports: [], calls: [] },
      detailLevel: "compact",
      version: { ledgerVersion: "v1", astFingerprint: "abcd" },
    };

    const cardWithoutEtag = { ...card };
    delete (cardWithoutEtag as any).etag;
    const etag = hashCard(cardWithoutEtag);

    const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs([card], {
      [card.symbolId]: etag,
    });

    assert.strictEqual(
      cardsForPayload.length,
      0,
      "unchanged card should not be in payload",
    );
    assert.strictEqual(
      cardRefs?.length ?? 0,
      0,
      "unchanged card should not be in cardRefs",
    );
  });

  it("includes changed cards in payload when knownCardEtags differs", () => {
    const card: SymbolCard = {
      symbolId: "sym-etag2",
      repoId: "repo-1",
      file: "src/etag2.ts",
      range: { startLine: 1, startCol: 0, endLine: 5, endCol: 1 },
      kind: "function",
      name: "etagTest2",
      exported: true,
      deps: { imports: [], calls: [] },
      detailLevel: "compact",
      version: { ledgerVersion: "v1", astFingerprint: "abcd" },
    };

    const { cardsForPayload, cardRefs } = buildPayloadCardsAndRefs([card], {
      [card.symbolId]: "stale-etag",
    });

    assert.strictEqual(
      cardsForPayload.length,
      1,
      "changed card should be in payload",
    );
    assert.strictEqual(
      cardRefs?.length ?? 0,
      1,
      "changed card should be in cardRefs",
    );
  });
});
