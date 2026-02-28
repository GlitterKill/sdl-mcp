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

Start with `level: "stats"` (cheapest), escalate to `"directories"` or `"full"` only when you need per-directory breakdowns.

```json
{ "repoId": "my-repo", "level": "stats" }
```

Filter output to specific directories and bound payload size:

```json
{
  "repoId": "my-repo",
  "level": "directories",
  "directories": ["src/auth", "src/api"],
  "maxDirectories": 20,
  "maxExportsPerDirectory": 10,
  "includeHotspots": true
}
```

`level: "full"` auto-enables hotspots unless `includeHotspots: false` is set explicitly.

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

The returned card includes `metrics.canonicalTest` (if available), which contains the file path, distance, and proximity information for the nearest test associated with this symbol.

Pass `ifNoneMatch` with the card's ETag to get a lightweight `notModified` response when the symbol has not changed:

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>", "ifNoneMatch": "<etag>" }
```

### `sdl.symbol.getCards`
Batch fetch up to 100 symbol cards in a single round trip. Prefer this over multiple sequential `sdl.symbol.getCard` calls when you already have a list of symbol IDs.

```json
{
  "repoId": "my-repo",
  "symbolIds": ["<symbol-id-1>", "<symbol-id-2>", "<symbol-id-3>"]
}
```

Pass `knownEtags` (map of `symbolId → ETag`) to skip unchanged cards — they return `notModified` instead of the full payload:

```json
{
  "repoId": "my-repo",
  "symbolIds": ["<id1>", "<id2>"],
  "knownEtags": { "<id1>": "<etag1>" }
}
```

The response is an array where each entry is either a full card or a `notModified` marker.

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
Build a task-scoped graph slice. `taskText` alone is sufficient — it triggers auto-discovery of relevant symbols via full-text search in a single round trip, no `entrySymbols` required. Adding `entrySymbols` improves precision.

```json
{
  "repoId": "my-repo",
  "taskText": "trace auth token validation",
  "entrySymbols": ["<symbol-id>"],
  "budget": { "maxCards": 50, "maxEstimatedTokens": 4000 }
}
```

When `editedFiles` is provided, all symbols in those files plus their immediate callers are forced into the slice regardless of score threshold — useful for impact analysis after a code change:

```json
{
  "repoId": "my-repo",
  "taskText": "review changes to auth module",
  "editedFiles": ["src/auth/token.ts"],
  "budget": { "maxCards": 30, "maxEstimatedTokens": 3000 }
}
```

Key optional parameters:

- `minConfidence` (default `0.5`): raise toward `0.8`–`0.95` for precision-focused runs; keep near `0.5` for recall-oriented work
- `knownCardEtags` (map of `symbolId → ETag`): cards with unchanged ETags return as `cardRefs` instead of full payloads, reducing token cost on subsequent slice builds
- `cardDetail` (`"minimal"` | `"signature"` | `"deps"` | `"compact"` | `"full"`): leave unset for default mixed behavior; use `"full"` only when all slice cards are needed in full
- `wireFormatVersion` (default `2`): use `2` for compact wire encoding
- `failingTestPath`: provide a failing test file path to bias slice discovery toward code under test
- `stackTrace`: provide a stack trace to bias slice discovery toward call-path symbols

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

The response includes an `amplifiers` field containing multipliers for dependent symbols that increase blast-radius scoring based on test proximity, fan-in, and change severity. Amplifiers help prioritize high-impact symbols for testing and review.

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

### `sdl.agent.feedback`
Record which symbols were useful or missing during a task. Feedback is stored per version and used for offline slice-ranking tuning.

Required: `repoId`, `versionId` (from `sdl.repo.status`), `sliceHandle` (from the slice you used), `usefulSymbols` (at least one symbol ID).

```json
{
  "repoId": "my-repo",
  "versionId": "v1770600000000",
  "sliceHandle": "h_abc123",
  "usefulSymbols": ["<symbol-id-1>", "<symbol-id-2>"],
  "missingSymbols": ["<symbol-id-3>"],
  "taskType": "debug",
  "taskText": "traced auth timeout to token expiry logic"
}
```

Response includes `feedbackId`, `symbolsRecorded`, and confirmation fields.

### `sdl.agent.feedback.query`
Query stored feedback records and aggregated statistics. Useful for offline tuning pipelines to understand which symbols are consistently useful or missing.

```json
{
  "repoId": "my-repo",
  "versionId": "v1770600000000",
  "limit": 50
}
```

Filter by time window with `since` (ISO timestamp):

```json
{ "repoId": "my-repo", "since": "2026-01-01T00:00:00Z", "limit": 100 }
```

Response includes `feedback` (array of records), `aggregatedStats` (top useful/missing symbols with counts), and `hasMore` (pagination flag).

## Tool-Usage Pattern for Agents

Use in this order for most tasks:

1. `sdl.symbol.search`
2. `sdl.symbol.getCard` — or `sdl.symbol.getCards` when fetching multiple symbols at once
3. `sdl.slice.build`
4. `sdl.code.getSkeleton`
5. `sdl.code.getHotPath`
6. `sdl.code.needWindow` only when necessary
7. `sdl.agent.feedback` after completing a task to record which symbols were useful

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
