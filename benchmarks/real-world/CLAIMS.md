# Benchmark Claim Policy

This document defines what SDL-MCP token-reduction claims are currently supported.

## Approved Claim Language

- SDL-MCP achieves `>=50%` capped token reduction across the benchmarked use-case families in the current matrix.
- Claim scope is limited to the benchmark matrix (`benchmarks/real-world/matrix.json`) and configured repos.
- Do not claim universal performance for all coding-agent tasks outside this measured scope.

## Claim Gates

Use `scripts/check-benchmark-claims.ts` on matrix aggregate output with:

- family `p50(capped reduction) >= 50%`
- family `p25(capped reduction) >= 40%`
- minimum per-task capped reduction `>= 20%`

Command:

```bash
npx tsx scripts/check-benchmark-claims.ts \
  --in benchmarks/real-world/runs/coverage-matrix/aggregate.json \
  --min-family-p50 50 \
  --min-family-p25 40 \
  --min-task-floor 20
```

## Reproducibility

```bash
# 1) Prepare external repos
npm run benchmark:setup-external

# 2) Build merged benchmark config
node -e "const fs=require('fs');const b=JSON.parse(fs.readFileSync('config/sdlmcp.config.json','utf8'));const e=JSON.parse(fs.readFileSync('benchmarks/real-world/external-repos.config.json','utf8'));fs.writeFileSync('benchmarks/real-world/benchmark.config.json', JSON.stringify({...b,repos:[...(b.repos||[]),...(e.repos||[])]},null,2)+'\\n');"

# 3) Run matrix
npm run benchmark:matrix -- -- --matrix benchmarks/real-world/matrix.json --config benchmarks/real-world/benchmark.config.json --out-dir benchmarks/real-world/runs/coverage-matrix

# 4) Validate claim thresholds
npx tsx scripts/check-benchmark-claims.ts --in benchmarks/real-world/runs/coverage-matrix/aggregate.json
```

## Residual Risk

- Benchmarks are broad but still finite; unrepresented repos/task shapes may perform differently.
- Family-level thresholds do not guarantee every single future task will exceed `50%`.
- Matrix quality depends on task-pack realism and maintained context targets.
