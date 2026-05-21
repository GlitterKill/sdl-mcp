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

SDL-MCP is configured through one JSON file. This page documents the current parsed configuration surface from `src/config/types.ts` and the current example config. Deprecated compatibility-only keys are intentionally omitted from the reference and examples.

```mermaid
%%{init: {"theme":"base","themeVariables":{"background":"#ffffff","primaryColor":"#E7F8F2","primaryBorderColor":"#0F766E","primaryTextColor":"#102A43","secondaryColor":"#E8F1FF","secondaryBorderColor":"#2563EB","secondaryTextColor":"#102A43","tertiaryColor":"#FFF4D6","tertiaryBorderColor":"#B45309","tertiaryTextColor":"#102A43","lineColor":"#0F766E","textColor":"#102A43","fontFamily":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"},"flowchart":{"curve":"basis","htmlLabels":true}}}%%
flowchart LR
    File["Config file"] e1@--> Parse["Parse JSON<br/>expand ${VAR}"]
    Parse e2@--> Validate["Zod validation<br/>fill defaults"]
    Validate e3@--> Tier["Apply performance tier presets<br/>only to unset fields"]
    Tier e4@--> Runtime["Resolved runtime state"]

    classDef source fill:#E7F8F2,stroke:#0F766E,stroke-width:2px,color:#102A43;
    classDef process fill:#E8F1FF,stroke:#2563EB,stroke-width:2px,color:#102A43;
    classDef decision fill:#FFF4D6,stroke:#B45309,stroke-width:2px,color:#102A43;
    classDef storage fill:#F2E8FF,stroke:#7C3AED,stroke-width:2px,color:#102A43;
    classDef output fill:#FFE8EF,stroke:#BE123C,stroke-width:2px,color:#102A43;
    classDef muted fill:#F8FAFC,stroke:#64748B,stroke-width:1px,color:#102A43;
    classDef animate stroke:#0F766E,stroke-width:2px,stroke-dasharray:10\,5,stroke-dashoffset:900,animation:dash 22s linear infinite;
    class e1,e2,e3,e4 animate;
```

## Resolution Order

| Source       | How it is used                                                                               |
| ------------ | -------------------------------------------------------------------------------------------- |
| Default path | User-global `sdlmcp.config.json`, resolved from `SDL_CONFIG_HOME` or the OS config directory |
| CLI flag     | `sdl-mcp ... --config <path>`                                                                |
| Environment  | `SDL_CONFIG` or `SDL_CONFIG_PATH`                                                            |

Environment-variable expansion supports `${VAR_NAME}` and `${VAR_NAME:-default}` inside string values.

## Minimal Config

