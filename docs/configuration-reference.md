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

SDL-MCP is configured via a single JSON file. This reference covers every option, its default, valid values, and when you should change it.

## Config File Location

| Method | Details |
|--------|---------|
| **Default** | User-global `sdlmcp.config.json` (resolved from `SDL_CONFIG_HOME` or OS config dir) |
| **CLI flag** | `--config <PATH>` on any command |
| **Environment** | `SDL_CONFIG` or `SDL_CONFIG_PATH` |

The `sdl-mcp init` command creates this file interactively. You can also copy `config/sdlmcp.config.example.json` and edit it.

### Required Top-Level Fields

Only two fields are required — everything else has sensible defaults:

```json
{
  "repos": [{ "repoId": "...", "rootPath": "..." }],
  "policy": {}
}
```

KuzuDB storage is directory-based. If `graphDatabase.path` is omitted, SDL-MCP defaults to `<configDir>/sdl-mcp-graph`.

---

## Annotated Full Configuration

Below is every option with inline commentary. JSON does not support comments, so this is JSONC for illustration — remove comments before using as a config file.

```jsonc
{
  // ──────────────────────────────────────────────────────────
  // REPOSITORIES — which codebases to index
  // ──────────────────────────────────────────────────────────
  "repos": [
    {
      // Unique ID used in all MCP tool calls (e.g., sdl.symbol.search({ repoId: "my-repo" }))
      "repoId": "my-repo",

      // Path to repository root. Absolute recommended; relative resolved from config file dir.
      "rootPath": "/workspace/my-repo",

      // Glob patterns to exclude from indexing. Add heavy/generated dirs here.
      // If using the Rust engine, also add "**/native/target/**".
      "ignore": [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/build/**",
        "**/.git/**",
        "**/coverage/**"
      ],

      // File extensions to index. Only include languages present in your repo for faster indexing.
      // Supported: ts, tsx, js, jsx, py, go, java, cs, c, cpp, php, rs, kt, sh
      "languages": ["ts", "tsx", "js", "jsx"],

      // Files larger than this (bytes) are skipped. Default: 2000000 (2MB).
      "maxFileBytes": 2000000,

      // Include @types/* declarations from node_modules for TypeScript call resolution.
      // Excludes @types/node. Disable for non-TS repos or if indexing is slow.
      "includeNodeModulesTypes": true,

      // Override auto-detection of package.json location (monorepo roots, custom layouts).
      "packageJsonPath": null,

      // Override auto-detection of tsconfig.json (useful for monorepos with multiple tsconfigs).
      "tsconfigPath": null,

      // Glob patterns to find workspace package.json files in monorepos.
      // Example: ["packages/*/package.json", "apps/*/package.json"]
      "workspaceGlobs": null
    }
  ],

  // ──────────────────────────────────────────────────────────
  // GRAPH DATABASE — KuzuDB directory storage
  // ──────────────────────────────────────────────────────────

  // Optional override for the KuzuDB database directory.
  // If omitted, SDL-MCP defaults to <configDir>/sdl-mcp-graph.
  // Supports ${VAR_NAME} environment variable expansion.
  "graphDatabase": {
    "path": "./data/sdl-mcp-graph"
  },

  // Deprecated legacy database file path (v0.7.x). Only used by the one-time
  // SQLite→Kuzu migration script in v0.8.
  // "dbPath": "./data/sdlmcp.sqlite",

  // ──────────────────────────────────────────────────────────
  // POLICY — gated code access controls
  // ──────────────────────────────────────────────────────────
  "policy": {
    // Max lines returned per sdl.code.needWindow request. Requests above this are clamped.
    "maxWindowLines": 180,

    // Max tokens returned per sdl.code.needWindow request. Requests above this are clamped.
    "maxWindowTokens": 1400,

    // Require non-empty identifiersToFind in sdl.code.needWindow calls.
    // Enforces proof-of-need: agents must specify what they're looking for.
    "requireIdentifiers": true,

    // Allow break-glass override to bypass policy denials (logged in audit trail).
    "allowBreakGlass": true
  },

  // ──────────────────────────────────────────────────────────
  // REDACTION — sensitive data masking in returned code
  // ──────────────────────────────────────────────────────────
  "redaction": {
    // Enable secret redaction in code windows, skeletons, and hot paths.
    "enabled": true,

    // Include built-in patterns (AWS keys, GitHub tokens, private keys, etc.).
    "includeDefaults": true,

    // Additional custom regex patterns to redact.
    "patterns": [
      // Example: redact internal API tokens
      // { "name": "internal-token", "pattern": "INTERNAL_[A-Z0-9]{32}", "flags": "g" }
    ]
  },

  // ──────────────────────────────────────────────────────────
  // INDEXING — how and when code is indexed
  // ──────────────────────────────────────────────────────────
  "indexing": {
    // Number of concurrent file-processing workers during indexing (1-10).
    // Higher = faster on SSDs with many cores. Lower for constrained CI or spinning disks.
    "concurrency": 8,

    // Keep the index fresh by watching for file changes during sdl-mcp serve.
    // Disable in CI or batch-only workflows.
    "enableFileWatching": true,

    // Upper bound on source files the watcher tracks. Prevents memory overload on huge repos.
    "maxWatchedFiles": 25000,

    // Optional cap on worker pool threads. Defaults to a CPU-count heuristic if unset.
    "workerPoolSize": null,

    // Pass-1 indexer implementation: "typescript" (default) or "rust" (native addon).
    // The Rust engine is faster but requires building the native addon first.
    "engine": "typescript",

    // Debounce delay (ms) before processing file-change events (50-5000).
    // Lower = faster incremental updates but more reindex calls during rapid edits.
    // Higher = fewer redundant calls but slower responsiveness.
    "watchDebounceMs": 300
  },

  // ──────────────────────────────────────────────────────────
  // SLICE — graph slice budget and traversal weights
  // ──────────────────────────────────────────────────────────
  "slice": {
    // Default max symbol cards returned per sdl.slice.build call.
    // Overridden per-call via the budget parameter.
    "defaultMaxCards": 60,

    // Default max estimated tokens per slice response.
    "defaultMaxTokens": 12000,

    // Edge weights for BFS/beam search traversal. Higher = stronger pull.
    "edgeWeights": {
      "call": 1.0,    // Function/method calls — strongest signal
      "import": 0.6,  // Module imports — moderate signal
      "config": 0.8   // Configuration references — strong signal
    }
  },

  // ──────────────────────────────────────────────────────────
  // DIAGNOSTICS — TypeScript/JavaScript error reporting
  // ──────────────────────────────────────────────────────────
  "diagnostics": {
    // Enable TypeScript diagnostics integration (type errors, warnings).
    "enabled": true,

    // Diagnostics engine: "tsLS" (TypeScript Language Service, faster) or "tsc" (compiler).
    "mode": "tsLS",

    // Max errors to report before truncating. Prevents overwhelming output.
    "maxErrors": 50,

    // Timeout for diagnostics collection per operation (ms). Min: 100.
    "timeoutMs": 2000,

    // Scope: "changedFiles" (only files modified since last index) or "workspace" (all files).
    // "workspace" is more thorough but much slower on large repos.
    "scope": "changedFiles"
  },

  // ──────────────────────────────────────────────────────────
  // CACHE — in-memory LRU caches for symbol cards and slices
  // ──────────────────────────────────────────────────────────
  "cache": {
    // Toggle all caching. Disable only for debugging cache-related issues.
    "enabled": true,

    // Max symbol cards held in memory (LRU eviction).
    "symbolCardMaxEntries": 2000,

    // Total byte cap for symbol card cache (~100MB default).
    "symbolCardMaxSizeBytes": 104857600,

    // Max graph slices held in memory.
    "graphSliceMaxEntries": 1000,

    // Total byte cap for graph slice cache (~50MB default).
    "graphSliceMaxSizeBytes": 52428800
  },

  // ──────────────────────────────────────────────────────────
  // PLUGINS — adapter plugin loading
  // ──────────────────────────────────────────────────────────
  "plugins": {
    // Paths to plugin entrypoints (files or directories).
    "paths": [],

    // Enable plugin loading. Set false to disable all plugins without removing paths.
    "enabled": true,

    // Require plugin API version compatibility. Disable for development/testing only.
    "strictVersioning": true
  },

  // ──────────────────────────────────────────────────────────
  // SEMANTIC — semantic search, embeddings, and LLM summaries
  // ──────────────────────────────────────────────────────────
  "semantic": {
    // Enable semantic reranking in sdl.symbol.search when semantic: true is passed.
    // When enabled, lexical results are reranked by embedding similarity.
    "enabled": true,

    // Lexical/semantic blend ratio (0.0 = pure lexical, 1.0 = pure semantic).
    // 0.6 gives semantic signals priority while preserving exact-match recall.
    "alpha": 0.6,

    // Embedding provider: "api" (remote), "local" (onnxruntime-node), "mock" (deterministic).
    // Use "mock" for testing or when no embedding service is available.
    // Use "local" for offline environments with onnxruntime-node installed.
    "provider": "mock",

    // Embedding model identifier. Used by "api" and "local" providers.
    "model": "all-MiniLM-L6-v2",

    // Generate LLM-powered symbol summaries during indexing.
    // Requires an API key (summaryApiKey or ANTHROPIC_API_KEY env var).
    // Summaries are cached in the symbol_summary_cache table.
    "generateSummaries": false,

    // LLM model for summary generation. Supports Anthropic Claude or OpenAI-compatible APIs.
    "summaryModel": "claude-haiku-4-5-20251001",

    // API key for the summary LLM provider. Falls back to ANTHROPIC_API_KEY env var.
    "summaryApiKey": null,

    // Base URL for OpenAI-compatible local providers.
    // Example: "http://localhost:11434/v1" for Ollama.
    // If null, uses Anthropic API.
    "summaryApiBaseUrl": null,

    // Max concurrent LLM requests during batch summary generation (1-20).
    // Higher = faster generation but more memory and API quota usage.
    "summaryMaxConcurrency": 5,

    // Symbols per LLM request during index-time summary generation (1-50).
    // Larger batches reduce API calls but need larger context windows.
    "summaryBatchSize": 20,

    // HNSW approximate nearest neighbor index for faster semantic retrieval.
    "ann": {
      // Enable the HNSW ANN index. Useful for large repos (>10k symbols).
      "enabled": false,

      // Bi-directional links per HNSW node (4-64). Higher = better recall, more memory.
      "m": 16,

      // Dynamic candidate list size during index construction (16-500).
      // Higher = better index quality, slower build.
      "efConstruction": 200,

      // Dynamic candidate list size during search (8-256).
      // Higher = better recall, slower queries.
      "efSearch": 50,

      // Maximum elements in the ANN index (1000-1000000).
      "maxElements": 200000
    }
  },

  // ──────────────────────────────────────────────────────────
  // PREFETCH — predictive background warming
  // ──────────────────────────────────────────────────────────
  "prefetch": {
    // Enable background prefetch queue during serve.
    // Predicts likely next requests and pre-computes results.
    "enabled": true,

    // Cap for prefetch resource usage as % of configured budget (1-100).
    "maxBudgetPercent": 20,

    // Number of top symbols warmed on server startup.
    "warmTopN": 50
  },

  // ──────────────────────────────────────────────────────────
  // TRACING — OpenTelemetry observability
  // ──────────────────────────────────────────────────────────
  "tracing": {
    // Enable OpenTelemetry tracing for tool calls and indexing operations.
    "enabled": false,

    // Service name attached to all trace spans.
    "serviceName": "sdl-mcp",

    // Exporter: "console" (stdout), "otlp" (collector endpoint), "memory" (in-process).
    "exporterType": "console",

    // OTLP collector endpoint URL. Required when exporterType is "otlp".
    // Example: "http://localhost:4318/v1/traces"
    "otlpEndpoint": null,

    // Sampling rate for traces (0.0 to 1.0). 1.0 = trace everything.
    "sampleRate": 1.0
  },

  // ──────────────────────────────────────────────────────────
  // PARALLEL SCORER — worker-thread beam search acceleration
  // ──────────────────────────────────────────────────────────
  "parallelScorer": {
    // Enable parallel scoring using worker threads for slice.build.
    // Can improve slice performance on multi-core machines with large graphs.
    "enabled": false,

    // Number of worker threads (1-8). Defaults to CPU-count heuristic if unset.
    "poolSize": null,

    // Minimum candidate count to trigger parallel scoring (1-100).
    // Below this threshold, single-threaded scoring is used.
    "minBatchSize": null
  }
}
```

