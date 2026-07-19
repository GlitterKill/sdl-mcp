# Generic Tool-Contract Candidate Seeding Design

## Status

Approved in conversation on 2026-07-19.

## Context

The live broad review prompt asks SDL-MCP to review tool contracts, output noise, deterministic responses, and safe errors. The verified graph indexes all five expected contract symbols, and focused retrieval returns them. Broad retrieval removes generated-output noise after commit `c4c71ec6`, but it still selects none of the expected symbols in its top ten.

The failure occurs before path ranking. `buildActionSeedQueries()` returns an empty query list when the task does not name a catalog action. That early return prevents the function's existing output-contract projection query from running for generic tool-surface QA.

## Goal

Allow generic tool-contract QA to use the existing action-seeding projection query without changing named-action behavior, adding a retrieval lane, or introducing another ranking scorer.

## Non-goals

- Do not add symbol names or tool-specific vocabulary to ranking.
- Do not change response payloads, diagnostics, schemas, tool order, or database state.
- Do not broaden generic seeding to ordinary output formatting or application debugging.
- Do not add configuration or a reusable abstraction for one predicate.

## Design

`buildActionSeedQueries()` determines two independent conditions before its current early return:

1. Tool-surface intent matches bounded terms such as tool, schema, descriptor, or registration.
2. Contract QA intent matches bounded terms such as contract, output, response, determinism, or error.

When the task names no catalog action, the function returns an empty list unless both conditions are true. When both conditions are true, the function continues with an empty ranked-action list and emits its existing projection seed query. Named-action requests keep their current ranking, handler queries, projection behavior, limits, and ordering.

The first implementation changes only control flow. It does not alter the existing projection query text. If the unchanged query fails the live 4-of-5 acceptance threshold, implementation stops for a new design decision instead of adding vocabulary.

## Data flow

1. `buildSeedContext()` calls `buildActionSeedQueries(task.taskText)`.
2. The narrow conjunctive predicate decides whether a generic task may enter the existing action-seed lane.
3. The existing projection query joins the bounded lexical query plan.
4. Existing entity, lexical, graph-expansion, ranking, and response-projection stages remain unchanged.

## Verification

A test-first regression uses the exact live QA prompt and expects the current implementation to return no action seeds. After the change, the prompt returns exactly the existing projection query.

Additional regressions require:

- ordinary output formatting or debugging without tool-surface intent returns no generic action seed;
- tool-surface discussion without contract QA intent returns no generic action seed;
- named-action seed output remains deeply equal to its pre-change value;
- query count and ordering stay deterministic.

The existing ranking suite, context-quality acceptance, and seed-resolution benchmark must not regress. Live verification requires:

- at least four of `buildFlatToolDescriptors`, `registerTool`, `buildToolResponseEnvelope`, `asStructuredContent`, and `handleRuntimeQueryOutput` in the top ten;
- no `outputs/logos` or seed-evaluator symbols in the top ten;
- explicit `outputs/logos` and `scripts` focus remains retrievable;
- graph integrity remains verified.

## Failure handling

If the unchanged projection query does not meet the live threshold, stop. Do not add a second query, change semantic thresholds, deepen ranking penalties, or add diagnostic fields under this design.

## Documentation impact

The final QA report records the early-return root cause, the narrow activation predicate, observed benchmark results, and any evidence-backed stop. Public tool documentation changes only if behavior reaches acceptance.
