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
7. Compare implementations using the same built commit, config, and immutable index. For each candidate, run one discarded warm-up followed by three measured 26-case forced-semantic passes with no concurrent repo workload; select the lowest median total wall time among candidates reaching 85%.
8. Verify the full test suite, goldens, determinism, typecheck, lint, docs inventory, and a fresh-process MCP call with `semantic: true`.

The final report includes baseline versus final recall, noise, failed cases, p50, p95, and total benchmark wall time.

## Documentation

Update `docs/feature-deep-dives/context-modes.md`, `docs/benchmark-guardrails.md`, and `CHANGELOG.md` for the forced-semantic aggregate-only gate and caller-observable behavior. No other tool documentation should change.
