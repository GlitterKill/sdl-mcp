# Context Profiles

`sdl.context` uses one retrieval pipeline with declarative task profiles. Callers describe the task, priority targets, and token budget instead of selecting a breadth or semantic mode.

## Mental Model

Three inputs shape a request:

1. `taskType` selects the deterministic profile.
2. Flat focus fields identify priority seeds; directory `focusPaths` also scopes final evidence selection.
3. `budget.maxTokens` bounds the complete response.

The engine chooses available retrieval lanes, expands the graph, and selects evidence bundles under that budget. Focus fields do not create an unlimited guarantee. Exact-file paths remain priorities, while directory paths scope unpinned evidence when an in-directory bundle fits the budget.

## Task Profiles

| Task type | Primary goal | Preferred evidence | Test default |
| --- | --- | --- | --- |
| `debug` | Trace a failure and its nearby implementation | card, hot path, skeleton | included |
| `review` | Inspect behavior, dependencies, and risk | card, skeleton, hot path | included |
| `implement` | Find edit targets and supporting structure | card, skeleton | included |
| `explain` | Describe an API or behavior from source evidence | card, hot path | excluded |

The profile also selects expansion direction and depth. Explicit `includeTests` overrides the profile default.

## Priority Seeds

Use `focusSymbols` when canonical symbol IDs or names are known. Use `focusPaths` for repository-relative files or directories, and use `chatMentions` for identifiers named in the current conversation.

An exact indexed or overlay file in `focusPaths` matches that file path exactly, contributes symbols to the existing bounded Tier-0 allocation, and remains a priority; it does not make every other file ineligible. A directory matches descendants beneath its `focus/` path-segment prefix, so similarly named sibling paths do not match. Candidate search stable-partitions only the already-fused, already-bounded pool: Tier-0 pins first, then in-directory rows in fused order, then outside rows in fused order. This does not widen lanes, oversample, rerun retrieval, or change scores or provenance. Final selection retains explicit Tier-0 pins. If an in-directory evidence bundle fits the remaining budget, unpinned outside evidence is excluded; if no usable in-directory bundle fits, outside candidates remain a fallback. Missing and tombstoned paths have no effect.

Semantic test cases remain ordinary symbols with an optional `testCase` card facet: framework, title, and optional suite path, category, and modifiers. JavaScript and TypeScript detectors cover `node:test`, Jest, and Vitest, while Python detectors cover pytest and unittest. Python `test_*` functions and methods attach the facet to their existing structural symbols and retain their IDs. Every statically titled JavaScript or TypeScript `node:test`, Jest, or Vitest call instead emits a synthetic ordinary `function` symbol that covers the complete call construct, including calls with named callbacks. The facet augments existing symbol FTS and card or hot-path evidence without adding a test-only lane or query-time source scan.

A valid facet makes a symbol a test candidate even when its path is not test-like. `includeTests: false` filters unpinned test candidates, while explicit focus pins remain eligible; `includeTests: true` admits them. Directory focus follows the scoped selection rule above. Dotted literals such as `sdl.info` continue to center a hot path only after symbol selection.

If every selected Tier-0 rung cannot fit, the response uses `status: "budgetLimited"`, emits no Tier-1 evidence, and identifies the highest-ranked omitted Tier-0 work.

## Retrieval Levels

The engine reports capability, not caller preference:

| Level | Meaning |
| --- | --- |
| `hybrid` | Lexical and vector lanes contribute with full configured coverage |
| `hybrid-partial` | Vector retrieval contributes with partial coverage and adjusted weight |
| `lexical` | Lexical evidence contributes without vector evidence |
| `graph-only` | Resolved graph seeds remain available without text or vector candidates |

An unreadable graph fails before lane selection. A request with insufficient capabilities returns a structured error rather than a successful `graph-only` or `empty` payload.

## Evidence Selection

Each candidate owns one bundle:

- card
- optional skeleton
- optional hot path

The selector orders Tier 0 before Tier 1 and admits complete non-exact Tier-1 bundles by rank. It compares deterministic value per estimated token only for progressive rung upgrades. Hydration runs only for selected bundles. After hydration, one exact serialized-size pass may evict optional Tier-1 rungs when estimates were low.

Raw windows are not a context rung. Use `sdl.retrieve` `codeNeedWindow` with a concrete reason and identifiers when exact source is necessary.

## Response Status

- `complete` means all selected evidence fits.
- `budgetLimited` means the budget excludes resolved priority or optional work.
- `empty` means healthy available lanes found no candidates.

`omitted.byReason` summarizes the full omitted set. `omitted.highestRanked` remains bounded and includes logical recovery actions.

## Focused Request

```json
{
  "repoId": "my-repo",
  "taskType": "review",
  "taskText": "Review parseConfig timeout validation",
  "budget": { "maxTokens": 3000 },
  "focusSymbols": ["parseConfig"],
  "focusPaths": ["src/config/parse.ts"],
  "includeTests": true
}
```

## Exploratory Request

```json
{
  "repoId": "my-repo",
  "taskType": "explain",
  "taskText": "Trace request dispatch from the server entrypoint to handlers",
  "budget": { "maxTokens": 7000 },
  "includeTests": false,
  "responseMode": "auto"
}
```

## Decision Guide

- Use `sdl.context` when the task needs task-shaped evidence across multiple symbols.
- Add focus fields when exact targets are already known.
- Reduce `budget.maxTokens` for a tighter payload; increase it only when bounded omissions identify required work.
- Use `sdl.retrieve` for one exact card, slice, skeleton, hot path, or code window.
- Use `sdl.workflow` for procedural pipelines, runtime execution, transforms, or mutations.

## Related

- [Agent Context](./agent-context.md)
- [Code Mode](./code-mode.md)
- [Token Economy](./token-economy.md)
- [Graph Slicing](./graph-slicing.md)
