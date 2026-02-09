# Benchmark Guardrails Core - Implementation Summary

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

## Overview

This implementation provides a comprehensive benchmark guardrails system for CI/CD regression detection, tracking key performance metrics, and generating machine-readable reports.

## Components Implemented

### 1. Threshold Configuration (`config/benchmark.config.example.json`)

- Centralized threshold configuration with:
  - Indexing metrics (time per file/symbol)
  - Quality metrics (symbols per file, edge coverage, connectivity)
  - Performance metrics (slice/skeleton build time)
  - Token efficiency metrics (card/skeleton tokens)
  - Coverage metrics (call/import edge counts)
- Statistical smoothing configuration (warmup runs, sample runs, outlier detection)
- Baseline file path configuration

### 2. Threshold Evaluation Engine (`src/benchmark/threshold.ts`)

- `ThresholdEvaluator` class for comparing current metrics against thresholds
- Support for absolute thresholds (min/max values)
- Support for relative thresholds (allowable % change from baseline)
- Trend-aware evaluation (lower-is-better vs higher-is-better)
- Baseline loading/saving utilities
- Detailed evaluation results with pass/fail status and delta calculations

### 3. Regression Report Generator (`src/benchmark/regression.ts`)

- `RegressionReportGenerator` class for generating detailed reports
- Automatic trend detection (improved, degraded, neutral, unknown)
- Impact assessment (high, medium, low, none) based on delta magnitude
- Categorized recommendations based on failure types
- Markdown report generation for human readability
- JSON report generation for CI integration
- Comprehensive metric delta explanations

### 4. Statistical Smoothing (`src/benchmark/smoothing.ts`)

- `MetricSmoothing` class for reducing benchmark flakiness
- Warmup run filtering (discard first N runs)
- Outlier detection using IQR or standard deviation methods
- Median-based aggregation for robust results
- `runBenchmarkWithSmoothing` async wrapper for easy integration

### 5. Benchmark CI Command (`src/cli/commands/benchmark.ts`)

- New CLI command: `sdl-mcp benchmark:ci`
- Metrics collection:
  - Indexing duration (time per file/symbol)
  - Call-edge coverage (total call/import edges)
  - Slice quality (connectivity, symbols per file)
  - Runtime/memory (slice/skeleton build time, token efficiency)
- Integration with threshold evaluation engine
- Baseline comparison support
- Machine-readable regression reports (JSON)
- Console output with clear pass/fail status
- Options for local/CI usage patterns

### 6. CLI Integration

- Added `benchmark:ci` command to main CLI
- Argument parsing for benchmark options
- Help text and usage examples
- NPM script: `npm run benchmark:ci`

### 7. Testing (`tests/unit/benchmark-guardrails.test.ts`)

- Comprehensive test coverage for:
  - Threshold evaluation with various scenarios
  - Regression report generation
  - Statistical smoothing (IQR, stddev outlier detection)
  - Baseline management
  - Warmup run filtering

### 8. Documentation (`docs/benchmark-guardrails.md`)

- Complete usage guide
- Configuration reference
- Threshold types and properties
- Metric descriptions
- Smoothing configuration
- Output format examples
- Best practices
- Troubleshooting guide

## Acceptance Criteria Status

### ✅ 1. Benchmark:ci command runs locally and in CI

- Command: `npm run benchmark:ci` or `sdl-mcp benchmark:ci`
- Works locally with default configuration
- Supports CI integration with JSON output
- Options for flexible usage:
  - `--repo-id`: Test specific repository
  - `--baseline-path`: Custom baseline location
  - `--threshold-path`: Custom threshold config
  - `--out`: Custom output path
  - `--json`: JSON output for CI
  - `--update-baseline`: Update baseline after run
  - `--skip-indexing`: Skip re-indexing for faster iteration

### ✅ 2. Threshold config is centralized and documented

- Single configuration file: `config/benchmark.config.json`
- Example provided: `config/benchmark.config.example.json`
- Complete documentation in `docs/benchmark-guardrails.md`
- Schema defined in code for type safety
- Categories: indexing, quality, performance, token efficiency, coverage

### ✅ 3. Regression report explains metric deltas and failing thresholds

