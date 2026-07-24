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

</details>
</div>

Complete reference for the SDL-MCP runtime surfaces exposed by `registerTools`.

- `35` flat SDL action tools
- `2` universal tools: `sdl.action.search` and `sdl.info`
- Code Mode tools: `sdl.action.search`, `sdl.manual`, `sdl.context`, `sdl.retrieve`, `sdl.workflow`, and `sdl.file` (`sdl.info` is omitted in Code Mode exclusive)

Flat mode and gateway mode share the same handler layer. The CLI `tool` command exposes direct action aliases for the shared handler layer rather than the full MCP surface.

Parameter normalization is shared across flat and gateway calls. SDL-MCP accepts canonical camelCase fields plus common public aliases such as `repo_id`, `root_path`, `symbol_id`, `symbol_ids`, `from_version`, `to_version`, `slice_handle`, `spillover_handle`, `limit`, `if_none_match`, `known_etags`, `known_card_etags`, `edited_files`, `entry_symbols`, and `relative_cwd`.

Selected stable tools, starting with `sdl.repo.status`, `sdl.runtime.execute`, and `sdl.runtime.queryOutput`, also advertise MCP `outputSchema` metadata for their structured results.


---

## Diagnostics and Discovery (2 tools)

### `sdl.info`

Return unified runtime, config, logging, Ladybug, and native-addon status.

**Parameters:** none

**Response includes:**

- `version`
- `runtime` (`node`, `platform`, `arch`)
- `config` (`path`, `exists`, `loaded`)
- `logging` (`path`, `consoleMirroring`, `fallbackUsed`)
- `ladybug` (`available`, `activePath`)
- `native` (`available`, `sourcePath`, `reason`, `disabledByEnv`)
- `warnings`
- `misconfigurations`

**Example:**

```json
{}
```

### `sdl.action.search`

Search the SDL action catalog and return the best matching actions, examples, and schema summaries. Use this to discover the right SDL action before calling `sdl.manual`, `sdl.context`, `sdl.workflow`, or the direct flat or gateway tool surfaces.

See the [Code Mode deep dive](./feature-deep-dives/code-mode.md) for end-to-end discovery and chaining workflows.

**Parameters:**

| Parameter         | Type      | Required | Description                               |
| ----------------- | --------- | -------- | ----------------------------------------- |
| `query`           | `string`  | Yes      | Search query                              |
| `limit`           | `integer` | No       | Max results to return (1-50, default: 10) |
| `offset`          | `integer` | No       | Skip the first N ranked results (min: 0)  |
| `includeSchemas`  | `boolean` | No       | Include compact schema summaries          |
| `includeExamples` | `boolean` | No       | Include example calls                     |

**Response:** `{ actions, total, hasMore, offset, limit, tokenEstimate }`

Use `offset` with `limit` to page through large result sets such as `query: "*"`.

---

## Repository and Indexing (7 tools)

### `sdl.repo.register`

Register a new repository for indexing.

**Parameters:**

| Parameter      | Type       | Required | Description                                      |
| -------------- | ---------- | -------- | ------------------------------------------------ |
| `repoId`       | `string`   | Yes      | Unique identifier for the repository             |
| `rootPath`     | `string`   | Yes      | Absolute path to repository root                 |
| `ignore`       | `string[]` | No       | Glob patterns for files/dirs to ignore           |
| `languages`    | `string[]` | No       | Language extension filter (e.g., `["ts", "py"]`) |
| `maxFileBytes` | `integer`  | No       | Max file size to index (min: 1)                  |

**Response:** `{ ok: boolean, repoId: string }`

**Example:**

```json
{
  "repoId": "my-repo",
  "rootPath": "/workspace/my-repo",
  "ignore": ["node_modules", "dist"],
  "languages": ["ts", "py"]
}
```

---

### `sdl.repo.status`

Get status for one repository including latest version, indexed files/symbols, timestamps, health, watcher telemetry, and prefetch statistics.

**Parameters:**

| Parameter         | Type      | Required | Description                                              |
| ----------------- | --------- | -------- | -------------------------------------------------------- |
| `repoId`          | `string`  | Yes      | Repository identifier                                    |
| `surfaceMemories` | `boolean` | No       | Include relevant development memories (default: `false`) |
| `detail`          | `"minimal" \| "standard" \| "full"` | No | Response detail; defaults to `"minimal"` |
| `includeTelemetry` | `boolean` | No       | Include volatile operational telemetry (default: `false`) |

**Response includes:**

- `repoId`, `rootPath`, `latestVersionId`, `filesIndexed`, `symbolsIndexed`, `countNotes`, `lastIndexedAt`. The default minimal model-facing projection omits `rootPath` and `lastIndexedAt`; broader detail can expose `rootPath`, while timestamp telemetry requires `includeTelemetry: true`.
- `rootAvailability` on every detail level, with `status` set to `available`, `missing`, or `unreadable`. An unavailable root also includes a stable `nextBestAction` for restoring or updating the registration.
- `healthScore` (0-100), `healthComponents` (freshness, coverage, errorRate, edgeQuality, callResolution), `healthAvailable`. Root availability and graph availability are independent health gates. A missing or unreadable root sets `healthAvailable: false` and omits `healthScore`. A current manifest-backed graph remains available in `verifying` or `failed` state, although those states do not claim that the current revision is verified.
- `watcherHealth` (nullable) — runtime telemetry: provider/configuredProvider/fallbackReason, enabled/running state, filesWatched, eventsReceived/Processed, errors, queueDepth, restartCount, stale timestamps, and Watchman warning/recrawl/fresh-instance diagnostics when Watchman is active or was attempted
- `prefetchStats` — queue depth, hit/waste rates, latency reduction, last run
- `liveIndexStatus` — live buffer overlay state: enabled, pendingBuffers, dirtyBuffers, parseQueueDepth, checkpointPending, reconcileQueueDepth, etc.
- `derivedState` — derived-state freshness: stale flag, dirty cluster/process/algorithm/summary/embedding flags, target/computed version ids, `lastError` when recomputation failed, `graphIntegrityState`, `graphIntegrityVersionId`, `graphIntegrityRevision`, `graphIntegrityVerifiedRevision`, `graphIntegrityDigest`, and `nextBestAction` when recovery is needed. Equal current and verified revisions in `verified` state prove the latest revision. `verifying` and `failed` can remain readable when the current Version has a manifest and revisions, but they do not prove the latest revision. A `verifying` state does not require a refresh. An `unknown`, missing-manifest, or permanent failed state directs a populated graph to stopped `index --force --safe-rebuild` recovery rather than repeated full refreshes. Integrity mismatch details stay in operational logs and never appear in the response. Startup and foreground quiescence checks requeue persisted pending revisions.
- `memories` (when `surfaceMemories: true` and memory is enabled in config) — array of relevant development memories auto-surfaced for the repository

**Example:**

```json
{ "repoId": "my-repo" }
```

---

### `sdl.repo.unregister`

Permanently remove a runtime repository registration and all repository-owned graph state. Repositories declared in `SDL_CONFIG` cannot be removed with this action; remove the configuration entry first.

**Parameters:**

| Parameter       | Type      | Required | Description                                                               |
| --------------- | --------- | -------- | ------------------------------------------------------------------------- |
| `repoId`        | `string`  | Yes      | Runtime repository identifier                                             |
| `confirmRepoId` | `string`  | Yes      | Must exactly match `repoId`                                               |
| `discardDrafts` | `boolean` | No       | Permit removal when dirty live buffers exist (default: `false`)           |

**Response:** `{ ok: true, repoId: string, removed: true }`

Unknown repositories return `NOT_FOUND`. Dirty live buffers fail closed unless `discardDrafts: true`; this discards their transient draft state. Removal also invalidates repository-scoped graph, overview, slice, card, health, prefetch, and stored response-handle state.

---

### `sdl.index.refresh`

Refresh the symbol index in `incremental` or `full` mode.

**Parameters:**

| Parameter            | Type                      | Required | Description                                                                           |
| -------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `repoId`             | `string`                  | Yes      | Repository identifier                                                                 |
| `mode`               | `"full" \| "incremental"` | Yes      | Refresh mode                                                                          |
| `reason`             | `string`                  | No       | Human-readable reason for the refresh                                                 |
| `includeDiagnostics` | `boolean`                 | No       | When `true`, include coarse phase timings in the synchronous response                 |
| `async`              | `boolean`                 | No       | When `true`, start indexing in the background and return an `operationId` immediately |

**Response:** `{ ok: boolean, repoId: string, versionId?: string, changedFiles?: integer, async?: boolean, operationId?: string, message?: string, diagnostics?: { timings: { totalMs: number, phases: Record<string, number> } } }`

