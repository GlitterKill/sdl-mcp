# Benchmark Guardrails

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)

</details>
</div>

This directory contains the benchmark guardrails system for CI/CD regression detection.

## Overview

The benchmark guardrails system provides:

- **Threshold-based regression detection**: Compare current benchmark metrics against defined thresholds
- **Baseline comparison**: Track metric changes over time
- **Statistical smoothing**: Reduce flakiness with warmup runs and outlier detection
- **Machine-readable reports**: JSON output for CI integration
- **Human-readable summaries**: Detailed explanations of metric deltas

## Configuration

### Threshold Configuration

Create a `config/benchmark.config.json` file based on `config/benchmark.config.example.json`:

```json
{
  "version": "1.0",
  "thresholds": {
    "indexing": {
      "indexTimePerFile": {
        "maxMs": 200,
        "trend": "lower-is-better",
        "allowableIncreasePercent": 10
      }
    }
  },
  "smoothing": {
    "warmupRuns": 2,
    "sampleRuns": 3,
    "outlierMethod": "iqr",
    "iqrMultiplier": 1.5
  }
}
```

### Threshold Types

- `lower-is-better`: Metrics where lower values are better (e.g., time, memory)
- `higher-is-better`: Metrics where higher values are better (e.g., coverage, quality)

### Threshold Properties

- `maxMs`/`maxTokens`/`minValue`/`minPercent`: Absolute thresholds
- `allowableIncreasePercent`/`allowableDecreasePercent`: Relative thresholds when comparing to baseline

## Usage

### Local Development

```bash
# Run benchmark CI locally
npm run benchmark:ci

# With custom options
npm run build
node dist/cli/index.js benchmark:ci --repo-id my-repo --json

# Update baseline
node dist/cli/index.js benchmark:ci --update-baseline

# Skip re-indexing (faster iteration)
node dist/cli/index.js benchmark:ci --skip-indexing
```

### CI/CD Integration

The hosted Zod structural guardrail derives a temporary config from `config/sdlmcp.config.json` with only `semantic.enabled` set to `false`. Its metrics cover indexing, graph structure, slices, skeletons, token sizes, and edge coverage; they do not evaluate embedding quality. This isolates mock embeddings from semantic readiness checks while preserving production checks and the existing `config/benchmark.ci.config.json` thresholds.


```yaml
# GitHub Actions example
- name: Run Benchmark CI
  run: npm run benchmark:ci

# Or with baseline update on passing PRs
- name: Run Benchmark CI
  run: |
    npm run benchmark:ci
    if [ $? -eq 0 ]; then
      node dist/cli/index.js benchmark:ci --update-baseline
      git add .benchmark/baseline.json
      git commit -m "Update benchmark baseline"
    fi
```

## External Repository Evidence

The external benchmark wrapper runs a pinned repository against isolated LadybugDB families and writes reproducible evidence beneath an ignored artifact directory. Prepare the locked checkout, build the runtime, and run one cold repeat with this exact sequence:

```bash
npm run benchmark:setup-external -- --base-dir .tmp/external-benchmarks --out benchmarks/real-world/external-repos.config.json
npm run build:runtime
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-cold-smoke-v1 --cache-mode cold --repeats 1
```

The cold command uses a stable, single-use artifact directory. A completed run has this layout:

```text
.benchmark/external/scip-io-cold-smoke-v1/
├── preflight.log
├── run-manifest.json
├── results.json
├── inputs/
│   ├── sdlmcp.config.json
│   ├── baseline.json
│   └── threshold.json
├── db/
│   ├── repeat-001.lbug
│   └── repeat-001.lbug.*
├── logs/
│   ├── repeat-001.stdout.log
│   └── repeat-001.stderr.log
└── raw/
    └── repeat-001.benchmark.json
```

The `*.lbug.*` pattern includes every produced WAL and sidecar. Pre-manifest validation failures record `preflight.log` and `preflight-error.json` and may also retain partially staged directories or files as evidence. Controlled post-manifest benchmark, child, or evidence failures enter the `finally` path, attempt to write an exact-count `results.json`, and retain declared logs. Host filesystem or process-finalization failures can prevent complete writes, so missing declared artifacts make the verifier fail and must not be claimed complete. The artifact directory remains ignored, but the root-workspace owner retains it until the evidence is archived or an authorized run explicitly supersedes it.

The runner copies `config/benchmark.config.json` to `inputs/threshold.json` and requires the source and staged bytes to remain identical. It validates the exact live five-category, twelve-rule set:

