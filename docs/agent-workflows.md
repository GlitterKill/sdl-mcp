# Agent Workflows

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows (this page)](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

This page defines practical workflows for coding agents using SDL-MCP.

## Context Ladder

Use this order unless blocked by policy or task constraints:

1. `sdl.symbol.search`
2. `sdl.symbol.getCard`
3. `sdl.slice.build`
4. `sdl.code.getSkeleton`
5. `sdl.code.getHotPath`
6. `sdl.code.needWindow` (last resort)

## Bug Investigation Workflow

1. Search suspect symbol(s):

```json
{ "repoId": "my-repo", "query": "handleError", "limit": 20 }
```

2. Pull card for top candidate and inspect deps/calls.
3. Build slice around candidate with explicit task text.
4. Use skeleton/hot-path for exact branch focus.
5. Request raw window only when logic remains ambiguous.

## Feature Implementation Workflow

1. Search for similar symbols/patterns.
2. Build slice from entry points and related modules.
3. Use overview/hotspots to avoid narrow local optimization.
4. Run `sdl.delta.get` after changes to assess impact.

## PR Review Workflow

1. Use `sdl.delta.get` between base/head versions.
2. Run `sdl.pr.risk.analyze` for risk scoring and recommended tests.
3. Inspect impacted symbols via `sdl.symbol.getCard`.
4. Escalate code-window access only for high-risk findings.

## Autonomous Agent Workflow

Use `sdl.agent.orchestrate` to execute rung-based tool selection with evidence capture when you want policy-aware automation.

Example:

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "identify and fix flaky test root cause",
  "budget": { "maxTokens": 6000, "maxActions": 20 },
  "options": { "includeTests": true, "requireDiagnostics": true }
}
```

## Efficiency Tips

- Keep `entrySymbols` focused for smaller slices.
- Reuse `sliceHandle` with `sdl.slice.refresh` instead of rebuilding repeatedly.
- Use `ifNoneMatch` with symbol cards to reduce payload churn.
- Use `sdl.repo.overview` for large repos before deep traversal.