Public refresh calls use one process-wide FIFO admission gate because
LadybugDB permits one writer. One refresh runs while at most eight additional
requests wait. A ninth queued request fails immediately with a retryable
`RUNTIME_ERROR` classified as `unavailable`; aborting a queued request removes
it without canceling running work. An `async: true` refresh keeps its admission
ownership until the detached refresh settles, even though the operation
response returns immediately.

In incremental mode, files whose modification time predates their last indexed timestamp are skipped. If changed files are found, derived cluster/process state is recomputed inline before the refresh returns. If no tracked files changed, the existing version is reused instead of creating an empty snapshot and the refresh can short-circuit after `scanRepo`, `versioning`, and `memorySync`.

When called with a progress token, the server emits `notifications/progress` messages with the current stage, file path, and completion percentage.

`diagnostics.timings` is only returned for synchronous requests with `includeDiagnostics: true`.

Common `diagnostics.timings.phases` entries include:

- `initSharedState.tsResolver`
- `initSharedState.symbolMaps`
- `resolveUnresolvedImports.fetchEdges`
- `finalizeEdges.cleanupUnresolvedBuiltins`
- `finalizeEdges.insertConfigEdges`
- `finalizeIndexing.metrics`
- `finalizeIndexing.metrics.testRefs`
- `finalizeIndexing.fileSummaries`
- `clustersAndProcesses.loadSymbols`
- `clustersAndProcesses.processWrite`

The TS resolver is lazy, so compiler-program subphases such as `initSharedState.tsResolver.sourceFiles` and `initSharedState.tsResolver.programBuild` appear only when pass 2 needs the TypeScript program. No-op incremental refreshes may omit later phases entirely and report a `shortCircuitNoOp` phase instead.

**Example:**

```json
{
  "repoId": "my-repo",
  "mode": "incremental",
  "reason": "post-edit refresh",
  "includeDiagnostics": true
}
```

---

### `sdl.semantic.enrichment.refresh`

Report provider-backed semantic source selection. SCIP/LSP graph facts are materialized only by provider-first indexing, so this action does not ingest provider facts directly.

**Parameters:**

| Parameter   | Type       | Required | Description                                                                   |
| ----------- | ---------- | -------- | ----------------------------------------------------------------------------- |
| `repoId`    | `string`   | Yes      | Repository identifier                                                         |
| `dryRun`    | `boolean`  | No       | Preserve response compatibility; no graph writes are performed                |
| `force`     | `boolean`  | No       | Preserved for compatibility                                                   |
| `install`   | `boolean`  | No       | Allow verified downloads only when `semanticEnrichment.installPolicy` permits |
| `languages` | `string[]` | No       | Restrict refresh to specific language IDs                                     |

**Response includes:** selected provider per language and skipped-provider reasons. SCIP/LSP selections are skipped with guidance to run provider-first indexing.

---

### `sdl.semantic.enrichment.status`

Report semantic enrichment source selection, skipped providers, last runs, and precision scores.

**Parameters:**

| Parameter   | Type       | Required | Description                              |
| ----------- | ---------- | -------- | ---------------------------------------- |
| `repoId`    | `string`   | Yes      | Repository identifier                    |
| `languages` | `string[]` | No       | Restrict status to specific language IDs |
| `detail`    | `"compact" \| "full"` | No | Defaults to `"compact"`; use `"full"` for untrimmed provider rows and run metadata |
| `limit`     | `integer`  | No       | Max compact `lastRuns` entries (default: `5`) |

Compact responses return selection counts and `languagesWithSelection`, plus short `lastRuns` summaries. Full responses retain provider rows, skipped-provider details, and raw run metadata.

---

### `sdl.repo.overview`

Return a token-efficient repository overview with directory summaries and hotspots.

**Parameters:**

| Parameter                | Type                                 | Required | Description                                                |
| ------------------------ | ------------------------------------ | -------- | ---------------------------------------------------------- |
| `repoId`                 | `string`                             | Yes      | Repository identifier                                      |
| `level`                  | `"stats" \| "directories" \| "full"` | Yes      | Detail level                                               |
| `includeHotspots`        | `boolean`                            | No       | Include codebase hotspots (auto-enabled at `"full"` level) |
| `directories`            | `string[]`                           | No       | Filter to specific directories                             |
| `maxDirectories`         | `integer`                            | No       | Max directories to return (1-200)                          |
| `maxExportsPerDirectory` | `integer`                            | No       | Max exports per directory (1-50)                           |

Start with `level: "stats"` (cheapest). Escalate to `"directories"` or `"full"` only when needed. `level: "full"` auto-enables hotspots unless `includeHotspots: false` is set.

**Response includes:**

- `stats` — fileCount, symbolCount, edgeCount, exportedSymbolCount, byKind, byEdgeType, avgSymbolsPerFile, avgEdgesPerSymbol, countNotes
- `directories` — array of summaries with path, fileCount, symbolCount, compact unique exports, topByFanIn, topByChurn
- `hotspots` (optional) — mostDepended, mostChanged, largestFiles, mostConnected
- `clusters` (optional) — totalClusters, averageClusterSize, largestClusters
- `processes` (optional) — totalProcesses, averageDepth, entryPoints, longestProcesses
- `tokenMetrics` — fullCardsEstimate, overviewTokens, compressionRatio

**Examples:**

```json
{ "repoId": "my-repo", "level": "stats" }
```

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

---

## Live Buffer and Draft Indexing (3 tools)

### `sdl.buffer.push`

Push an editor buffer update into the live draft overlay so symbol/search/slice reads can see unsaved changes.

**Parameters:**

| Parameter    | Type                                                      | Required | Description                             |
| ------------ | --------------------------------------------------------- | -------- | --------------------------------------- |
| `repoId`     | `string`                                                  | Yes      | Repository identifier                   |
| `eventType`  | `"open" \| "change" \| "save" \| "close" \| "checkpoint"` | Yes      | Buffer lifecycle event                  |
| `filePath`   | `string`                                                  | Yes      | Repository-relative file path           |
| `content`    | `string`                                                  | Yes      | Current buffer contents                 |
| `language`   | `string`                                                  | No       | Explicit language hint                  |
| `version`    | `integer`                                                 | Yes      | Monotonic buffer version                |
| `dirty`      | `boolean`                                                 | Yes      | Whether the buffer has unsaved edits    |
| `timestamp`  | `string`                                                  | Yes      | ISO timestamp for the event             |
| `cursor`     | `object`                                                  | No       | Cursor position (`{ line, character }`) |
| `selections` | `object[]`                                                | No       | Active selections (`[{ start, end }]`)  |

**Response includes:**

- `accepted`, `repoId`, `overlayVersion`
- `parseScheduled` and `checkpointScheduled`
- `warnings` for stale updates, disabled live index, or draft-limit pressure

**Example:**

```json
{
  "repoId": "my-repo",
  "eventType": "change",
  "filePath": "src/auth/token.ts",
  "content": "export function validateToken() {}",
  "language": "typescript",
  "version": 12,
  "dirty": true,
  "timestamp": "2026-03-07T12:00:00.000Z"
}
```

---

### `sdl.buffer.checkpoint`

Flush the live draft overlay for a repository into a durable checkpoint.

**Parameters:**

| Parameter | Type     | Required | Description                      |
| --------- | -------- | -------- | -------------------------------- |
| `repoId`  | `string` | Yes      | Repository identifier            |
| `reason`  | `string` | No       | Human-readable checkpoint reason |

**Response includes:**

- `repoId`, `requested`, `checkpointId`
- `pendingBuffers`, `checkpointedFiles`, `failedFiles`
- `lastCheckpointAt`

**Example:**

```json
{
  "repoId": "my-repo",
  "reason": "manual"
}
```

---

### `sdl.buffer.status`

Inspect the current live draft overlay health for a repository.

**Parameters:**

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `repoId`  | `string` | Yes      | Repository identifier |

**Response includes:**

- `enabled`, `pendingBuffers`, `dirtyBuffers`, `parseQueueDepth`
- `checkpointPending`, `lastBufferEventAt`, `lastCheckpointAt`
- `reconcileQueueDepth`, `lastReconciledAt`, `reconcileInflight`

**Example:**

```json
{ "repoId": "my-repo" }
```

---

## Symbol Discovery and Editing (5 tools)

### `sdl.symbol.search`

Search symbols by name or summary text.

**Parameters:**