- `indexing`: `indexTimePerFile`, `indexTimePerSymbol`
- `quality`: `symbolsPerFile`, `edgesPerSymbol`, `graphConnectivity`, `exportedSymbolRatio`
- `performance`: `sliceBuildTimeMs`, `avgSkeletonTimeMs`
- `tokenEfficiency`: `avgCardTokens`, `avgSkeletonTokens`
- `coverage`: `callEdgeCoverage`, `importEdgeCoverage`

A failed rule remains visible in `results.json` and causes a nonzero exit. Do not weaken a threshold to make an external run pass.

### Warm follow-up

Warm mode is a follow-up operation, and the command below does not claim that a warm result exists:

```bash
npm run benchmark:external -- --repo-id scip-io --out-dir .benchmark/external/scip-io-warm-smoke-v1 --cache-mode warm --warm-db .benchmark/external/scip-io-cold-smoke-v1/db/repeat-001.lbug --repeats 1
```

The runner fingerprints the complete source database family before and after staging and rejects membership or byte drift. It stages the family under `inputs/warm-db`, copies every member exclusively to an absent repeat family, and never mutates the source snapshot. Do not report a warm run as green until this command runs and its evidence passes validation.

## Metrics Tracked

### Indexing Metrics

- `indexTimePerFile`: Time to index a single file (ms)
- `indexTimePerSymbol`: Time to index a single symbol (ms)

### Quality Metrics

- `symbolsPerFile`: Average symbols extracted per file
- `edgesPerSymbol`: Average edges (call/import) per symbol
- `graphConnectivity`: Ratio of symbols with edges to total symbols
- `exportedSymbolRatio`: Ratio of exported symbols to total symbols

### Performance Metrics

- `sliceBuildTimeMs`: Time to build a graph slice (ms)
- `avgSkeletonTimeMs`: Average time to generate a skeleton (ms)

### Token Efficiency Metrics

- `avgCardTokens`: Average tokens per symbol card
- `avgSkeletonTokens`: Average tokens per skeleton

### Coverage Metrics

- `callEdgeCount`: Total call edges detected
- `importEdgeCount`: Total import edges detected

## Context Quality Suite

The context quality benchmark (`tests/benchmark/context-quality.test.ts`) validates the canonical v2 evidence response against pinned, verified LadybugDB graphs. The SDL corpus contains the original 27 cases plus four QA-derived hard-floor cases. The neutral corpus contains two cases from `sdlbench/tests/fixtures/repo`.

### What It Measures

- **Required-symbol recall**: The fraction of declared hard requirements represented by distinct evidence symbols at the case budget.
- **Primary-symbol MRR**: The reciprocal rank of the declared primary symbol. Duplicate evidence rungs do not improve rank.
- **Explicit-negative token ratio**: The fraction of evidence tokens assigned to labeled negative symbols or paths. The benchmark does not treat unlabeled evidence as noise.
- **Evidence tokens per required hit**: The evidence-token cost of each required-symbol hit.
- **Paired latency**: Interleaved v1 baseline and v2 control measurements after a fixed warm-up, reported at p50 and p95.

### Quality and Latency Gates

The committed v1 reference lives at `devdocs/benchmarks/context-quality-v1-baseline.json`. Release evaluation runs v2 against a closed copy of the same pinned graph family and requires `graphIntegrityState: "verified"`.

| Metric | Status |
| ------ | ------ |
| QA-derived required-symbol recall | Hard gate: `100%` for every case |
| Aggregate required-symbol recall | Hard gate: `>=` committed v1 baseline |
| Primary-symbol MRR | Hard gate: `>=` committed v1 baseline |
| Explicit-negative token ratio | Hard gate: `<=` committed v1 baseline |
| Evidence tokens per required hit | Hard gate: `<=` committed v1 baseline |
| Paired v2 p95 latency | Hard gate: `<= 1.25x` committed v1 baseline |
| Failures and timeouts | Hard gate: `0` |
| Neutral corpus | Hard gate: both cases pass without SDL-specific ranking rules |

Candidate comparisons use the same build, configuration, and fresh copies of one pinned logical index snapshot. Do not refresh or reindex the source snapshot. LadybugDB may checkpoint files on open or close, so compare the complete source file-family fingerprint instead of filesystem modification times.

### Running the Suite

```bash
# Requires a built dist/ and an isolated verified graph copy.
SDL_CONTEXT_QUALITY_REQUIRE_INDEX=1 \
SDL_CONTEXT_QUALITY_CORPUS=sdl-mcp \
SDL_CONTEXT_QUALITY_REPO_ID=sdl-mcp \
SDL_CONTEXT_QUALITY_VARIANT=semantic \
SDL_CONTEXT_QUALITY_V2_SHADOW=1 \
SDL_CONTEXT_QUALITY_OUTPUT_PATH=/absolute/path/context-quality.json \
SDL_CONFIG=/absolute/path/sdlmcp.config.json \
SDL_GRAPH_DB_PATH=/absolute/path/working.lbug \
node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
```

