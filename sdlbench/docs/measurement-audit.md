# SDLBench measurement audit

Reviewed 2026-09-07. This audit covers source changes and offline regression verification. No paid agent benchmark was launched. An initial run of the pre-existing test suite entered a real SDL server/index path; that fixture dependency was replaced with a fake HTTP server for offline verification.

## Assessment

Fixture runs apply supplied solutions and test harness plumbing. They do not measure agent effectiveness. The corrections below improve measurement boundaries and reject unsupported comparisons; they do not establish live product savings or complete session observability.

## Findings and corrections

| Finding | Correction | Evidence boundary |
| --- | --- | --- |
| Pairing omitted repository identity and overwrote repeated passing records after discarding failures. | Shared pairing includes repository and execution conditions, experiment and repetition IDs, and provenance checks. Duplicate variants fail before pass-gating. | Missing historical provenance cannot be reconstructed from append order. |
| Scaling ran the whole matrix for every size and silently selected fixture mode. | Select tasks before execution, default scaling to behavior mode, propagate explicit mode, share pairing, record actual selected counts, and rotate variant order across repetitions. | Selected and jointly solved counts do not prove representativeness. |
| Provider counters were labeled as independently tokenized session content. | Schema v4 separates provider usage from independently counted observed prompt/output text, with coverage and tokenizer provenance. | Observed text is partial. It does not capture every request, schema, tool result, or hidden reasoning token. |
| Index response JSON was tokenized as indexing cost. | Remove that proxy. Record indexing time and keep unavailable enrichment, embedding, and indexing expenses unknown. | Actual provider expense and cold/amortized total-cost claims still need measured usage and rates. |
| Synchronous agent execution prevented in-process observability polling. | Run agents asynchronously with timeout/exit handling and await initial and final observability samples. | Fake-agent polling tests do not establish telemetry completeness on live servers. |

## Attempt and experiment contract

1. Assign experiment and repetition IDs before execution. Pair counterparts with the same IDs and recorded source, task, verifier, prompt, agent configuration, tokenizer, and pricing conditions. Reject ambiguous duplicates.
2. Run each task in a fresh environment. Scaling counterbalances variant order over repetitions. Warm-session execution is rejected until the server can prove that it indexes the exact agent worktree.
3. Preserve unsuccessful attempts, including timeouts and provider or verifier failures. Report success rates alongside conditional savings on jointly solved tasks. A fair experiment can show that SDL loses.
4. Keep provider usage separate from independently tokenized observed content. State missing coverage instead of inferring billed input from a transcript counted once.
5. Execute only implemented variants: `baseline` and `sdl`. Product lock declarations do not constitute integrations.

## Remaining evidence limits

Visible prompt/output tokenization does not provide complete, independently reconstructed model requests. Provider counters remain the billing-usage source. Provider-specific reasoning/output semantics need fixture verification and live confirmation before cross-provider cost claims.

Indexing time and model usage do not establish total indexing expense. Missing enrichment or embedding usage and prices remain unknown. There is no validated warm-session amortization experiment.

Edit coverage compares changed files with expected files, while symbol retrieval attribution describes a different observation. Neither establishes neutral retrieval relevance or independently graded answer quality. Review tasks can correctly inspect a file without editing it.

Timing fields have different boundaries: agent execution, runtime preparation and verification, and broader task wall time. They are not interchangeable. Likewise, phase attribution must not be interpreted as disjoint token buckets unless the provider and event data support that interpretation.

Repeated observations of a task are dependent. Paired uncertainty averages repetitions within repository/task clusters and bootstraps those equally weighted task means. It reports task and observation counts, with no interval for fewer than two independent tasks. Counterbalanced ordering helps control order effects; neither technique establishes that the task matrix represents real workloads.

## Compatibility and verification

Schema v4 distinguishes measured usage, observed text, unavailable expenses, and attempt provenance. Historical JSONL remains raw evidence; do not fill missing fields with invented values or select a winning retry. Ambiguous historical attempts fail pairing.