| Parameter                  | Type                      | Required | Description                                                                                                                                                                     |
| -------------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoId`                   | `string`                  | Yes      | Repository identifier                                                                                                                                                           |
| `query`                    | `string`                  | Yes      | Search query (min length: 1)                                                                                                                                                    |
| `kinds`                    | `string[]`                | No       | Filter by symbol kind (e.g., `["function", "class"]`)                                                                                                                           |
| `limit`                    | `integer`                 | No       | Max results (1-1000, default: 50)                                                                                                                                               |
| `semantic`                 | `boolean`                 | No       | Enable semantic reranking / hybrid retrieval                                                                                                                                    |
| `includeRetrievalEvidence` | `boolean`                 | No       | Include retrieval evidence (sources, candidate counts, latency, fallback reason)                                                                                                |
| `chatMentions`             | `string[]`                | No       | Up to 20 identifiers / symbol names / IDs the user just mentioned in chat. Seeds Personalized PageRank for chat-aware re-ranking.                                               |
| `chatMentionWeights`       | `Record<string, number>`  | No       | Per-mention weight overrides; missing entries default to uniform 1.0.                                                                                                           |
| `pprDirection`             | `"out" \| "in" \| "both"` | No       | Walk direction across the dependency graph. Default: `"both"`.                                                                                                                  |
| `pprWeight`                | `number`                  | No       | PPR coefficient: final multiplier is `1 + pprWeight × pprScore`, capped per call at 2× and across stacked boosts at 4× the original RRF score. Default: `2.0`. Range: `[0, 2]`. |

When `chatMentions` is non-empty, results are re-ranked via Personalized PageRank seeded at those mentions — see [semantic-engine.md → Chat-Aware PageRank Boost](feature-deep-dives/semantic-engine.md#chat-aware-personalized-pagerank-boost-v0109). When `chatMentions` is **omitted** (`undefined`), the server auto-extracts identifier-like tokens from the query as seeds. Pass an explicit empty array `[]` to disable PPR entirely. PPR diagnostics surface in `response.pprBoosts` when `includeRetrievalEvidence: true`.

When semantic mode is enabled, the retrieval path depends on `semantic.retrieval.mode`:

- `"hybrid"` uses FTS + vector search with RRF fusion.
- `"legacy"` uses alpha-blended lexical + embedding reranking.

SDL-MCP falls back to legacy automatically if hybrid indexes are unavailable.

**Response:** `{ results: [{ symbolId, name, file, kind }], retrievalMode?, retrievalEvidence?, truncation? }`

**Examples:**

```json
{ "repoId": "my-repo", "query": "parseConfig", "limit": 20 }
```

```json
{
  "repoId": "my-repo",
  "query": "auth token refresh",
  "limit": 20,
  "semantic": true
}
```

---

### `sdl.symbol.getCard`

Fetch a single symbol card by ID or natural reference with ETag support.

**Parameters:**

| Parameter                   | Type                                    | Required    | Description                                                                                       |
| --------------------------- | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `repoId`                    | `string`                                | Yes         | Repository identifier                                                                             |
| `symbolId`                  | `string`                                | Conditional | Symbol identifier                                                                                 |
| `symbolRef`                 | `{ name, file?, kind?, exportedOnly? }` | Conditional | Natural symbol reference. Use this when you know the symbol name and optionally the file or kind. |
| `ifNoneMatch`               | `string`                                | No          | ETag for conditional fetch (returns `notModified` if unchanged)                                   |
| `minCallConfidence`         | `number`                                | No          | Filter call edges below this confidence threshold (0-1)                                           |
| `includeResolutionMetadata` | `boolean`                               | No          | Include call resolution strategy and provenance in edge data                                      |

Provide exactly one of `symbolId` or `symbolRef`.

The returned card includes identity, signature, summary, invariants, side effects, dependency edges (imports/calls), metrics, and (when available) cluster/process metadata (`card.cluster`, `card.processes`). `metrics.canonicalTest` (if available) contains the file path, distance, and proximity of the nearest associated test.

**Response:** Either `{ card: SymbolCard }` or `{ notModified: true, etag, ledgerVersion }`.

If a natural reference is ambiguous or not found, the error response includes structured guidance such as `classification`, `fallbackTools`, `fallbackRationale`, and ranked `candidates`.

**Examples:**

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>" }
```

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>", "ifNoneMatch": "<etag>" }
```

```json
{
  "repoId": "my-repo",
  "symbolRef": { "name": "handleRequest", "file": "src/server.ts" }
}
```

---

### `sdl.symbol.edit`

Preview or apply a symbol-scoped edit with symbol, file, and draft preconditions. It reuses the search-edit plan store and write path, then adds `symbolId`, `astFingerprint`, range, saved-file sha, optional draft version, and parse-after validation.

Use this for edits where the target is one symbol. Use `sdl.search.edit` for cross-file search replacements, and use `sdl.file.write` for immediate non-symbol-shaped writes.

**Parameters:**

| Parameter                | Type                                       | Required    | Description                                                                  |
| ------------------------ | ------------------------------------------ | ----------- | ---------------------------------------------------------------------------- |
| `repoId`                 | `string`                                   | Yes         | Repository identifier                                                        |
| `mode`                   | `"preview" \| "apply" \| "applyNow"`       | Yes         | Preview creates a plan, apply consumes one, applyNow does both               |
| `symbolId`               | `string`                                   | Conditional | Symbol identifier or shorthand. Required for applyNow                        |
| `symbolRef`              | `{ name, file?, kind?, exportedOnly? }`    | Conditional | Natural symbol reference for preview                                         |
| `operation`              | `object`                                   | Conditional | Edit operation for preview/applyNow                                          |
| `planHandle`             | `string`                                   | Conditional | Plan handle for apply                                                        |
| `expectedAstFingerprint` | `string`                                   | Conditional | Required for applyNow                                                        |
| `expectedRange`          | `{ startLine, startCol, endLine, endCol }` | Conditional | Required for applyNow                                                        |
| `createBackup`           | `boolean`                                  | No          | Backup saved files before writing. Must match preview when supplied to apply |

**Operations:** `replaceSymbol`, `replaceBody`, `replaceSignature`, `insertBefore`, `insertAfter`, and `renameLocal`. TypeScript, TSX, JavaScript, and JSX support all operations. Other indexed languages support only full-symbol replacement and adjacent inserts when symbol ranges are available and the language adapter can parse before and after the edit.

**Response:** preview returns `{ mode, planHandle, symbolId, file, writeTarget, validation, fileEntries }`; apply returns `{ mode, filesWritten, results, validation, draftUpdate? }`. Preconditions are held server-side by the plan handle and rechecked on apply.

**Examples:**

```json
{
  "repoId": "my-repo",
  "mode": "preview",
  "symbolRef": { "name": "handleAuth", "file": "src/auth.ts" },
  "operation": { "kind": "replaceBody", "content": "return true;\n" }
}
```

```json
{
  "repoId": "my-repo",
  "mode": "apply",
  "planHandle": "se-mf0abc-1234"
}
```

See [sdl.symbol.edit](./symbol-edit-tool.md) for the full operation and precondition contract.

---

### `sdl.symbol.getCard` (batch request shape)

Batch fetch up to 100 symbol cards through the same `sdl.symbol.getCard` tool. Prefer this over multiple sequential calls when you already have a list of symbol IDs or natural symbol references.

**Parameters:**

| Parameter                   | Type                                           | Required    | Description                                                          |
| --------------------------- | ---------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| `repoId`                    | `string`                                       | Yes         | Repository identifier                                                |
| `symbolIds`                 | `string[]`                                     | Conditional | Array of symbol IDs (1-100)                                          |
| `symbolRefs`                | `Array<{ name, file?, kind?, exportedOnly? }>` | Conditional | Array of natural symbol references (1-100)                           |
| `knownEtags`                | `Record<string, string>`                       | No          | Map of symbolId to known ETag; matching symbols return `notModified` |
| `minCallConfidence`         | `number`                                       | No          | Filter call edges below this confidence threshold (0-1)              |
| `includeResolutionMetadata` | `boolean`                                      | No          | Include call resolution strategy and provenance in edge data         |

Provide exactly one of `symbolIds` or `symbolRefs`.

**Response:** `{ cards: Array<SymbolCard | NotModifiedResponse>, partial?, succeeded?, failed?, failures? }`

When you use `symbolRefs`, the batch resolves each reference independently. Mixed batches can succeed partially and return:

- `partial` when some references resolved and others did not
- `succeeded` with resolved symbol IDs
- `failed` with the unresolved input names
- `failures` with structured per-input error metadata such as `classification`, `fallbackTools`, and ranked `candidates`

**Example:**

```json
{
  "repoId": "my-repo",
  "symbolIds": ["<id1>", "<id2>", "<id3>"],
  "knownEtags": { "<id1>": "<etag1>" }
}
```

```json
{
  "repoId": "my-repo",
  "symbolRefs": [
    { "name": "handleRequest", "file": "src/server.ts" },
    { "name": "parseConfig", "kind": "function" }
  ]
}
```

---

## Graph Slice Workflows (3 tools)

### `sdl.slice.build`

Build a task-scoped graph slice. `taskText` alone is sufficient — it triggers auto-discovery of relevant symbols via full-text search in a single round trip. Adding `entrySymbols` improves precision.

**Parameters:**

| Parameter                   | Type                                                        | Required | Description                                                                                                |
| --------------------------- | ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `repoId`                    | `string`                                                    | Yes      | Repository identifier                                                                                      |
| `taskText`                  | `string`                                                    | No       | Natural language task description (auto-discovers symbols via hybrid retrieval or legacy full-text search) |
| `entrySymbols`              | `string[]`                                                  | No       | Symbol IDs to start the slice from                                                                         |
| `editedFiles`               | `string[]`                                                  | No       | Files whose symbols (+ callers) are forced into the slice                                                  |
| `stackTrace`                | `string`                                                    | No       | Stack trace to bias toward call-path symbols                                                               |
| `failingTestPath`           | `string`                                                    | No       | Failing test file to bias toward code under test                                                           |
| `budget`                    | `{ maxCards?, maxEstimatedTokens? }`                        | No       | Token/card budget constraints                                                                              |
| `minConfidence`             | `number`                                                    | No       | Edge confidence threshold (0-1, default: 0.5)                                                              |
| `knownCardEtags`            | `Record<string, string>`                                    | No       | ETags for cards already held; unchanged return as `cardRefs`                                               |
| `cardDetail`                | `"minimal" \| "signature" \| "deps" \| "compact" \| "full"` | No       | Card detail level (leave unset for mixed)                                                                  |
| `adaptiveDetail`            | `boolean`                                                   | No       | Enable adaptive detail level selection                                                                     |
| `wireFormat`                | `"standard" \| "readable" \| "compact" \| "agent"`          | No       | Wire format (default: compact)                                                                             |
| `wireFormatVersion`         | `3`                                                         | No       | Wire format version. Only `3` is accepted; v1 and v2 were retired in 0.11.0.                               |
| `minCallConfidence`         | `number`                                                    | No       | Filter call edges below this confidence threshold (0-1)                                                    |
| `includeResolutionMetadata` | `boolean`                                                   | No       | Include call resolution metadata in edge data                                                              |
| `includeMemories`           | `boolean`                                                   | No       | Include related development memories in the response (only effective when memory is enabled in config)     |
| `memoryLimit`               | `integer`                                                   | No       | Max memories to include (default: 5)                                                                       |
| `includeRetrievalEvidence`  | `boolean`                                                   | No       | Include retrieval evidence (sources, candidate counts, symptom type, fusion latency, fallback reason)      |

**Response:** `{ sliceHandle, ledgerVersion, lease, sliceEtag?, slice, retrievalEvidence? }` or `{ notModified }`.

The slice contains `symbolIndex`, `cards`, optional `cardRefs` (for ETag matches), `edges`, optional `frontier`, and optional `truncation` with resume info. Slice cards may include cluster/process metadata (`card.cluster`, `card.processes`) when available.

**Tips:**

- Raise `minConfidence` toward 0.8-0.95 for precision-focused runs; keep near 0.5 for recall-oriented work
- Use `knownCardEtags` on subsequent calls to reduce token cost
- Use `editedFiles` for impact analysis after code changes

**Examples:**

```json
{
  "repoId": "my-repo",
  "taskText": "trace auth token validation",
  "entrySymbols": ["<symbol-id>"],
  "budget": { "maxCards": 50, "maxEstimatedTokens": 4000 }
}
```

```json
{
  "repoId": "my-repo",
  "taskText": "review changes to auth module",
  "editedFiles": ["src/auth/token.ts"],
  "budget": { "maxCards": 30, "maxEstimatedTokens": 3000 }
}
```

---

### `sdl.slice.refresh`

Refresh an existing slice handle and receive changes relative to a known version. Prefer this over rebuilding slices when you already have a handle.

**Parameters:**

| Parameter      | Type     | Required | Description                              |
| -------------- | -------- | -------- | ---------------------------------------- |
| `sliceHandle`  | `string` | Yes      | Handle from a previous `sdl.slice.build` |
| `knownVersion` | `string` | Yes      | Version ID the client currently holds    |

**Response:** `{ sliceHandle, knownVersion, currentVersion, notModified?, delta?, lease? }`

If nothing changed, `notModified: true` is returned. Otherwise, `delta` contains the incremental changes (changedSymbols, blastRadius, trimmedSet, etc.).

**Example:**

```json
{ "sliceHandle": "h_abc123", "knownVersion": "v1770600000000" }
```

---

### `sdl.slice.spillover.get`

Paginate additional symbols that exceeded the slice budget. Only use when the slice was truncated and you need more symbols.

**Parameters:**

| Parameter         | Type      | Required | Description                             |
| ----------------- | --------- | -------- | --------------------------------------- |
| `repoId`          | `string`  | Yes      | Repository identifier                   |
| `spilloverHandle` | `string`  | Yes      | Spillover handle from a truncated slice |
| `cursor`          | `string`  | No       | Pagination cursor from previous page    |
| `pageSize`        | `integer` | No       | Items per page (1-100, default: 20)     |
| `limit`           | `integer` | No       | Public alias for `pageSize`             |

**Response:** `{ spilloverHandle, cursor?, hasMore, symbols: SymbolCard[] }`

**Example:**

```json
{ "repoId": "my-repo", "spilloverHandle": "sp_abc123", "limit": 20 }
```

---

## Delta and Risk (2 tools)

### `sdl.delta.get`

Compute a delta pack between two ledger versions, showing changed symbols and blast radius.

**Parameters:**

| Parameter     | Type                                 | Required | Description                           |
| ------------- | ------------------------------------ | -------- | ------------------------------------- |
| `repoId`      | `string`                             | Yes      | Repository identifier                 |
| `fromVersion` | `string`                             | Yes      | Base version ID                       |
| `toVersion`   | `string`                             | Yes      | Target version ID                     |
| `budget`      | `{ maxCards?, maxEstimatedTokens? }` | No       | Budget to constrain blast-radius work |

**Response includes:**

- `delta` — changedSymbols (with changeType, signatureDiff, invariantDiff, sideEffectDiff), blastRadius (ranked by distance/signal: diagnostic|directDependent|graph|process, with fanInTrend), diagnosticsSummary, diagnosticSuspects, truncation, trimmedSet, spilloverHandle
- `amplifiers` — multipliers for dependent symbols (symbolId, growthRate, previous/current fan-in) that increase blast-radius scoring

**Example:**

```json
{ "repoId": "my-repo", "fromVersion": "v1", "toVersion": "v2" }
```

---

### `sdl.pr.risk.analyze`

Assess PR-level risk from delta and blast radius, producing findings, impact analysis, and test recommendations.

**Parameters:**

| Parameter       | Type      | Required | Description                                                   |
| --------------- | --------- | -------- | ------------------------------------------------------------- |
| `repoId`        | `string`  | Yes      | Repository identifier                                         |
| `fromVersion`   | `string`  | Yes      | Base version ID                                               |
| `toVersion`     | `string`  | Yes      | Target version ID                                             |
| `riskThreshold` | `number`  | No       | Risk threshold 0-100 (raise to focus on highest-risk changes) |

**Response includes:**

- `analysis` — riskScore (0-100), riskLevel (low/medium/high), findings (type, severity, message, affectedSymbols), impactedSymbols, evidence, recommendedTests (type, description, targetSymbols, priority), changedSymbolsCount, blastRadiusCount
- `escalationRequired` — whether the risk exceeds the threshold
- `policyDecision` (optional) — decision, deniedReasons, auditHash

**Example:**

```json
{
  "repoId": "my-repo",
  "fromVersion": "v1",
  "toVersion": "v2",
  "riskThreshold": 70
}
```

---

## Code Access Ladder (3 tools)

These tools form an escalation path. Use them in order: skeleton first, then hot-path, then raw window only when necessary.

### `sdl.code.getSkeleton`

Get a skeleton view of code showing signatures, control flow structure, and elided function bodies. Returns `null` for files exceeding the configured `maxFileBytes` limit.

**Parameters:**

| Parameter           | Type       | Required | Description                                                   |
| ------------------- | ---------- | -------- | ------------------------------------------------------------- |
| `repoId`            | `string`   | Yes      | Repository identifier                                         |
| `symbolId`          | `string`   | No\*     | Symbol to get skeleton for                                    |
| `file`              | `string`   | No\*     | File path to get skeleton for                                 |
| `exportedOnly`      | `boolean`  | No       | Only show exported symbols (file mode)                        |
| `maxLines`          | `integer`  | No       | Max output lines (min: 1)                                     |
| `maxTokens`         | `integer`  | No       | Max output tokens (min: 1)                                    |
| `identifiersToFind` | `string[]` | No       | Highlight specific identifiers                                |
| `skeletonOffset`    | `integer`  | No       | Resume from a previous truncation point (line offset, min: 0) |

\*Either `symbolId` or `file` must be provided.

In file mode, prefer `exportedOnly: true` when possible to reduce output size.

**Response:** `{ skeleton, file, range, estimatedTokens, originalLines, truncated, truncation? }`

**Example:**

```json
{ "repoId": "my-repo", "symbolId": "<symbol-id>" }
```

```json
{ "repoId": "my-repo", "file": "src/auth/token.ts", "exportedOnly": true }
```

---

### `sdl.code.getHotPath`

Get an identifier-focused code excerpt showing only lines that match the requested identifiers, with surrounding context.

**Parameters:**

| Parameter           | Type       | Required | Description                                          |
| ------------------- | ---------- | -------- | ---------------------------------------------------- |
| `repoId`            | `string`   | Yes      | Repository identifier                                |
| `symbolId`          | `string`   | Conditional | Symbol to search within                          |
| `symbolRef`         | `{ name, file?, kind?, exportedOnly? }` | Conditional | Natural symbol reference when the canonical ID is not known |
| `identifiersToFind` | `string[]` | Yes      | Identifiers to locate (min: 1)                       |
| `contextLines`      | `integer`  | No       | Lines of context around matches (default: 3, min: 0) |
| `maxLines`          | `integer`  | No       | Max output lines (min: 1)                            |
| `maxTokens`         | `integer`  | No       | Max output tokens (min: 1)                           |

The `matchedIdentifiers` field in the response contains only identifiers that were actually found in the AST, not the full request list.
Provide exactly one of `symbolId` or `symbolRef`.

**Response:** `{ excerpt, file, range, estimatedTokens, matchedIdentifiers, matchedLineNumbers, truncated }`

**Example:**

```json
{
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "identifiersToFind": ["validate", "token"],
  "contextLines": 3
}
```

---

### `sdl.code.needWindow`

Request raw code for a symbol. This is policy-gated and should be used as a last resort after trying skeleton and hot-path.

**Parameters:**

| Parameter           | Type                                  | Required | Description                                                |
| ------------------- | ------------------------------------- | -------- | ---------------------------------------------------------- |
| `repoId`            | `string`                              | Yes      | Repository identifier                                      |
| `symbolId`          | `string`                              | Conditional | Symbol to get code for                                  |
| `symbolRef`         | `{ name, file?, kind?, exportedOnly? }` | Conditional | Natural symbol reference when the canonical ID is not known |
| `reason`            | `string`                              | Yes      | Justification for raw code access (min length: 1)          |
| `expectedLines`     | `integer`                             | Yes      | Expected lines needed (min: 1, clamped to policy max: 180) |
| `identifiersToFind` | `string[]`                            | Yes      | Identifiers expected in the code (required by policy)      |
| `granularity`       | `"symbol" \| "block" \| "fileWindow"` | No       | Code extraction scope                                      |
| `maxTokens`         | `integer`                             | No       | Max tokens (min: 1, clamped to policy max: 1400)           |
| `sliceContext`      | `object`                              | No       | Slice context for approval scoring                         |

`sliceContext` fields: `taskText`, `stackTrace`, `failingTestPath`, `editedFiles`, `entrySymbols`, `budget`.
Provide exactly one of `symbolId` or `symbolRef`.

The `expectedLines` and `maxTokens` values are clamped to the effective policy limits, so requests exceeding policy caps are silently reduced rather than rejected.

Approval can proceed when one or more requested identifiers match the candidate window. Prefer a short list of precise identifiers instead of long all-or-nothing lists.

**Response (approved):** `{ approved: true, status, contentKind, symbolId, file, range, code, whyApproved, estimatedTokens, downgradedFrom?, matchedIdentifiers?, matchedLineNumbers?, truncation? }`. `contentKind` is `raw`, `skeleton`, or `hotPath`, so clients can identify the delivered representation without changing the established `approved` discriminant. When `downgradedFrom` is present, `status` is `downgraded`; otherwise raw delivery uses `approvedRaw`.

**Response (denied):** `{ approved: false, status: "denied", whyDenied, suggestedNextRequest?, nextBestAction? }`

When denied, `nextBestAction` suggests an alternative tool and args to try instead.

**Example:**

```json
{
  "repoId": "my-repo",
  "symbolId": "<symbol-id>",
  "reason": "Need exact branch logic for debugging auth timeout",
  "expectedLines": 80,
  "identifiersToFind": ["if", "catch", "tokenExpiry"]
}
```

---

## Policy Management (2 tools)

### `sdl.policy.get`

Fetch the effective policy configuration for a repository.

**Parameters:**

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `repoId`  | `string` | Yes      | Repository identifier |

**Response:** `{ policy: { maxWindowLines, maxWindowTokens, requireIdentifiers, allowBreakGlass } }`

Default policy values: `maxWindowLines: 180`, `maxWindowTokens: 1400`, `requireIdentifiers: true`, `allowBreakGlass: false`.

**Example:**

```json
{ "repoId": "my-repo" }
```

---

### `sdl.policy.set`

Update policy configuration for a repository. Accepts a partial patch — only specified fields are updated.

**Parameters:**

| Parameter     | Type     | Required | Description             |
| ------------- | -------- | -------- | ----------------------- |
| `repoId`      | `string` | Yes      | Repository identifier   |
| `policyPatch` | `object` | Yes      | Partial policy to apply |

`policyPatch` fields (all optional):

| Field                | Type      | Default | Description                                    |
| -------------------- | --------- | ------- | ---------------------------------------------- |
| `maxWindowLines`     | `integer` | 180     | Max lines per code window                      |
| `maxWindowTokens`    | `integer` | 1400    | Max tokens per code window                     |
| `requireIdentifiers` | `boolean` | true    | Require identifiersToFind in needWindow        |
| `allowBreakGlass`    | `boolean` | false   | Allow break-glass override for denied requests |

**Response:** `{ ok: boolean, repoId: string }`

**Example:**

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

---

## Code Context and Agent Feedback

### `sdl.context`

Retrieve task-shaped code context with rung path selection and evidence capture. The engine uses path inference, bounded lexical seeding, feedback priors, evidence-aware ranking, and confidence-driven rung planning to select an optimal path through the context ladder (card -> skeleton -> hotPath -> raw). Broad mode uses bounded multi-entity hybrid seeding (FTS + vector via RRF) by default. Precise mode keeps the lexical fast path unless `options.semantic: true` forces hybrid retrieval.

`sdl.context` is part of the Code Mode surface. In regular flat or gateway mode, use the manual ladder directly or enable Code Mode for task-shaped retrieval.

**Context modes:**

- **`"precise"`** — Returns minimal, chain-efficient context. Tight cluster expansion (max 4 symbols), stripped response envelope (no `actionsTaken`, `summary`, `answer`, `nextBestAction`). Designed to beat manual `sdl.workflow` on token efficiency.
- **`"broad"`** (default) — Returns richer surrounding context with graph-guided cluster expansion (max 10 symbols, diversity-scored). Compact response envelope with `answer` always preserved on success. Explicit `focusPaths` are still the fastest way to constrain broad investigations.

**Parameters:**

| Parameter            | Type                                              | Required | Description                                  |
| -------------------- | ------------------------------------------------- | -------- | -------------------------------------------- |
| `repoId`             | `string`                                          | Yes      | Repository identifier                        |
| `taskType`           | `"debug" \| "review" \| "implement" \| "explain"` | Yes      | Type of task                                 |
| `taskText`           | `string`                                          | Yes      | Task description or prompt                   |
| `budget`             | `object`                                          | No       | Budget constraints                           |
| `options`            | `object`                                          | No       | Task-specific options                        |
| `wireFormat`         | `"json" \| "packed" \| "auto"`                  | No       | Response wire format; default `"auto"`       |
| `refsMode`           | `"auto" \| "off"`                               | No       | Reference deduplication mode; default `"auto"` |
| `responseMode`       | `"inline" \| "auto" \| "handle"`                 | No       | Large-response handling                      |
| `ifNoneMatch`        | `string`                                          | No       | Return an unchanged reference when the ETag matches |
| `includeDiagnostics` | `boolean`                                         | No       | Include coarse phase timings in the response |

`budget` fields (all optional):

| Field               | Type     | Description                                      |
| ------------------- | -------- | ------------------------------------------------ |
| `maxTokens`         | `number` | Maximum tokens to consume                        |
| `maxEstimatedTokens` | `number` | Alias for `maxTokens`, compatible with slice budgets |
| `maxActions`        | `number` | Maximum number of actions to execute             |
| `maxDurationMs`     | `number` | Maximum duration in milliseconds                 |

Context budgets reject unknown fields. `maxCards` returns guidance to call `slice.build` for card-count budgets.

`options` fields (all optional):

| Field                      | Type                                          | Description                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contextMode`              | `"precise" \| "broad"`                        | Context breadth. `"precise"` returns minimal context; `"broad"` (default) returns richer surrounding context                                                                                                                                                                                                                                                                         |
| `focusSymbols`             | `string[]`                                    | Symbol IDs to focus on                                                                                                                                                                                                                                                                                                                                                               |
| `focusPaths`               | `string[]`                                    | File paths to focus on                                                                                                                                                                                                                                                                                                                                                               |
| `includeTests`             | `boolean`                                     | Include test files in analysis                                                                                                                                                                                                                                                                                                                                                       |
| `requireDiagnostics`       | `boolean`                                     | Include diagnostic info (may add a raw rung)                                                                                                                                                                                                                                                                                                                                         |
| `semantic`                 | `boolean`                                     | Control context seeding. Leave unset for default hybrid broad retrieval and lexical precise retrieval; set `true` to force bounded hybrid plus lexical coverage in either mode; set `false` for lexical-only retrieval.                                                                                                                                                                  |
| `includeRetrievalEvidence` | `boolean`                                     | Attach hybrid `retrievalEvidence` to the response (sources, candidate counts, top ranks per source, fusion latency, lane availability). Default `true`                                                                                                                                                                                                                               |
| `evidenceOptimization`     | `"off" \| "dedupe" \| "budgeted" \| "global"` | Enable opt-in evidence optimization for `sdl.context`. `dedupe` removes duplicate/subsumed evidence; `budgeted` greedily selects finalEvidence by value per token under `budget.maxTokens`; `global` also optimizes broad-mode `summary`, `answer`, and `finalEvidence` together under the response budget while preserving supporting cards for selected hot paths. Default `"off"` |
| `chatMentions`             | `string[]`                                    | Up to 20 identifiers / symbol names / IDs the user just mentioned in chat. Seeds Personalized PageRank for chat-aware re-ranking. See [semantic-engine.md → Chat-Aware PageRank](feature-deep-dives/semantic-engine.md#chat-aware-personalized-pagerank-boost-v0109)                                                                                                                 |
| `chatMentionWeights`       | `Record<string, number>`                      | Per-mention weight overrides; missing entries default to uniform 1.0                                                                                                                                                                                                                                                                                                                 |
| `pprDirection`             | `"out" \| "in" \| "both"`                     | Walk direction across the dependency graph for chat-aware re-ranking. Default `"both"`                                                                                                                                                                                                                                                                                               |
| `pprWeight`                | `number`                                      | PPR coefficient: final multiplier is `1 + pprWeight × pprScore`, capped per call at 2× and across stacked boosts at 4× the original RRF score. Default `2.0`, range `[0, 2]`                                                                                                                                                                                                         |

**Response:**

In **broad** mode (default, compact): `taskId`, `taskType`, `success`, `summary`, `answer`, `finalEvidence`, `nextBestAction?`, `retrievalEvidence?`, `diagnostics?`, `error?` — the fields `actionsTaken`, `path`, and `metrics` are omitted from the model-visible response. `finalEvidence` is the primary evidence surface. `retrievalEvidence` carries `sources`, `candidateCountPerSource`, `topRanksPerSource`, `fusionLatencyMs`, `diagnosticTimings`, `ftsAvailable`, and `vectorAvailable` from hybrid seeding when available. `diagnostics` is returned only when `includeDiagnostics: true`. The `answer` field is always preserved on successful responses.

In **precise** mode: `taskId`, `taskType`, `success`, `path`, `finalEvidence`, `metrics` — envelope fields stripped for token efficiency.

Planner token estimates: card ~50, skeleton ~200, hotPath ~500, raw ~2000. When over budget, the planner trims rungs based on confidence tier: high-confidence retrievals trim to cheapest rungs, low-confidence retrievals preserve diagnostic depth.

When Code Mode is enabled, `sdl.context` accepts the same task envelope and should be preferred over `sdl.workflow` for `debug`, `review`, `implement`, and `explain` retrieval.

**Precise mode rung strategies:**

| Task Type   | Precise Rungs   | Broad Rungs               |
| ----------- | --------------- | ------------------------- |
| `debug`     | card + hotPath  | card + skeleton + hotPath |
| `explain`   | card + skeleton | card + skeleton           |
| `review`    | card            | card + skeleton           |
| `implement` | card + skeleton | card + skeleton + hotPath |

**Examples:**

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "check NaN handling in normalizeEdgeConfidence",
  "budget": { "maxTokens": 4000 },
  "options": {
    "contextMode": "precise",
    "focusPaths": ["src/graph/slice/beam-search-engine.ts"]
  }
}
```

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "investigate auth timeout across the pipeline",
  "budget": { "maxTokens": 4000, "maxActions": 12 },
  "options": { "includeTests": true, "focusPaths": ["src/auth/"] }
}
```

