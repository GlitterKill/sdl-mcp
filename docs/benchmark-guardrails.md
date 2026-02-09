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
- [Legacy User Guide](./USER_GUIDE.md)

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
