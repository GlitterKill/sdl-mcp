/**
 * Slice Serializer Module
 *
 * Handles conversion of symbol cards to wire format for graph slices.
 * Manages payload construction, ETag-based deduplication, and edge encoding.
 *
 * @module graph/slice/slice-serializer
 */

import type { SymbolId, EdgeType } from "../../db/schema.js";
import type {
  SymbolCard,
  SliceSymbolCard,
  SliceDepRef,
  SliceSymbolDeps,
  CompressedEdge,
  CardDetailLevel,
} from "../../mcp/types.js";
import { CARD_DETAIL_LEVEL_RANK } from "../../mcp/types.js";
import { estimateTokens as estimateTextTokens } from "../../util/tokenize.js";
import { hashCard } from "../../util/hashing.js";
import {
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_INVARIANTS_LIGHT,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
  SYMBOL_TOKEN_BASE,
  SYMBOL_TOKEN_ADDITIONAL_MAX,
  SYMBOL_TOKEN_MAX,
  AST_FINGERPRINT_WIRE_LENGTH,
} from "../../config/constants.js";

export function uniqueLimit(values: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= max) break;
  }
  return result;
}

export function uniqueDepRefs(
  values: SliceDepRef[],
  max: number,
): SliceDepRef[] {
  const bySymbolId = new Map<string, number>();
  for (const value of values) {
    if (!value?.symbolId) continue;
    const confidence = normalizeEdgeConfidence(value.confidence);
    const existing = bySymbolId.get(value.symbolId);
    if (existing === undefined || confidence > existing) {
      bySymbolId.set(value.symbolId, confidence);
    }
  }

  return Array.from(bySymbolId.entries())
    .slice(0, max)
    .map(([symbolId, confidence]) => ({ symbolId, confidence }));
}

function normalizeEdgeConfidence(confidence: number | undefined): number {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return 1;
  }
  return Math.max(0, Math.min(1, confidence));
}

export function toDefaultSliceDeps(card: SymbolCard): SliceSymbolDeps {
  return {
    imports: card.deps.imports.map((symbolId) => ({
      symbolId,
      confidence: 1,
    })),
    calls: card.deps.calls.map((symbolId) => ({
      symbolId,
      confidence: 1,
    })),
  };
}

export function resolveSliceDeps(
  card: SymbolCard,
  sliceDepsBySymbol?: Map<SymbolId, SliceSymbolDeps>,
  sliceSymbolSet?: Set<SymbolId>,
): SliceSymbolDeps {
  const deps =
    sliceDepsBySymbol?.get(card.symbolId) ?? toDefaultSliceDeps(card);
  if (!sliceSymbolSet) {
    return deps;
  }
  return filterDepsBySliceSymbolSet(deps, sliceSymbolSet);
}

export function filterDepsBySliceSymbolSet(
  deps: SliceSymbolDeps,
  sliceSymbolSet: Set<SymbolId>,
): SliceSymbolDeps {
  const filter = (values: SliceDepRef[]): SliceDepRef[] =>
    values.filter((dep) => sliceSymbolSet.has(dep.symbolId));

  return {
    imports: filter(deps.imports),
    calls: filter(deps.calls),
  };
}

export function toFullCard(card: SymbolCard): SymbolCard {
  const normalized: SymbolCard = {
    ...card,
    detailLevel: "full",
  };
  delete normalized.etag;
  return normalized;
}

export function toCompactCard(card: SymbolCard): SymbolCard {
  const depsCard = toDepsCard(card);
  return {
    ...depsCard,
    detailLevel: "compact",
  };
}

export function toMinimalCard(card: SymbolCard): SymbolCard {
  const minimal: SymbolCard = {
    symbolId: card.symbolId,
    repoId: card.repoId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: { imports: [], calls: [] },
    detailLevel: "minimal",
    version: card.version,
  };

  return minimal;
}

export function toSignatureCard(card: SymbolCard): SymbolCard {
  const signature: SymbolCard = {
    symbolId: card.symbolId,
    repoId: card.repoId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: { imports: [], calls: [] },
    detailLevel: "signature",
    version: card.version,
  };

  if (card.visibility) {
    signature.visibility = card.visibility;
  }

  if (card.signature) {
    signature.signature = card.signature;
  }

  if (card.summary) {
    signature.summary = card.summary.slice(
      0,
      SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
    );
  }

  return signature;
}

