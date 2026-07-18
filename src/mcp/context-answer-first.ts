import { estimateTokens } from "../util/tokenize.js";

export const INSUFFICIENT_SUMMARY_COVERAGE =
  "insufficient-summary-coverage";

const MIN_PROVENANCE_COVERAGE = 0.6;
const HIGH_CONFIDENCE_COVERAGE = 0.85;
const MAX_PLANNED_CARDS = 10;
const MAX_EVIDENCE = 8;
const MAX_RELATIONSHIP_SENTENCES = 4;
const MAX_ANSWER_TOKENS = 250;

type AnswerFirstTaskType = "debug" | "review" | "implement" | "explain";
type SummaryProvenance = "llm" | "heuristic";

export interface AnswerFirstCard {
  symbolId: string;
  name: string;
  file: string;
  kind?: string;
  summary?: string;
  summaryProvenance?: SummaryProvenance;
  deps?: {
    calls?: readonly string[];
    imports?: readonly string[];
  };
  sideEffects?: readonly string[] | string;
  canonicalTest?: string;
}

export interface AnswerFirstEvidence {
  symbolId: string;
  name: string;
  file: string;
  why: string;
}

export interface AnswerFirstResponse {
  answer: string;
  confidence: "high" | "medium";
  evidence: AnswerFirstEvidence[];
  expand: {
    hint: string;
  };
}

export type AnswerFirstResult =
  | { kind: "active"; response: AnswerFirstResponse }
  | {
      kind: "fallback";
      answerFirstFallback: typeof INSUFFICIENT_SUMMARY_COVERAGE;
      answer: string;
      nextBestAction: string;
    }
  | { kind: "ignored" };

export function buildAnswerFirstResponse(
  taskType: AnswerFirstTaskType,
  cards: readonly AnswerFirstCard[],
): AnswerFirstResult {
  if (taskType !== "explain" && taskType !== "debug") {
    return { kind: "ignored" };
  }

  const planned = cards.slice(0, Math.min(MAX_PLANNED_CARDS, cards.length));
  const covered = planned.filter(hasProvenancedSummary);
  const coverage = planned.length === 0 ? 0 : covered.length / planned.length;
  if (coverage < MIN_PROVENANCE_COVERAGE) {
    return {
      kind: "fallback",
      answerFirstFallback: INSUFFICIENT_SUMMARY_COVERAGE,
      answer:
        "Answer-first could not produce a reliable answer because too few symbol cards have high-quality summaries.",
      nextBestAction:
        "Retry sdl.context without options.answerFirst to inspect finalEvidence.",
    };
  }

  const evidenceCards = covered.slice(0, MAX_EVIDENCE);
  const evidence = evidenceCards.map((card, index) => ({
    symbolId: card.symbolId,
    name: card.name,
    file: card.file,
    why: index === 0 ? "entry symbol" : "supporting evidence",
  }));

  const confidence =
    coverage >= HIGH_CONFIDENCE_COVERAGE &&
    evidenceCards.every((card) => card.summaryProvenance === "llm")
      ? "high"
      : "medium";

  const answer = trimToTokenBudget(
    [
      ...summarySentences(evidenceCards),
      ...relationshipSentences(evidenceCards),
      ...(taskType === "debug" ? debugSentences(evidenceCards) : []),
    ].join(" "),
    MAX_ANSWER_TOKENS,
  );

  return {
    kind: "active",
    response: {
      answer,
      confidence,
      evidence,
      expand: {
        hint: "call sdl.context without answerFirst, or symbol.getCard on evidence ids",
      },
    },
  };
}

function hasProvenancedSummary(card: AnswerFirstCard): boolean {
  return !!card.summary?.trim() && card.summaryProvenance !== undefined;
}

function summarySentences(cards: readonly AnswerFirstCard[]): string[] {
  return cards.map((card) => `${card.name}: ${ensureSentence(card.summary)}`);
}

function relationshipSentences(cards: readonly AnswerFirstCard[]): string[] {
  const byIdOrName = new Map<string, AnswerFirstCard>();
  for (const card of cards) {
    byIdOrName.set(card.symbolId, card);
    byIdOrName.set(card.name, card);
  }

  const sentences: string[] = [];
  for (const card of cards) {
    for (const target of card.deps?.calls ?? []) {
      const targetCard = byIdOrName.get(target);
      if (targetCard) sentences.push(`${card.name} calls ${targetCard.name}.`);
      if (sentences.length >= MAX_RELATIONSHIP_SENTENCES) return sentences;
    }
    for (const target of card.deps?.imports ?? []) {
      const targetCard = byIdOrName.get(target);
      if (targetCard) sentences.push(`${card.name} imports ${targetCard.name}.`);
      if (sentences.length >= MAX_RELATIONSHIP_SENTENCES) return sentences;
    }
  }
  return sentences;
}

function debugSentences(cards: readonly AnswerFirstCard[]): string[] {
  const sentences: string[] = [];
  for (const card of cards) {
    const sideEffects = sideEffectText(card.sideEffects);
    if (sideEffects) sentences.push(`${card.name} side effects: ${sideEffects}.`);
    if (card.canonicalTest?.trim()) {
      sentences.push(`${card.name} canonical test: ${card.canonicalTest.trim()}.`);
    }
  }
  return sentences;
}

function sideEffectText(value: AnswerFirstCard["sideEffects"]): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || value.length === 0) return undefined;
  return value.map((item) => item.trim()).filter(Boolean).join(", ");
}

function ensureSentence(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "No summary available.";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function trimToTokenBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const next = [...kept, sentence].join(" ");
    if (estimateTokens(next) > maxTokens) break;
    kept.push(sentence);
  }
  if (kept.length > 0) return kept.join(" ");

  const words = text.split(/\s+/).filter(Boolean);
  const trimmed: string[] = [];
  for (const word of words) {
    const next = [...trimmed, word].join(" ");
    if (estimateTokens(next) > maxTokens) break;
    trimmed.push(word);
  }
  return trimmed.join(" ");
}
