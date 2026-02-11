# Baseline Snapshot (2026-02-11)

This directory freezes a reproducible baseline before expanding missing use-case coverage.

## Commands Used

```bash
# setup external repos
npm run benchmark:setup-external

# index external repo once
SDL_CONFIG_PATH=benchmarks/real-world/benchmark.config.json SDL_DB_PATH=data/sdlmcp.sqlite node dist/scripts/index-repo.js zod-oss --mode full

# local repo baseline
npm run benchmark:real -- -- --repo-id my-repo --skip-index --out benchmarks/real-world/runs/2026-02-11-baseline/my-repo.json

# zod-only task baseline
npm run benchmark:real -- -- --config benchmarks/real-world/benchmark.config.json --repo-id zod-oss --skip-index --tasks benchmarks/real-world/runs/2026-02-11-baseline/zod-only.tasks.json --out benchmarks/real-world/runs/2026-02-11-baseline/zod-oss.json
```

## Baseline Results

| Repo | Tasks | SDL Wins | Traditional Wins | Ties | Avg Capped Token Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| `my-repo` | 9 | 9 | 0 | 0 | 63.1% |
| `zod-oss` | 3 | 3 | 0 | 0 | 63.9% |

## Notes

- `zod-oss` baseline uses `zod-only.tasks.json` to avoid mixing in `my-repo` tasks.
- This snapshot is only a starting point; it does not cover the missing use-case families yet.
