# Generic Tool-Contract Vocabulary Design

## Status

The user approved the architecture, testing, and failure behavior on 2026-07-19. The written specification awaits final user review.

## Context

The generic tool-contract fallback currently emits the single query `context response projection`. A restarted-server probe concentrated the first six results on response-projection helpers and removed the historical generated-output noise, but it returned none of the five accepted contract symbols.

The current fallback is intentionally narrow. It activates only when a task names no catalog action and matches bounded tool-surface, contract-quality, and review intent. Named-action tasks already produce useful handler, schema, projection, and response-test queries and must remain byte-identical.

## Goal

Extend only the generic no-action projection query with bounded domain vocabulary that represents the five missing contract concepts without naming their implementation symbols.

## Non-goals

- Do not change named-action queries, ordering, limits, deduplication, or response-test behavior.
- Do not add a second query, retrieval lane, scorer, ranking weight, threshold, configuration field, response field, or diagnostic.
- Do not add exact symbol names, file paths, action names, or repository-specific identifiers.
- Do not change response serialization, tool schemas, catalog metadata, database state, or focus-path behavior.
- Do not broaden the generic activation predicate.

## Architecture

`buildActionSeedQueries()` remains the only changed production boundary. The function keeps the existing generic activation predicate and projection-query branch.

When `useGenericToolContractFallback` is true, the projection query appends this static ordered vocabulary:

```text
tool descriptor registration response envelope structured content output schema runtime query
```

The complete generic query becomes:

```text
context response projection tool descriptor registration response envelope structured content output schema runtime query
```

When `useGenericToolContractFallback` is false, the projection query continues to append the existing ranked-action terms. The implementation must not route named-action requests through the static vocabulary.

A fixed literal is the smallest deterministic option. Two specialized queries would compete for retrieval budget, while catalog-derived vocabulary would make generic query text change when the catalog changes.

## Data flow

1. `buildActionSeedQueries()` detects catalog action mentions.
2. The existing three-group predicate decides whether a no-action task is a generic tool-contract review.
3. The existing projection branch selects either the static generic vocabulary or the current ranked-action terms.
4. `buildSeedEntitySearchPlan()` appends the first action-seed query to the task-derived FTS query.
5. Existing lexical, semantic, graph-expansion, ranking, and response-projection stages run unchanged.

The static term order is contract surface. Repeated calls against unchanged input must return the same string and query count.

## Behavior invariants

The canonical generic task returns exactly one action-seed query with the complete vocabulary string.

A generic task containing `test` or `tests` still returns one query and does not emit the empty generic `response` query.

The existing named-action prompt `Review runtime.queryOutput output contract tests` retains these exact queries and order:

1. `handleRuntimeQueryOutput RuntimeQueryOutputRequestSchema RuntimeQueryOutputResponseSchema runtimeQueryOutput runtime.queryOutput`
2. `context response projection runtimeQueryOutput runtime queryOutput`
3. `response runtime queryOutput`

Existing negative prompts remain inactive:

- `debug tool output formatting`
- `fix schema response error`
- `review tool output formatting`
- `review tool registration safety`
- `debug tool contract formatting`
- `audit response contracts for application output`

## Verification

Test-first verification updates the focused action-seeding suite before production code. The unchanged build must fail only the new generic vocabulary expectation while the named-action and negative cases remain green.

After implementation:

- the focused action-seeding suite passes;
- context-ranking and context-quality suites do not regress;
- typecheck and lint report no new errors;
- the seed-resolution artifact check passes;
- context-assembly recall remains at least `0.375`;
- slice-start recall remains at least `0.917`;
- autopilot explicit-scope recall remains `1`;
- every existing named-action FTS query remains byte-identical.

Live verification uses the same canonical broad request as the prior probe: review task type, broad mode, semantic retrieval and retrieval evidence enabled, evidence optimization off, task-detail cards, no focus paths, and diagnostics disabled.

The first ten `symbolCard` entries must contain at least four exact name/path pairs:

- `buildFlatToolDescriptors` — `src/mcp/tools/tool-descriptors.ts`
- `registerTool` — `src/server.ts`
- `buildToolResponseEnvelope` — `src/server.ts`
- `asStructuredContent` — `src/server.ts`
- `handleRuntimeQueryOutput` — `src/mcp/tools/runtime-query.ts`

No first-ten path may begin `outputs/logos/` or equal `scripts/evaluate-seed-resolution.ts`.

Two precise focus guards use the same request and change only `contextMode` plus `focusPaths`:

- `focusPaths: ["outputs/logos"]` returns a first-ten path beginning `outputs/logos/`.
- `focusPaths: ["scripts"]` returns a first-ten path beginning `scripts/`.

Graph integrity must remain `verified`, and the fresh index must contain the edited `buildActionSeedQueries` range.

## Failure handling

If the live canonical request returns fewer than four expected pairs, revert only the static vocabulary change through a normal corrective commit. Keep the previously verified generic fallback, tests, benchmark artifact, and design history.

Record the failed vocabulary experiment in the ignored local QA report. Do not add more vocabulary, a second query, ranking changes, thresholds, or diagnostics during the same implementation cycle.

If a named-action byte comparison, negative boundary, noise exclusion, focus guard, benchmark floor, or graph-integrity check fails, stop and fix or revert the vocabulary change before acceptance.

## Documentation impact

Update the ignored local QA report with the vocabulary, automated results, live first-ten evidence, focus guards, and final accepted or reverted status. Public tool documentation and response fixtures remain unchanged because the tool surface does not change.
