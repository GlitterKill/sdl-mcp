# Real-World Workflow Benchmark

This benchmark measures **end-to-end engineering tasks**, not isolated tool calls.
It compares:

- Traditional workflow: file search + open files
- SDL-MCP workflow: symbol search -> cards -> slice -> skeletons

The goal is honesty: no per-task score tuning and no hand-crafted benchmark keywords.
Scores are computed after a completion pass where both approaches continue working
until task target context is reached.

## What It Benchmarks

`benchmarks/real-world/tasks.json` defines realistic workflows, including:

- code review
- feature review
- bug fixing
- code/feature understanding
- code change implementation
- performance investigation
- impact analysis
- test triage

Each workflow has multiple steps (`triage`, `investigate`, `change`/`validate`) and
ground-truth context targets (`files`, `symbols`) used only for scoring.

## Key Metrics

| Metric | Meaning | Better |
|---|---|---|
| Token Reduction | `%` fewer tokens than traditional workflow at task completion | Higher |
| File Coverage | `relevantFilesFound / relevantFilesTotal` | Higher |
| Symbol Coverage | `relevantSymbolsFound / relevantSymbolsTotal` | Higher |
| Context Coverage | `(relevant files + symbols found) / total context units` | Higher |
| Precision | Relevant files found / files returned | Higher |
| Recall | Relevant files found / relevant files total | Higher |
| Extra Context (when cheaper) | Additional context found by SDL when SDL also used fewer tokens | Higher |

Coverage definitions are shown in the benchmark output for each task:

- File Coverage = relevant files found / total relevant files
- Symbol Coverage = relevant symbols found / total relevant symbols

## Usage

```bash
# Run all real-world workflow tasks
npm run benchmark:real

# Use specific tasks file
npm run benchmark:real -- --tasks benchmarks/real-world/tasks.json

# Use specific repo config entry
npm run benchmark:real -- --repo-id my-repo

# Skip re-indexing for faster iteration
npm run benchmark:real -- --skip-index

# Write JSON report
npm run benchmark:real -- --out benchmarks/real-world/results.json
```

## Benchmark Policy

The benchmark runner enforces realism-first behavior:

- no per-task baseline/SDL budgets
- no task-specific query-term tuning
- terms are derived from workflow prompts/artifacts
- fixed SDL ladder policy across tasks
- baseline file-open token cost is capped per file to model partial human/agent reads
- completion pass is applied to both approaches so benchmarks compare fully-completed tasks (not early stopping states)

If SDL loses a task, the report includes per-task loss reasons and server-focused
improvement suggestions.

## Tasks File Schema

```json
{
  "version": 3,
  "defaults": {
    "baseline": { "maxFilesPerStep": 4, "maxTokensPerFile": 2200 },
    "sdl": {
      "maxSearchTerms": 12,
      "maxSearchResultsPerTerm": 6,
      "maxEntrySymbols": 4,
      "maxCardsPerStep": 5,
      "maxCards": 14,
      "maxTokens": 3200,
      "maxSkeletonsPerStep": 1,
      "skeletonMaxLines": 120,
      "skeletonMaxTokens": 1500
    }
  },
  "tasks": [
    {
      "id": "task-id",
      "category": "code-review",
      "title": "Task title",
      "description": "Task description",
      "contextTargets": {
        "files": ["src/path.ts"],
        "symbols": ["functionName"]
      },
      "workflow": [
        {
          "id": "triage-step",
          "phase": "triage",
          "goal": "Step objective",
          "prompt": "Natural language prompt",
          "entrySymbolHints": ["optionalSymbolHint"],
          "artifacts": {
            "changedFiles": ["src/file.ts"],
            "stackTrace": "optional trace",
            "failingTest": "optional test"
          }
        }
      ]
    }
  ]
}
```

## Output

Console output includes:

- per-step token/context activity for baseline and SDL
- per-task comparison table
- file/symbol coverage definitions
- summary across all tasks
- loss analysis for tasks where traditional wins

JSON output (`--out`) includes:

- benchmark metadata
- defaults used
- per-task step telemetry
- token and coverage metrics
- per-loss analysis and suggestions