export function toDepsCard(card: SymbolCard): SymbolCard {
  const deps: SymbolCard = {
    symbolId: card.symbolId,
    repoId: card.repoId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: {
      imports: uniqueLimit(
        card.deps?.imports ?? [],
        SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
      ),
      calls: uniqueLimit(
        card.deps?.calls ?? [],
        SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
      ),
    },
    detailLevel: "deps",
    version: card.version,
  };

  if (card.visibility) {
    deps.visibility = card.visibility;
  }

  if (card.signature) {
    deps.signature = card.signature;
  }

  if (card.summary) {
    deps.summary = card.summary.slice(0, SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT);
  }

  return deps;
}

export function toCardAtDetailLevel(
  card: SymbolCard,
  detailLevel: CardDetailLevel,
): SymbolCard {
  switch (detailLevel) {
    case "minimal":
      return toMinimalCard(card);
    case "signature":
      return toSignatureCard(card);
    case "deps":
      return toDepsCard(card);
    case "compact":
      return toCompactCard(card);
    case "full":
      return toFullCard(card);
    default:
      return toCompactCard(card);
  }
}

export function selectAdaptiveDetailLevel(
  budget: number,
  cardCount: number,
  requestedLevel: CardDetailLevel,
): CardDetailLevel {
  const requestedRank = CARD_DETAIL_LEVEL_RANK[requestedLevel];
  const tokensPerCard = cardCount > 0 ? budget / cardCount : budget;

  if (tokensPerCard < 30) {
    return CARD_DETAIL_LEVEL_RANK.minimal <= requestedRank
      ? "minimal"
      : requestedLevel;
  }
  if (tokensPerCard < 50) {
    return CARD_DETAIL_LEVEL_RANK.signature <= requestedRank
      ? "signature"
      : requestedLevel;
  }
  if (tokensPerCard < 80) {
    return CARD_DETAIL_LEVEL_RANK.deps <= requestedRank
      ? "deps"
      : requestedLevel;
  }
  if (tokensPerCard < 120) {
    return CARD_DETAIL_LEVEL_RANK.compact <= requestedRank
      ? "compact"
      : requestedLevel;
  }
  return requestedLevel;
}

export function toSliceSymbolCard(
  card: SymbolCard,
  deps?: SliceSymbolDeps,
): SliceSymbolCard {
  const detailLevel = card.detailLevel ?? "compact";
  const astFingerprint = card.version.astFingerprint.slice(
    0,
    AST_FINGERPRINT_WIRE_LENGTH,
  );
  const sliceCard: SliceSymbolCard = {
    symbolId: card.symbolId,
    file: card.file,
    range: card.range,
    kind: card.kind,
    name: card.name,
    exported: card.exported,
    deps: deps ?? toDefaultSliceDeps(card),
    detailLevel,
    version: {
      astFingerprint,
    },
  };

  if (card.visibility) {
    sliceCard.visibility = card.visibility;
  }

  if (card.signature) {
    sliceCard.signature = card.signature;
  }

  if (card.summary) {
    sliceCard.summary = card.summary;
  }

  if (card.invariants && card.invariants.length > 0) {
    sliceCard.invariants = card.invariants;
  }

  if (card.sideEffects && card.sideEffects.length > 0) {
    sliceCard.sideEffects = card.sideEffects;
  }

  if (card.metrics) {
    sliceCard.metrics = card.metrics;
  }

  return sliceCard;
}

