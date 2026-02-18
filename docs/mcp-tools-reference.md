# MCP Tools Reference

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference (this page)](./mcp-tools-reference.md)
  - [Configuration Reference](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Use this page for the current tool surface exposed by `registerTools`.

## Repository and Indexing

### `sdl.repo.register`
Register repository metadata for indexing.

Example:

```json
{ "repoId": "my-repo", "rootPath": "/workspace/my-repo" }
```

### `sdl.repo.status`
Get status for one repository (latest version, indexed files/symbols, timestamps, health, and watcher telemetry).

Example:

```json
{ "repoId": "my-repo" }
```

Response includes:

- `healthScore`, `healthComponents`, `healthAvailable`
- `watcherHealth` (nullable runtime telemetry snapshot)

### `sdl.index.refresh`
Refresh index in `incremental` or `full` mode.

Example:

```json
{ "repoId": "my-repo", "mode": "incremental" }
```

### `sdl.repo.overview`
Return token-efficient repository overview with directory summaries and hotspots.

Example:

```json
{ "repoId": "my-repo", "level": "full", "includeHotspots": true }
```

## Symbol Discovery

### `sdl.symbol.search`
Search symbols by name/summary.

```json
{ "repoId": "my-repo", "query": "parseConfig", "limit": 20 }
```

### `sdl.symbol.getCard`
Fetch one symbol card.

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>" }
```

### `sdl.context.summary`
Generate a token-bounded context summary for symbol/file/task queries.

```json
{
  "repoId": "my-repo",
  "query": "auth middleware",
  "budget": 2000,
  "format": "markdown",
  "scope": "task"
}
```

## Graph Slice Workflows

### `sdl.slice.build`
Build a task-scoped graph slice.

```json
{
  "repoId": "my-repo",
  "taskText": "trace auth token validation",
  "entrySymbols": ["<symbol-id>"],
  "budget": { "maxCards": 50, "maxEstimatedTokens": 4000 }
}
```

### `sdl.slice.refresh`
Refresh an existing handle and receive changes relative to known version.

```json
{ "sliceHandle": "h_abc123", "knownVersion": "v1770600000000" }
```

### `sdl.slice.spillover.get`
Paginate additional symbols from spillover.

```json
{ "spilloverHandle": "sp_abc123", "pageSize": 20 }
```

## Delta and Risk

### `sdl.delta.get`
Compute delta between two versions with blast-radius support.

```json
{ "repoId": "my-repo", "fromVersion": "v1", "toVersion": "v2" }
```

### `sdl.pr.risk.analyze`
Assess PR-level risk from delta + blast radius and produce test recommendations.

```json
{
  "repoId": "my-repo",
  "fromVersion": "v1",
  "toVersion": "v2",
  "riskThreshold": 70
}
```

## Code Access Ladder

### `sdl.code.getSkeleton`
Get structure-first symbol code view.

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>" }
```

### `sdl.code.getHotPath`
Get identifier-focused excerpt with context.

```json
{
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "identifiersToFind": ["validate", "token"],
  "contextLines": 3
}
```

### `sdl.code.needWindow`
Request raw code window (policy-gated).

```json
{
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "reason": "Need exact branch logic",
  "expectedLines": 80,
  "identifiersToFind": ["if", "catch"]
}
```

## Policy and Agent

### `sdl.policy.get`
Fetch effective policy for a repo.

```json
{ "repoId": "my-repo" }
```

### `sdl.policy.set`
Patch policy values.

```json
{
  "repoId": "my-repo",
  "policyPatch": {
    "maxWindowLines": 220,
    "maxWindowTokens": 1800,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

### `sdl.agent.orchestrate`
Run automated rung selection with evidence capture for agent tasks.

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "find root cause of auth timeout",
  "budget": { "maxTokens": 4000, "maxActions": 12 },
  "options": { "includeTests": true, "requireDiagnostics": true }
}
```

## Tool-Usage Pattern for Agents

Use in this order for most tasks:

1. `sdl.symbol.search`
2. `sdl.symbol.getCard`
3. `sdl.slice.build`
4. `sdl.code.getSkeleton`
5. `sdl.code.getHotPath`
6. `sdl.code.needWindow` only when necessary
