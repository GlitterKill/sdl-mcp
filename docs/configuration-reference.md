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

</details>
</div>

SDL-MCP is configured via a single JSON file. This reference covers every option, its default, valid values, and when you should change it.

## Config File Location

| Method          | Details                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| **Default**     | User-global `sdlmcp.config.json` (resolved from `SDL_CONFIG_HOME` or OS config dir) |
| **CLI flag**    | `--config <PATH>` on any command                                                    |
| **Environment** | `SDL_CONFIG` or `SDL_CONFIG_PATH`                                                   |

The `sdl-mcp init` command creates this file interactively. You can also copy `config/sdlmcp.config.example.json` and edit it.

### Required Top-Level Fields

Only two fields are required — everything else has sensible defaults:

```json
{
  "repos": [{ "repoId": "...", "rootPath": "..." }],
  "policy": {}
}
```

Ladybug storage is file-based. If `graphDatabase.path` is omitted, SDL-MCP defaults to `<configDir>/sdl-mcp-graph.lbug`.

---

## Annotated Full Configuration

Below is every option with inline commentary. JSON does not support comments, so this is JSONC for illustration — remove comments before using as a config file. All values shown are the defaults.

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
        "**/coverage/**",
      ],

      // File extensions to index. Only include languages present in your repo for faster indexing.
      // Supported: ts, tsx, js, jsx, py, go, java, cs, c, cpp, php, rs, kt, sh
      "languages": ["ts", "tsx", "js", "jsx", "py", "go", "java", "cs", "c", "cpp", "php", "rs", "kt", "sh"],

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
      "workspaceGlobs": null,
    },
  ],

  // ──────────────────────────────────────────────────────────
  // GRAPH DATABASE — Ladybug single-file storage
  // ──────────────────────────────────────────────────────────

  // Optional override for the Ladybug database file.
  // If omitted, SDL-MCP defaults to <configDir>/sdl-mcp-graph.lbug.
  // Supports ${VAR_NAME} environment variable expansion.
  "graphDatabase": {
    "path": null,
  },

  // Deprecated legacy database file path (v0.7.x). Only used by the one-time
  // SQLite→Ladybug migration script in v0.8.
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
    "allowBreakGlass": false,

    // Default deny for raw code windows (subjects needWindow to proof-of-need gating).
    "defaultDenyRaw": true,

    // Optional server-side budget defaults applied when the client does not supply them.
    "budgetCaps": null,
    // Example: { "maxCards": 60, "maxEstimatedTokens": 12000 }

    // Optional default minCallConfidence for symbol-card and slice call-edge filtering.
    // Leave null to keep call-edge filtering request-driven only.
    "defaultMinCallConfidence": null,
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
    ],
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

    // Pass-1 indexer implementation: "rust" (default, native addon) or "typescript" (fallback).
    // The Rust engine is faster. Falls back to TypeScript automatically if native addon is unavailable.
    "engine": "rust",

    // Debounce delay (ms) before processing file-change events (50-5000).
    // Lower = faster incremental updates but more reindex calls during rapid edits.
    // Higher = fewer redundant calls but slower responsiveness.
    "watchDebounceMs": 300,
  },

  // ──────────────────────────────────────────────────────────
  // LIVE INDEX — editor buffer overlay for draft-aware intelligence
  // ──────────────────────────────────────────────────────────
  "liveIndex": {
    "enabled": true,               // Enable live overlay for unsaved buffers
    "debounceMs": 75,              // Parse delay after buffer update (25-5000)
    "idleCheckpointMs": 15000,     // Auto-checkpoint after idle (1000-300000)
    "maxDraftFiles": 200,          // Max concurrent draft files (1-10000)
    "reconcileConcurrency": 1,     // Concurrent overlay→DB merge jobs (1-8)
    "clusterRefreshThreshold": 25, // Reconciled symbols before cluster refresh (1-1000)
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
      "call": 1.0, // Function/method calls — strongest signal
      "import": 0.6, // Module imports — moderate signal
      "config": 0.8, // Configuration references — strong signal
    },
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
    "scope": "changedFiles",
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
    "graphSliceMaxSizeBytes": 52428800,
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
    "strictVersioning": true,
  },

  // ──────────────────────────────────────────────────────────
  // SEMANTIC — semantic search, embeddings, and LLM summaries
  // ──────────────────────────────────────────────────────────
  "semantic": {
    // Enable semantic reranking in sdl.symbol.search when semantic: true is passed.
    // When enabled, lexical results are reranked by embedding similarity.
    "enabled": true,

    // @deprecated — use retrieval.fusion.rrfK instead.
    // Legacy lexical/semantic blend ratio (0.0 = pure lexical, 1.0 = pure semantic).
    // Still honoured in "legacy" retrieval mode; ignored when retrieval.mode is "hybrid".
    "alpha": 0.6,

    // Embedding provider: "local" (onnxruntime-node, default), "api" (remote), "mock" (deterministic).
    // Use "local" for offline environments with onnxruntime-node installed.
    // Use "mock" for testing or when no embedding service is available.
    "provider": "local",

    // Embedding model identifier. Used by "api" and "local" providers.
    "model": "all-MiniLM-L6-v2",

    // Override directory for downloaded ONNX model files. Defaults to platform-specific cache.
    "modelCacheDir": null,

    // Generate LLM-powered symbol summaries during indexing.
    // Requires an API key (summaryApiKey or ANTHROPIC_API_KEY env var).
    // Summaries are cached as SummaryCache graph nodes in LadybugDB.
    "generateSummaries": false,

    // Summary LLM backend, independent from the embedding provider.
    // "api" = Anthropic, "local" = OpenAI-compatible (Ollama), "mock" = deterministic.
    // Defaults to the embedding "provider" value when null.
    "summaryProvider": null,

    // LLM model for summary generation. Defaults per-provider:
    // "api" uses "claude-haiku-4-5-20251001", "local" uses "gpt-4o-mini".
    "summaryModel": null,

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

    // @deprecated — Removed in v0.10.1. Use retrieval.vector instead.
    // Legacy HNSW ANN sidecar index config. Silently ignored; retained only for
    // backward-compatible config parsing.
    "ann": {
      "enabled": true,
      "m": 16,              // Bi-directional links per HNSW node (4-64)
      "efConstruction": 200, // Candidate list during build (16-500)
      "efSearch": 50,        // Candidate list during search (8-256)
      "maxElements": 200000, // Max elements in index (1000-1000000)
    },

    // Hybrid retrieval pipeline configuration (FTS + vector fusion).
    // Replaces legacy embedding re-ranking with a two-stage pipeline.
    "retrieval": {
      // "legacy" = original semantic-only re-rank; "hybrid" = FTS + vector fusion pipeline.
      "mode": "hybrid",

      // When true, file-extension filtering is optional (not enforced) during retrieval.
      "extensionsOptional": true,

      // Full-text search stage configuration.
      "fts": {
        "enabled": true,
        "indexName": "symbol_search_text_v1", // FTS index name on Symbol.searchText
        "topK": 75,                           // Max FTS candidates before fusion (1-500)
        "conjunctive": false,                 // true = AND all terms; false = OR
      },

      // Vector (HNSW) retrieval stage using native Ladybug vector indexes.
      "vector": {
        "enabled": true,
        "topK": 75,       // Max candidates per model (1-500)
        "efs": 200,        // Query-time accuracy (efSearch) (8-1000)
        "indexes": {       // Per-model index name overrides
          "all-MiniLM-L6-v2": { "indexName": "symbol_vec_minilm_l6_v2" },
          "nomic-embed-text-v1.5": { "indexName": "symbol_vec_nomic_embed_v15" },
        },
      },

      // Score fusion for combining FTS and vector results.
      "fusion": {
        "strategy": "rrf",  // Reciprocal Rank Fusion
        "rrfK": 60,         // RRF smoothing constant (1-1000)
      },

      // Max candidate symbols after fusion re-ranking (10-1000).
      "candidateLimit": 100,
    },
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
    "warmTopN": 50,
  },

  // ──────────────────────────────────────────────────────────
  // TRACING — OpenTelemetry observability
  // ──────────────────────────────────────────────────────────
  "tracing": {
    // Enable OpenTelemetry tracing for tool calls and indexing operations.
    "enabled": true,

    // Service name attached to all trace spans.
    "serviceName": "sdl-mcp",

    // Exporter: "console" (stdout), "otlp" (collector endpoint), "memory" (in-process).
    "exporterType": "console",

    // OTLP collector endpoint URL. Required when exporterType is "otlp".
    // Example: "http://localhost:4318/v1/traces"
    "otlpEndpoint": null,

    // Sampling rate for traces (0.0 to 1.0). 1.0 = trace everything.
    "sampleRate": 1.0,
  },

  // ──────────────────────────────────────────────────────────
  // PARALLEL SCORER — worker-thread beam search acceleration
  // ──────────────────────────────────────────────────────────
  "parallelScorer": {
    // Enable parallel scoring using worker threads for slice.build.
    // Improves slice performance on multi-core machines with large graphs.
    "enabled": true,

    // Number of worker threads (1-8). Defaults to CPU-count heuristic if unset.
    "poolSize": null,

    // Minimum candidate count to trigger parallel scoring (1-100).
    // Below this threshold, single-threaded scoring is used.
    "minBatchSize": null,
  },

  // ──────────────────────────────────────────────────────────
  // CONCURRENCY — session, tool, and DB connection limits
  // ──────────────────────────────────────────────────────────
  "concurrency": {
    "maxSessions": 8,          // Max concurrent HTTP sessions (1-16)
    "maxToolConcurrency": 8,   // Max concurrent tool handler executions (1-32)
    "readPoolSize": 4,         // LadybugDB read connections (1-8)
    "writeQueueTimeoutMs": 30000,  // Queued write timeout (ms)
    "toolQueueTimeoutMs": 30000,   // Queued tool invocation timeout (ms)
  },

  // ──────────────────────────────────────────────────────────
  // RUNTIME — sandboxed command execution via sdl.runtime.execute
  // ──────────────────────────────────────────────────────────
  "runtime": {
    // Must be true to use sdl.runtime.execute.
    "enabled": false,

    // Whitelist of runtimes. 16 supported: node, typescript, python, shell,
    // ruby, php, perl, r, elixir, go, java, kotlin, rust, c, cpp, csharp.
    "allowedRuntimes": ["node", "python"],

    // Additional executables beyond the runtime defaults (e.g., ["bun", "deno"]).
    "allowedExecutables": [],

    // Default execution timeout in milliseconds (100-600000).
    "maxDurationMs": 30000,

    // Max stdout capture size in bytes. Default: 1048576 (1 MB).
    "maxStdoutBytes": 1048576,

    // Max stderr capture size in bytes. Default: 262144 (256 KB).
    "maxStderrBytes": 262144,

    // Max persisted artifact size in bytes. Default: 10485760 (10 MB).
    "maxArtifactBytes": 10485760,

    // Hours to retain output artifacts before cleanup. Default: 24.
    "artifactTtlHours": 24,

    // Max concurrent runtime executions (1-8). Default: 2.
    "maxConcurrentJobs": 2,

    // Environment variables passed through to subprocesses.
    "envAllowlist": [],

    // Override directory for runtime output artifacts. Auto-detected if null.
    "artifactBaseDir": null,
  },

  // ──────────────────────────────────────────────────────────
  // GATEWAY — namespace-scoped tool registration
  // ──────────────────────────────────────────────────────────
  "gateway": {
    "enabled": true,          // Enable gateway-mode tool registration
    "emitLegacyTools": false,  // Legacy tool aliases (deprecated)
  },

  // ──────────────────────────────────────────────────────────
  // HTTP AUTH — bearer-token authentication for HTTP transport
  // ──────────────────────────────────────────────────────────
  "httpAuth": {
    // Disabled by default. Enable for shared dev servers or production HTTP transport.
    // Has no effect on stdio transport.
    "enabled": false,

    // Static bearer token. When null, a random token is generated at startup.
    // Set a fixed value for shared dev servers or CI pipelines.
    "token": null,
  },

  // ──────────────────────────────────────────────────────────
  // CODE MODE — sdl.manual + sdl.chain tool chaining
  // ──────────────────────────────────────────────────────────
  "codeMode": {
    "enabled": true,            // Enable Code Mode tools (sdl.action.search, sdl.manual, sdl.chain)
    "exclusive": true,          // Suppress gateway and legacy tools — only register code-mode tools + discovery
    "maxChainSteps": 20,        // Max steps per chain (1-50)
    "maxChainTokens": 50000,    // Max tokens per chain (100-500000)
    "maxChainDurationMs": 60000,// Max chain duration in ms (1000-300000)
    "ladderValidation": "warn", // off | warn | enforce
    "etagCaching": true,        // Auto-inject ETags within chains
  },

  // ──────────────────────────────────────────────────────────
  // SECURITY — access restrictions
  // ──────────────────────────────────────────────────────────
  "security": {
    // Whitelist of allowed repo root paths. Empty = allow any path.
    "allowedRepoRoots": [],
  },
}
```

---

## Field Reference

### `repos[]` (required)

Each entry registers a codebase for indexing. You can index multiple repos in one config.

| Field                     | Type       | Default                                                              | Description                                             |
| ------------------------- | ---------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `repoId`                  | `string`   | —                                                                    | **Required.** Unique identifier used in all tool calls  |
| `rootPath`                | `string`   | —                                                                    | **Required.** Absolute or relative path to repo root    |
| `ignore`                  | `string[]` | `["**/node_modules/**", "**/dist/**", "**/.next/**", "**/build/**"]` | Glob patterns to exclude                                |
| `languages`               | `string[]` | All supported                                                     | File extensions to index                                |
| `maxFileBytes`            | `integer`  | `2000000` (2MB)                                                      | Max file size; larger files skipped                     |
| `includeNodeModulesTypes` | `boolean`  | `true`                                                               | Index `@types/*` for TS call resolution                 |
| `packageJsonPath`         | `string`   | Auto-detected                                                        | Override package.json location                          |
| `tsconfigPath`            | `string`   | Auto-detected                                                        | Override tsconfig.json location                         |
| `workspaceGlobs`          | `string[]` | —                                                                    | Glob patterns for monorepo workspace package.json files |

**Supported languages:** `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh`

> **When to change:** Add `ignore` patterns for generated directories (e.g., `**/native/target/**` for Rust builds, `**/.venv/**` for Python). Narrow `languages` to only what your repo uses for faster indexing. Set `workspaceGlobs` for monorepos.

---

### `graphDatabase` (optional)

Controls where SDL-MCP stores the Ladybug graph database (file path). Supports `${ENV_VAR}` expansion.

| Field                | Type      | Default                          | Description                       |
| -------------------- | --------- | -------------------------------- | --------------------------------- |
| `graphDatabase.path` | `string?` | `<configDir>/sdl-mcp-graph.lbug` | Path to the Ladybug database file |

> **When to change:** Move to a fast SSD path if indexing is slow. Use `${SDL_GRAPH_DB_PATH}` for an explicit file path, or `${SDL_GRAPH_DB_DIR}` to point at a containing directory and let SDL-MCP place `sdl-mcp-graph.lbug` inside it.

---

### `dbPath` (deprecated)

Legacy v0.7.x SQLite database file path, only used by the one-time SQLite→Ladybug migration script.

| Field    | Type      | Default | Description                              |
| -------- | --------- | ------- | ---------------------------------------- |
| `dbPath` | `string?` | —       | Legacy SQLite file path (migration only) |

---

### `policy` (required)

Controls the proof-of-need gating system for raw code access via `sdl.code.needWindow`.

| Field                      | Type      | Default | Description                                                                           |
| -------------------------- | --------- | ------- | ------------------------------------------------------------------------------------- |
| `maxWindowLines`           | `integer` | `180`   | Min: 1      | Max lines per code window                                                             |
| `maxWindowTokens`          | `integer` | `1400`  | Min: 1      | Max tokens per code window                                                            |
| `requireIdentifiers`       | `boolean` | `true`  | —           | Require `identifiersToFind` in needWindow calls                                       |
| `allowBreakGlass`          | `boolean` | `false` | —           | Allow emergency override of policy denials                                            |
| `defaultDenyRaw`           | `boolean` | `true`  | —           | Default deny for raw code windows (subjects needWindow to proof-of-need gating)       |
| `budgetCaps`               | `object?` | `null`  | —           | Optional server-side budget defaults: `{ maxCards, maxEstimatedTokens }`              |
| `defaultMinCallConfidence` | `number?` | `null`  | 0.0-1.0     | Optional server-side default for `symbol.getCard` / `slice.build` call-edge filtering |

Requests exceeding `maxWindowLines` or `maxWindowTokens` are silently clamped (not rejected). Policy can also be changed at runtime via `sdl.policy.set`.

`defaultMinCallConfidence` is optional. Leave it unset to keep call-edge filtering request-driven. When set, it becomes the default threshold for `minCallConfidence` unless the client overrides it per request.

> **When to change:** Increase limits for codebases with large functions. Set `allowBreakGlass: false` in production to enforce strict gating. In CI, tighten to `maxWindowLines: 120, maxWindowTokens: 1000` to control token spend. Set `defaultMinCallConfidence` only if you want low-confidence heuristic calls hidden by default.

---

### `redaction` (optional)

Controls sensitive-data masking in all returned code content.

| Field             | Type       | Default | Description                                                         |
| ----------------- | ---------- | ------- | ------------------------------------------------------------------- |
| `enabled`         | `boolean`  | `true`  | Enable redaction                                                    |
| `includeDefaults` | `boolean`  | `true`  | Use built-in patterns (AWS keys, GitHub tokens, private keys, etc.) |
| `patterns`        | `object[]` | `[]`    | Custom regex patterns                                               |

Each custom pattern:

| Field     | Type     | Required | Description                     |
| --------- | -------- | -------- | ------------------------------- |
| `name`    | `string` | No       | Label for documentation/logging |
| `pattern` | `string` | Yes      | Regex pattern to match          |
| `flags`   | `string` | No       | Regex flags (e.g., `"gi"`)      |

> **When to change:** Add custom patterns for internal tokens, connection strings, or proprietary secrets not covered by defaults. Disable only for fully private/air-gapped environments.

---

### `indexing` (optional)

Controls how and when code is indexed.

| Field                | Type      | Default        | Range                      | Description                                     |
| -------------------- | --------- | -------------- | -------------------------- | ----------------------------------------------- |
| `concurrency`        | `integer` | `8`            | 1-10                       | Concurrent indexing workers                     |
| `enableFileWatching` | `boolean` | `true`         | —                          | Auto-reindex on file changes                    |
| `maxWatchedFiles`    | `integer` | `25000`        | min: 1                     | Cap on tracked files to prevent memory overload |
| `workerPoolSize`     | `integer` | Auto           | 1-16                       | Override worker pool thread count               |
| `engine`             | `string`  | `"rust"`       | `"typescript"` \| `"rust"` | Indexer implementation (falls back to TS if native addon missing) |
| `watchDebounceMs`    | `integer` | `300`          | 50-5000                    | Debounce delay for file watch events (ms)       |

> **When to change:**
>
> - **CI/batch mode:** Set `enableFileWatching: false`, `concurrency: 2`
> - **Large repos (>25k files):** Increase `maxWatchedFiles` or disable watching
> - **Slow machine:** Lower `concurrency` to 2-4
> - **Rapid-edit workflows:** Lower `watchDebounceMs` to 50-100 for faster incremental updates
> - **Rust engine:** Set `engine: "rust"` after building native addon with `npm run build:native`

---

### `slice` (optional)

Default budget and traversal weights for graph slices (`sdl.slice.build`).

| Field                | Type      | Default | Description                                       |
| -------------------- | --------- | ------- | ------------------------------------------------- |
| `defaultMaxCards`    | `integer` | `60`    | Default max symbol cards per slice (min: 1)       |
| `defaultMaxTokens`   | `integer` | `12000` | Default max estimated tokens per slice (min: 1)   |
| `edgeWeights.call`   | `number`  | `1.0`   | Weight for function/method call edges (min: 0)    |
| `edgeWeights.import` | `number`  | `0.6`   | Weight for module import edges (min: 0)           |
| `edgeWeights.config` | `number`  | `0.8`   | Weight for configuration reference edges (min: 0) |

Per-call `budget` parameters in `sdl.slice.build` override these defaults.

> **When to change:** Increase `defaultMaxCards` and `defaultMaxTokens` for deep exploration tasks. Adjust edge weights if your codebase has unusual dependency patterns (e.g., heavy config-driven architecture: raise `config` weight).

---

### `diagnostics` (optional)

TypeScript/JavaScript diagnostics integration for delta packs and blast radius.

| Field       | Type      | Default          | Range                             | Description                                   |
| ----------- | --------- | ---------------- | --------------------------------- | --------------------------------------------- |
| `enabled`   | `boolean` | `true`           | —                                 | Enable diagnostics (only applies to TS/JS repos) |
| `mode`      | `string`  | `"tsLS"`         | `"tsLS"` \| `"tsc"`               | Engine: Language Service (faster) or compiler |
| `maxErrors` | `integer` | `50`             | min: 1                            | Max errors before truncation                  |
| `timeoutMs` | `integer` | `2000`           | min: 100                          | Per-operation timeout (ms)                    |
| `scope`     | `string`  | `"changedFiles"` | `"changedFiles"` \| `"workspace"` | Which files to check                          |

> **When to change:** Disable for non-TypeScript repos. Use `scope: "workspace"` for thorough CI checks (much slower). Increase `timeoutMs` for very large files.

---

### `cache` (optional)

In-memory LRU caches for frequently accessed symbol cards and graph slices.

| Field                    | Type      | Default             | Description                          |
| ------------------------ | --------- | ------------------- | ------------------------------------ |
| `enabled`                | `boolean` | `true`              | Toggle all caching                   |
| `symbolCardMaxEntries`   | `integer` | `2000`              | Max cached symbol cards (min: 1)     |
| `symbolCardMaxSizeBytes` | `integer` | `104857600` (100MB) | Byte cap for card cache (min: 1024)  |
| `graphSliceMaxEntries`   | `integer` | `1000`              | Max cached graph slices (min: 1)     |
| `graphSliceMaxSizeBytes` | `integer` | `52428800` (50MB)   | Byte cap for slice cache (min: 1024) |

> **When to change:** Increase entries for large repos with many symbols. Decrease byte caps on memory-constrained systems. Disable only for debugging stale-cache issues.

---

### `plugins` (optional)

Adapter plugin loading for extending indexer language support.

| Field              | Type       | Default | Description                                        |
| ------------------ | ---------- | ------- | -------------------------------------------------- |
| `paths`            | `string[]` | `[]`    | Paths to plugin entrypoints (files or directories) |
| `enabled`          | `boolean`  | `true`  | Toggle plugin loading                              |
| `strictVersioning` | `boolean`  | `true`  | Require API version compatibility                  |

> **When to change:** Add paths when using third-party language adapters. Set `strictVersioning: false` only during plugin development.

---

### `semantic` (optional)

Controls semantic search reranking, embedding generation, and LLM-powered symbol summaries.

| Field                   | Type      | Default                       | Range                            | Description                                              |
| ----------------------- | --------- | ----------------------------- | -------------------------------- | -------------------------------------------------------- |
| `enabled`               | `boolean` | `true`                        | —                                | Enable semantic reranking in symbol search               |
| `alpha`                 | `number`  | `0.6`                         | 0.0-1.0                          | **Deprecated** — use `retrieval.fusion.rrfK` instead. Legacy lexical/semantic blend weight |
| `provider`              | `string`  | `"local"`                     | `"api"` \| `"local"` \| `"mock"` | Embedding provider                                       |
| `model`                 | `string`  | `"all-MiniLM-L6-v2"`          | —                                | Embedding model identifier                               |
| `generateSummaries`     | `boolean` | `false`                       | —                                | Generate LLM summaries during indexing                   |
| `summaryModel`          | `string`  | `"claude-haiku-4-5-20251001"` | —                                | LLM model for summaries                                  |
| `summaryApiKey`         | `string?` | `null`                        | —                                | API key (falls back to `ANTHROPIC_API_KEY` env var)      |
| `summaryApiBaseUrl`     | `string?` | `null`                        | —                                | Base URL for OpenAI-compatible endpoints                 |
| `summaryMaxConcurrency` | `integer` | `5`                           | 1-20                             | Max concurrent LLM requests                              |
| `summaryBatchSize`      | `integer` | `20`                          | 1-50                             | Symbols per LLM batch request                            |
| `modelCacheDir`         | `string?` | `null`                        | —                                | Override directory for downloaded ONNX model files       |

#### `semantic.retrieval` (nested, optional)

Hybrid retrieval configuration. Replaces legacy alpha-blending with FTS + vector search fused via Reciprocal Rank Fusion (RRF).

| Field                | Type      | Default    | Range                  | Description                                      |
| -------------------- | --------- | ---------- | ---------------------- | ------------------------------------------------ |
| `mode`               | `string`  | `"hybrid"` | `"legacy"` \| `"hybrid"` | Retrieval strategy                              |
| `extensionsOptional` | `boolean` | `true`     | —                      | Allow graceful fallback when extensions unavailable |
| `candidateLimit`     | `integer` | `100`      | 10-1000                | Max candidates after fusion                      |

#### `semantic.retrieval.fts` (nested, optional)

Full-text search stage configuration.

| Field         | Type      | Default                    | Range | Description                            |
| ------------- | --------- | -------------------------- | ----- | -------------------------------------- |
| `enabled`     | `boolean` | `true`                     | —     | Enable FTS retrieval                   |
| `indexName`   | `string`  | `"symbol_search_text_v1"`  | —     | FTS index name on Symbol.searchText    |
| `topK`        | `integer` | `75`                       | 1-500 | Max FTS candidates                     |
| `conjunctive` | `boolean` | `false`                    | —     | `true` = AND all terms; `false` = OR   |

#### `semantic.retrieval.vector` (nested, optional)

Vector search stage configuration. Uses native Ladybug vector indexes on Symbol embedding properties.

| Field     | Type      | Default | Range   | Description                              |
| --------- | --------- | ------- | ------- | ---------------------------------------- |
| `enabled` | `boolean` | `true`  | —       | Enable vector retrieval                  |
| `topK`    | `integer` | `75`    | 1-500   | Max candidates per model                 |
| `efs`     | `integer` | `200`   | 8-1000  | Query-time accuracy parameter            |
| `indexes` | `object`  | —       | —       | Per-model index name overrides (optional)|

#### `semantic.retrieval.fusion` (nested, optional)

Fusion strategy for combining FTS and vector candidates.

| Field      | Type      | Default | Range  | Description                              |
| ---------- | --------- | ------- | ------ | ---------------------------------------- |
| `strategy` | `string`  | `"rrf"` | `"rrf"` | Fusion algorithm (Reciprocal Rank Fusion)|
| `rrfK`     | `integer` | `60`    | 1-1000 | RRF smoothing constant (higher = more uniform ranking) |

#### `semantic.ann` (removed)

> **Removed in v0.10.1**: The HNSW sidecar index (`ann-index.ts`) has been deleted. Use `semantic.retrieval.vector` for native Ladybug vector indexes instead. Legacy `semantic.ann` config keys are silently ignored for backward compatibility.

> **When to change:**
>
> - **Use semantic search in production:** Set `provider: "api"` or `provider: "local"` (with `onnxruntime-node` installed). The `"mock"` provider returns deterministic results for testing only.
> - **Generate summaries:** Set `generateSummaries: true` and provide an API key. Use `summaryApiBaseUrl` for local LLMs (e.g., Ollama at `http://localhost:11434/v1`).
> - **Enable hybrid retrieval:** Set `retrieval.mode: "hybrid"` for best search quality. Falls back automatically if extensions are unavailable.
> - **Tune relevance (legacy):** Adjust `alpha` — lower for exact-match-heavy workflows, higher for natural-language queries. Note: `alpha` is deprecated when using hybrid retrieval.

---

### `prefetch` (optional)

Predictive background warming of likely-needed results during `sdl-mcp serve`.

| Field              | Type      | Default | Range  | Description                            |
| ------------------ | --------- | ------- | ------ | -------------------------------------- |
| `enabled`          | `boolean` | `true`  | —      | Toggle prefetch queue                  |
| `maxBudgetPercent` | `integer` | `20`    | 1-100  | Resource cap as % of configured budget |
| `warmTopN`         | `integer` | `50`    | min: 1 | Symbols warmed on startup              |

Prefetch metrics are exposed in `sdl.repo.status` under `prefetchStats` (queue depth, hit/waste rates, latency reduction).

> **When to change:** Disable (`enabled: false`) in CI or batch-only workflows. Increase `warmTopN` for repos where you frequently access many symbols. Lower `maxBudgetPercent` on constrained systems.

---

### `tracing` (optional)

OpenTelemetry observability for tool calls, indexing, and internal operations.

| Field          | Type      | Default     | Range                                 | Description                                |
| -------------- | --------- | ----------- | ------------------------------------- | ------------------------------------------ |
| `enabled`      | `boolean` | `true`      | —                                     | Enable tracing                             |
| `serviceName`  | `string`  | `"sdl-mcp"` | —                                     | Service name for trace spans               |
| `exporterType` | `string`  | `"console"` | `"console"` \| `"otlp"` \| `"memory"` | Trace exporter                             |
| `otlpEndpoint` | `string?` | —           | —                                     | OTLP collector URL (required for `"otlp"`) |
| `sampleRate`   | `number`  | `1.0`       | 0.0-1.0                               | Sampling rate (1.0 = trace everything)     |

> **When to change:** Disable (`enabled: false`) if trace output is not needed. Use `exporterType: "otlp"` with a Jaeger/Zipkin collector for production monitoring. Lower `sampleRate` under heavy load.

---

### `parallelScorer` (optional)

Worker-thread acceleration for beam search scoring in `sdl.slice.build`.

| Field          | Type       | Default | Range | Description                           |
| -------------- | ---------- | ------- | ----- | ------------------------------------- |
| `enabled`      | `boolean`  | `true`  | —     | Enable parallel scoring               |
| `poolSize`     | `integer?` | Auto    | 1-8   | Worker thread count                   |
| `minBatchSize` | `integer?` | Auto    | 1-100 | Min candidates to trigger parallelism |

> **When to change:** Disable (`enabled: false`) on single-core or memory-constrained systems. Most useful for repos with >5k symbols and large slices.

---

### `concurrency` (optional)

Controls concurrency limits for sessions, tool dispatch, and database connections.

| Field                | Type      | Default | Range        | Description                                |
| -------------------- | --------- | ------- | ------------ | ------------------------------------------ |
| `maxSessions`        | `integer` | `8`     | 1-16         | Max concurrent HTTP sessions               |
| `maxToolConcurrency` | `integer` | `8`     | 1-32         | Max concurrent tool handler executions     |
| `readPoolSize`       | `integer` | `4`     | 1-8          | LadybugDB read connection pool size        |
| `writeQueueTimeoutMs`| `integer` | `30000` | 1000-120000  | Timeout for queued write operations (ms)   |
| `toolQueueTimeoutMs` | `integer` | `30000` | 5000-120000  | Timeout for queued tool invocations (ms)   |

> **When to change:**
>
> - **Multi-agent setups:** Increase `maxSessions` (up to 16) for more concurrent HTTP clients.
> - **Large repos:** Increase `readPoolSize` to 6-8 for better concurrent read throughput.
> - **Resource-constrained systems:** Lower `maxToolConcurrency` to 2-4 to reduce CPU pressure.
> - **Slow queries:** Increase `writeQueueTimeoutMs` or `toolQueueTimeoutMs` if you see timeout errors.

---

### `liveIndex` (optional)

Controls the live editor buffer overlay for draft-aware code intelligence.

| Field                     | Type      | Default | Range        | Description                                               |
| ------------------------- | --------- | ------- | ------------ | --------------------------------------------------------- |
| `enabled`                 | `boolean` | `true`  | —            | Enable live index overlay for unsaved editor buffers      |
| `debounceMs`              | `integer` | `75`    | 25-5000      | Debounce delay before parsing buffer updates (ms)         |
| `idleCheckpointMs`        | `integer` | `15000` | 1000-300000  | Idle time before auto-checkpoint to DB (ms)               |
| `maxDraftFiles`           | `integer` | `200`   | 1-10000      | Max concurrent draft files in the overlay                 |
| `reconcileConcurrency`    | `integer` | `1`     | 1-8          | Concurrent reconciliation jobs (overlay → DB merge)       |
| `clusterRefreshThreshold` | `integer` | `25`    | 1-1000       | Number of reconciled symbols before triggering cluster refresh |

> **When to change:**
>
> - **Large codebases with many editors:** Increase `maxDraftFiles` to avoid eviction.
> - **Fast typing responsiveness:** Lower `debounceMs` to 25-50 for near-instant parse feedback.
> - **Memory-constrained systems:** Lower `maxDraftFiles` to 50-100.
> - **Disable entirely:** Set `enabled: false` in CI or batch-only workflows.

---

### `runtime` (optional)

Controls the sandboxed runtime execution engine (`sdl.runtime.execute`).

| Field                | Type       | Default              | Range         | Description                                         |
| -------------------- | ---------- | -------------------- | ------------- | --------------------------------------------------- |
| `enabled`            | `boolean`  | `false`              | —             | Enable runtime execution (must be `true` to use `sdl.runtime.execute`) |
| `allowedRuntimes`    | `string[]` | `["node", "python"]` | See note      | Runtimes permitted for execution                    |
| `allowedExecutables` | `string[]` | `[]`                 | —             | Additional executable names allowed (whitelist)     |
| `maxDurationMs`      | `integer`  | `30000`              | 100-600000    | Default execution timeout (ms)                      |
| `maxStdoutBytes`     | `integer`  | `1048576` (1 MB)     | min: 1024     | Max stdout capture size (bytes)                     |
| `maxStderrBytes`     | `integer`  | `262144` (256 KB)    | min: 1024     | Max stderr capture size (bytes)                     |
| `maxArtifactBytes`   | `integer`  | `10485760` (10 MB)   | min: 1024     | Max persisted artifact size (bytes)                 |
| `artifactTtlHours`   | `integer`  | `24`                 | min: 1        | Hours to retain output artifacts                    |
| `maxConcurrentJobs`  | `integer`  | `2`                  | 1-8           | Max concurrent runtime executions                   |
| `envAllowlist`       | `string[]` | `[]`                 | —             | Environment variables passed through to subprocesses |
| `artifactBaseDir`    | `string?`  | Auto                 | —             | Override directory for runtime output artifacts     |

**Supported runtimes:** `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp` (16 runtimes total).

> **When to change:**
>
> - **Enable runtime:** Set `enabled: true` and configure `allowedRuntimes` with the runtimes you need.
> - **CI pipelines:** Add `"shell"` to `allowedRuntimes` for running test/build commands via `sdl.runtime.execute`.
> - **Security:** Keep `allowedRuntimes` minimal — only include runtimes your agents actually need.
> - **Custom interpreters:** Use `allowedExecutables` to whitelist specific binaries (e.g., `["bun", "deno"]`).
> - **Environment variables:** Use `envAllowlist` to pass through variables like `NODE_ENV`, `DATABASE_URL`.

---

### `gateway` (optional)

Controls the gateway tool registration mode.

| Field            | Type      | Default | Description                                                |
| ---------------- | --------- | ------- | ---------------------------------------------------------- |
| `enabled`        | `boolean` | `true`  | Enable gateway-mode tool registration (namespace-scoped)   |
| `emitLegacyTools`| `boolean` | `false` | Also emit flat (legacy) tools alongside gateway tools (deprecated) |

Gateway mode groups tools into 4 namespace tools (`sdl_repo`, `sdl_symbol`, `sdl_code`, `sdl_agent`) plus `sdl.action.search` and `sdl.info`. When `emitLegacyTools` is `true`, the flat tool names are also registered for backwards compatibility. Legacy tool aliases are deprecated and will be removed in a future version.

> **When to change:** Set `emitLegacyTools: false` to reduce the tool list from 38 to 6 tools (gateway-only mode). Set `enabled: false` to use flat-only mode (34 tools).

---

### `codeMode` (optional)

Controls Code Mode tools (`sdl.manual` and `sdl.chain`).

| Field               | Type      | Default  | Range        | Description                                                |
| -------------------- | --------- | -------- | ------------ | ---------------------------------------------------------- |
| `enabled`            | `boolean` | `true`   | —            | Enable Code Mode tools (sdl.manual + sdl.chain)            |
| `exclusive`          | `boolean` | `true`   | —            | When true, suppress gateway and legacy tools — only register code-mode tools + discovery |
| `maxChainSteps`      | `integer` | `20`     | 1-50         | Maximum steps allowed in a single chain                    |
| `maxChainTokens`     | `integer` | `50000`  | 100-500000   | Maximum total estimated tokens for chain results           |
| `maxChainDurationMs` | `integer` | `60000`  | 1000-300000  | Maximum wall-clock duration for a chain (ms)               |
| `ladderValidation`   | `string`  | `"warn"` | `"off"` \| `"warn"` \| `"enforce"` | Context ladder validation mode |
| `etagCaching`        | `boolean` | `true`   | —            | Auto-inject ifNoneMatch ETags for repeated card requests within a chain |

> **When to change:**
>
> - **Full tool surface:** Set `exclusive: false` to expose gateway and legacy tools alongside code-mode tools.
> - **Disable code mode:** Set `enabled: false` to remove sdl.manual, sdl.chain, and sdl.action.search tools entirely.
> - **Strict ladder enforcement:** Set `ladderValidation: "enforce"` to reject chains that skip context ladder rungs.
> - **Long chains:** Increase `maxChainSteps` and `maxChainTokens` for complex multi-step lookups.
> - **Performance:** `etagCaching` is recommended to stay `true` — it automatically avoids resending unchanged cards.

---

### `security` (optional)

Controls security restrictions.

| Field              | Type       | Default | Description                                                    |
| ------------------ | ---------- | ------- | -------------------------------------------------------------- |
| `allowedRepoRoots` | `string[]` | `[]`    | Whitelist of allowed repository root paths for `repo.register` |

When non-empty, `sdl.repo.register` calls are rejected unless the `rootPath` starts with one of these prefixes. An empty array (default) allows any path.

> **When to change:** Set this in shared/multi-tenant deployments to prevent agents from registering arbitrary filesystem paths.

---

### `httpAuth` (optional)

Controls bearer-token authentication for the HTTP transport (`sdl-mcp serve --http`). Has no effect on stdio transport.

| Field     | Type      | Default | Description                                                                 |
| --------- | --------- | ------- | --------------------------------------------------------------------------- |
| `enabled` | `boolean` | `false` | Enable bearer-token authentication for `/mcp` and `/api/*` endpoints        |
| `token`   | `string?` | `null`  | Static bearer token. When `null`, a random token is generated at startup.   |

Three modes:

| Configuration                              | Behavior                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Omitted / `{ "enabled": false }`           | Auth disabled entirely — all requests accepted without a token (default) |
| `{ "enabled": true }`                      | Random token generated at startup, printed to stderr                     |
| `{ "enabled": true, "token": "my-token" }` | Static token from config — no random generation, token not printed       |

> **When to change:**
>
> - **Shared dev servers / production:** Set `enabled: true` with a static `token` so all agents can use the same credential.
> - **CI pipelines:** Set `enabled: true` to prevent unauthorized access to the HTTP transport.
> - **Local development:** Leave default (`enabled: false`) for frictionless stdio and HTTP access.

---

## Environment Variables

| Variable                         | Description                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `SDL_CONFIG` / `SDL_CONFIG_PATH` | Path to config file                                                            |
| `SDL_CONFIG_HOME`                | Directory for default global config resolution                                 |
| `SDL_GRAPH_DB_PATH`              | Override graph DB file path (takes precedence over config)                     |
| `SDL_GRAPH_DB_DIR`               | Legacy directory-style override; SDL-MCP stores `sdl-mcp-graph.lbug` inside it |
| `SDL_DB_PATH`                    | Legacy alias for graph DB path override (v0.7.x)                               |
| `SDL_LOG_FILE`                   | Explicit log file path. If unusable, SDL-MCP falls back to an OS temp file     |
| `SDL_LOG_LEVEL`                  | Log level: `debug`, `info`, `warn`, `error` (case-insensitive)                 |
| `SDL_CONSOLE_LOGGING`            | Set to `true` to mirror log lines to stderr in addition to file logging        |
| `SDL_LOG_FORMAT`                 | Log format: `json`, `text`                                                     |
| `ANTHROPIC_API_KEY`              | Fallback API key for `semantic.generateSummaries`                              |
| `SDL_MCP_DISABLE_NATIVE_ADDON`  | Set to `1` to force TypeScript fallback engine (skip native Rust addon)        |

SDL-MCP expands `${VAR_NAME}` references inside JSON config values at load time.

## Operational Diagnostics

Use `sdl-mcp info` or the MCP tool `sdl.info` to inspect the resolved runtime state without starting a debugging session by hand. The report includes:

- config path, existence, and load status
- resolved log file path and whether temp-file fallback is active
- whether `SDL_CONSOLE_LOGGING` is mirroring logs to stderr
- Ladybug availability and active DB path
- native-addon availability, source path, and fallback reason

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
  "tracing": { "enabled": false },
  "parallelScorer": { "enabled": false },
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
    "summaryMaxConcurrency": 3
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
  "graphDatabase": { "path": "./data/sdl-mcp-graph.lbug" }
}
```

---

## Native Rust Engine

The Rust indexer (default engine) replaces the TypeScript tree-sitter pass with a native addon for faster multi-threaded symbol extraction. It supports the same 12 languages (14 extensions) as the TypeScript engine.

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

Run `sdl-mcp doctor` to validate your config and check environment health. The doctor report now includes registered pass2 resolvers, call-edge metadata schema support, and whether `minCallConfidence` is request-only or driven by a policy default.
