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

    assert.match(
      src,
      /limit:\s*\(isBroad \? 32 : 16\) \*\s*\(scopePaths\.length > 0 \? 3 : 1\)/,
    );
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

  it("filters scoped candidates before source and final caps", () => {
    const src = source();
    const scopeFilter = src.indexOf(
      "const resolvedScopedCandidates = filterSeedCandidatesToScope(",
    );
    const primaryCap = src.indexOf(".slice(0, primarySourceCap)", scopeFilter);
    const lexicalCap = src.indexOf(".slice(0, lexicalTargetCap)", scopeFilter);
    const finalCap = src.indexOf(".slice(0, maxSeeds)", scopeFilter);

    assert.ok(scopeFilter >= 0, "expected production scope-filter call");
    assert.ok(primaryCap > scopeFilter, "semantic cap must follow scope filter");
    assert.ok(lexicalCap > scopeFilter, "lexical cap must follow scope filter");
    assert.ok(finalCap > scopeFilter, "final cap must follow scope filter");
  });

  it("uses the existing scoped file and symbol batches for precise lexical seeding", () => {
    const src = source();

    assert.match(src, /getFileIdsByRepoPaths/);
    assert.match(src, /getExportedSymbolsLiteByFileIds/);
    assert.match(src, /const useScopedPreciseLexical/);
  });

  it("only queries feedback for explicit feedback intent on the scoped fast path", () => {
    const src = source();

    assert.match(
      src,
      /\(!useScopedPreciseLexical \|\| taskMentionsFeedback\)/,
    );
  });

  it("does not re-resolve lexical candidates already loaded from explicit scope", () => {
    const src = source();

    assert.match(
      src,
      /const candidatesNeedingScopeResolution = useScopedPreciseLexical/,
    );
  });

  it("short-circuits path resolution when no candidates need filtering", () => {
    assert.match(
      source(),
      /if \(candidates\.length === 0\) return new Map<string, string>\(\)/,
    );
  });
});