---

## Field Reference

### `repos[]` (required)

Each entry registers a codebase for indexing. You can index multiple repos in one config.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `repoId` | `string` | — | **Required.** Unique identifier used in all tool calls |
| `rootPath` | `string` | — | **Required.** Absolute or relative path to repo root |
| `ignore` | `string[]` | `["**/node_modules/**", "**/dist/**", "**/.next/**", "**/build/**"]` | Glob patterns to exclude |
| `languages` | `string[]` | All 14 languages | File extensions to index |
| `maxFileBytes` | `integer` | `2000000` (2MB) | Max file size; larger files skipped |
| `includeNodeModulesTypes` | `boolean` | `true` | Index `@types/*` for TS call resolution |
| `packageJsonPath` | `string` | Auto-detected | Override package.json location |
| `tsconfigPath` | `string` | Auto-detected | Override tsconfig.json location |
| `workspaceGlobs` | `string[]` | — | Glob patterns for monorepo workspace package.json files |

**Supported languages:** `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh`

> **When to change:** Add `ignore` patterns for generated directories (e.g., `**/native/target/**` for Rust builds, `**/.venv/**` for Python). Narrow `languages` to only what your repo uses for faster indexing. Set `workspaceGlobs` for monorepos.

---

### `graphDatabase` (optional)

