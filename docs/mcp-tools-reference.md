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
- `prefetchStats` (queue depth, hit/waste rates, latency reduction, last run)

### `sdl.index.refresh`
Refresh index in `incremental` or `full` mode.

Example:

```json
{ "repoId": "my-repo", "mode": "incremental" }
```

When called with a progress token, the server emits `notifications/progress` messages with the current stage, file path, and completion percentage. MCP clients that support progress tokens can display real-time indexing status.

In incremental mode, files whose modification time predates their last indexed timestamp are skipped. If no files changed, the existing version is reused instead of creating an empty snapshot.

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

Optional semantic reranking:

```json
{ "repoId": "my-repo", "query": "auth token refresh", "limit": 20, "semantic": true }
```

When semantic mode is enabled, lexical candidates are reranked by embeddings. If the embedding provider is unavailable, the tool falls back to lexical-only results.

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
Get structure-first symbol code view. Returns `null` for files exceeding the configured `maxFileBytes` limit.

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>" }
```

### `sdl.code.getHotPath`
Get identifier-focused excerpt with context. The `matchedIdentifiers` field in the response contains only identifiers that were actually found in the AST, not the full request list.

```json
{
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "identifiersToFind": ["validate", "token"],
  "contextLines": 3
}
```

### `sdl.code.needWindow`
Request raw code window (policy-gated). The `expectedLines` and `maxTokens` values are clamped to the effective policy limits (`maxWindowLines`, `maxWindowTokens`), so requests exceeding policy caps are silently reduced rather than rejected.

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

## HTTP Surface (Non-MCP)

When serving with `sdl-mcp serve --http`, these non-MCP endpoints are available for graph/IDE integrations:

- `/ui/graph`
- `/api/graph/:repoId/slice/:handle`
- `/api/graph/:repoId/symbol/:symbolId/neighborhood`
- `/api/graph/:repoId/blast-radius/:fromVersion/:toVersion`
- `/api/symbol/:repoId/search`
- `/api/symbol/:repoId/card/:symbolId`
- `/api/repo/:repoId/status`
- `/api/repo/:repoId/reindex`
