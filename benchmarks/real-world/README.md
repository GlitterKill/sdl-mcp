# Real-World Use Case Benchmark

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [SDL-MCP Overview](../../README.md)
- [Documentation Hub](../../docs/README.md)
  - [Benchmark Guardrails](../../docs/benchmark-guardrails.md)
  - [Benchmark Failure Guide](../../docs/benchmark-failure-guide.md)
  - [Benchmark Baseline Management](../../docs/benchmark-baseline-management.md)
- [Real-World Benchmark (this page)](./README.md)

</details>
</div>

This benchmark compares SDL-MCP against traditional "grep + open files" workflows
on realistic software maintenance tasks. It measures both efficiency (token usage)
and effectiveness (precision/recall) to demonstrate the benefits of semantic code
context.

## Key Metrics

| Metric | Description | Better |
|--------|-------------|--------|
| **Token Reduction** | % fewer tokens than traditional approach | Higher |
| **Precision** | Ratio of relevant files in selection | Higher |
| **Recall** | Ratio of relevant files found vs total | Higher |
| **Coverage Gain** | Improvement in relevant file coverage | Higher |
| **Efficiency Ratio** | Tokens saved per coverage point | Higher |

## Quick Start

```bash
# Run with defaults (uses first configured repo)
npm run benchmark:real

# Run CI guardrails benchmark
npm run benchmark:ci

# Run with specific options
npm run benchmark:real -- --repo-id my-repo --skip-index

# Save results to JSON
npm run benchmark:real -- --out benchmarks/real-world/results.json
```

## Command Line Options

| Option | Description |
|--------|-------------|
| `--tasks <path>` | Path to tasks JSON file (default: `benchmarks/real-world/tasks.json`) |
| `--repo-id <id>` | Target a specific repository |
| `--config <path>` | Custom config file path |
| `--out <path>` | Save results to JSON file |
| `--skip-index` | Skip re-indexing (use existing data) |

## How It Works

For each task in `tasks.json`:

### 1. Baseline Approach (Traditional)
- Scans all files matching language extensions
- Scores files by query term frequency
- Selects top N files (default: 6)
- Counts tokens in selected files
- Measures coverage against known relevant files

### 2. SDL-MCP Approach
- Searches for entry symbols by name
- Builds a graph slice from entry points
- Generates skeletons for key functions
- Counts tokens in cards + skeletons
- Measures coverage against known relevant files

### 3. Comparison
- Calculates token reduction percentage
- Computes precision and recall for both
- Determines winner based on multiple factors
- Generates tuning insights from results

## Task Definition

Each task in `tasks.json` defines:

```json
{
  "id": "unique-task-id",
  "title": "Human-readable title",
  "description": "What this task simulates",
  "queryTerms": ["search", "terms", "for", "baseline"],
  "entrySymbolNames": ["functionName", "ClassName"],
  "relevantFiles": [
    "src/path/to/expected/file.ts",
    "src/another/relevant/file.ts"
  ],
  "relevantSymbols": [
    "functionName",
    "methodName"
  ],
  "baseline": {
    "maxFiles": 6
  },
  "sdl": {
    "maxCards": 20,
    "maxTokens": 4000,
    "maxEntrySymbols": 2,
    "maxSkeletons": 2
  }
}
```

### Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for the task |
| `title` | Yes | Display name |
| `description` | Yes | What the task simulates |
| `queryTerms` | Yes | Keywords for baseline file search |
| `entrySymbolNames` | No | Symbol names to seed SDL-MCP slice |
| `relevantFiles` | No | Expected files for coverage measurement |
| `relevantSymbols` | No | Expected symbols for coverage measurement |
| `baseline` | No | Override baseline defaults |
| `sdl` | No | Override SDL-MCP defaults |

## Output Format

### Console Output

