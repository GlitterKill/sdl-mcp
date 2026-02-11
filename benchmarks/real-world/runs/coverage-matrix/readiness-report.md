# Universal-Claim Readiness Report

- Generated: `2026-02-11T18:30:19.876Z`
- Aggregate: `benchmarks/real-world/runs/coverage-matrix/aggregate.json`
- Aggregate SHA256: `945F15DC6F89D04B076F671E0A1F3EC8280B46354A123FA5E65FE3BB5B72F568`

## Gate Evaluation

Thresholds:

- Family `p50 >= 50%`
- Family `p25 >= 40%`
- Minimum task reduction `>= 20%`

Result: `PASS`

- Worst family p50: `60.3%` (`frontend-ui`)
- Worst family p25: `55.6%` (`frontend-ui`)
- Minimum task reduction observed: `53.0%`

## Decision

- Broad benchmarked-coverage claim: `YES`
- Universal “all coding-agent use cases” claim: `NO`

Rationale:

- Matrix thresholds pass across the benchmarked families and repos.
- Coverage is still bounded to modeled task packs and selected repositories.

## Next Actions

- Keep matrix packs and context targets maintained alongside code changes.
- Expand matrix with additional repos/workflows when new major agent use-case classes appear.
- Keep nightly matrix + claim checker green before updating public claim language.
