# Forced-Semantic `sdl.context` Recall Design

## Goal

Raise expected-symbol recall for the existing 26-case `sdl.context` benchmark from 56.5% to at least 85% when callers explicitly set `options.semantic: true`. Among implementations that meet the recall target, keep the one with the shortest measured wall time.

## Scope

The behavior change is limited to forced-semantic `sdl.context` seeding. Default `sdl.context`, `semantic: false`, shared retrieval functions, MCP schemas, and every other tool keep their current behavior.

The existing benchmark remains authoritative:

- semantic aggregate expected-symbol recall: at least 85%;
- noise rate: no more than 10%;
- failed cases: zero;
- fixtures and expected symbols stay unchanged;
- wall time is measured for every candidate implementation, but has no fixed threshold.

Production code must not contain benchmark case IDs, expected symbol lists, or case-specific path mappings.

## Chosen Approach

Add bounded concept-coverage selection inside `buildSeedContext`, guarded by `task.options?.semantic === true`.

The current forced-semantic path can stop after the semantic lane has filled its quota. That preserves high-scoring candidates but can let several candidates cover the same phrase while other task concepts receive no seed. The new selection step will preserve one strong candidate for each distinct task concept, then fill remaining slots in the current score order.

The implementation reuses existing query and ranking machinery:

- `extractIdentifiersFromText` and the existing FTS query normalization;
- `buildSeedEntitySearchPlan` action queries;
- the current `entitySearch` result pool and `ContextSeedCandidate` shape;
- existing lexical `searchSymbols` only if the semantic pool cannot cover a concept.

No new retrieval service, schema, configuration knob, or dependency is introduced.

## Data Flow

1. Run the existing forced-semantic `entitySearch` exactly once.
2. Derive a bounded, deterministic concept list from code-like identifiers, normalized task clauses, and existing action-seed queries.
3. Match concepts against the returned symbol/file-summary metadata already available to `sdl.context`.
4. Select at most one unique anchor per covered concept.
5. If a concept has no candidate in the semantic pool, issue the smallest bounded lexical query needed for that concept. Remove this fallback if measurement shows the existing pool alone reaches 85%.
6. Append remaining candidates in existing score and tie-break order until the normal seed cap is reached.
7. Pass the result through the unchanged executor and evidence pipeline.

Concept count, fallback query count, and candidates remain bounded by existing precise/broad seed caps. Negated clauses keep the existing non-pruning behavior.

## Isolation

The new branch is entered only when `forceSemanticEntitySearch` is true. Shared functions such as `entitySearch`, `hybridSearch`, and `searchSymbols` are called through their existing contracts and are not modified.

Regression tests must prove:

- omitted `semantic` retains current default selection;
- `semantic: false` retains current lexical-only selection;
- other MCP tool descriptions, schemas, and deterministic outputs do not change.

## Failure Handling

Concept coverage is an accuracy enhancement, not a new failure boundary. If concept extraction or a targeted lexical fallback returns nothing, selection falls back to the existing semantic order. Existing retrieval exceptions remain non-fatal and continue through current logging and fallback behavior.

## Measurement and Testing

Implementation follows red-green-refactor:

1. Persist a case-level forced-semantic diagnostic showing current misses and wall time.
2. Run the unchanged live benchmark and record the 56.5% red baseline.
3. Add focused unit tests for deterministic concept coverage, deduplication, caps, and the forced-semantic guard.
4. Implement the smallest coverage selector using only the existing semantic pool.
5. Run the live benchmark. Add bounded lexical fallback only if recall remains below 85%.
6. Compare wall time for every passing variant and retain the fastest.
7. Verify the full test suite, goldens, determinism, typecheck, lint, docs inventory, and a fresh-process MCP call with `semantic: true`.

The final report includes baseline versus final recall, noise, failed cases, p50, p95, and total benchmark wall time.

## Documentation

Update the `sdl.context` deep dive and `CHANGELOG.md` only if caller-observable forced-semantic behavior changes. No other tool documentation should change.