```
======================================================================
  SDL-MCP REAL-WORLD USE CASE BENCHMARK
======================================================================

  Repository: sdl-mcp
  Root Path:  /path/to/repo
  Tasks:      10

----------------------------------------------------------------------
  TASK: Enforce policy downgrade on code window requests
  ID: policy-downgrade
----------------------------------------------------------------------
  Trace how code window requests are evaluated...

  [Baseline] Searching files with grep-style matching...
    Files matched: 15, Selected: 6
    Tokens: 12,450

  [SDL-MCP] Building slice from entry symbols...
    Entry symbols found: 2
    Slice cards: 18
    Skeletons generated: 2
    Total tokens: 3,200

  COMPARISON TABLE
  ----------------------------------------------------------------
  | Metric                    | Traditional    | SDL-MCP        | Winner |
  |---------------------------+----------------+----------------+--------|
  | Tokens                    |       12,450   |        3,200   |    SDL |
  | Files/Cards               |            6   |           18   |        |
  | File Coverage             |        42.9%   |        71.4%   |    SDL |
  | Symbol Coverage           |        60.0%   |        80.0%   |    SDL |
  | Precision                 |        50.0%   |        55.6%   |    SDL |
  | Recall                    |        42.9%   |        71.4%   |    SDL |
  |---------------------------+----------------+----------------+--------|
  | OVERALL WINNER: SDL-MCP                                            |
  | Token Reduction: 74.3%                                             |
  ----------------------------------------------------------------
```

### JSON Output

When using `--out`, results are saved with full details:

```json
{
  "benchmarkVersion": "2.0",
  "generatedAt": "2025-01-15T10:30:00.000Z",
  "repoId": "sdl-mcp",
  "summary": {
    "taskCount": 10,
    "avgTokenReduction": 52.3,
    "avgCoverageGain": 0.15,
    "avgPrecisionGain": 0.12,
    "avgRecallGain": 0.18,
    "sdlWins": 8,
    "traditionalWins": 1,
    "ties": 1,
    "tuningInsights": [...]
  },
  "tasks": [...]
}
```

## Tuning Insights

The benchmark automatically generates tuning recommendations based on results:

- **Low coverage tasks**: Suggests increasing `maxCards` or adding entry symbols
- **Traditional wins**: Indicates entry symbols may not be well-connected
- **High token usage**: Recommends tighter budgets or skeleton preference
- **Low precision**: Suggests increasing score threshold
- **Slow operations**: Recommends caching or reduced frontier size

## Adding Custom Tasks

1. Edit `benchmarks/real-world/tasks.json`
2. Add a new task object following the schema
3. Run the benchmark to validate
4. Iterate on entry symbols and relevant files

### Tips for Good Tasks

- **Entry symbols should be central**: Pick functions that have many edges
- **Query terms should be distinctive**: Avoid common words
- **Relevant files should be achievable**: Include files that both approaches could find
- **Relevant symbols should be specific**: Use exact function/class names

## Comparing Results Over Time

Save results after each tuning change:

```bash
# Before change
npm run benchmark:real -- --out results/before-tuning.json

# Make configuration changes...

# After change
npm run benchmark:real -- --out results/after-tuning.json
```

Compare JSON files to track improvements.

## Understanding Winners

A "winner" is determined by scoring multiple factors:

| Factor | SDL-MCP Point | Traditional Point |
|--------|---------------|-------------------|
| Lower tokens | SDL-MCP tokens < Traditional tokens | Vice versa |
| Higher precision | SDL-MCP precision > Traditional | Vice versa |
| Higher recall | SDL-MCP recall > Traditional | Vice versa |
| Better coverage | SDL-MCP coverage > Traditional | Vice versa |

The approach with more points wins. Ties indicate comparable performance.

## Performance Considerations

- **First run**: Includes indexing time (can be slow for large repos)
- **With `--skip-index`**: Much faster, uses existing symbol database
- **Large repos**: Consider reducing `maxCards` for faster slice builds
- **Many tasks**: Results are processed sequentially