Controls where SDL-MCP stores the KuzuDB graph database (directory path). Supports `${ENV_VAR}` expansion.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `graphDatabase.path` | `string?` | `<configDir>/sdl-mcp-graph` | Path to KuzuDB database directory |

> **When to change:** Move to a fast SSD path if indexing is slow. Use `${SDL_GRAPH_DB_PATH}` (or `${SDL_GRAPH_DB_DIR}`) in CI environments where paths differ between machines.

---

### `dbPath` (deprecated)

Legacy v0.7.x SQLite database file path, only used by the one-time SQLite→Kuzu migration script.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dbPath` | `string?` | — | Legacy SQLite file path (migration only) |

---

### `policy` (required)

Controls the proof-of-need gating system for raw code access via `sdl.code.needWindow`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxWindowLines` | `integer` | `180` | Max lines per code window (min: 1) |
| `maxWindowTokens` | `integer` | `1400` | Max tokens per code window (min: 1) |
| `requireIdentifiers` | `boolean` | `true` | Require `identifiersToFind` in needWindow calls |
| `allowBreakGlass` | `boolean` | `true` | Allow emergency override of policy denials |

Requests exceeding `maxWindowLines` or `maxWindowTokens` are silently clamped (not rejected). Policy can also be changed at runtime via `sdl.policy.set`.