export function buildPayloadCardsAndRefs(
  cards: SymbolCard[],
  knownCardEtags?: Record<SymbolId, string>,
  sliceDepsBySymbol?: Map<SymbolId, SliceSymbolDeps>,
  sliceSymbolSet?: Set<SymbolId>,
): {
  cardsForPayload: SliceSymbolCard[];
  cardRefs?: Array<{
    symbolId: SymbolId;
    etag: string;
    detailLevel: CardDetailLevel;
  }>;
} {
  const hasKnownCardEtags = Boolean(
    knownCardEtags && Object.keys(knownCardEtags).length > 0,
  );

  if (!hasKnownCardEtags) {
    return {
      cardsForPayload: cards.map((card) => {
        const detailLevel = card.detailLevel ?? "compact";
        const normalized: SymbolCard = {
          ...card,
          detailLevel,
        };
        delete normalized.etag;
        const deps = resolveSliceDeps(
          normalized,
          sliceDepsBySymbol,
          sliceSymbolSet,
        );
        return toSliceSymbolCard(normalized, deps);
      }),
    };
  }

  const cardsForPayload: SliceSymbolCard[] = [];
  const cardRefs: Array<{
    symbolId: SymbolId;
    etag: string;
    detailLevel: CardDetailLevel;
  }> = [];

  const knownEtags = knownCardEtags ?? {};

  for (const card of cards) {
    const detailLevel = card.detailLevel ?? "compact";
    const cardWithoutEtag: SymbolCard = { ...card };
    cardWithoutEtag.detailLevel = detailLevel;
    delete cardWithoutEtag.etag;
    const etag = hashCard(cardWithoutEtag);

    if (knownEtags[card.symbolId] === etag) {
      continue;
    }

    cardRefs.push({
      symbolId: card.symbolId,
      etag,
      detailLevel,
    });
    const deps = resolveSliceDeps(
      cardWithoutEtag,
      sliceDepsBySymbol,
      sliceSymbolSet,
    );
    cardsForPayload.push(toSliceSymbolCard(cardWithoutEtag, deps));
  }

  return {
    cardsForPayload,
    cardRefs,
  };
}

export function encodeEdgesWithSymbolIndex(
  symbolIds: SymbolId[],
  dbEdges: ReadonlyArray<{
    from_symbol_id: SymbolId;
    to_symbol_id: SymbolId;
    type: EdgeType;
    weight: number;
  }>,
): { symbolIndex: SymbolId[]; edges: CompressedEdge[] } {
  const symbolIndex = Array.from(new Set(symbolIds)).sort();
  const symbolPosition = new Map<SymbolId, number>();

  for (const [index, symbolId] of symbolIndex.entries()) {
    symbolPosition.set(symbolId, index);
  }

  const edges: CompressedEdge[] = [];
  for (const edge of dbEdges) {
    const fromIndex = symbolPosition.get(edge.from_symbol_id);
    const toIndex = symbolPosition.get(edge.to_symbol_id);
    if (fromIndex === undefined || toIndex === undefined) continue;
    edges.push([fromIndex, toIndex, edge.type, edge.weight]);
  }

  return {
    symbolIndex,
    edges,
  };
}

export function estimateTokens(
  cards: Array<SymbolCard | SliceSymbolCard>,
): number {
  let total = 0;

  for (const card of cards) {
    let cardTokens = SYMBOL_TOKEN_BASE;

    cardTokens += estimateTextTokens(card.name);
    cardTokens += estimateTextTokens(card.file);

    if (card.signature) {
      const sigText = JSON.stringify(card.signature);
      cardTokens += estimateTextTokens(sigText);
    }

    if (card.summary) {
      cardTokens += Math.min(
        estimateTextTokens(card.summary),
        SYMBOL_TOKEN_ADDITIONAL_MAX,
      );
    }

    cardTokens += card.deps.imports.length * 5;
    cardTokens += card.deps.calls.length * 5;

    if (card.invariants) {
      for (const invariant of card.invariants) {
        cardTokens += estimateTextTokens(invariant);
      }
    }

    if (card.sideEffects) {
      for (const effect of card.sideEffects) {
        cardTokens += estimateTextTokens(effect);
      }
    }

    cardTokens = Math.min(cardTokens, SYMBOL_TOKEN_MAX);
    total += cardTokens;
  }

  return total;
}

export {
  SYMBOL_CARD_MAX_DEPS_PER_KIND,
  SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT,
  SYMBOL_CARD_MAX_INVARIANTS,
  SYMBOL_CARD_MAX_INVARIANTS_LIGHT,
  SYMBOL_CARD_MAX_SIDE_EFFECTS,
  SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT,
  SYMBOL_CARD_MAX_TEST_REFS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS,
  SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT,
};
