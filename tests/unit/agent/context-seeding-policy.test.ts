import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = () =>
  readFileSync(join(process.cwd(), "src/agent/context-seeding.ts"), "utf8");
const symbolSource = () =>
  readFileSync(join(process.cwd(), "src/db/ladybug-symbols.ts"), "utf8");
const rankingSource = () =>
  readFileSync(join(process.cwd(), "src/agent/context-ranking.ts"), "utf8");

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

  it("carries bounded retrieval lanes into one merged candidate set", () => {
    const src = source();
    const pipeline = src.slice(src.indexOf("export async function buildSeedContext"));

    assert.match(pipeline, /mergeContextSeedCandidates\(allCandidates\)/);
    assert.doesNotMatch(pipeline, /collectBeforeCaps/);
    assert.doesNotMatch(pipeline, /lexicalTargetCap/);
    assert.doesNotMatch(pipeline, /primarySourceCap/);
  });

  it("defers explicit scope and card caps to the final selector", () => {
    const src = source();
    const seedPipeline = src.slice(src.indexOf("export async function buildSeedContext"));
    const ranking = rankingSource();

    assert.doesNotMatch(seedPipeline, /filterSeedCandidatesToScope\(/);
    assert.doesNotMatch(seedPipeline, /selectPreservedSeedCandidates\(/);
    assert.match(ranking, /export function selectFinalSymbols/);
    assert.match(ranking, /const inFocus = rankedIds\.filter\(matchesExplicit\)/);
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
      /const useScopedPreciseLexical =\s*scopePaths\.length > 0 && !isBroad;/,
    );
  });

  it("preserves resolved scoped concepts without an early candidate cap", () => {
    const src = source();

    assert.match(src, /conceptSelection\.resolvedRefs/);
    assert.match(src, /preservedScopedSeedRefs\.add\(ref\)/);
    assert.doesNotMatch(src, /completeScopedConceptRefs/);
  });

  it("keeps bounded feedback evidence available for the final selector", () => {
    const src = source();
    const pipeline = src.slice(src.indexOf("export async function buildSeedContext"));

    assert.match(pipeline, /await queryFeedbackBoosts/);
    assert.doesNotMatch(pipeline, /shouldQueryFeedbackBoosts/);
    assert.doesNotMatch(pipeline, /sourceCounts\.feedback >= feedbackCap/);
  });

  it("falls back to global lexical lanes only when the scoped pool query fails", () => {
    const src = source();

    assert.match(src, /let scopedLexicalResults:[\s\S]*\| undefined/);
    assert.match(src, /const usingScopedLexicalPool =\s*useScopedPreciseLexical && scopedLexicalResults !== undefined/);
    assert.equal(src.match(/await useScopedResultsOrFallback\(/g)?.length, 3);
    assert.match(src, /\(\) => searchSymbols\(conn, task\.repoId, query, 4\)/);
    assert.match(src, /: searchSymbols\(\s*conn,[\s\S]*?compoundQuery/);
    assert.match(src, /: searchSymbols\(conn, task\.repoId, term, perTermLimit\)/);
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
