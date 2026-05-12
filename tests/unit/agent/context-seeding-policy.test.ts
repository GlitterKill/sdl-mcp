import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = () =>
  readFileSync(join(process.cwd(), "src/agent/context-seeding.ts"), "utf8");

describe("context seeding policy", () => {
  it("keeps Stage 2 lexical-only after the hybrid entity lane", () => {
    const src = source();

    assert.match(src, /const semanticDisabled = task\.options\?\.semantic === false/);
    assert.match(
      src,
      /forceSemanticEntitySearch \|\| \(!semanticDisabled && isBroad\)/,
    );
    assert.match(src, /const useHybridLexical = false/);
  });

  it("restores bounded FTS in semantic entity search", () => {
    const src = source();

    assert.match(src, /limit: isBroad \? 32 : 16/);
    assert.match(src, /ftsEnabled: true/);
  });

  it("applies semantic score threshold after RRF score normalization", () => {
    const src = source();

    assert.match(src, /const MIN_ENTITY_NORMALIZED_SCORE = 0\.3/);
    assert.match(src, /const rawSemanticCandidates = entityResult\.results\.filter\(\s*\(r\) => r\.score > 0,\s*\)/);
    assert.match(src, /const normalizedScore = r\.score \/ norm/);
    assert.match(
      src,
      /normalizedScore < MIN_ENTITY_NORMALIZED_SCORE/,
    );
  });

  it("keeps lexical diversity slots even when semantic fills its lane", () => {
    const src = source();

    assert.match(src, /const lexicalTargetCap = semanticDisabled/);
    assert.match(
      src,
      /Math\.max\(diversityReserve, preFeedbackCap - sourceCounts\.semantic\)/,
    );
    assert.match(src, /sourceCounts\.lexical < lexicalTargetCap/);
    assert.match(src, /sourceCounts\.lexical >= lexicalTargetCap/);
  });
});
