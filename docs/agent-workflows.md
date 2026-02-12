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

## Paste-Ready AGENTS.md Block

Copy this block into `AGENTS.md` for token-efficient SDL-MCP usage on the current codebase/tooling.

```md
## SDL-MCP Token-Efficient Protocol (v0.6)

- Repository ID: `sdl-mcp`
- MCP Server: `sdl-mcp`

### 0) Establish state before deep context

1. Call `sdl.repo.status` first.
2. If local code changed and indexing is stale, run `sdl.index.refresh` with `mode: "incremental"`.
3. Call `sdl.policy.get` and honor returned caps. Current effective policy is:
   - `maxWindowLines: 180`
   - `maxWindowTokens: 1400`
   - `requireIdentifiers: true`

### 1) Default token-first ladder

Use this order unless task constraints force escalation:

1. `sdl.repo.overview` (start with `level: "stats"`; use `directories`/`full` only when needed).
2. `sdl.symbol.search` with a tight `limit` (`5-20` to start; default is `50`, max is `1000`).
3. `sdl.symbol.getCard`; send `ifNoneMatch` when re-checking known symbols to get `notModified` responses.
4. `sdl.slice.build` with explicit budget and compact output:
   - Keep `wireFormat: "compact"` (default) and `wireFormatVersion: 2` (default).
   - Set budget early, for example: `{ "maxCards": 30, "maxEstimatedTokens": 4000 }`.
   - Always provide `entrySymbols` when available.
   - Provide `knownCardEtags` to avoid resending unchanged cards (`cardRefs` are returned instead).
   - Leave `cardDetail` unset for mixed compact/full behavior. Use `"full"` only when you truly need full cards for all slice symbols.
5. `sdl.slice.refresh` if you already have a `sliceHandle`; prefer refresh over rebuilding.
6. `sdl.slice.spillover.get` only when necessary; keep `pageSize` small (default `20`, max `100`).
7. `sdl.code.getSkeleton` before `hotPath` or raw windows. In file mode, prefer `exportedOnly: true` when possible.
8. `sdl.code.getHotPath` with focused identifiers (`1-3` identifiers, low `contextLines`, default `3`).
9. `sdl.code.needWindow` last. Keep requests tight:
   - `expectedLines <= 180`
   - `maxTokens <= 1400`
   - Non-empty `identifiersToFind` (required by policy)

### 2) Task-specific workflows

- Debug: `search -> card -> slice.build -> hotPath -> needWindow (only if still ambiguous)`.
- Feature implementation: `repo.overview -> search -> card -> slice.build`.
- PR review: `delta.get -> pr.risk.analyze -> card/hotPath for high-risk symbols`.

### 3) Token controls by tool

- `sdl.repo.overview`:
  - `level: "stats"` is cheapest.
  - `level: "full"` auto-enables hotspots unless overridden.
  - Use `directories`, `maxDirectories`, and `maxExportsPerDirectory` to bound payload.
- `sdl.delta.get`:
  - Pass `budget` for large version diffs to constrain blast-radius work.
- `sdl.pr.risk.analyze`:
  - Raise `riskThreshold` (for example `80`) to focus on highest-risk changes.

### 4) Autopilot (`sdl.agent.orchestrate`) guidance

- Always provide a budget (`maxTokens`, `maxActions`, optionally `maxDurationMs`).
- Always scope with `focusSymbols` and/or `focusPaths`.
- Avoid `requireDiagnostics` unless needed; it can add a raw rung.
- Planner token estimates are approximately:
  - `card`: `50`
  - `skeleton`: `200`
  - `hotPath`: `500`
  - `raw`: `2000`
- When over budget, planner trims rungs from the end while keeping at least one rung.

### 5) Do not

- Do not jump directly to raw file reads if SDL tools can answer the question.
- Do not call `sdl.code.needWindow` before trying `sdl.code.getSkeleton`/`sdl.code.getHotPath`.
- Do not use broad `sdl.symbol.search` limits by default.
- Do not rebuild slices repeatedly when `sdl.slice.refresh` can provide incremental deltas.
```

## Why This Replaces `agentIntegration.txt`

- It includes newer tools (`sdl.repo.overview`, `sdl.pr.risk.analyze`, `sdl.agent.orchestrate`).
- It reflects current defaults and caps (compact slice wire format, policy window/token limits, spillover paging).
- It adds concrete cache-aware guidance (`ifNoneMatch`, `knownCardEtags`, `slice.refresh`) for repeat-turn token savings.