The regression tests use offline fixtures and fake agents. Run them from the repository root:

```bash
node --test sdlbench/tests/scaling.test.mjs sdlbench/tests/clustered-stats.test.mjs sdlbench/tests/pairing-fairness.test.mjs
node --test sdlbench/tests/*.test.mjs
```

Verified 2026-09-07: `node --test sdlbench/tests/*.test.mjs` passed all 89 tests (0 failures), including the existing suite and new measurement, pairing, scaling, provider, fairness, and task-cluster regressions. `git diff --check` passed. These checks do not establish live product savings or measured enrichment expense.

## Live-run timeout follow-up (2026-09-07)

A live Codex/Moshi attempt exceeded its 10-minute limit while output pipes remained open after child termination. The timeout handler now releases inherited stdout/stderr pipes after process-tree termination. A detached-descendant regression reproduces the stall and verifies bounded return. All 90 offline tests pass with the correction. The live experiment records its timeout and a separate operator interruption explicitly; neither qualifies as a passing pair.

## Context and discovery remediation (2026-09-07)

Focused manual requests with explicit action names and `includeSchemas:true` now include nested argument fields and descriptions even at compact detail. Broad query and wildcard discovery stays compact. Symbol-edit convenience aliases resolve to the canonical `symbol.edit` schema; the file-write example documents zero-based, end-exclusive line bounds.

Context assembly now folds a selected symbol's card into its matching code evidence after budget enforcement. Card metadata, code, card-only fallback, and session references remain available. Offline replay of the retained fixture payloads reduced 42 entries to 21 while retaining all 21 selected symbols. Serialized JSON measured with `o200k_base` fell from 4,831 to 3,728 tokens for each implementation context and from 5,621 to 4,518 for review. These are payload reductions, not measured provider-token savings. Retrieval still selects the same symbols; relevance narrowing remains unproven.

The [index preflight](index-preflight.md) is **not ready** for another benchmark: generated JavaScript configuration excludes the fixture `.mjs` tests, and both retained Moshi index responses report SCIP generator failures. Local embeddings and mock summaries also require an explicit benchmark-mode label. No fresh indexing or new agent benchmark was run for these changes.

Verification: TypeScript compilation passed; 122 focused manual, discovery, context, and projection tests passed. Scoped ESLint reported no errors (nine existing warnings). Focused manual serialization was compared byte-for-byte across fresh Node processes. The index-using determinism integration suite was not executed; its fixtures and session-card extraction were updated for the nested representation.

Selection follow-up: `selectProgressiveTier` and `selectTierOne` admit candidates while their costs fit, and `defaultExpand` follows the profile's unbounded graph depth. Selection has no task-sufficiency signal; its inputs are ranks, lanes, and token estimates. The captured projected payloads cannot justify a relevance cutoff. Fixing that remaining expansion requires a tested relevance or task-coverage contract, rather than an arbitrary smaller budget.

## Index preflight corrections (2026-09-07)

The [preflight blockers](index-preflight.md) have code corrections with offline regressions: explicit module-extension configuration/routing, the Windows Java launcher environment, required fixture file admission, and provider readiness before agent execution. The scanner now admits 13 tracked fixture source/test files; the initial four-verifier inventory omitted two other tracked `.mjs` fixtures. Generated configs explicitly retain and label local embeddings with mock summaries. Failed provider setup remains an error record with its index evidence and cannot launch the agent. Fresh disposable indexes remain the next validation step; no new benchmark or refresh was performed.

Disposable indexing was subsequently authorized and completed: the fixture passed the readiness gates (13 files, 37 symbols, 13 edges), while Moshi failed on a newly exposed generated Gradle initialization-script error at its Windows jar path. The earlier jar-launcher failure did not recur. Provider fallback was correctly rejected; no benchmark agent ran. See the updated [live preflight evidence](index-preflight.md#disposable-index-validation).
