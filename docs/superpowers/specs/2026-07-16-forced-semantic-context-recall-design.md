# Forced-Semantic `sdl.context` Recall Design

## Goal

Raise expected-symbol recall for the existing 26-case `sdl.context` benchmark from 56.5% to at least 85% when callers explicitly set `options.semantic: true`. Among implementations that meet the recall target, keep the one with the shortest measured wall time.

## Scope

The behavior change is limited to forced-semantic `sdl.context` seeding. Default `sdl.context`, `semantic: false`, shared retrieval functions, MCP schemas, and every other tool keep their current behavior.

The existing benchmark cases and fixtures remain authoritative and unchanged. The forced-semantic gate becomes:

- semantic aggregate expected-symbol recall: at least 85%;
- noise rate: no more than 10%;
- failed cases: zero;
- forced-semantic precise/broad recall breakdowns and forced-semantic latency percentiles are report-only;
- the separate default scoped-precise latency gate remains unchanged;
- wall time is measured for every candidate implementation, with no fixed threshold.

Production code must not contain benchmark case IDs, expected symbol lists, or case-specific path mappings.

## Chosen Approach

Start with the existing bounded lexical lane inside `buildSeedContext`, guarded by `task.options?.semantic === true`.

The current forced-semantic path builds compound and individual lexical queries, then skips them whenever `semanticLaneHasCoverage` is true. The first implementation candidate removes that suppression so forced-semantic calls combine the existing semantic and bounded lexical candidates. If this reaches 85%, no new selector is added.

Only if the existing lane remains below 85%, add bounded concept coverage from the lexical result batches already produced by that lane:

- `extractIdentifiersFromText` and the existing FTS query normalization;
- `buildSeedEntitySearchPlan` action queries;
- existing `searchSymbols` result batches;
- `selectFirstUnseenPerBatch` for deterministic one-per-query coverage;
- the current `ContextSeedCandidate` shape and final score ordering.

This fallback does not assume names, paths, or summaries are present on semantic candidates. If later measurement proves metadata hydration necessary, hydrate symbol rows once with the existing batched `getSymbolsByIds` query and count its wall-time cost before keeping it. No new retrieval service, schema, configuration knob, or dependency is introduced.

## Data Flow

1. Run the existing forced-semantic `entitySearch` exactly once.
2. Run the existing bounded action, compound, and individual lexical queries instead of suppressing them after semantic coverage.
3. Merge and cap candidates through the existing deterministic score order.
4. Measure recall and wall time. Stop here if recall is at least 85%.
5. If recall is still low, for unscoped forced-semantic calls only, execute every query in the existing bounded lexical plan, preserve the first unique result from each batch, then fill remaining slots in semantic/lexical score order. Scoped collect-before-cap behavior remains unchanged.
6. Pass the result through the unchanged executor and evidence pipeline.

Query count and candidates remain bounded by existing precise/broad limits and seed caps. Negated clauses keep the existing non-pruning behavior.

## Isolation

The changed branch is entered only when `forceSemanticEntitySearch` is true. Shared functions such as `entitySearch`, `hybridSearch`, and `searchSymbols` are called through their existing contracts and are not modified.

Regression tests must prove:

- omitted `semantic` retains current default selection;
- `semantic: false` retains current lexical-only selection;
- other MCP tool descriptions, schemas, and deterministic outputs do not change.

## Failure Handling

The lexical lane remains an accuracy enhancement, not a new failure boundary. If its queries return nothing or fail, selection falls back to the existing semantic order. Existing retrieval exceptions remain non-fatal and continue through current logging and fallback behavior.

## Measurement and Testing

Implementation follows red-green-refactor:

1. Persist a case-level forced-semantic diagnostic showing current misses and wall time.
2. Run the live benchmark and record the 56.5% red baseline without changing fixtures.
3. Add a synthetic unit regression proving forced-semantic uses the existing lexical lane while omitted/false semantic modes retain their behavior.
4. Remove the `semanticLaneHasCoverage` suppression and rerun the live benchmark.
5. Stop if recall reaches 85%. Otherwise add deterministic one-per-lexical-batch coverage, starting with another failing synthetic unit test.
6. Change only the forced-semantic benchmark contract so aggregate recall, noise, and failures are its hard gates; forced-semantic precise/broad recall and latency remain visible but report-only. Preserve the separate default scoped-precise latency gate.
7. Compare implementations using the same built commit, config, and fresh clones of one pinned logical index snapshot. For each candidate, run one discarded warm-up followed by three measured 26-case forced-semantic passes on its clone, with no refresh/reindex or concurrent repo workload; select the lowest median total wall time among candidates reaching 85%. LadybugDB checkpoint mtimes are not treated as corpus fingerprints.
8. Verify the full test suite, goldens, determinism, typecheck, lint, docs inventory, and a fresh-process MCP call with `semantic: true`.

The final report includes baseline versus final recall, noise, failed cases, p50, p95, and total benchmark wall time.

## Documentation

Update `docs/feature-deep-dives/context-modes.md`, `docs/benchmark-guardrails.md`, and `CHANGELOG.md` for the forced-semantic aggregate-only gate and caller-observable behavior. No other tool documentation should change.

## Measured Amendment: Same-File Related Symbols

The first candidate improved the pinned-index baseline from 54.0% to 54.8%. The deterministic one-per-query fallback reduced recall to 52.4% and nearly doubled forced-semantic total wall time from 42.5 seconds to 71.9 seconds, so it is rejected.

