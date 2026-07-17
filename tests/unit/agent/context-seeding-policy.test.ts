import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = () =>
  readFileSync(join(process.cwd(), "src/agent/context-seeding.ts"), "utf8");
const symbolSource = () =>
  readFileSync(join(process.cwd(), "src/db/ladybug-symbols.ts"), "utf8");

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
    const lexicalCap = src.indexOf(
      "Math.max(lexicalTargetCap, preservedScopedSeedRefs.size)",
      scopeFilter,
    );
    const finalCap = src.indexOf(".slice(0, maxSeeds)", scopeFilter);

    assert.ok(scopeFilter >= 0, "expected production scope-filter call");
    assert.ok(primaryCap > scopeFilter, "semantic cap must follow scope filter");
    assert.ok(lexicalCap > scopeFilter, "lexical cap must follow scope filter");
    assert.ok(finalCap > scopeFilter, "final cap must follow scope filter");
  });

  it("loads precise lexical candidates through one scope-first symbol pool", () => {
    const src = source();

    assert.match(src, /getScopedSearchSymbolPool/);
    assert.match(src, /searchSymbolsLiteQueriesInPool/);
    assert.doesNotMatch(src, /getFilesByPrefix/);
    assert.doesNotMatch(src, /getExportedSymbolsLiteByFileIds/);
    assert.match(src, /const useScopedPreciseLexical/);
  });

  it("retains scoped lexical concepts for forced semantic precise requests", () => {
    const src = source();

    assert.match(
      src,
      /const useScopedPreciseLexical =\s*collectBeforeCaps && !isBroad;/,
    );
  });

  it("uses only complete concept coverage instead of redundant scoped seeds", () => {
    const src = source();

    assert.match(src, /completeScopedConceptRefs/);
    assert.match(src, /conceptSelection\.complete/);
    assert.match(src, /preservedScopedSeedRefs\.has\(candidate\.contextRef\)/);
  });

  it("keeps general scoped feedback behavior", () => {
    const src = source();

    assert.match(
      src,
      /const shouldQueryFeedbackBoosts =\s*collectBeforeCaps \|\|\s*!forceSemanticEntitySearch \|\|\s*taskMentionsFeedback \|\|/,
    );
    assert.doesNotMatch(src, /!useScopedPreciseLexical \|\| taskMentionsFeedback/);
  });

  it("falls back to global lexical lanes only when the scoped pool query fails", () => {
    const src = source();

    assert.match(src, /let scopedLexicalResults:[\s\S]*\| undefined/);
    assert.match(src, /const usingScopedLexicalPool =\s*useScopedPreciseLexical && scopedLexicalResults !== undefined/);
    assert.equal(src.match(/await useScopedResultsOrFallback\(/g)?.length, 3);
    assert.match(src, /\(\) => searchSymbols\(conn, task\.repoId, query, 4\)/);
    assert.match(src, /: searchSymbols\(\s*conn,[\s\S]*?compoundQuery/);
    assert.match(src, /: searchSymbols\(conn, task\.repoId, term, perTermLimit\)/);
    assert.match(src, /const candidatesNeedingScopeResolution = usingScopedLexicalPool/);
  });

  it("short-circuits path resolution when no candidates need filtering", () => {
    assert.match(
      source(),
      /if \(candidates\.length === 0\) return new Map<string, string>\(\)/,
    );
  });

  it("keeps the scope pool to one deterministic unbounded DB query", () => {
    const src = symbolSource().replaceAll("\r\n", "\n");
    const start = src.indexOf("export async function getScopedSearchSymbolPool");
    const end = src.indexOf("\n}\n", start);

    assert.ok(start >= 0, "expected scoped symbol pool query");
    assert.ok(end > start, "expected scoped symbol pool query body");

    const body = src.slice(start, end + 3);
    assert.equal(body.match(/queryAll</g)?.length, 1);
    assert.doesNotMatch(body, /\bLIMIT\b/);
    assert.match(body, /ORDER BY f\.relPath ASC, s\.symbolId ASC/);
  });
});