> **When to change:** Increase limits for codebases with large functions. Set `allowBreakGlass: false` in production to enforce strict gating. In CI, tighten to `maxWindowLines: 120, maxWindowTokens: 1000` to control token spend.

---

### `redaction` (optional)

Controls sensitive-data masking in all returned code content.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable redaction |
| `includeDefaults` | `boolean` | `true` | Use built-in patterns (AWS keys, GitHub tokens, private keys, etc.) |
| `patterns` | `object[]` | `[]` | Custom regex patterns |

Each custom pattern:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | No | Label for documentation/logging |
| `pattern` | `string` | Yes | Regex pattern to match |
| `flags` | `string` | No | Regex flags (e.g., `"gi"`) |

> **When to change:** Add custom patterns for internal tokens, connection strings, or proprietary secrets not covered by defaults. Disable only for fully private/air-gapped environments.

---

### `indexing` (optional)

Controls how and when code is indexed.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `concurrency` | `integer` | `8` | 1-10 | Concurrent indexing workers |
| `enableFileWatching` | `boolean` | `true` | — | Auto-reindex on file changes |
| `maxWatchedFiles` | `integer` | `25000` | min: 1 | Cap on tracked files to prevent memory overload |
| `workerPoolSize` | `integer` | Auto | 1-16 | Override worker pool thread count |
| `engine` | `string` | `"typescript"` | `"typescript"` \| `"rust"` | Indexer implementation |
| `watchDebounceMs` | `integer` | `300` | 50-5000 | Debounce delay for file watch events (ms) |

