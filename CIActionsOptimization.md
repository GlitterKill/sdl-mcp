# CI Workflow Parallelization & Optimization

## Context
The CI workflow takes 60+ minutes because all steps run sequentially in a single monolithic job across a 4-entry matrix. The benchmark step alone takes 30-60 minutes, and the auto-update baseline step re-runs the entire benchmark unnecessarily. Node 18.x (EOL April 2025) doubles the matrix size for no value.

## Changes

### 1. Drop Node 18.x support

**Files:**
- `.github/workflows/ci.yml` — remove `18.x` from matrix (line 23)
- `package.json` — change `engines.node` from `>=18.0.0` to `>=20.0.0` (line 129)
- `src/config/constants.ts` — change `NODE_MIN_MAJOR_VERSION` from `18` to `20`

Matrix goes from 4 entries → 2 entries (ubuntu + windows, Node 20.x only).

### 2. Split `ci` job into `tests` and `benchmarks` jobs

**File:** `.github/workflows/ci.yml`

**`tests` job** (~5-8 min) — fast feedback:
- Setup: checkout, node 20.x, cache node_modules, cache dist, npm install, kuzu binary, build
- Typecheck
- Lint
- Config sync check
- Security audit
- Run tests
- Run test harness
- Verify runtime entrypoints
- Smoke test serve --stdio (Linux only)
- Display test summary

**`benchmarks` job** (~20-40 min) — performance regression gate:
- Setup: checkout, node 20.x, cache node_modules, cache dist, npm install, kuzu binary, build
- Cache locked benchmark repos
- Setup locked benchmark repos
- Run Benchmark CI Guardrails
- Auto-update benchmark baseline (simplified — see #3)
- Setup external benchmark repos (ubuntu only)
- Build benchmark matrix config (ubuntu only)
- Run benchmark matrix smoke (ubuntu only)
- Validate benchmark matrix smoke claims (ubuntu only)

Both jobs run in parallel on the same 2-entry matrix.

**Dependency changes:**
- `sync-memory`: change `needs: ci` → `needs: tests` (line 411)
- `sync-validation`: unchanged (still `needs: sync-memory`)

### 3. Fix auto-update baseline (eliminate redundant benchmark run)

**File:** `.github/workflows/ci.yml` — replace lines 160-171

Current: re-runs `benchmark:ci` with `--update-baseline` (5 more full indexes via smoothing).

New: copy the already-generated result file to the baseline path:
```yaml
- name: Auto-update benchmark baseline on main
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  shell: bash
  run: |
    if [ "${{ runner.os }}" = "Windows" ]; then
      BASELINE_PATH=".benchmark/baseline.windows.json"
    else
      BASELINE_PATH=".benchmark/baseline.zod-oss.json"
    fi
    if [ -f .benchmark/latest-result.json ]; then
      mkdir -p "$(dirname "$BASELINE_PATH")"
      cp .benchmark/latest-result.json "$BASELINE_PATH"
      echo "Baseline updated: $BASELINE_PATH"
    else
      echo "No result file found, skipping baseline update"
    fi
```

### 4. Reduce smoothing runs (5 → 3 total)

**Files:**
- `config/benchmark.ci.config.json` (lines 80-81)
- `config/benchmark.ci.windows.config.json` (lines 78-79)

Change:
```json
"warmupRuns": 1,
"sampleRuns": 2,
```

From 2+3=5 runs to 1+2=3 runs. ~40% reduction in benchmark time. With 2 samples, IQR outlier detection is skipped (code returns empty for < 3 values), median of 2 = average of 2. Acceptable tradeoff.

## Expected Time Improvements

| Metric | Before | After |
|--------|--------|-------|
| Matrix entries | 4 | 2 |
| Test feedback time | ~60 min (blocked by benchmarks) | ~5-8 min |
| Benchmark runs per step | 5 (2 warmup + 3 sample) | 3 (1 warmup + 2 sample) |
| Baseline update | 5 more full indexes | File copy (~0s) |
| Total CI wall-clock (Linux) | ~45 min | ~20-25 min |
| Total CI wall-clock (Windows) | ~65 min | ~35-45 min |

## Verification

1. Push changes and verify CI run completes:
   - `tests` job passes on both ubuntu and windows (Node 20.x only)
   - `benchmarks` job passes on both ubuntu and windows
   - Both jobs run in parallel (not sequentially)
   - `sync-memory` triggers after `tests` completes (doesn't wait for benchmarks)
2. Verify baseline file is correctly copied (not re-benchmarked) on main push
3. Verify benchmark matrix smoke still only runs on ubuntu
4. Verify `npm run test:harness` and `npm test` still pass locally