Case-level misses show that additional prompt-term searches are the wrong lever. Most missing symbols are siblings of already-relevant cards in the same file, such as `ContextEngine` with truncation helpers, planner budget methods together, executor rung methods together, and skeleton helpers together.

The next bounded candidate therefore reuses `Executor.buildRelatedSymbolNameMap()`, which already loads and relevance-ranks same-file symbols for forced-semantic context cards. It changes only the forced-semantic related-name cap from 14 to 32; inferred-focus/default calls retain 14. This adds no database query, no retrieval batch, and no new response field. A runtime unit test must prove the forced-semantic cap and unchanged inferred-focus cap before measurement.

That cap-only candidate also produced 54.8%, proving the missing names do not reach final evidence through the current related-name selection. It is rejected.

## Measured Amendment: Preserve Exact Mentions Through Executor Ranking

Case-level evidence shows a more direct loss boundary: `ContextEngine.seedExactMentionedSymbols()` resolves and prepends exact symbol refs to `context`. `Executor.resolveContextToSymbols()` normally turns direct symbol refs into lexical score-1 candidates, but skips that upgrade when the same ref already exists as a lower-scored semantic candidate. Under forced semantic, that duplicate semantic candidate can therefore displace an exact resolved symbol such as `adjustForBudget` before evidence is built.

The next candidate retains the existing exact lookup and query count, but for `semantic: true` only, prepends resolved exact symbol refs to all existing `seedCandidates` as lexical score-1 candidates with `sourceRank: -1000 + exactIndex`, then removes only later candidates with duplicate exact refs before calling `Executor.execute()`. Unrelated semantic, lexical, and feedback candidates preserve their order and scores. Omitted and false modes keep the current seed-candidate list. A runtime ContextEngine test must use a duplicate exact/semantic ref and prove the executor receives the lexical score-1 version.

That exact-prior candidate also produced 54.8%. Executor-boundary tracing showed why: exact candidates already entered ranking at lexical score 1, but `ensureFocusPathCoverage()` subsequently replaced every non-focus selection when several inferred paths were present. It is rejected.

## Measured Amendment: Bound Forced-Semantic Inferred Coverage

Inferred paths are soft hints, but the current per-path addition limit can cumulatively fill the entire final selection. For a forced-semantic planner-budget case, `adjustForBudget` entered ranking first at score 1, then three inferred hot-path/util paths replaced it and every other non-focus result.

The next candidate changes only `semantic: true`: inferred-path additions may occupy at most `Math.ceil(maxCount / 2)`, preserving at least `Math.floor(maxCount / 2)` of the already-ranked retrieval selection. Per-path ordering and matching stay unchanged. Omitted and false modes retain the current cumulative per-path behavior. This adds no query, candidate, response field, or schema change.

That finalization-only cap also produced 54.8%. Tracing showed the inferred paths had already been copied into `focusPaths` and dominated `rankSymbols()` before finalization, so there were no ranked non-focus results left to preserve.

## Measured Amendment: Separate Forced-Semantic Ranking From Inferred Coverage

The next candidate combines the bounded finalization cap with a ranking-only task view. When `semantic: true` and `inferredFocusPaths` are present, `Executor.selectTopSymbols()` calls `rankSymbols()` without those inferred `focusPaths`/`inferredFocusPaths`; it still passes the original task to finalization, which may fill at most `Math.ceil(maxCount / 2)` slots from the inferred paths. Explicit focus paths are never removed because they do not carry `inferredFocusPaths`.

This preserves retrieval/lexical ranking for at least `Math.floor(maxCount / 2)` results while keeping bounded inferred coverage. Omitted and false modes use the original ranking task and unlimited inferred additions. No query, schema, response field, or other tool changes.

## Selected Amendment: Repair and Bound Forced-Semantic File Outlines

The combined ranking/coverage candidate reached only 56.5%. The decisive trace was in `Executor.buildRelatedSymbolNameMap()`: selected production symbols carry opaque file IDs, but the inferred-path filter compared those IDs directly with repository-relative paths. Forced-semantic requests with inferred paths therefore discarded every selected file before building related-name evidence.

The selected implementation bypasses that invalid path comparison only for `semantic: true`; the selected symbols have already passed forced-semantic ranking and bounded inferred coverage. It orders forced-semantic outline files deterministically by repository path and source range. For the first card in each selected file, it emits one outline containing up to 80 query-ranked names, then declarative and source-order names up to 160 total. Only the first ordered file adds a dependency sample, using at most 80 source symbols, 512 deterministically selected dependency candidates, and 24 emitted dependency names through one bounded LadybugDB read. Omitted and false modes retain DB-map ordering, the existing inferred-path filter, the 14-name related-symbol limit, and card behavior.

Candidate ablation selected a forced-semantic precise cap of 20 cards. After separate discarded warmups, the normal cap measured 48.037, 48.232, and 48.647 seconds (median 48.232 seconds) at 108/124 recall, while the 20-card cap measured 47.905, 47.969, and 48.843 seconds (median 47.969 seconds) at 109/124 recall. The selected cap was therefore 0.263 seconds faster by the required median comparison and recovered one more expected symbol. All selected-candidate passes had one configured-noise hit across 601 evidence items (0.2%) and zero failures; p50 ranged from 1478 to 1536 ms and p95 from 2805 to 2890 ms. These are expected-symbol recall and corpus-specific configured-noise measurements, not a general precision estimate.

`SDL_CONTEXT_QUALITY_VARIANT=semantic` runs only the forced-semantic corpus and gates for candidate measurement. The normal full benchmark continues to enforce the separate unchanged default scoped-precise p95 gate.
