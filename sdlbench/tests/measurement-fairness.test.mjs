import assert from "node:assert/strict";
import test from "node:test";
import { auditFairness } from "../src/fairness.mjs";
import { validateClaims } from "../src/claim-gates.mjs";
import { computeCoverage } from "../src/coverage.mjs";

test("fairness requires measured injection and tool budgets, independently of savings", () => {
  const inputs = { baselinePromptTokens: 10, sdlPromptTokens: 10, baselineToolBudget: 20, sdlToolBudget: 20,
    sdlInjectedFiles: [{ content: "additional instructions" }] };
  const missing = auditFairness(inputs);
  assert.equal(missing.sdlInjectionTokens, null);
  assert.equal(missing.promptTokenImbalance, null);
  assert.equal(missing.available, false);
  const measured = auditFairness({ ...inputs, sdlTokenizer: () => 5 });
  assert.equal(measured.available, true);
  assert.equal(measured.passed, true);
  assert.equal(measured.netSavingsPct, -50);
  assert.equal(measured.toolBudgetImbalance, 0);
  assert.equal(auditFairness({ ...inputs, sdlTokenizer: () => NaN }).available, false);
});

test("claim validity fails closed on missing fairness but allows a fair product loss", () => {
  const row = { variant: "sdl", bothPass: true, claimGrade: "primary", executionMode: "behavior", deltaPct: 90 };
  assert.equal(validateClaims({ paired: [row], profile: "smoke" }).passed, false);
  const loss = validateClaims({ paired: [{ ...row, deltaPct: -20, fairness: { available: true, passed: true } }] });
  assert.equal(loss.experimentalValidity.passed, true);
  assert.equal(loss.performancePassed, false);
  assert.equal(loss.passed, false);
  assert.equal(validateClaims({ paired: [] }).experimentalValidity.passed, false);
});

test("edit coverage stays separate from observed retrieval relevance and unknown retrieval", () => {
  const targets = { files: ["a.js"], symbols: ["review"] };
  const review = computeCoverage({ changedFiles: [], retrievedSymbols: ["review", "review"], contextTargets: targets });
  assert.equal(review.editCoverage.recall, 0);
  assert.equal(review.retrievalRelevance.recall, 100);
  assert.equal(review.retrievalRelevance.precision, 100);
  assert.equal(review.contextCoverage, null);
  const missing = computeCoverage({ changedFiles: [], contextTargets: targets });
  assert.equal(missing.retrievalRelevance.available, false);
  assert.equal(missing.symbolCoverage, null);
});