> **When to change:**
> - **CI/batch mode:** Set `enableFileWatching: false`, `concurrency: 2`
> - **Large repos (>25k files):** Increase `maxWatchedFiles` or disable watching
> - **Slow machine:** Lower `concurrency` to 2-4
> - **Rapid-edit workflows:** Lower `watchDebounceMs` to 50-100 for faster incremental updates
> - **Rust engine:** Set `engine: "rust"` after building native addon with `npm run build:native`

---

### `slice` (optional)

Default budget and traversal weights for graph slices (`sdl.slice.build`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultMaxCards` | `integer` | `60` | Default max symbol cards per slice (min: 1) |
| `defaultMaxTokens` | `integer` | `12000` | Default max estimated tokens per slice (min: 1) |
| `edgeWeights.call` | `number` | `1.0` | Weight for function/method call edges (min: 0) |
| `edgeWeights.import` | `number` | `0.6` | Weight for module import edges (min: 0) |
| `edgeWeights.config` | `number` | `0.8` | Weight for configuration reference edges (min: 0) |

Per-call `budget` parameters in `sdl.slice.build` override these defaults.

> **When to change:** Increase `defaultMaxCards` and `defaultMaxTokens` for deep exploration tasks. Adjust edge weights if your codebase has unusual dependency patterns (e.g., heavy config-driven architecture: raise `config` weight).

---

### `diagnostics` (optional)

TypeScript/JavaScript diagnostics integration for delta packs and blast radius.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `true` | — | Enable diagnostics |
| `mode` | `string` | `"tsLS"` | `"tsLS"` \| `"tsc"` | Engine: Language Service (faster) or compiler |
| `maxErrors` | `integer` | `50` | min: 1 | Max errors before truncation |
| `timeoutMs` | `integer` | `2000` | min: 100 | Per-operation timeout (ms) |
| `scope` | `string` | `"changedFiles"` | `"changedFiles"` \| `"workspace"` | Which files to check |

> **When to change:** Disable for non-TypeScript repos. Use `scope: "workspace"` for thorough CI checks (much slower). Increase `timeoutMs` for very large files.

---

### `cache` (optional)

In-memory LRU caches for frequently accessed symbol cards and graph slices.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Toggle all caching |
| `symbolCardMaxEntries` | `integer` | `2000` | Max cached symbol cards (min: 1) |
| `symbolCardMaxSizeBytes` | `integer` | `104857600` (100MB) | Byte cap for card cache (min: 1024) |
| `graphSliceMaxEntries` | `integer` | `1000` | Max cached graph slices (min: 1) |
| `graphSliceMaxSizeBytes` | `integer` | `52428800` (50MB) | Byte cap for slice cache (min: 1024) |

> **When to change:** Increase entries for large repos with many symbols. Decrease byte caps on memory-constrained systems. Disable only for debugging stale-cache issues.

---

### `plugins` (optional)

Adapter plugin loading for extending indexer language support.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `paths` | `string[]` | `[]` | Paths to plugin entrypoints (files or directories) |
| `enabled` | `boolean` | `true` | Toggle plugin loading |
| `strictVersioning` | `boolean` | `true` | Require API version compatibility |

> **When to change:** Add paths when using third-party language adapters. Set `strictVersioning: false` only during plugin development.

---

### `semantic` (optional)

Controls semantic search reranking, embedding generation, and LLM-powered symbol summaries.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `true` | — | Enable semantic reranking in symbol search |
| `alpha` | `number` | `0.6` | 0.0-1.0 | Lexical/semantic blend (0=pure lexical, 1=pure semantic) |
| `provider` | `string` | `"mock"` | `"api"` \| `"local"` \| `"mock"` | Embedding provider |
| `model` | `string` | `"all-MiniLM-L6-v2"` | — | Embedding model identifier |
| `generateSummaries` | `boolean` | `false` | — | Generate LLM summaries during indexing |
| `summaryModel` | `string` | `"claude-haiku-4-5-20251001"` | — | LLM model for summaries |
| `summaryApiKey` | `string?` | `null` | — | API key (falls back to `ANTHROPIC_API_KEY` env var) |
| `summaryApiBaseUrl` | `string?` | `null` | — | Base URL for OpenAI-compatible endpoints |
| `summaryMaxConcurrency` | `integer` | `5` | 1-20 | Max concurrent LLM requests |
| `summaryBatchSize` | `integer` | `20` | 1-50 | Symbols per LLM batch request |

#### `semantic.ann` (nested, optional)

HNSW approximate nearest neighbor index for faster semantic retrieval on large repos.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `false` | — | Enable HNSW ANN index |
| `m` | `integer` | `16` | 4-64 | Bi-directional links per node |
| `efConstruction` | `integer` | `200` | 16-500 | Candidate list size during build |
| `efSearch` | `integer` | `50` | 8-256 | Candidate list size during search |
| `maxElements` | `integer` | `200000` | 1000-1000000 | Max elements in index |

> **When to change:**
> - **Use semantic search in production:** Set `provider: "api"` or `provider: "local"` (with `onnxruntime-node` installed). The `"mock"` provider returns deterministic results for testing only.
> - **Generate summaries:** Set `generateSummaries: true` and provide an API key. Use `summaryApiBaseUrl` for local LLMs (e.g., Ollama at `http://localhost:11434/v1`).
> - **Large repos (>10k symbols):** Enable `ann` for faster semantic search.
> - **Tune relevance:** Adjust `alpha` — lower for exact-match-heavy workflows, higher for natural-language queries.

---

### `prefetch` (optional)

Predictive background warming of likely-needed results during `sdl-mcp serve`.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `true` | — | Toggle prefetch queue |
| `maxBudgetPercent` | `integer` | `20` | 1-100 | Resource cap as % of configured budget |
| `warmTopN` | `integer` | `50` | min: 1 | Symbols warmed on startup |

Prefetch metrics are exposed in `sdl.repo.status` under `prefetchStats` (queue depth, hit/waste rates, latency reduction).

> **When to change:** Disable in CI or batch-only workflows. Increase `warmTopN` for repos where you frequently access many symbols. Lower `maxBudgetPercent` on constrained systems.

---

### `tracing` (optional)

OpenTelemetry observability for tool calls, indexing, and internal operations.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `false` | — | Enable tracing |
| `serviceName` | `string` | `"sdl-mcp"` | — | Service name for trace spans |
| `exporterType` | `string` | `"console"` | `"console"` \| `"otlp"` \| `"memory"` | Trace exporter |
| `otlpEndpoint` | `string?` | — | — | OTLP collector URL (required for `"otlp"`) |
| `sampleRate` | `number` | `1.0` | 0.0-1.0 | Sampling rate (1.0 = trace everything) |

> **When to change:** Enable for production monitoring or debugging performance issues. Use `exporterType: "otlp"` with a Jaeger/Zipkin collector. Lower `sampleRate` under heavy load.

---

### `parallelScorer` (optional)

Worker-thread acceleration for beam search scoring in `sdl.slice.build`.

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | `boolean` | `false` | — | Enable parallel scoring |
| `poolSize` | `integer?` | Auto | 1-8 | Worker thread count |
| `minBatchSize` | `integer?` | Auto | 1-100 | Min candidates to trigger parallelism |

> **When to change:** Enable on multi-core machines where slice building is a bottleneck. Most useful for repos with >5k symbols and large slices.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SDL_CONFIG` / `SDL_CONFIG_PATH` | Path to config file |
| `SDL_CONFIG_HOME` | Directory for default global config resolution |
| `SDL_GRAPH_DB_PATH` | Override graph DB directory path (takes precedence over config) |
| `SDL_GRAPH_DB_DIR` | Alias for graph DB directory path override |
| `SDL_DB_PATH` | Legacy alias for graph DB path override (v0.7.x) |
| `SDL_LOG_LEVEL` | Log level: `debug`, `info`, `warn`, `error` |
| `SDL_LOG_FORMAT` | Log format: `json`, `text` |
| `ANTHROPIC_API_KEY` | Fallback API key for `semantic.generateSummaries` |

SDL-MCP expands `${VAR_NAME}` references inside JSON config values at load time.

---

## Common Profiles

### Fast Local Development

Optimized for rapid iteration with large context.

```json
{
  "indexing": {
    "concurrency": 8,
    "enableFileWatching": true,
    "watchDebounceMs": 100
  },
  "slice": {
    "defaultMaxCards": 100,
    "defaultMaxTokens": 20000
  },
  "prefetch": {
    "enabled": true,
    "warmTopN": 100
  },
  "cache": {
    "enabled": true,
    "symbolCardMaxEntries": 5000
  }
}
```

### Conservative CI

Minimal resources, no background processes.

```json
{
  "indexing": {
    "concurrency": 2,
    "enableFileWatching": false
  },
  "policy": {
    "maxWindowLines": 120,
    "maxWindowTokens": 1000
  },
  "prefetch": { "enabled": false },
  "diagnostics": { "scope": "workspace" },
  "cache": { "enabled": false }
}
```

### Semantic-Enabled with Local LLM

Full semantic search with local Ollama for summaries.

```json
{
  "semantic": {
    "enabled": true,
    "provider": "local",
    "generateSummaries": true,
    "summaryApiBaseUrl": "http://localhost:11434/v1",
    "summaryModel": "llama3",
    "summaryMaxConcurrency": 3,
    "ann": { "enabled": true }
  }
}
```

### Monorepo with Multiple Repos

```json
{
  "repos": [
    {
      "repoId": "frontend",
      "rootPath": "./packages/frontend",
      "languages": ["ts", "tsx"],
      "workspaceGlobs": ["packages/*/package.json"]
    },
    {
      "repoId": "backend",
      "rootPath": "./packages/backend",
      "languages": ["ts"],
      "tsconfigPath": "./packages/backend/tsconfig.json"
    },
    {
      "repoId": "shared",
      "rootPath": "./packages/shared",
      "languages": ["ts"]
    }
  ],
  "graphDatabase": { "path": "./data/sdl-mcp-graph" }
}
```

---

## Native Rust Engine

The optional Rust indexer replaces the TypeScript tree-sitter pass with a native addon for faster symbol extraction. It supports the same 14 languages as the TypeScript engine.

### Prerequisites

- Rust toolchain (rustc 1.70+, cargo)
- `@napi-rs/cli` (installed as a dev dependency)

### Build

```bash
npm run build:native
```

This compiles the native addon in `native/` and produces a platform-specific `.node` file.

### Enable

Set `indexing.engine` to `"rust"` in your config:

```json
{
  "indexing": { "engine": "rust" }
}
```

Add `**/native/target/**` to your repo `ignore` patterns to exclude the Rust build directory from indexing.

### Verify

```bash
npm run test:native-parity
```

This runs parity checks comparing Rust and TypeScript extraction output.

If the native addon fails to load at runtime, the indexer falls back to the TypeScript engine with a warning.

---

## Config Validation

The JSON Schema is at `config/sdlmcp.config.schema.json`. Add a `$schema` reference to your config for editor autocompletion:

```json
{
  "$schema": "./node_modules/sdl-mcp/config/sdlmcp.config.schema.json",
  "repos": [...]
}
```

Run `sdl-mcp doctor` to validate your config and check environment health.