- Detailed regression reports with:
  - Per-metric delta calculations (absolute and percentage)
  - Trend detection (improved/degraded/neutral)
  - Impact assessment (high/medium/low)
  - Clear pass/fail status for each threshold
  - Category-based organization
  - Explanatory messages for each metric change
  - Actionable recommendations for failures
- Markdown format for human readability
- JSON format for machine consumption

### ✅ 4. Statistical smoothing/warmup logic reduces flakiness

- Configurable warmup runs (default: 2)
- Configurable sample runs (default: 3)
- Multiple outlier detection methods:
  - IQR (Interquartile Range) - default
  - Standard deviation
  - None
- Median-based aggregation (more robust than mean)
- Configurable IQR multiplier (default: 1.5)
- Automatic warmup run filtering

## Usage Examples

### Local Development

```bash
# Run benchmark CI locally
npm run benchmark:ci

# With custom options
npm run build
node dist/cli/index.js benchmark:ci --repo-id my-repo --json

# Update baseline after successful run
node dist/cli/index.js benchmark:ci --update-baseline

# Skip indexing for faster iteration
node dist/cli/index.js benchmark:ci --skip-indexing
```

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Run Benchmark CI
  run: npm run benchmark:ci

# With baseline update on passing PRs
- name: Run Benchmark CI
  run: |
    npm run benchmark:ci
    if [ $? -eq 0 ]; then
      node dist/cli/index.js benchmark:ci --update-baseline
      git add .benchmark/baseline.json
      git commit -m "Update benchmark baseline"
    fi
```

## Output Example

### Console Output

```
Benchmark CI: Running benchmark guardrails...

✓ Loaded threshold config from: config/benchmark.config.json

Benchmarking repository: my-repo
Repository path: /path/to/repo

Smoothing config: 3 sample runs, 2 warmup runs

Running benchmark with smoothing...
✓ Benchmark complete with smoothing

=== Benchmark Metrics ===
Indexing:
  Time per file:      150ms
  Time per symbol:    5ms
Quality:
  Symbols per file:   25.5
  Edges per symbol:   12.3
  Graph connectivity: 80.0%
  Exported ratio:     30.0%
Performance:
  Slice build:        100ms
  Skeleton time:      2ms
Token Efficiency:
  Avg card tokens:    180
  Avg skeleton tokens:150

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

✓ Results saved to: .benchmark/latest.json
```

### JSON Output

```json
{
  "timestamp": "2025-02-08T15:00:00.000Z",
  "repoId": "my-repo",
  "metrics": { ... },
  "thresholdResult": {
    "passed": true,
    "evaluations": [ ... ],
    "summary": {
      "total": 10,
      "passed": 10,
      "failed": 0,
      "warnings": 0
    }
  },
  "regressionReport": { ... }
}
```

## Key Features

1. **Extensible**: Easy to add new metrics and thresholds
2. **Type-safe**: Full TypeScript coverage
3. **Well-documented**: Complete docs and inline comments
4. **Tested**: Comprehensive unit test suite
5. **CI-ready**: JSON output and proper exit codes
6. **Flexible**: Configurable smoothing and thresholds
7. **Robust**: Statistical methods reduce flakiness
8. **Informative**: Clear reports with actionable recommendations

## Files Added/Modified

### New Files

- `config/benchmark.config.example.json` - Example threshold configuration
- `src/benchmark/index.ts` - Module exports
- `src/benchmark/threshold.ts` - Threshold evaluation engine
- `src/benchmark/regression.ts` - Regression report generator
- `src/benchmark/smoothing.ts` - Statistical smoothing utilities
- `src/cli/commands/benchmark.ts` - Benchmark CI command
- `tests/unit/benchmark-guardrails.test.ts` - Test suite
- `docs/benchmark-guardrails.md` - Complete documentation

### Modified Files

- `src/cli/types.ts` - Added BenchmarkOptions interface
- `src/cli/argParsing.ts` - Added parseBenchmarkOptions function
- `src/cli/index.ts` - Added benchmark:ci command
- `package.json` - Added benchmark:ci script
- `.gitignore` - Added .benchmark/ directory

## Next Steps

1. Set up initial baseline on a stable commit
2. Tune thresholds based on your codebase characteristics
3. Integrate into CI/CD pipeline
4. Monitor results and adjust as needed
5. Update baselines after intentional performance improvements