---

### `sdl.agent.feedback`

Record which symbols were useful or missing during a task. Feedback is stored per version and used for offline slice-ranking tuning.

**Parameters:**

| Parameter        | Type                                              | Required | Description                               |
| ---------------- | ------------------------------------------------- | -------- | ----------------------------------------- |
| `repoId`         | `string`                                          | Yes      | Repository identifier                     |
| `versionId`      | `string`                                          | Yes      | Version ID (from `sdl.repo.status`)       |
| `sliceHandle`    | `string`                                          | Yes      | Slice handle used during the task         |
| `usefulSymbols`  | `string[]`                                        | Yes      | Symbol IDs that were useful (min: 1)      |
| `missingSymbols` | `string[]`                                        | No       | Symbol IDs that were expected but missing |
| `taskTags`       | `string[]`                                        | No       | Tags describing the task type             |
| `taskType`       | `"debug" \| "review" \| "implement" \| "explain"` | No       | Type of task performed                    |
| `taskText`       | `string`                                          | No       | Task description for context              |

**Response:** `{ ok: boolean, feedbackId: integer, repoId, versionId, symbolsRecorded: integer }`

**Example:**

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

---

### `sdl.agent.feedback.query`

Query stored feedback records and aggregated statistics. Useful for offline tuning pipelines to understand which symbols are consistently useful or missing.