Only `repos` and the `policy` object are required. The `policy` object can be empty because its fields have defaults.

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "."
    }
  ],
  "policy": {}
}
```

## High-Impact Defaults

| Setting                      | Current default | Why it matters                                                 |
| ---------------------------- | --------------- | -------------------------------------------------------------- |
| `performanceTier`            | `"auto"`        | Auto-tunes concurrency-related defaults to the current machine |
| `codeMode.enabled`           | `true`          | Code Mode tools are enabled by default                         |
| `codeMode.exclusive`         | `true`          | Code Mode hides gateway and flat tools unless you opt out      |
| `gateway.enabled`            | `true`          | Gateway tools are available when Code Mode is not exclusive    |
| `runtime.enabled`            | `true`          | `sdl.runtime.execute` is on unless you disable it              |
| `memory.enabled`             | `false`         | Memory stays opt-in                                            |
| `scip.enabled`               | `false`         | SCIP ingest stays opt-in                                       |
| `semanticEnrichment.enabled` | `false`         | Provider-backed graph precision stays explicit                 |

The smallest high-leverage change is usually `codeMode.exclusive`. Setting it to `false` exposes Code Mode and the regular MCP surfaces together.

## Top-Level Sections

| Section              | Required | Purpose                                                 |
| -------------------- | -------- | ------------------------------------------------------- |
| `repos`              | Yes      | Repository registration defaults and per-repo overrides |
| `performanceTier`    | No       | Hardware-aware concurrency preset selection             |
| `graphDatabase`      | No       | Ladybug database file location                          |
| `policy`             | Yes      | Iris Gate and budget enforcement                        |
| `redaction`          | No       | Secret masking in code responses                        |
| `indexing`           | No       | Indexer concurrency, watcher, and engine settings       |
| `liveIndex`          | No       | Draft-buffer overlay behavior                           |
| `slice`              | No       | Default slice budgets and edge weights                  |
| `diagnostics`        | No       | TypeScript diagnostics behavior                         |
| `cache`              | No       | In-memory cache limits                                  |
| `plugins`            | No       | Plugin loading                                          |
| `semantic`           | No       | Embeddings, retrieval, and summary generation           |
| `semanticEnrichment` | No       | Provider-backed graph precision enrichment              |
| `prefetch`           | No       | Predictive warming                                      |
| `tracing`            | No       | OpenTelemetry tracing                                   |
| `parallelScorer`     | No       | Worker-thread slice scoring                             |
| `concurrency`        | No       | Session, queue, and DB read concurrency                 |
| `runtime`            | No       | Runtime execution limits                                |
| `gateway`            | No       | Gateway-mode registration                               |
| `codeMode`           | No       | Code Mode tool registration and workflow budgets        |
| `security`           | No       | Allowed repository roots                                |
| `httpAuth`           | No       | HTTP bearer-token auth                                  |
| `memory`             | No       | Development memory subsystem                            |
| `scip`               | No       | SCIP ingest and optional `scip-io` generation           |

## `repos[]`

Each entry configures one repository.

| Field                       | Type               | Default                 | Notes                                                                                   |
| --------------------------- | ------------------ | ----------------------- | --------------------------------------------------------------------------------------- |
| `repoId`                    | `string`           | Required                | Stable identifier used in all tool calls                                                |
| `rootPath`                  | `string`           | Required                | Absolute path recommended; relative paths resolve from the config file                  |
| `ignore`                    | `string[]`         | See below               | Glob patterns excluded from indexing                                                    |
| `languages`                 | `string[]`         | All supported languages | `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh` |
| `maxFileBytes`              | `number`           | `2000000`               | Files larger than this are skipped                                                      |
| `postIndexSessionTimeoutMs` | `number`           | `900000`                | `1000-86400000`. Hard timeout for post-index finalization writes after pass-1/pass-2    |
| `includeNodeModulesTypes`   | `boolean`          | `true`                  | TypeScript-only helper for `@types/*` resolution                                        |
| `packageJsonPath`           | `string \| null`   | `null`                  | Manual package root override                                                            |
| `tsconfigPath`              | `string \| null`   | `null`                  | Manual `tsconfig.json` override                                                         |
| `workspaceGlobs`            | `string[] \| null` | `null`                  | Monorepo workspace package discovery                                                    |
| `memory`                    | object             | Omitted                 | Per-repo override for the top-level memory settings                                     |

Use `postIndexSessionTimeoutMs` when large repositories spend longer than
15 minutes in finalization work such as embedding writes or deferred vector
index builds. It is deliberately scoped to the post-index write session, not
the whole scan/parse/pass-2 runtime.

Default `ignore` patterns:

```json
[
  "**/.git/**",
  "**/dist/**",
  "**/dist-*/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/*.pyc",
  "**/.venv/**",
  "**/venv/**",
  "**/.tmp/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.cursor/**",
  "**/.aider*/**",
  "**/.windsurf/**",
  "**/.continue/**",
  "**/.sdl-memory/**"
]
```

### `repos[].memory`

This override only accepts partial fields. Unspecified values inherit from the top-level `memory` section.

| Field                 | Type      |
| --------------------- | --------- |
| `enabled`             | `boolean` |
| `toolsEnabled`        | `boolean` |
| `fileSyncEnabled`     | `boolean` |
| `surfacingEnabled`    | `boolean` |
| `hintsEnabled`        | `boolean` |
| `defaultSurfaceLimit` | `number`  |

## `performanceTier`

| Field             | Type     | Default  | Values                                   |
| ----------------- | -------- | -------- | ---------------------------------------- |
| `performanceTier` | `string` | `"auto"` | `"mid"`, `"high"`, `"extreme"`, `"auto"` |

`"auto"` detects the machine tier at startup and only fills fields you did not set explicitly. It currently influences:

- `indexing.concurrency`
- `concurrency.maxSessions`
- `concurrency.maxToolConcurrency`
- `concurrency.readPoolSize`
- `runtime.maxConcurrentJobs`
- `liveIndex.reconcileConcurrency`
- `semantic.summaryMaxConcurrency`
- `parallelScorer.enabled`
- `parallelScorer.poolSize`

## `graphDatabase`

| Field  | Type             | Default | Notes                                                     |
| ------ | ---------------- | ------- | --------------------------------------------------------- |
| `path` | `string \| null` | `null`  | Defaults to `<configDir>/sdl-mcp-graph.lbug` when omitted |

## `policy`

| Field                           | Type      | Default | Notes                                            |
| ------------------------------- | --------- | ------- | ------------------------------------------------ |
| `maxWindowLines`                | `number`  | `180`   | Hard cap for `sdl.code.needWindow` line count    |
| `maxWindowTokens`               | `number`  | `1400`  | Hard cap for `sdl.code.needWindow` tokens        |
| `requireIdentifiers`            | `boolean` | `true`  | Keeps raw-window requests scoped                 |
| `allowBreakGlass`               | `boolean` | `false` | Enables break-glass override paths               |
| `defaultMinCallConfidence`      | `number`  | unset   | Optional default confidence floor for call edges |
| `defaultDenyRaw`                | `boolean` | `true`  | Raw code access starts denied unless justified   |
| `budgetCaps.maxCards`           | `number`  | unset   | Optional server-side cap for slice card count    |
| `budgetCaps.maxEstimatedTokens` | `number`  | unset   | Optional server-side cap for slice token budget  |

If you set `budgetCaps`, provide both `maxCards` and `maxEstimatedTokens`.

## `redaction`

| Field             | Type                                | Default |
| ----------------- | ----------------------------------- | ------- |
| `enabled`         | `boolean`                           | `true`  |
| `includeDefaults` | `boolean`                           | `true`  |
| `patterns`        | `Array<{ name?, pattern, flags? }>` | `[]`    |

## `indexing`

| Field                | Type                     | Default  | Range / notes                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`        | `number`                 | `8`      | `1-32`                                                                                                                                                                                                                                                              |
| `enableFileWatching` | `boolean`                | `true`   | Usually disable in CI                                                                                                                                                                                                                                               |
| `maxWatchedFiles`    | `number`                 | `25000`  | Hard guard for watcher scale                                                                                                                                                                                                                                        |
| `workerPoolSize`     | `number \| null`         | `null`   | Optional cap for worker threads                                                                                                                                                                                                                                     |
| `engine`             | `"typescript" \| "rust"` | `"rust"` | Falls back to TS if native addon is unavailable                                                                                                                                                                                                                     |
| `watchDebounceMs`    | `number`                 | `300`    | `50-5000`                                                                                                                                                                                                                                                           |
| `pass2Concurrency`   | `number`                 | `1`      | `1-16`. Files resolved in parallel during pass-2. CPU presets default to `12` (extreme tier), `8` (high), `1` (mid). Effective parallelism is gated by writeLimiter saturation; the dispatcher coalesces all writes per concurrency batch into one `withWriteConn`. |

## `liveIndex`

| Field                     | Type      | Default | Range         |
| ------------------------- | --------- | ------- | ------------- |
| `enabled`                 | `boolean` | `true`  |               |
| `debounceMs`              | `number`  | `75`    | `25-5000`     |
| `idleCheckpointMs`        | `number`  | `15000` | `1000-300000` |
| `maxDraftFiles`           | `number`  | `200`   | `1-10000`     |
| `reconcileConcurrency`    | `number`  | `1`     | `1-16`        |
| `clusterRefreshThreshold` | `number`  | `25`    | `1-1000`      |

## `slice`

| Field                    | Type     | Default |
| ------------------------ | -------- | ------- |
| `defaultMaxCards`        | `number` | `60`    |
| `defaultMaxTokens`       | `number` | `12000` |
| `edgeWeights.call`       | `number` | `1.0`   |
| `edgeWeights.import`     | `number` | `0.6`   |
| `edgeWeights.config`     | `number` | `0.8`   |
| `edgeWeights.implements` | `number` | `0.9`   |

`edgeWeights.implements` is current and should stay documented. It is easy to miss and it materially changes slice ranking in interface-heavy codebases.

## `diagnostics`

| Field       | Type                            | Default          | Notes                                      |
| ----------- | ------------------------------- | ---------------- | ------------------------------------------ |
| `enabled`   | `boolean`                       | `true`           |                                            |
| `mode`      | `"tsLS" \| "tsc"`               | `"tsLS"`         | `tsLS` is faster; `tsc` is stricter        |
| `maxErrors` | `number`                        | `50`             |                                            |
| `timeoutMs` | `number`                        | `2000`           |                                            |
| `scope`     | `"changedFiles" \| "workspace"` | `"changedFiles"` | Workspace-wide is slower but more complete |

## `cache`

| Field                    | Type      | Default     |
| ------------------------ | --------- | ----------- |
| `enabled`                | `boolean` | `true`      |
| `symbolCardMaxEntries`   | `number`  | `2000`      |
| `symbolCardMaxSizeBytes` | `number`  | `104857600` |
| `graphSliceMaxEntries`   | `number`  | `1000`      |
| `graphSliceMaxSizeBytes` | `number`  | `52428800`  |

## `plugins`

| Field              | Type       | Default |
| ------------------ | ---------- | ------- |
| `paths`            | `string[]` | `[]`    |
| `enabled`          | `boolean`  | `true`  |
| `strictVersioning` | `boolean`  | `true`  |

## `semantic`

`semantic` now centers on retrieval and vector index configuration. It does not configure SCIP or LSP graph enrichment; those settings live under `semanticEnrichment`.

| Field                           | Type                                    | Default                          | Notes                                                                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                       | `boolean`                               | `true`                           |                                                                                                                                                                                                                                                                                                     |
| `provider`                      | `"api" \| "local" \| "mock"`            | `"local"`                        | Embedding provider                                                                                                                                                                                                                                                                                  |
| `embeddingProfile`              | `"specialized" \| "max-recall"`          | `"specialized"`                   | `specialized` embeds Symbols with Jina and FileSummary nodes with Nomic to reduce index time. `max-recall` restores both supported models on both lanes.                                                                                                                                            |
| `symbolEmbeddingModels`         | `string[]`                              | `["jina-embeddings-v2-base-code"]` | Optional Symbol-lane override. When set, this replaces the profile default for Symbol embeddings. Unknown model names are skipped.                                                                                                                                                                  |
| `fileSummaryEmbeddingModels`    | `string[]`                              | `["nomic-embed-text-v1.5"]`       | Optional FileSummary-lane override. When set, this replaces the profile default for FileSummary embeddings. Unknown model names are skipped.                                                                                                                                                        |
| `model`                         | `string`                                | _none_                             | Deprecated legacy primary embedding model. If no profile or per-lane arrays are configured, `model` plus `additionalModels` are still treated as one shared model list for both Symbol and FileSummary embeddings.                                                                                  |
| `additionalModels`              | `string[]`                              | _none_                             | Deprecated legacy shared extra embedding models. Use `embeddingProfile`, `symbolEmbeddingModels`, or `fileSummaryEmbeddingModels` for new configs.                                                                                                                                                  |
| `modelCacheDir`                 | `string \| null`                        | `null`                           | Optional local cache override                                                                                                                                                                                                                                                                       |
| `generateSummaries`             | `boolean`                               | `false`                          | Generates symbol summaries during indexing                                                                                                                                                                                                                                                          |
| `summaryProvider`               | `"api" \| "local" \| "mock" \| null`    | `null`                           | Falls back to `provider` when omitted                                                                                                                                                                                                                                                               |
| `summaryModel`                  | `string \| null`                        | `null`                           | Provider-specific default is chosen when omitted                                                                                                                                                                                                                                                    |
| `summaryApiKey`                 | `string \| null`                        | `null`                           | Needed for hosted summary providers                                                                                                                                                                                                                                                                 |
| `summaryApiBaseUrl`             | `string \| null`                        | `null`                           | OpenAI-compatible local endpoints                                                                                                                                                                                                                                                                   |
| `summaryMaxConcurrency`         | `number`                                | `5`                              | `1-32`                                                                                                                                                                                                                                                                                              |
| `summaryBatchSize`              | `number`                                | `20`                             | `1-50`                                                                                                                                                                                                                                                                                              |
| `embeddingConcurrency`          | `number`                                | `1`                              | `1-8`. Number of embedding batches in flight per model. Higher values overlap tokenisation (single-thread JS) with ONNX inference. Watch for ORT thread oversubscription on shared thread pools.                                                                                                    |
| `embeddingBatchSize`            | `number`                                | `32`                             | `1-128`. ONNX inference batch width. Larger batches amortise tokenizer + session bind/unbind costs. Length-bucketing keeps tokenizer pad waste bounded.                                                                                                                                             |
| `fileSummaryEmbeddingBatchSize` | `number`                                | `4`                              | `1-16`. ONNX inference batch width for hybrid `FileSummary` vectors. Defaults lower than symbol embeddings because file-level payloads are much larger.                                                                                                                                             |
| `fileSummaryEmbeddingMaxChars`  | `number`                                | `4096`                           | `512-32768`. Maximum characters sent to the embedding provider for each `FileSummary`; stored summaries and FTS text remain complete.                                                                                                                                                               |
| `embeddingsSequential`          | `boolean`                               | `false`                          | Run multiple embedding models in series instead of via `Promise.all`. Set `true` on systems where ORT serializes parallel sessions at the thread-pool layer (alternation pattern in CLI progress).                                                                                                  |
| `modelVariant`                  | `string`                                | _model-defined_                  | ONNX file variant to load. Common: `"default"` / `"int8"`, `"fp16"`, `"fp32"`. nomic also publishes `"uint8"`, `"q4"`, `"q4f16"`, `"bnb4"`. Falls back to model's `defaultVariant` with a warning if unsupported. See [semantic-embeddings-setup](feature-deep-dives/semantic-embeddings-setup.md). |
| `executionProviders`            | `string[]`                              | `["cpu"]`                        | ONNX Runtime execution providers in priority order. Bundled with default `onnxruntime-node` package: Windows x64 `["cpu","dml","webgpu"]`, macOS `["cpu","coreml"]`, Linux x64 `["cpu","cuda","tensorrt"]`, Linux arm64 `["cpu"]`. Unsupported entries dropped; `cpu` auto-appended.                |
| `onnx.intraOpNumThreads`        | `number`                                | `0` (auto)                       | `0-256`. ORT intra-op thread pool. `0` = `os.availableParallelism()`. For inference, set to physical core count (e.g. 16 on a 9950X3D); higher counts hit hyperthreading penalty.                                                                                                                   |
| `onnx.interOpNumThreads`        | `number`                                | `0` (auto)                       | `0-64`. Only used in `executionMode: "parallel"`. Keep at 1 for transformer-style models.                                                                                                                                                                                                           |
| `onnx.executionMode`            | `"sequential" \| "parallel"`            | `"sequential"`                   | ORT graph execution. Sequential is usually optimal for sentence-transformer ONNX graphs.                                                                                                                                                                                                            |
| `retrieval.mode`                | `"legacy" \| "hybrid"`                  | `"hybrid"`                       | Current recommended mode                                                                                                                                                                                                                                                                            |
| `retrieval.extensionsOptional`  | `boolean`                               | `true`                           |                                                                                                                                                                                                                                                                                                     |
| `retrieval.fts.enabled`         | `boolean`                               | `true`                           |                                                                                                                                                                                                                                                                                                     |
| `retrieval.fts.indexName`       | `string`                                | `"symbol_search_text_v1"`        |                                                                                                                                                                                                                                                                                                     |
| `retrieval.fts.topK`            | `number`                                | `75`                             |                                                                                                                                                                                                                                                                                                     |
| `retrieval.fts.conjunctive`     | `boolean`                               | `false`                          |                                                                                                                                                                                                                                                                                                     |
| `retrieval.vector.enabled`      | `boolean`                               | `true`                           |                                                                                                                                                                                                                                                                                                     |
| `retrieval.vector.topK`         | `number`                                | `75`                             |                                                                                                                                                                                                                                                                                                     |
| `retrieval.vector.efc`          | `number`                                | `200`                            | Build-time HNSW setting                                                                                                                                                                                                                                                                             |
| `retrieval.vector.efs`          | `number`                                | `200`                            | Query-time HNSW setting                                                                                                                                                                                                                                                                             |
| `retrieval.vector.indexes`      | `Record<string, { indexName: string }>` | See below                        | Per-model vector index names                                                                                                                                                                                                                                                                        |
| `retrieval.fusion.strategy`     | `"rrf"`                                 | `"rrf"`                          |                                                                                                                                                                                                                                                                                                     |
| `retrieval.fusion.rrfK`         | `number`                                | `60`                             |                                                                                                                                                                                                                                                                                                     |
| `retrieval.candidateLimit`      | `number`                                | `100`                            |                                                                                                                                                                                                                                                                                                     |

Default vector indexes:

```json
{
  "jina-embeddings-v2-base-code": {
    "indexName": "symbol_vec_jina_code_v2"
  },
  "nomic-embed-text-v1.5": {
    "indexName": "symbol_vec_nomic_embed_v15"
  }
}
```

## `semanticEnrichment`

`semanticEnrichment` controls provider-backed graph precision. Source selection is fixed per language: SCIP first, then LSP. Only one source runs for a language; skipped providers are reported in status output.

For one release, stale `semanticEnrichment.providers.lsif` config entries are ignored during parsing so older local configs keep loading. Remove those entries because LSIF no longer runs.

| Field                       | Type                                       | Default   | Notes                                                                                          |
| --------------------------- | ------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------- |
| `enabled`                   | `boolean`                                  | `false`   | Enables explicit refresh writes. Status remains available when disabled                         |
| `autoRunOnIndexRefresh`     | `boolean`                                  | `false`   | Runs eligible LSP enrichment after indexing; SCIP keeps its existing mid-index placement  |
| `installPolicy`             | `"never" \| "verified"`                    | `"never"` | `verified` allows only checksum-verified downloads. Package-manager recipes are never executed |
| `cacheDir`                  | `string \| null`                           | `null`    | Reserved cache root for future durable provider caches; V2 does not persist LSP responses |
| `concurrency`               | `number`                                   | `1`       | Reserved `1-8` cap for future cross-provider scheduling; V2 runs selected providers serially   |
| `timeoutMs`                 | `number`                                   | `300000`  | Provider request/process timeout                                                               |
| `languages`                 | `string[]`                                 | `[]`      | Empty means all current tree-sitter-backed languages                                           |
| `providers.scip.indexes`    | `{path,label?}[]`                          | `[]`      | When omitted, the bridge reuses `scip.indexes`                                                 |
| `providers.lsp.servers`     | `Record<string, {serverId, command, ...}>` | `{}`      | Stdio LSP servers. SDL-MCP does not run package-manager install commands                       |
| `providers.lsp.confidence`  | `number`                                   | `0.8`     | LSP evidence is marked `resolverId: "lsp:<serverId>"` when it creates or upgrades edges        |
| `providers.lsp.candidateLimit` | `number`                                | `200`     | Maximum tree-sitter-assisted call-definition candidates per refresh                            |

Each LSP server entry supports `serverId`, `command`, `args`, `languages`, optional `initializationOptions`, and optional LSP-IO metadata hints: `documentLanguageIds`, `filePatterns`, `capabilities`, and `readiness`. SDL-MCP uses tree-sitter-assisted call-definition enrichment for languages that already have adapters, and generic LSP diagnostic ingestion for configured servers that request or advertise diagnostics.

`semantic` means embeddings, summaries, and retrieval. `semanticEnrichment` means provider-backed graph precision and provenance.

Combined SCIP indexes are supported. When `languages` or `--languages` narrows refresh scope, SDL-MCP filters documents inside the combined SCIP artifact. LSP is selected per configured server language.

## `prefetch`

| Field              | Type      | Default |
| ------------------ | --------- | ------- |
| `enabled`          | `boolean` | `true`  |
| `maxBudgetPercent` | `number`  | `20`    |
| `warmTopN`         | `number`  | `0`     |
| `policy.enabled`   | `boolean` | `true`  |
| `policy.mode`      | `"observe" \| "safe"` | `"safe"` |
| `policy.minSamples` | `number` | `20` |
| `policy.suppressionWasteRate` | `number` | `0.8` |
| `policy.boostHitRate` | `number` | `0.35` |
| `policy.retentionDays` | `number` | `14` |
| `policy.maxPriorityBoost` | `number` | `25` |
| `policy.maxBudgetTrimPercent` | `number` | `50` |

`prefetch.policy` stores outcome learning in LadybugDB and applies it only to
existing deterministic strategies. In `safe` mode the policy may suppress a
high-waste strategy, trim its budget within `maxBudgetPercent`, or add a bounded
priority boost; it does not invent new prefetch resource types. `observe` keeps
recording outcomes without changing queue behavior.

## `tracing`

| Field          | Type                              | Default     |
| -------------- | --------------------------------- | ----------- |
| `enabled`      | `boolean`                         | `true`      |
| `serviceName`  | `string`                          | `"sdl-mcp"` |
| `exporterType` | `"console" \| "otlp" \| "memory"` | `"console"` |
| `otlpEndpoint` | `string \| null`                  | `null`      |
| `sampleRate`   | `number`                          | `1.0`       |

## `parallelScorer`

| Field          | Type             | Default |
| -------------- | ---------------- | ------- |
| `enabled`      | `boolean`        | `true`  |
| `poolSize`     | `number \| null` | `null`  |
| `minBatchSize` | `number \| null` | `null`  |

## `concurrency`

| Field                 | Type     | Default | Range         |
| --------------------- | -------- | ------- | ------------- |
| `maxSessions`         | `number` | `8`     | `1-32`        |
| `maxToolConcurrency`  | `number` | `8`     | `1-64`        |
| `readPoolSize`        | `number` | `4`     | `1-16`        |
| `writeQueueTimeoutMs` | `number` | `30000` | `1000-120000` |
| `toolQueueTimeoutMs`  | `number` | `30000` | `5000-120000` |

`toolQueueTimeoutMs` controls how long a foreground MCP tool request can wait
for a dispatch slot before its handler starts. It does not bound handler
execution after the slot is acquired. When it expires, the queued request fails
with a retryable `RUNTIME_ERROR` classified as `unavailable`; running tools keep
running. The server logs `Tool dispatch queue timed out` with `active`, `queued`,
`maxConcurrency`, `configuredMax`, and `indexingActive` fields.

During indexing, SDL-MCP narrows foreground tool dispatch to one slot to avoid
LadybugDB contention. If tool calls fail with dispatch queue timeouts while
indexing is active, increase `toolQueueTimeoutMs` only when it is acceptable for
foreground tools to wait longer. Increasing `maxToolConcurrency` can reintroduce
database pressure and should not be the first response to indexing-related
queue waits.

Startup derived-refresh recovery is handled differently from ordinary
foreground tool dispatch: foreground tool calls wait for that recovery to
finish, and index progress can show the active deferred phase with a percentage
when the server can derive one. Current index refreshes compute derived state
inline before returning; the background recovery path is for stale persisted rows
left by older interrupted runs. If CLI indexing delegated to a live HTTP server
fails with a server-busy dispatch timeout, retry after the server finishes its
active index or startup recovery work; the CLI does not open the same graph DB
directly while the server owns the lock. Tune `toolQueueTimeoutMs` only when
longer foreground waits are acceptable.

## `runtime`

`runtime` is enabled by default in current source. Disable it explicitly if your deployment cannot permit subprocess execution.

| Field                | Type             | Default                                     | Range / notes                                      |
| -------------------- | ---------------- | ------------------------------------------- | -------------------------------------------------- |
| `enabled`            | `boolean`        | `true`                                      |                                                    |
| `allowedRuntimes`    | `string[]`       | `["node", "typescript", "python", "shell"]` | Can be narrowed aggressively for safer deployments |
| `allowedExecutables` | `string[]`       | `[]`                                        | Extra binary whitelist                             |
| `maxDurationMs`      | `number`         | `30000`                                     | `100-600000`                                       |
| `maxStdoutBytes`     | `number`         | `1048576`                                   |                                                    |
| `maxStderrBytes`     | `number`         | `262144`                                    |                                                    |
| `maxArtifactBytes`   | `number`         | `10485760`                                  |                                                    |
| `maxResponseArtifactsPerRepo` | `number` | `128`                                      | Response-artifact handles retained per repo        |
| `maxResponseArtifactBytesPerRepo` | `number` | `1342177280`                         | Response-artifact bytes retained per repo          |
| `maxResponseArtifactBytesTotal` | `number` | `2684354560`                           | Response-artifact bytes retained across storage    |
| `maxResponseArtifactsTotal` | `number` | `512`                                      | Response-artifact handles retained across storage  |
| `artifactTtlHours`   | `number`         | `24`                                        |                                                    |
| `maxConcurrentJobs`  | `number`         | `2`                                         | `1-12`                                             |
| `envAllowlist`       | `string[]`       | `[]`                                        |                                                    |
| `artifactBaseDir`    | `string \| null` | `null`                                      | Optional artifact storage root                     |

Supported runtimes: `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp`.

## `gateway`

| Field     | Type      | Default |
| --------- | --------- | ------- |
| `enabled` | `boolean` | `true`  |

With current defaults, `gateway.enabled` matters only when `codeMode.exclusive` is `false` or `codeMode.enabled` is `false`.

See [Tool Gateway](./feature-deep-dives/tool-gateway.md) for the current tool-count matrix. The deprecated legacy-alias toggle is intentionally omitted from this reference.

## `codeMode`

| Field                   | Type                           | Default  | Notes                                  |
| ----------------------- | ------------------------------ | -------- | -------------------------------------- |
| `enabled`               | `boolean`                      | `true`   |                                        |
| `exclusive`             | `boolean`                      | `true`   | Hides flat and gateway tools when true |
| `maxWorkflowSteps`      | `number`                       | `20`     | `1-50`                                 |
| `maxWorkflowTokens`     | `number`                       | `50000`  | `100-500000`                           |
| `maxWorkflowDurationMs` | `number`                       | `60000`  | `1000-300000`                          |
| `ladderValidation`      | `"off" \| "warn" \| "enforce"` | `"warn"` |                                        |
| `etagCaching`           | `boolean`                      | `true`   |                                        |

If you want both `sdl.context` and the regular gateway or flat tools in the same session, set:

```json
{
  "codeMode": {
    "enabled": true,
    "exclusive": false
  }
}
```

## `security`

| Field              | Type       | Default | Notes                           |
| ------------------ | ---------- | ------- | ------------------------------- |
| `allowedRepoRoots` | `string[]` | `[]`    | Empty means any path is allowed |

`SDL_ALLOWED_REPO_ROOTS` can append additional comma-separated roots at load time.

## `httpAuth`

| Field       | Type                                      | Default                           | Notes                                                                            |
| ----------- | ----------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `enabled`   | `boolean`                                 | `false`                           | Only affects HTTP transport                                                      |
| `token`     | `string \| null`                          | `null`                            | Random token is generated at startup when auth is enabled and `token` is omitted |
| `rateLimit` | `{ bucketSize: number, refillPerSec: number }` | `{ bucketSize: 30, refillPerSec: 0.5 }` | Per-client token bucket for failed HTTP auth attempts; valid bearer-token traffic is governed by session and dispatch concurrency limits |

## `memory`

Memory remains opt-in.

| Field                 | Type      | Default |
| --------------------- | --------- | ------- |
| `enabled`             | `boolean` | `false` |
| `toolsEnabled`        | `boolean` | `true`  |
| `fileSyncEnabled`     | `boolean` | `true`  |
| `surfacingEnabled`    | `boolean` | `true`  |
| `hintsEnabled`        | `boolean` | `true`  |
| `defaultSurfaceLimit` | `number`  | `5`     |

## `scip`

| Field                          | Type                                      | Default     | Notes                                                                                                                                                                                                                            |
| ------------------------------ | ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                      | `boolean`                                 | `false`     | Master toggle for SCIP ingest                                                                                                                                                                                                    |
| `indexes`                      | `Array<{ path: string, label?: string }>` | `[]`        | Files to ingest                                                                                                                                                                                                                  |
| `externalSymbols.enabled`      | `boolean`                                 | `true`      |                                                                                                                                                                                                                                  |
| `externalSymbols.maxPerIndex`  | `number`                                  | `10000`     | `100-100000`                                                                                                                                                                                                                     |
| `confidence`                   | `number`                                  | `0.95`      | `0.5-1.0`                                                                                                                                                                                                                        |
| `autoIngestOnRefresh`          | `boolean`                                 | `true`      |                                                                                                                                                                                                                                  |
| `generator.enabled`            | `boolean`                                 | `false`     | Runs `scip-io index` before refresh                                                                                                                                                                                              |
| `generator.binary`             | `string`                                  | `"scip-io"` |                                                                                                                                                                                                                                  |
| `generator.args`               | `string[]`                                | `[]`        | Extra args after `index`                                                                                                                                                                                                         |
| `generator.autoInstall`        | `boolean`                                 | `true`      | Downloads `scip-io` if needed                                                                                                                                                                                                    |
| `generator.timeoutMs`          | `number`                                  | `600000`    | `1000-1800000`                                                                                                                                                                                                                   |
| `generator.cleanupAfterIngest` | `boolean`                                 | `true`      | Deletes `<repoRoot>/index.scip` after the post-refresh ingest consumes it. Skipped automatically when `args` contains `--output`/`-o` (custom paths are user-managed). Set to `false` to keep the generated file for inspection. |

When both `scip.enabled` and `scip.generator.enabled` are true, SDL-MCP auto-adds `index.scip` to `scip.indexes` if you forgot to list it.

## Example Profiles

### Code Mode + Gateway Together

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "."
    }
  ],
  "codeMode": {
    "enabled": true,
    "exclusive": false
  },
  "gateway": {
    "enabled": true
  }
}
```

### Conservative CI

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "."
    }
  ],
  "indexing": {
    "concurrency": 2,
    "enableFileWatching": false
  },
  "prefetch": {
    "enabled": false
  },
  "parallelScorer": {
    "enabled": false
  },
  "runtime": {
    "enabled": false
  }
}
```

### Semantic Search + Local Summaries

```json
{
  "repos": [
    {
      "repoId": "my-repo",
      "rootPath": "."
    }
  ],
  "semantic": {
    "enabled": true,
    "provider": "local",
    "embeddingProfile": "max-recall",
    "generateSummaries": true,
    "summaryProvider": "local",
    "summaryApiBaseUrl": "http://localhost:11434/v1",
    "summaryModel": "gpt-4o-mini"
  }
}
```

## Environment Variables

| Variable                         | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `SDL_CONFIG` / `SDL_CONFIG_PATH` | Explicit config file path                                 |
| `SDL_CONFIG_HOME`                | Default config directory root                             |
| `SDL_GRAPH_DB_PATH`              | Override Ladybug DB file path                             |
| `SDL_GRAPH_DB_DIR`               | Override the directory that contains `sdl-mcp-graph.lbug` |
| `SDL_ALLOWED_REPO_ROOTS`         | Extra comma-separated allowed repo roots                  |
| `SDL_LOG_LEVEL`                  | Logging level                                             |
| `SDL_LOG_FILE`                   | Explicit log file path                                    |
| `SDL_CONSOLE_LOGGING`            | Mirror logs to stderr                                     |
| `SDL_LOG_FORMAT`                 | `json` or `text`                                          |
| `SDL_MCP_DISABLE_NATIVE_ADDON`   | Force TypeScript indexing engine                          |
| `SDL_DERIVED_REFRESH_TIMEOUT_MS` | Timeout for background startup recovery of stale derived-state rows. Default: `120000` |
| `ANTHROPIC_API_KEY`              | Hosted semantic-summary provider credential               |

`SDL_DERIVED_REFRESH_TIMEOUT_MS` accepts a positive integer number of
milliseconds. Invalid or non-positive values are ignored. This is intentionally
an environment variable rather than a config-file field because it controls
process-level startup recovery work rather than a per-repo index scan setting.

## Validation and Inspection

- Add `"$schema": "./node_modules/sdl-mcp/config/sdlmcp.config.schema.json"` to your config for editor help.
- Run `sdl-mcp doctor` to validate configuration and environment health.
- Run `sdl-mcp info` or call `sdl.info` to inspect the resolved runtime state.

## Omitted Compatibility Keys

This page intentionally does not document deprecated compatibility keys such as legacy SQLite path settings, retired semantic blending and ANN config, or the deprecated legacy-tool emission toggle. They may still be tolerated for backward compatibility, but they are not part of the recommended current configuration surface.
