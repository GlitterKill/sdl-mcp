import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnswerFirstResponse,
  INSUFFICIENT_SUMMARY_COVERAGE,
} from "../../dist/mcp/context-answer-first.js";

function card(
  symbolId: string,
  overrides: Partial<{
    name: string;
    file: string;
    summary: string;
    summaryProvenance: "llm" | "heuristic";
  }> = {},
) {
  return {
    symbolId,
    name: overrides.name ?? `symbol${symbolId}`,
    file: overrides.file ?? `src/${symbolId}.ts`,
    kind: "function",
    summary: overrides.summary,
    summaryProvenance: overrides.summaryProvenance,
    deps: {},
  };
}

test("falls back when answer-first summary coverage is too low", () => {
  const result = buildAnswerFirstResponse("explain", [
    card("a", {
      summary: "Builds the graph slice.",
      summaryProvenance: "heuristic",
    }),
    card("b", { summary: "Selects cards." }),
    card("c"),
  ]);

  assert.deepEqual(result, {
    kind: "fallback",
    answerFirstFallback: INSUFFICIENT_SUMMARY_COVERAGE,
  });
});

test("returns compact answer-first response when coverage is sufficient", () => {
  const result = buildAnswerFirstResponse("debug", [
    card("a", {
      name: "buildGraphSlice",
      file: "src/graph/slice.ts",
      summary: "Builds a graph slice over dependency edges.",
      summaryProvenance: "llm",
    }),
    card("b", {
      name: "scoreCandidate",
      file: "src/graph/scoring.ts",
      summary: "Scores candidate symbols for inclusion.",
      summaryProvenance: "llm",
    }),
  ]);

  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.equal(typeof result.response.answer, "string");
  assert.equal(result.response.confidence, "high");
  assert.equal(result.response.evidence.length, 2);
  assert.equal(result.response.evidence[0]?.symbolId, "a");
  assert.equal(result.response.evidence[0]?.why, "entry symbol");
  assert.equal(Object.hasOwn(result.response, "cards"), false);
});

test("caps answer-first evidence at eight entries", () => {
  const cards = Array.from({ length: 10 }, (_, index) =>
    card(String(index), {
      summary: `Summary for symbol ${index}.`,
      summaryProvenance: "llm",
    }),
  );

  const result = buildAnswerFirstResponse("explain", cards);

  assert.equal(result.kind, "active");
  if (result.kind !== "active") return;
  assert.equal(result.response.evidence.length, 8);
});

test("ignores answer-first for implement tasks", () => {
  const result = buildAnswerFirstResponse("implement", [
    card("a", {
      summary: "Implements a feature.",
      summaryProvenance: "heuristic",
    }),
  ]);

  assert.deepEqual(result, { kind: "ignored" });
});
