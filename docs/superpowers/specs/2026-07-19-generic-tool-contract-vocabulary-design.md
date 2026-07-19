# Generic Tool-Contract Vocabulary Design

## Status

The user approved the architecture, testing, failure behavior, and written specification on 2026-07-19.

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

The unit comparison surface is that exact three-element action-seed array for the named-action prompt. The benchmark comparison surface is separate: for every existing case ID in `devdocs/benchmarks/seed-resolution-evaluation-v1.json`, `cases[*].contextAssembly.ftsQuery` must equal the pre-change artifact value. The vocabulary experiment must not change either surface.

Existing negative prompts remain inactive:

- `debug tool output formatting`
- `fix schema response error`
- `review tool output formatting`
- `review tool registration safety`
- `debug tool contract formatting`
- `audit response contracts for application output`

Each negative prompt must return exactly `[]` from `buildActionSeedQueries()`.

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

Before the benchmark writer runs, read and retain `devdocs/benchmarks/seed-resolution-evaluation-v1.json`. Run `npm.cmd run benchmark:seed-resolution`, inspect the named quality and FTS-query fields against the retained artifact, then run `node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check`. Restore the retained artifact with `sdl.file.write` and stop if any gate fails.

The pre-change live baseline is repository version `v1784483895766`, graph integrity `verified`, and `buildActionSeedQueries` ending at line 285. After restart and fresh indexing, `repo.status` must report a different latest version, `stale: false`, `graphIntegrityState: "verified"`, and a graph-integrity version equal to the latest version. `symbol.getCard` for `buildActionSeedQueries` must report that same ledger version. The canonical result below proves that the restarted server executes the new query behavior.

Live verification calls `sdl.context` with this exact canonical request:

```json
{
  "repoId": "sdl-mcp",
  "taskType": "review",
  "taskText": "Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.",
  "options": {
    "contextMode": "broad",
    "semantic": true,
    "includeRetrievalEvidence": true,
    "evidenceOptimization": "off",
    "cardDetail": "task"
  },
  "includeDiagnostics": false
}
```

The first ten `symbolCard` entries must contain at least four exact name/path pairs:

- `buildFlatToolDescriptors` — `src/mcp/tools/tool-descriptors.ts`
- `registerTool` — `src/server.ts`
- `buildToolResponseEnvelope` — `src/server.ts`
- `asStructuredContent` — `src/server.ts`
- `handleRuntimeQueryOutput` — `src/mcp/tools/runtime-query.ts`

No first-ten path may begin `outputs/logos/` or equal `scripts/evaluate-seed-resolution.ts`.

Copy the canonical request twice. Set `options.contextMode` to `"precise"`, add the listed `options.focusPaths`, and preserve every other field:

- `focusPaths: ["outputs/logos"]` returns a first-ten path beginning `outputs/logos/`.
- `focusPaths: ["scripts"]` returns a first-ten path beginning `scripts/`.

Graph integrity must remain `verified`, and the fresh index must contain the edited `buildActionSeedQueries` range.

## Failure handling

If the live canonical request returns fewer than four expected pairs, create a normal corrective commit that restores the production generic query to `context response projection`. Restore the generic positive test expectation to that prior query while retaining the generic activation, generic-`tests`, negative-boundary, and named-action regressions. The focused suite must pass after correction.

Restore the retained pre-experiment benchmark artifact and verify it with `node --experimental-strip-types scripts/evaluate-seed-resolution.ts --check`. Keep the experiment and corrective commits in design history.

Record the failed experiment in `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md`. `git check-ignore -v` must identify the `devdocs/*` rule; preserve the updated local file and never force-add it. Do not add more vocabulary, a second query, ranking changes, thresholds, or diagnostics during the same implementation cycle.

If a named-action byte comparison, negative boundary, noise exclusion, focus guard, benchmark floor, or graph-integrity check fails, stop and fix or revert the vocabulary change before acceptance.

## Documentation impact

Update the ignored local report `devdocs/qaplans/2026-07-18-sdl-tool-qa-live-v0-12-4.md` with the vocabulary, automated results, live first-ten evidence, focus guards, and final accepted or reverted status. Preserve it outside tracked Git state under the existing `devdocs/*` ignore rule. Public tool documentation and response fixtures remain unchanged because the tool surface does not change.
