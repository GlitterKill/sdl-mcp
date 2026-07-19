# Generic Tool-Contract Candidate Seeding Design

## Status

Approved by the user on 2026-07-19.

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

`buildActionSeedQueries()` evaluates three bounded intent groups before its current early return:

1. Tool-surface intent matches `/\b(?:tools?|schemas?|descriptors?|registr(?:ation|ations|y|ies))\b/i`.
2. Contract-quality intent matches `/\b(?:contracts?|projections?|determinism|deterministic)\b/i`.
3. Review intent matches `/\b(?:review|reviews|reviewing|audit|audits|auditing|qa|determinism|deterministic)\b/i`.

A generic fallback activates only when all three groups match. Requests such as `debug tool output formatting` and `fix schema response error` remain inactive because they lack review intent. `review tool output formatting` also remains inactive because output formatting alone is not a contract-quality marker.

When the task names no catalog action, the function returns an empty list unless the narrow generic predicate matches. When it matches, the function continues with an empty ranked-action list and emits exactly the existing projection seed query. The response-test query remains gated on `rankedActions.length > 0`, so generic prompts containing `test` or `tests` still emit one query.

Named-action requests keep their current ranking, handler queries, projection behavior, response-test behavior, limits, deduplication, and ordering. The first implementation changes only control flow and the narrow predicate. It does not alter the existing projection query text.

If the unchanged query fails the live 4-of-5 acceptance threshold, implementation stops for a new design decision instead of adding vocabulary.

## Data flow

1. `buildSeedContext()` calls `buildSeedEntitySearchPlan(task.taskText, isBroad)`.
2. `buildSeedEntitySearchPlan()` derives `toolQaFocused`, entity types, FTS augmentation, and calls `buildActionSeedQueries(taskText)`.
3. The narrow conjunctive predicate decides whether a generic task may enter the existing action-seed lane.
4. The existing projection query joins the bounded lexical query plan.
5. Existing entity, lexical, graph-expansion, ranking, and response-projection stages remain unchanged.

## Verification

The canonical live request uses:

- task type `review`;
- task text `Review the current SDL-MCP tool surface for contracts, output noise, deterministic responses, and safe errors.`;
- broad context mode;
- semantic retrieval enabled;
- retrieval evidence enabled;
- evidence optimization disabled;
- task-detail cards;
- no focus paths;
- diagnostics disabled.

The top ten are the first ten `symbolCard` entries in `finalEvidence` order. Acceptance compares these exact name/path pairs:

- `buildFlatToolDescriptors` — `src/mcp/tools/tool-descriptors.ts`;
- `registerTool` — `src/server.ts`;
- `buildToolResponseEnvelope` — `src/server.ts`;
- `asStructuredContent` — `src/server.ts`;
- `handleRuntimeQueryOutput` — `src/mcp/tools/runtime-query.ts`.

The baseline contains zero of those five pairs. For the noise exclusion, a seed-evaluator symbol is any `symbolCard` whose repository-relative path is `scripts/evaluate-seed-resolution.ts`; the exclusion is path-based rather than name-based.

A test-first regression passes the literal task text to `buildActionSeedQueries()` and expects the current implementation to return no action seeds. After the change, the prompt returns exactly the existing projection query.

Additional regressions require:

- `debug tool output formatting` returns no generic action seed;
- `fix schema response error` returns no generic action seed;
- `review tool output formatting` returns no generic action seed;
- tool-surface review without contract-quality intent returns no generic action seed;
- contract-quality review without tool-surface intent returns no generic action seed;
- an activated generic prompt containing `tests` still emits exactly one unchanged projection query;
- named-action seed output remains deeply equal to its pre-change value;
- query count, deduplication, and ordering stay deterministic.

The existing ranking suite, context-quality acceptance, and seed-resolution benchmark must not regress. Live verification requires:

- at least four of the five exact expected name/path pairs in the top ten;
- no top-ten `symbolCard` path begins `outputs/logos/`, and none equals `scripts/evaluate-seed-resolution.ts`;
- an `outputs/logos` focus run uses the canonical task type and text, `contextMode: "precise"`, `focusPaths: ["outputs/logos"]`, `semantic: true`, `includeRetrievalEvidence: true`, `evidenceOptimization: "off"`, `cardDetail: "task"`, and diagnostics disabled; at least one of its first ten `symbolCard` entries must have a path beginning `outputs/logos/`;
- a separate `scripts` focus run uses the same options with `focusPaths: ["scripts"]`; at least one of its first ten `symbolCard` entries must have a path beginning `scripts/`;
- graph integrity remains verified.

## Failure handling

If the unchanged projection query does not meet the live threshold, stop. Do not add a second query, change semantic thresholds, deepen ranking penalties, or add diagnostic fields under this design.

## Documentation impact

The final QA report records the early-return root cause, the narrow activation predicate, observed benchmark results, and any evidence-backed stop. Public tool documentation changes only if behavior reaches acceptance.
