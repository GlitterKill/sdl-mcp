# SDLBench claim policy

SDLBench separates product-performance targets from evidence that an experiment is valid. Passing a savings threshold does not prove a fair comparison.

## Eligible comparisons

Claims require provider-backed behavior records with `claimGrade: "primary"` and a matching baseline/SDL pair that both passed. Fixture runs and independently tokenized observed text do not establish billed session usage or product effectiveness. OpenCode remains secondary evidence until its provider semantics receive the required verification; capturing counters alone does not promote it to primary.

Pairing requires matching repository, task, agent, model, execution mode, experiment, repetition, and recorded provenance. Preserve failures and timeouts. Duplicate attempts are errors; do not select the best retry.

## Performance targets and experimental validity

Run the claim check from the repository root:

```bash
node sdlbench/src/cli.mjs claims --in sdlbench/results/sessions.jsonl --profile realism --variant sdl
```

| Profile | Median savings | 25th percentile | Minimum task savings |
| --- | --- | --- | --- |
| `smoke` | 30% | 20% | 5% |
| `efficient` | 45% | 35% | 0% |
| `realism` | 50% | 40% | 20% |

The result separates `performancePassed` from `experimentalValidity`. Overall `passed` requires both. Validity requires available, passing fairness evidence for every selected pair. Missing evidence stays unavailable; it is not replaced with zero savings.

The runner currently records incomplete fairness evidence as unavailable. Those records cannot pass the overall claim gate merely because token savings are large. A valid experiment may show negative savings and fail the performance target.

Edit coverage and provider cache metrics remain report-only. Edit coverage is not retrieval relevance or independently graded answer quality. Cache reads describe provider billing discounts and must not be called raw tokens saved.

## Reporting results

Report paired token, model-cost, and agent-time differences alongside success rates and missing telemetry. Conditional savings on jointly solved tasks do not account for unsuccessful tasks by themselves.

Uncertainty bootstraps equally weighted repository/task means across repetitions. Include both independent task counts and paired observation counts. Fewer than two independent tasks produce no interval; extra repetitions do not create extra independent tasks.

State whether costs cover provider agent usage or independently counted text estimates. Unknown indexing expenses prevent a complete cold-run total, and warm-session amortization is unavailable. Do not present known model spend as complete experiment spend.

After the realism profile and validity gate both pass, a supported description is: "On paired behavior tasks that both approaches solved, SDL reduced median provider-reported tokens by at least 50%, with a 25th percentile of at least 40% and a minimum task reduction of at least 20%." Include the task and observation counts, provenance conditions, uncertainty, and unresolved measurement coverage.

## Unsupported claims

- Fixture results, observed-text estimates, or mixed execution modes presented as behavior savings.
- Unpaired results or a winning retry selected from duplicate attempts.
- Cache discounts without explicit provider counters.
- Complete indexing, enrichment, or amortized expenses without measured usage and rates.
- Results for products without implemented integrations, including `crg` and `repomix`.

See the [measurement audit](measurement-audit.md) for the verified corrections and remaining evidence limits.
