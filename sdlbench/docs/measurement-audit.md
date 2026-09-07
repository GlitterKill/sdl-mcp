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