**Parameters:**

| Parameter   | Type      | Required | Description                           |
| ----------- | --------- | -------- | ------------------------------------- |
| `repoId`    | `string`  | Yes      | Repository identifier                 |
| `versionId` | `string`  | No       | Filter by version                     |
| `limit`     | `integer` | No       | Max records to return (1-1000)        |
| `since`     | `string`  | No       | ISO timestamp to filter feedback from |

**Response includes:**

- `feedback` — array of records (feedbackId, versionId, sliceHandle, usefulSymbols, missingSymbols, taskTags, taskType, taskText, createdAt)
- `aggregatedStats` — totalFeedback, topUsefulSymbols (symbolId + count), topMissingSymbols (symbolId + count)
- `hasMore` — pagination flag

**Examples:**

```json
{ "repoId": "my-repo", "versionId": "v1770600000000", "limit": 50 }
```

```json
{ "repoId": "my-repo", "since": "2026-01-01T00:00:00Z", "limit": 100 }
```

---

## File Access (2 tools)

### `sdl.file.read`

Read non-indexed files (templates, configs, docs, YAML, SQL, etc.) with optional line range, regex search, or JSON path extraction. Returns content directly without runtime execution overhead.

| Parameter       | Type     | Required | Description                                                                                |
| --------------- | -------- | -------- | ------------------------------------------------------------------------------------------ |
| `repoId`        | `string` | Yes      | Repository identifier                                                                      |
| `filePath`      | `string` | Yes      | Path relative to repo root                                                                 |
| `maxBytes`      | `number` | No       | Max bytes to read (default 512KB)                                                          |
| `offset`        | `number` | No       | Start line (0-based)                                                                       |
| `limit`         | `number` | No       | Max lines to return. In search mode this caps returned match/context lines after scanning. |
| `search`        | `string` | No       | Regex pattern (case-insensitive)                                                           |
| `searchContext` | `number` | No       | Context lines around matches (default 2)                                                   |
| `jsonPath`      | `string` | No       | Dot-separated key path for JSON extraction (YAML accepted only if JSON-compatible)         |

