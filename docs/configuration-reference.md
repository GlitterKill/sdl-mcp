# Configuration Reference

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../README.md)
- [Documentation Hub](./README.md)
  - [Getting Started](./getting-started.md)
  - [CLI Reference](./cli-reference.md)
  - [MCP Tools Reference](./mcp-tools-reference.md)
  - [Configuration Reference (this page)](./configuration-reference.md)
  - [Agent Workflows](./agent-workflows.md)
  - [Troubleshooting](./troubleshooting.md)
- [Legacy User Guide](./USER_GUIDE.md)

</details>
</div>

Main config file:

- Default: user-global `sdlmcp.config.json`
- Override per command: `--config <PATH>`
- Override via env: `SDL_CONFIG` (or `SDL_CONFIG_PATH`)

## Full Example

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "/workspace/my-repo",
      "ignore": ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      "languages": ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "php", "rs", "kt", "sh"],
      "maxFileBytes": 2000000
    }
  ],
  "dbPath": "./data/sdlmcp.sqlite",
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  },
  "redaction": {
    "enabled": true,
    "includeDefaults": true,
    "patterns": []
  },
  "indexing": {
    "concurrency": 8,
    "enableFileWatching": true,
    "maxWatchedFiles": 25000,
    "engine": "typescript"
  },
  "slice": {
    "defaultMaxCards": 60,
    "defaultMaxTokens": 12000,
    "edgeWeights": {
      "call": 1.0,
      "import": 0.6,
      "config": 0.8
    }
  },
  "diagnostics": {
    "enabled": true,
    "mode": "tsLS",
    "maxErrors": 50,
    "timeoutMs": 2000,
    "scope": "changedFiles"
  },
  "cache": {
    "enabled": true,
    "symbolCardMaxEntries": 2000,
    "symbolCardMaxSizeBytes": 104857600,
    "graphSliceMaxEntries": 1000,
    "graphSliceMaxSizeBytes": 52428800
  },
  "plugins": {
    "paths": [],
    "enabled": true,
    "strictVersioning": true
  },
  "semantic": {
    "enabled": false,
    "alpha": 0.6,
    "provider": "mock",
    "model": "all-MiniLM-L6-v2",
    "generateSummaries": false
  },
  "prefetch": {
    "enabled": false,
    "maxBudgetPercent": 20,
    "warmTopN": 50
  }
}
```

## Field Guide

### `repos[]`

- `repoId`: unique identifier used in tool calls
- `rootPath`: absolute path recommended
- `ignore`: glob patterns to exclude heavy or generated content. If you use the native Rust engine, include `**/native/target/**`.
- `languages`: include only needed languages for faster indexing
- `maxFileBytes`: per-file hard cap
- `packageJsonPath`: optional path to `package.json` (auto-detected if not set)
- `tsconfigPath`: optional path to `tsconfig.json` (auto-detected if not set)
- `workspaceGlobs`: optional globs to find workspace `package.json` files (monorepo support)

### `dbPath`

SQLite ledger path. Keep this on local fast storage for best performance.

### `policy`

Controls gated code access behavior:

- `maxWindowLines`
- `maxWindowTokens`
- `requireIdentifiers`
- `allowBreakGlass`

### `redaction`

Controls sensitive-data masking in returned content.

### `indexing`

- `concurrency`: increase on strong local machines, lower in constrained CI (max: 10)
- `enableFileWatching`: keeps index fresh during active development
- `maxWatchedFiles`: hard cap to prevent watcher overload on very large repos
- `workerPoolSize`: optional worker pool size cap (defaults to CPU-count based heuristic)
- `engine`: pass-1 indexer implementation, either `typescript` (default) or `rust`

### `slice`

Defaults for graph slice budget and edge weighting.

### `diagnostics`

TypeScript/JavaScript diagnostics integration controls.

### `cache`

Controls in-memory caching for symbol cards and graph slices.

### `plugins`

Controls adapter plugin loading. See the Plugin SDK docs for authoring and packaging.

### `semantic`

Controls optional semantic search and summary generation behavior.

- `enabled`: enables semantic reranking in symbol search
- `alpha`: lexical/semantic blend (0..1, default `0.6`)
- `provider`: `api`, `local`, or `mock`
- `model`: embedding model identifier
- `generateSummaries`: enables generated symbol summaries (disabled by default)

Use `provider: "local"` for offline environments with `onnxruntime-node` installed.

### `prefetch`

Controls predictive prefetch behavior.

- `enabled`: toggles background prefetch queue
- `maxBudgetPercent`: cap for prefetch resource usage relative to configured budget
- `warmTopN`: number of symbols warmed on `serve` startup when prefetch is enabled

Prefetch effectiveness and queue metrics are exposed in `sdl.repo.status.prefetchStats`.

## Common Profiles

### Fast Local Development

```json
{
  "indexing": { "concurrency": 8, "enableFileWatching": true },
  "slice": { "defaultMaxCards": 200, "defaultMaxTokens": 8000 }
}
```

### Conservative CI

```json
{
  "indexing": { "concurrency": 2, "enableFileWatching": false },
  "policy": { "maxWindowLines": 120, "maxWindowTokens": 1000 }
}
```

## Environment Overrides

- `SDL_CONFIG` (or `SDL_CONFIG_PATH`) to set the config file path
- `SDL_CONFIG_HOME` to set the directory used for default global config path resolution
- `SDL_DB_PATH` to override the SQLite database path

SDL-MCP also expands environment variables inside JSON config values using `${VAR_NAME}` syntax.