PowerShell:

```powershell
$env:SDL_CONTEXT_QUALITY_REQUIRE_INDEX='1'
$env:SDL_CONTEXT_QUALITY_CORPUS='sdl-mcp'
$env:SDL_CONTEXT_QUALITY_REPO_ID='sdl-mcp'
$env:SDL_CONTEXT_QUALITY_VARIANT='semantic'
$env:SDL_CONTEXT_QUALITY_V2_SHADOW='1'
$env:SDL_CONTEXT_QUALITY_OUTPUT_PATH='C:\isolated\context-quality.json'
$env:SDL_CONFIG='C:\isolated\sdlmcp.config.json'
$env:SDL_GRAPH_DB_PATH='C:\isolated\working.lbug'
node --experimental-strip-types --test tests/benchmark/context-quality.test.ts
```

Set `SDL_CONTEXT_QUALITY_REQUIRE_PROVIDER_INVARIANT=1` for the SDL release gate. Set `SDL_CONTEXT_QUALITY_CORPUS=neutral` and use the neutral repository ID, configuration, and graph copy for the neutral hard floor. Optional controls `SDL_CONTEXT_QUALITY_CASE_DETAILS=missing` and `SDL_CONTEXT_QUALITY_CASE_ID=<case-id>` report individual misses without changing the corpus definitions.

Without `SDL_CONTEXT_QUALITY_REQUIRE_INDEX=1`, the suite may run only structural case validation when no indexed repository is available. Release evidence must set the flag and persist a non-skipped artifact.

## Statistical Smoothing

To reduce test flakiness, the system applies statistical smoothing:

1. **Warmup Runs**: First N runs are discarded to warm up caches
2. **Sample Runs**: Collect M measurements
3. **Outlier Detection**: Remove outliers using IQR or standard deviation
4. **Aggregation**: Use median as the final value

Configuration:

```json
{
  "smoothing": {
    "warmupRuns": 2,
    "sampleRuns": 3,
    "outlierMethod": "iqr",
    "iqrMultiplier": 1.5
  }
}
```

## Output Formats

### JSON Output

```json
{
  "timestamp": "2025-02-08T12:00:00.000Z",
  "repoId": "my-repo",
  "metrics": { ... },
  "thresholdResult": {
    "passed": true,
    "evaluations": [ ... ],
    "summary": { ... }
  },
  "regressionReport": { ... }
}
```

### Console Output

```
=== Benchmark Metrics ===
Indexing:
  Time per file:      150ms
  Time per symbol:    5ms
Quality:
  Symbols per file:   25.5
  Edges per symbol:   12.3
...

=== Threshold Evaluation ===
Status: ✅ PASSED
Total: 10
Passed: 10
Failed: 0

=== Regression Summary ===
Status: ✅ PASSED
Improved: 2
Degraded: 0
Neutral: 8
```

## Best Practices

1. **Initial Baseline**: Run with `--update-baseline` on a known-good commit
2. **Threshold Tuning**: Adjust thresholds based on your codebase characteristics
3. **Smoothing Config**: Increase `sampleRuns` for noisy environments
4. **Regular Updates**: Update baselines after intentional performance improvements
5. **Review Failures**: Always investigate threshold failures before updating baselines

## Troubleshooting

### Failing Thresholds

If thresholds fail:

1. Check if the change is expected (e.g., added features)
2. Review the regression report recommendations
3. Consider adjusting thresholds if the new baseline is acceptable
4. Use `--update-baseline` only after manual review

### High Flakiness

If benchmarks are flaky:

1. Increase `warmupRuns` to allow more cache warming
2. Increase `sampleRuns` for more statistical power
3. Check for CI resource contention
4. Consider running benchmarks in dedicated, isolated runners

### Missing Baseline

If baseline is missing:

1. Run `--update-baseline` on a stable commit
2. Commit the baseline file to version control
3. Ensure `.benchmark/` is not gitignored

## Files

- `config/benchmark.config.example.json`: Example threshold configuration
- `src/benchmark/threshold.ts`: Threshold evaluation engine
- `src/benchmark/regression.ts`: Regression report generator
- `src/benchmark/smoothing.ts`: Statistical smoothing utilities
- `src/cli/commands/benchmark.ts`: Benchmark CI command