**Blocked extensions:** Indexed source files (.ts, .js, .py, .go, .rs, etc.) are rejected with guidance to use SDL code tools.

**Modes:**

- **Line range**: `offset` + `limit` — returns numbered lines
- **Search**: `search` — scans the file (or from `offset`) and returns matching lines with context, matches prefixed with `>`. `limit` caps returned lines; it does not limit the scanned window.
- **JSON path**: `jsonPath` — parses JSON and returns extracted subtree
- **Full read**: no params — returns entire file (subject to `maxBytes`)

### `sdl.file.write`

Write non-indexed files using targeted update modes. This action is also available from the CLI as `sdl-mcp tool file.write`.

| Parameter         | Type                                | Required | Description                                                              |
| ----------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------ |
| `repoId`          | `string`                            | Yes      | Repository identifier                                                    |
| `filePath`        | `string`                            | Yes      | Path relative to repo root                                               |
| `content`         | `string`                            | No       | Full create or overwrite content                                         |
| `replaceLines`    | `{ start, end, content }`           | No       | Replace a line range                                                     |
| `replacePattern`  | `{ pattern, replacement, global? }` | No       | Regex-based replacement                                                  |
| `jsonPath`        | `string`                            | No       | Dot-separated JSON key path                                              |
| `jsonValue`       | `unknown`                           | No       | New value for `jsonPath`                                                 |
| `insertAt`        | `{ line, content }`                 | No       | Insert content at a specific line                                        |
| `append`          | `string`                            | No       | Append content to the end of the file                                    |
| `createBackup`    | `boolean`                           | No       | Create a `.bak` file before modifying an existing file (default: `true`) |
| `createIfMissing` | `boolean`                           | No       | Create the file when it does not exist                                   |

