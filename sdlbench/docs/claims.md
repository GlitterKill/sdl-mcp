# SDLBench Claim Policy

This document defines what SDL-MCP token-reduction claims are claimable on
behavior-mode paired data from SDLBench.

## Claimable Data

Only **behavior-mode** records with `claimGrade: "primary"` (Codex session
token counts) can support savings claims. Fixture-mode records carry
`claimGrade: "none"` and make no savings assertion.

Only **pass-gated paired** deltas count — tasks where both baseline and SDL
passed. The summary's `paired[]` array contains these.

## Claim Gates

Run `sdlbench claims --in results/sessions.jsonl --profile <profile>` to
validate:

| Profile | p50 Floor | p25 Floor | Min Task | Coverage | Fairness |
|---|---|---|---|---|---|
| `smoke` | 30% | 20% | 5% | 0.5 | 0% |
| `efficient` | 45% | 35% | 0% | 0.4 | 10% |
| `realism` | 50% | 40% | 20% | 0.5 | 20% |

- Gates are computed on `paired[].deltaPct` only.
- `coverage.fileCoverage` must meet the floor (SDL retrieved the right files).
- `fairness.netSavingsPct` must meet the floor (net savings after deducting
  SDL reinforcement injection tokens).

## Approved Claim Language (on passing realism profile)

- "On paired behavior-mode tasks where both approaches solved the task, SDL-MCP
  achieved a median token reduction of >=50% (p25 >=40%, min task >=20%)."
- Claims must cite the number of paired tasks and the execution mode.
- Claims must NOT mix fixture-mode and behavior-mode data.

## Not Claimable

- Fixture-mode records (no real agent ran; `claimGrade: "none"`).
- Unpaired tasks (only one variant passed).
- Per-variant aggregate sums from mixed-mode sessions.
- Any savings number not derived from `paired[].deltaPct`.
