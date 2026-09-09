import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as serialization from "../../dist/context/serialize.js";
import { enforceContextBudget, estimateContextResponseTokens } from "../../dist/context/select.js";
import * as contextTool from "../../dist/mcp/tools/context.js";
import { projectToolResultForModelContent } from "../../dist/mcp/context-response-projection.js";
import { encodePackedContext } from "../../dist/mcp/wire/packed/encoders/context.js";
import type { ContextPayload } from "../../dist/context/types.js";

function payload(): ContextPayload {
  const identity = { symbolId: "a".repeat(64), path: "src/a.ts", rank: 0, tier: 0 as const, lanes: ["exactIdentifier" as const] };
  return {
    status: "complete", taskType: "review",
    retrieval: { level: "lexical", lanes: [{ id: "exactIdentifier", available: true }] },
    evidence: [
      { ...identity, rung: "card", content: { kind: "function", name: "check", signature: "check(): boolean", summary: "Checks input.", testCase: { title: "input" } } },
      { ...identity, rung: "skeleton", content: { file: "src/a.ts", skeleton: "function check() { return true; }", truncated: false } },
    ],
    edges: [], omitted: { total: 0, byReason: { budget: 0 }, highestRanked: [] }, nextActions: [],
  };
}

describe("context evidence density", () => {
  it("consolidates identity wrappers without losing code, metadata or recovery", () => {
    const original = payload();
    const result = serialization.consolidateContextEvidence(original);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].rung, "skeleton");
    assert.deepEqual(result.evidence[0].content, {
      ...original.evidence[1].content as object, card: original.evidence[0].content,
    });
    assert.deepEqual(result.omitted, original.omitted);
    assert.deepEqual(result.nextActions, original.nextActions);
    assert.equal(original.evidence.length, 2);
    assert.ok(estimateContextResponseTokens(result) < estimateContextResponseTokens(original));
    assert.deepEqual(serialization.consolidateContextEvidence(result), result);
    const packed = encodePackedContext(result);
    assert.ok(packed.includes("check"));
    for (const detail of ["compact", "standard", "full"] as const) {
      const projected = projectToolResultForModelContent("sdl.context", result, { detail }) as ContextPayload;
      const content = projected.evidence[0].content as Record<string, unknown>;
      assert.deepEqual(content.card, original.evidence[0].content);
      assert.equal(content.skeleton, "function check() { return true; }");
    }
  });

  it("keeps the existing card fallback when code is unavailable or evicted", () => {
    const original = payload();
    original.evidence[1].content = { skeleton: "code ".repeat(1000) };
    const cardOnly = { ...original, evidence: original.evidence.slice(0, 1) };
    const budget = estimateContextResponseTokens(cardOnly) + 350;
    const enforced = enforceContextBudget(original, budget);
    assert.equal(enforced.budgetError, undefined);
    const result = serialization.consolidateContextEvidence(enforced.payload);
    assert.deepEqual(result.evidence, cardOnly.evidence);
    assert.ok(result.omitted.highestRanked.some(item => item.rung === "skeleton"));
    assert.ok(estimateContextResponseTokens(result) <= budget);
    assert.deepEqual(serialization.consolidateContextEvidence(cardOnly), cardOnly);
  });

  it("uses the same card session key and leaves code intact on repeated references", () => {
    const first = serialization.consolidateContextEvidence(payload()) as unknown as Record<string, unknown>;
    const second = structuredClone(first);
    const third = structuredClone(first);
    const options = { repoId: "density-test", sessionId: "density-test-nested-card" };
    contextTool.applyContextSessionRefs(first, options);
    contextTool.applyContextSessionRefs(second, options);
    contextTool.applyContextSessionRefs(third, options);
    assert.deepEqual(second, third);
    const evidence = second.evidence as Array<{ content: Record<string, unknown> }>;
    assert.equal(evidence[0].content.skeleton, "function check() { return true; }");
    assert.deepEqual(evidence[0].content.card, { ref: { key: `card:density-test:${"a".repeat(64)}` }, unchanged: true });
    const projected = projectToolResultForModelContent("sdl.context", second) as typeof second;
    assert.deepEqual((projected.evidence as typeof evidence)[0].content.card, evidence[0].content.card);
    const off = serialization.consolidateContextEvidence(payload()) as unknown as Record<string, unknown>;
    contextTool.applyContextSessionRefs(off, { ...options, refsMode: "off" });
    assert.deepEqual(off, serialization.consolidateContextEvidence(payload()));
  });
});

it("preserves null-code fallback and missing-card code without inventing content", () => {
  const noCode = payload();
  noCode.evidence[1].content = null;
  assert.deepEqual(serialization.consolidateContextEvidence(noCode), noCode);
  const noCard = payload();
  noCard.evidence = noCard.evidence.slice(1);
  assert.deepEqual(serialization.consolidateContextEvidence(noCard), noCard);
});

it("keeps standalone-to-nested card ledger continuity and detects changed metadata", () => {
  const options = { repoId: "density-test", sessionId: "density-transition" };
  contextTool.applyContextSessionRefs(payload() as unknown as Record<string, unknown>, options);
  const repeated = serialization.consolidateContextEvidence(payload()) as unknown as Record<string, unknown>;
  contextTool.applyContextSessionRefs(repeated, options);
  assert.deepEqual(repeated.sessionDelta, { newCards: 0, changedCards: 0, unchangedRefs: 1 });
  const changed = payload();
  (changed.evidence[0].content as Record<string, unknown>).summary = "Updated summary.";
  const nested = serialization.consolidateContextEvidence(changed) as unknown as Record<string, unknown>;
  contextTool.applyContextSessionRefs(nested, options);
  assert.deepEqual(nested.sessionDelta, { newCards: 0, changedCards: 1, unchangedRefs: 0 });
  const card = ((nested.evidence as Array<{ content: { card: Record<string, unknown> } }>)[0].content.card);
  assert.equal(card.summary, "Updated summary.");
  assert.equal(card.changedSincePrior, true);
  for (const detail of ["compact", "standard", "full"] as const) {
    const projected = projectToolResultForModelContent("sdl.context", nested, { detail }) as typeof nested;
    const projectedCard = (projected.evidence as Array<{ content: { card: Record<string, unknown> } }>)[0].content.card;
    assert.equal(projectedCard.changedSincePrior, true);
  }
});