Provide exactly one write mode: `content`, `replaceLines`, `replacePattern`, `jsonPath`, `insertAt`, or `append`.

For search-edit previews, copy `applyArgs` from the preview when using `sdl.search.edit`. With `sdl.file`, apply using `{ "op": "searchEditApply", "planHandle": preview.planHandle, "createBackup": preview.defaultCreateBackup }` so the backup policy matches the reviewed plan.

**Response includes:**

- `filePath`, `bytesWritten`, `linesWritten`, `mode`
- `backupPath` when backup creation is enabled
- `replacementCount` for pattern-replace operations
- `indexUpdate` when SDL-MCP can live-sync an indexed source file after the write

See [file.write Tool Reference](./file-write-tool.md) for the mode-by-mode guide.

---

## Runtime Execution (2 tools)

### `sdl.runtime.execute`

Run a command in a repo-scoped subprocess. Runtime execution is enabled by default; set `runtime.enabled: false` to disable it.

**Parameters:**

| Parameter            | Type                                     | Required | Description                                                                                                                                                                                       |
| -------------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoId`             | `string`                                 | Yes      | Repository identifier                                                                                                                                                                             |
| `runtime`            | `string`                                 | Yes      | Runtime environment. Supported: `node`, `typescript`, `python`, `shell`, `powershell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp`                               |
| `executable`         | `string`                                 | No       | Custom executable path                                                                                                                                                                            |
| `args`               | `string[]`                               | No       | Command arguments (max 100)                                                                                                                                                                       |
| `code`               | `string`                                 | No       | Inline code to execute (max 1 MB)                                                                                                                                                                 |
| `stdin`              | `string`                                 | No       | UTF-8 text written to the child process stdin, then closed. Max 512 KiB by encoded byte size.                                                                                                     |
| `relativeCwd`        | `string`                                 | No       | Working directory relative to repo root (default: `"."`)                                                                                                                                          |
| `timeoutMs`          | `integer`                                | No       | Timeout in milliseconds (100-300,000)                                                                                                                                                             |
| `queryTerms`         | `string[]`                               | No       | Filter output to lines matching these terms (max 10)                                                                                                                                              |
| `maxResponseLines`   | `integer`                                | No       | Max output lines returned (5-1,000, default: 100)                                                                                                                                                 |
| `persistOutput`      | `boolean`                                | No       | Save full output to an artifact handle (default: true)                                                                                                                                            |
| `outputMode`         | `"minimal"` \| `"summary"` \| `"intent"` | No       | Controls response verbosity. `"minimal"` (default): status, artifact handle, and concise stdout/stderr previews. `"summary"`: head+tail excerpts. `"intent"`: only `queryTerms`-matched excerpts. |
| `includeDiagnostics` | `boolean`                                | No       | Include coarse policy, execution, output decoding, and artifact phase timings                                                                                                                     |

Use `stdin` for multiline scripts/input instead of shell quoting or base64 workarounds. SDL-MCP reports `stdinBytes` and `stdinSha256` but does not echo full stdin in visible output or persisted logs. `stdin` does not bypass command validation: the shell runtime still requires `code`. Use `code` for inline snippets or `args` for invoking files/commands. Default Node `code` snippets resolve relative imports from the requested working directory without repo-local temp files. When Node `code` also needs user `stdin`, SDL-MCP runs a temp `.mjs` from the OS temp directory so stdin remains available to the child process. On Windows shell runtime, use `&` or newlines rather than semicolons for command separation; SDL-MCP surfaces a warning when semicolons appear in shell code. Predictable failures can include compact `runtimeHints`, such as using ESM imports instead of `require()` or avoiding Bash syntax under Windows `cmd.exe`. `queryTerms` acts like a built-in grep, extracting only matching lines from long output.

**Response** varies by `outputMode`:

- **All modes:** `status`, `exitCode`, `signal`, `durationMs`, `artifactHandle`, `truncation`, `policyDecision`, `diagnostics?`, plus `stdinBytes`/`stdinSha256` when stdin was provided, `quotingWarnings` when risky quoting patterns are detected, and `runtimeHints` for compact corrective guidance
- **`"minimal"` (default):** returns concise `stdoutPreview` and short `stderrSummary` when output is small enough to show inline. Use `sdl.runtime.queryOutput` to search the artifact for full output.
- **`"summary"`:** adds `stdoutSummary`, `stderrSummary`, `excerpts`, `truncation` (legacy behavior)
- **`"intent"`:** adds `excerpts`, `truncation` — only `queryTerms`-matched windows, no head/tail summary

> Per-line truncation: all modes enforce a 500-character per-line cap.

**Example:**

```json
{
  "repoId": "my-repo",
  "runtime": "node",
  "args": ["--test", "tests/auth.test.ts"],
  "outputMode": "minimal",
  "timeoutMs": 30000
}
```

---

### `sdl.runtime.queryOutput`

Retrieve and search stored runtime output artifacts on demand. Companion to `outputMode: "minimal"`.

**Parameters:**

| Parameter        | Type                                 | Required | Description                                     |
| ---------------- | ------------------------------------ | -------- | ----------------------------------------------- |
| `artifactHandle` | `string`                             | Yes      | Handle returned by `sdl.runtime.execute`        |
| `queryTerms`     | `string[]`                           | Yes      | Keywords to search for in the output            |
| `maxExcerpts`    | `integer`                            | No       | Max excerpt windows to return (default: 10)     |
| `contextLines`   | `integer`                            | No       | Lines of context around each match (default: 3) |
| `stream`         | `"stdout"` \| `"stderr"` \| `"both"` | No       | Which stream(s) to search (default: `"both"`)   |

**Response:** `{ artifactHandle, excerpts[], totalLines, totalBytes, searchedStreams[] }`

Each excerpt: `{ lineStart, lineEnd, content, source }`

**Example:**

```json
{
  "artifactHandle": "runtime-my-repo-1774356909696-fc5aa1f22e33e17c",
  "queryTerms": ["FAIL", "Error"],
  "maxExcerpts": 5,
  "contextLines": 3
}
```

---

## Development Memories (4 tools)

> **Note:** Memory tools are only available when memory is enabled in the configuration (`"memory": { "enabled": true }`). When disabled (the default), these tools return a clear error. See the [Enabling Memory](./feature-deep-dives/development-memories.md#enabling-memory) section.

### `sdl.memory.store`

Store or update a development memory with optional symbol and file links. Memories persist across sessions and are surfaced in relevant slices when memory is enabled.

**Parameters:**

| Parameter      | Type                                                                                                                     | Required | Description                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------- |
| `repoId`       | `string`                                                                                                                 | Yes      | Repository identifier            |
| `type`         | `"decision" \| "bugfix" \| "task_context" \| "pattern" \| "convention" \| "architecture" \| "performance" \| "security"` | Yes      | Memory type                      |
| `title`        | `string`                                                                                                                 | Yes      | Short title (1-120 chars)        |
| `content`      | `string`                                                                                                                 | Yes      | Memory content (1-50,000 chars)  |
| `tags`         | `string[]`                                                                                                               | No       | Categorization tags (max 20)     |
| `confidence`   | `number`                                                                                                                 | No       | Confidence score (0-1)           |
| `symbolIds`    | `string[]`                                                                                                               | No       | Link memory to symbols (max 100) |
| `fileRelPaths` | `string[]`                                                                                                               | No       | Link memory to files (max 100)   |
| `memoryId`     | `string`                                                                                                                 | No       | Existing memory ID for upsert    |

Content-addressed deduplication prevents duplicate memories — if the same `repoId + type + title + content` hash already exists, the existing memory is returned.

**Response:** `{ ok: boolean, memoryId: string, created: boolean, deduplicated?: boolean }`

**Example:**

```json
{
  "repoId": "my-repo",
  "type": "bugfix",
  "title": "Race condition in authenticate()",
  "content": "The authenticate() function was not awaiting the token refresh promise, causing intermittent failures under concurrent requests.",
  "symbolIds": ["<symbol-id>"],
  "tags": ["auth", "concurrency"],
  "confidence": 0.9
}
```

---

### `sdl.memory.query`

Search and filter memories by text, type, tags, or linked symbols.

**Parameters:**

| Parameter   | Type                                           | Required | Description                                              |
| ----------- | ---------------------------------------------- | -------- | -------------------------------------------------------- |
| `repoId`    | `string`                                       | Yes      | Repository identifier                                    |
| `query`     | `string`                                       | No       | Full-text search query (max 1,000 chars)                 |
| `types`     | `("decision" \| "bugfix" \| "task_context")[]` | No       | Filter by memory types                                   |
| `tags`      | `string[]`                                     | No       | Filter by tags (max 20)                                  |
| `symbolIds` | `string[]`                                     | No       | Filter by linked symbols (max 100)                       |
| `staleOnly` | `boolean`                                      | No       | Return only stale memories (linked symbols have changed) |
| `limit`     | `integer`                                      | No       | Max results (1-100)                                      |
| `sortBy`    | `"recency" \| "confidence"`                    | No       | Sort order                                               |

**Response:** `{ memories: Memory[], total: number }`

**Examples:**

```json
{ "repoId": "my-repo", "query": "auth token", "limit": 10 }
```

```json
{ "repoId": "my-repo", "staleOnly": true, "sortBy": "recency" }
```

---

### `sdl.memory.remove`

Soft-delete a memory from the graph. Optionally also removes the `.sdl-memory/` file from disk.

**Parameters:**

| Parameter    | Type      | Required | Description                                     |
| ------------ | --------- | -------- | ----------------------------------------------- |
| `repoId`     | `string`  | Yes      | Repository identifier                           |
| `memoryId`   | `string`  | Yes      | Memory ID to remove                             |
| `deleteFile` | `boolean` | No       | Also delete the backing `.sdl-memory/*.md` file |

**Response:** `{ ok: boolean, memoryId: string, fileDeleted?: boolean }`

**Example:**

```json
{ "repoId": "my-repo", "memoryId": "<memory-id>", "deleteFile": true }
```

---

### `sdl.memory.surface`

Auto-surface memories relevant to a set of symbols or task type. Memories are ranked by `confidence × recencyFactor × overlapFactor`.

**Parameters:**

| Parameter   | Type                                       | Required | Description                                    |
| ----------- | ------------------------------------------ | -------- | ---------------------------------------------- |
| `repoId`    | `string`                                   | Yes      | Repository identifier                          |
| `symbolIds` | `string[]`                                 | No       | Symbols to find related memories for (max 500) |
| `taskType`  | `"decision" \| "bugfix" \| "task_context"` | No       | Filter by memory type                          |
| `limit`     | `integer`                                  | No       | Max memories to return (1-50)                  |

**Response:** `{ memories: SurfacedMemory[], total: number }`

Each `SurfacedMemory` includes the memory content plus a `score` field showing the ranking value and a `matchedSymbols` field showing which of the queried symbols matched.

**Example:**

```json
{
  "repoId": "my-repo",
  "symbolIds": ["<symbol-id-1>", "<symbol-id-2>"],
  "limit": 5
}
```

---

## Usage Statistics (1 tool)

### `sdl.usage.stats`

Get cumulative token usage statistics and savings metrics for the current session and/or historical sessions.

**Parameters:**

| Parameter | Type                               | Required | Description                                   |
| --------- | ---------------------------------- | -------- | --------------------------------------------- |
| `repoId`  | `string`                           | No       | Repository identifier (omit for global stats) |
| `scope`   | `"session" \| "history" \| "both"` | No       | Stats scope (default: `"both"`)               |
| `persist` | `boolean`                          | No       | Whether to persist current session stats      |
| `since`   | `string`                           | No       | ISO timestamp to filter historical stats from |
| `limit`   | `integer`                          | No       | Max historical entries to return (1-100)      |

**Response includes:**

- Token usage counters, savings estimates, and compression ratios
- `savedTokens` and `overallSavingsPercent` may be negative when SDL overhead exceeds the raw-equivalent estimate for that workload
- Per-tool breakdowns when available
- Session-scoped and/or historical aggregations depending on `scope`

**Example:**

```json
{ "repoId": "my-repo" }
```

```json
{ "repoId": "my-repo", "scope": "session" }
```

---

## Code Mode (6 tools)

### `sdl.context`

Retrieve task-shaped context inside Code Mode.

Use `sdl.context` first for `debug`, `review`, `implement`, and `explain` requests when you are already operating through the Code Mode surfaces. Its public schema exposes the complete nested `budget` and `options` contracts plus `refsMode`, `wireFormat`, and `ifNoneMatch`.

### `sdl.workflow`

Execute a multi-step workflow of SDL-MCP actions and internal transforms in one round trip.

Use this for runtime execution, data shaping, batch mutations, and reusable multi-step pipelines. Do not use it for context retrieval; route that work to `sdl.context`. Set `includeDiagnostics: true` to include workflow phase timings.

### `sdl.retrieve`

Run one compact retrieval operation inside Code Mode.

Use it when you need a single manual-ladder step without building a workflow. The public `args` schema exposes one authoritative variant for each supported operation: `symbolSearch`, `symbolGetCard`, `sliceBuild`, `codeSkeleton`, `codeHotPath`, and `codeNeedWindow`. The `sliceBuild` variant accepts `budget.maxCards` and `budget.maxEstimatedTokens`, not `budget.maxTokens`. `responseMode: "auto"` or `"handle"` can keep large code-window responses handle-backed.

### `sdl.manual`

Return a compact API reference for the SDL action surface.

Use this before `sdl.context` or `sdl.workflow` when the model needs a narrow, typed subset of the API instead of the full tool surface. Focused `actions` lookups return known selectors even when the request includes stale names; ignored selectors appear in `unknownActions` and `warning`.

### `sdl.file`

Provide a unified Code Mode file gateway for read, write, search/edit preview/apply, symbol edit preview/apply/applyNow, and plan-bound `previewWindow`/`sourceWindow` operations that route indexed source inspection through `code.needWindow` policy. Set `includeDiagnostics: true` to include file gateway phase timings.

---

## Tool-Usage Pattern for Agents

Use tools in this order for most tasks:

1. `sdl.repo.status` — check repo state and version
2. `sdl.context` — get task-shaped context first for explain/debug/review/implement/understand/investigate work when Code Mode is available
3. `sdl.retrieve` — run one exact retrieval step from Code Mode when task-shaped context is too broad
4. `sdl.symbol.search` — find exact symbols or APIs (start with tight limits)
5. `sdl.symbol.getCard` — understand what symbols do; batch through the same tool when you already have many IDs or refs
6. `sdl.slice.build` — get related symbols when you need a dependency frontier, likely files, blast radius, or edit-planning set
7. `sdl.repo.overview` — understand repo shape, directories, stats, or hotspots when task-shaped context is not the right surface
8. `sdl.code.getSkeleton` — see code structure without full bodies
9. `sdl.code.getHotPath` — find specific identifiers in code
10. `sdl.code.needWindow` — raw code only when necessary
11. `sdl.agent.feedback` — record useful/missing symbols when a slice-backed task produced durable training signal
12. `sdl.memory.store` — persist important decisions, bugfixes, or context for future sessions (requires memory enabled in config)

### Task-Specific Workflows

| Task                         | Workflow                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| **Explain / Debug / Review** | `sdl.context` first in Code Mode -> exact symbol or hot-path follow-up only if still ambiguous |
| **Debug (frontier/manual)**  | `slice.build` with `taskText` + `stackTrace` when you need related files -> hotPath -> needWindow with `sliceContext` |
| **Feature**                  | `sdl.context` for task-shaped understanding -> exact symbol/card or slice frontier before editing |
| **PR Review**                | delta.get -> pr.risk.analyze -> card/hotPath for high-risk symbols                      |
| **Cross-session**            | memory.surface -> slice.build -> work -> memory.store only for durable decisions/context |

---

## HTTP Surface (Non-MCP)

When serving with `sdl-mcp serve --http`, these non-MCP endpoints are available for graph/IDE integrations:

- `/ui/viewer` (SDL Galaxy; `/ui/graph` redirects here)
- `/api/graph/universe`
- `/api/graph/repo/:repoId/clusters`
- `/api/graph/repo/:repoId/layout`
- `/api/graph/repo/:repoId/edges`
- `/api/graph/repo/:repoId/search`
- `/api/graph/repo/:repoId/symbol/:symbolId/card`
- `/api/graph/repo/:repoId/impact`
- `/api/graph/events/recent`
- `/api/graph/skins` and `/api/graph/skins/:id`
- Deprecated legacy graph endpoints: `/api/graph/:repoId/slice/:handle`, `/api/graph/:repoId/symbol/:symbolId/neighborhood`, `/api/graph/:repoId/blast-radius/:fromVersion/:toVersion`
- `/api/symbol/:repoId/search`
- `/api/symbol/:repoId/card/:symbolId`
- `/api/repo/:repoId/status`
- `/api/repo/:repoId/reindex`
