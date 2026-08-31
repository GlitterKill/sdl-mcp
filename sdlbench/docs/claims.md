# SDLBench Claim Policy

This document defines which raw token-reduction claims SDLBench permits for a selected product.

## Claimable Data

Only provider-backed behavior records with `claimGrade: "primary"` can support savings claims. Current Codex and OpenCode behavior paths qualify when matching provider usage was captured. Fixture and tokenizer-only records carry `claimGrade: "none"` and make no savings assertion.

Only pass-gated baseline/product pairs count: both runs must solve the same task. The summary's `paired[]` array contains these rows, and every delta uses `tokens.total`.

## Claim Gates

Run `sdlbench claims --in results/sessions.jsonl --profile <profile> --variant <product>` to validate one product against baseline. `--variant` defaults to `sdl`.

| Profile | p50 Floor | p25 Floor | Min Task | Coverage | Fairness |
|---|---|---|---|---|---|
| `smoke` | 30% | 20% | 5% | 0.5 | 0% |
| `efficient` | 45% | 35% | 0% | 0.4 | 10% |
| `realism` | 50% | 40% | 20% | 0.5 | 20% |

- Gates are computed on the selected product's `paired[].deltaPct` only.
- `coverage.fileCoverage` must meet the floor.
- `fairness.netSavingsPct` must meet the floor.
- Cache hit rate, cache discount savings, and cache telemetry coverage are reported separately. They never change gates or exit status.

## Approved Claim Language

After the realism profile passes:

- "On paired behavior-mode tasks where both approaches solved the task, <product> achieved a median raw token reduction of >=50% (p25 >=40%, min task >=20%)."
- Claims must cite the number of paired tasks and the execution mode.
- Claims must not mix fixture-mode and behavior-mode data.
- Cache reads must not be described as raw tokens saved. Cache discount savings describe provider input-price savings only.

## Not Claimable

- Fixture-mode records or tokenizer-only estimates.
- Unpaired tasks.
- Per-variant aggregate sums from mixed-mode sessions.
- Any savings number not derived from `paired[].deltaPct`.
- Cache estimates without explicit provider cache counters.
- `crg` or `repomix` results while those products remain dry-run declarations without behavior integrations.
