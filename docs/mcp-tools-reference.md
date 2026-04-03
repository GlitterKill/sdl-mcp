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

- `32` flat SDL action tools (`31` gateway-routable + `1` flat-only)
- `2` universal tools: `sdl.action.search` and `sdl.info`
- optional Code Mode-only tools: `sdl.manual`, `sdl.context`, and `sdl.workflow`

Flat mode, gateway mode, and the CLI `tool` command all route into the same handler layer.

Parameter normalization is shared across flat and gateway calls. SDL-MCP accepts canonical camelCase fields plus common public aliases such as `repo_id`, `root_path`, `symbol_id`, `symbol_ids`, `from_version`, `to_version`, `slice_handle`, `spillover_handle`, `if_none_match`, `known_etags`, `known_card_etags`, `edited_files`, `entry_symbols`, and `relative_cwd`.

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Search query |
| `limit` | `integer` | No | Max results to return (1-50, default: 10) |
| `offset` | `integer` | No | Skip the first N ranked results (min: 0) |
| `includeSchemas` | `boolean` | No | Include compact schema summaries |
| `includeExamples` | `boolean` | No | Include example calls |

**Response:** `{ actions, total, hasMore, offset, limit, tokenEstimate }`

Use `offset` with `limit` to page through large result sets such as `query: "*"`.

---

## Repository and Indexing (4 tools)

### `sdl.repo.register`

Register a new repository for indexing.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Unique identifier for the repository |
| `rootPath` | `string` | Yes | Absolute path to repository root |
| `ignore` | `string[]` | No | Glob patterns for files/dirs to ignore |
| `languages` | `string[]` | No | Language filter (e.g., `["typescript", "javascript"]`) |
| `maxFileBytes` | `integer` | No | Max file size to index (min: 1) |

**Response:** `{ ok: boolean, repoId: string }`

**Example:**

```json
{
  "repoId": "my-repo",
  "rootPath": "/workspace/my-repo",
  "ignore": ["node_modules", "dist"],
  "languages": ["typescript", "javascript"]
}
```

---

### `sdl.repo.status`

Get status for one repository including latest version, indexed files/symbols, timestamps, health, watcher telemetry, and prefetch statistics.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `surfaceMemories` | `boolean` | No | Include relevant development memories (default: `false`) |

**Response includes:**

- `repoId`, `rootPath`, `latestVersionId`, `filesIndexed`, `symbolsIndexed`, `lastIndexedAt`
- `healthScore` (0-100), `healthComponents` (freshness, coverage, errorRate, edgeQuality, callResolution), `healthAvailable`
- `watcherHealth` (nullable) — runtime telemetry: enabled, running, filesWatched, eventsReceived/Processed, errors, queueDepth, restartCount, stale, lastEventAt, lastSuccessfulReindexAt
- `prefetchStats` — queue depth, hit/waste rates, latency reduction, last run
- `liveIndexStatus` — live buffer overlay state: enabled, pendingBuffers, dirtyBuffers, parseQueueDepth, checkpointPending, reconcileQueueDepth, etc.
- `memories` (when `surfaceMemories: true` and memory is enabled in config) — array of relevant development memories auto-surfaced for the repository

**Example:**

```json
{ "repoId": "my-repo" }
```

---

### `sdl.index.refresh`

Refresh the symbol index in `incremental` or `full` mode.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `mode` | `"full" \| "incremental"` | Yes | Refresh mode |
| `reason` | `string` | No | Human-readable reason for the refresh |
| `includeDiagnostics` | `boolean` | No | When `true`, include coarse phase timings in the synchronous response |
| `async` | `boolean` | No | When `true`, start indexing in the background and return an `operationId` immediately |

**Response:** `{ ok: boolean, repoId: string, versionId?: string, changedFiles?: integer, async?: boolean, operationId?: string, message?: string, diagnostics?: { timings: { totalMs: number, phases: Record<string, number> } } }`

In incremental mode, files whose modification time predates their last indexed timestamp are skipped. If no tracked files changed, the existing version is reused instead of creating an empty snapshot and the refresh can short-circuit after `scanRepo`, `versioning`, and `memorySync`.

When called with a progress token, the server emits `notifications/progress` messages with the current stage, file path, and completion percentage.

`diagnostics.timings` is only returned for synchronous requests with `includeDiagnostics: true`. `diagnostics.timings.phases` may include nested subphases such as `initSharedState.tsResolver`, `initSharedState.tsResolver.sourceFiles`, `initSharedState.tsResolver.programBuild`, `initSharedState.symbolMaps`, `resolveUnresolvedImports.fetchEdges`, `finalizeEdges.cleanupUnresolvedBuiltins`, `finalizeEdges.insertConfigEdges`, `finalizeIndexing.metrics`, `finalizeIndexing.metrics.testRefs`, `finalizeIndexing.fileSummaries`, `clustersAndProcesses.loadSymbols`, and `clustersAndProcesses.processWrite`. No-op incremental refreshes may omit later phases entirely and report a `shortCircuitNoOp` phase instead.

**Example:**

```json
{ "repoId": "my-repo", "mode": "incremental", "reason": "post-edit refresh", "includeDiagnostics": true }
```

---

### `sdl.repo.overview`

Return a token-efficient repository overview with directory summaries and hotspots.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `level` | `"stats" \| "directories" \| "full"` | Yes | Detail level |
| `includeHotspots` | `boolean` | No | Include codebase hotspots (auto-enabled at `"full"` level) |
| `directories` | `string[]` | No | Filter to specific directories |
| `maxDirectories` | `integer` | No | Max directories to return (1-200) |
| `maxExportsPerDirectory` | `integer` | No | Max exports per directory (1-50) |

Start with `level: "stats"` (cheapest). Escalate to `"directories"` or `"full"` only when needed. `level: "full"` auto-enables hotspots unless `includeHotspots: false` is set.

**Response includes:**

- `stats` — fileCount, symbolCount, edgeCount, exportedSymbolCount, byKind, byEdgeType, avgSymbolsPerFile, avgEdgesPerSymbol
- `directories` — array of summaries with path, fileCount, symbolCount, exports, topByFanIn, topByChurn
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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `eventType` | `"open" \| "change" \| "save" \| "close" \| "checkpoint"` | Yes | Buffer lifecycle event |
| `filePath` | `string` | Yes | Repository-relative file path |
| `content` | `string` | Yes | Current buffer contents |
| `language` | `string` | No | Explicit language hint |
| `version` | `integer` | Yes | Monotonic buffer version |
| `dirty` | `boolean` | Yes | Whether the buffer has unsaved edits |
| `timestamp` | `string` | Yes | ISO timestamp for the event |
| `cursor` | `object` | No | Cursor position (`{ line, character }`) |
| `selections` | `object[]` | No | Active selections (`[{ start, end }]`) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `reason` | `string` | No | Human-readable checkpoint reason |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |

**Response includes:**

- `enabled`, `pendingBuffers`, `dirtyBuffers`, `parseQueueDepth`
- `checkpointPending`, `lastBufferEventAt`, `lastCheckpointAt`
- `reconcileQueueDepth`, `lastReconciledAt`, `reconcileInflight`

**Example:**

```json
{ "repoId": "my-repo" }
```

---

## Symbol Discovery (4 tools)

### `sdl.symbol.search`

Search symbols by name or summary text.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `query` | `string` | Yes | Search query (min length: 1) |
| `kinds` | `string[]` | No | Filter by symbol kind (e.g., `["function", "class"]`) |
| `limit` | `integer` | No | Max results (1-1000, default: 50) |
| `semantic` | `boolean` | No | Enable semantic reranking / hybrid retrieval |
| `includeRetrievalEvidence` | `boolean` | No | Include retrieval evidence (sources, candidate counts, latency, fallback reason) |

When semantic mode is enabled, the retrieval path depends on `semantic.retrieval.mode`: `"hybrid"` uses FTS + vector search with RRF fusion; `"legacy"` uses alpha-blended lexical + embedding reranking. Falls back to legacy automatically if hybrid indexes are unavailable.

**Response:** `{ results: [{ symbolId, name, file, kind }], retrievalMode?, retrievalEvidence?, truncation? }`

**Examples:**

```json
{ "repoId": "my-repo", "query": "parseConfig", "limit": 20 }
```

```json
{ "repoId": "my-repo", "query": "auth token refresh", "limit": 20, "semantic": true }
```

---

### `sdl.symbol.getCard`

Fetch a single symbol card by ID or natural reference with ETag support.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolId` | `string` | Conditional | Symbol identifier |
| `symbolRef` | `{ name, file?, kind?, exportedOnly? }` | Conditional | Natural symbol reference. Use this when you know the symbol name and optionally the file or kind. |
| `ifNoneMatch` | `string` | No | ETag for conditional fetch (returns `notModified` if unchanged) |
| `minCallConfidence` | `number` | No | Filter call edges below this confidence threshold (0-1) |
| `includeResolutionMetadata` | `boolean` | No | Include call resolution strategy and provenance in edge data |

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

### `sdl.symbol.getCards`

Batch fetch up to 100 symbol cards in a single round trip. Prefer this over multiple sequential `sdl.symbol.getCard` calls when you already have a list of symbol IDs or natural symbol references.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolIds` | `string[]` | Conditional | Array of symbol IDs (1-100) |
| `symbolRefs` | `Array<{ name, file?, kind?, exportedOnly? }>` | Conditional | Array of natural symbol references (1-100) |
| `knownEtags` | `Record<string, string>` | No | Map of symbolId to known ETag; matching symbols return `notModified` |
| `minCallConfidence` | `number` | No | Filter call edges below this confidence threshold (0-1) |
| `includeResolutionMetadata` | `boolean` | No | Include call resolution strategy and provenance in edge data |

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

### `sdl.context.summary`

Generate a token-bounded context summary for a symbol, file, or task query. Useful for getting a quick overview of relevant symbols, dependencies, and risk areas without building a full slice.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `query` | `string` | Yes | Search query (min length: 1) |
| `budget` | `integer` | No | Max tokens for the summary (min: 1) |
| `format` | `"markdown" \| "json" \| "clipboard"` | No | Output format |
| `scope` | `"symbol" \| "file" \| "task"` | No | Query scope |

**Response includes:**

- `summary` — keySymbols, dependencyGraph, riskAreas, filesTouched, metadata (query, summaryTokens, budget, truncated, indexVersion)
- `content` — formatted summary string in the requested format

**Example:**

```json
{
  "repoId": "my-repo",
  "query": "auth middleware",
  "budget": 2000,
  "format": "markdown",
  "scope": "task"
}
```

---

## Graph Slice Workflows (3 tools)

### `sdl.slice.build`

Build a task-scoped graph slice. `taskText` alone is sufficient — it triggers auto-discovery of relevant symbols via full-text search in a single round trip. Adding `entrySymbols` improves precision.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `taskText` | `string` | No | Natural language task description (auto-discovers symbols via hybrid retrieval or legacy full-text search) |
| `entrySymbols` | `string[]` | No | Symbol IDs to start the slice from |
| `editedFiles` | `string[]` | No | Files whose symbols (+ callers) are forced into the slice |
| `stackTrace` | `string` | No | Stack trace to bias toward call-path symbols |
| `failingTestPath` | `string` | No | Failing test file to bias toward code under test |
| `budget` | `{ maxCards?, maxEstimatedTokens? }` | No | Token/card budget constraints |
| `minConfidence` | `number` | No | Edge confidence threshold (0-1, default: 0.5) |
| `knownCardEtags` | `Record<string, string>` | No | ETags for cards already held; unchanged return as `cardRefs` |
| `cardDetail` | `"minimal" \| "signature" \| "deps" \| "compact" \| "full"` | No | Card detail level (leave unset for mixed) |
| `adaptiveDetail` | `boolean` | No | Enable adaptive detail level selection |
| `wireFormat` | `"standard" \| "readable" \| "compact" \| "agent"` | No | Wire format (default: compact) |
| `wireFormatVersion` | `1 \| 2 \| 3` | No | Wire format version (default: 2) |
| `minCallConfidence` | `number` | No | Filter call edges below this confidence threshold (0-1) |
| `includeResolutionMetadata` | `boolean` | No | Include call resolution metadata in edge data |
| `includeMemories` | `boolean` | No | Include related development memories in the response (only effective when memory is enabled in config) |
| `memoryLimit` | `integer` | No | Max memories to include (default: 5) |
| `includeRetrievalEvidence` | `boolean` | No | Include retrieval evidence (sources, candidate counts, symptom type, fusion latency, fallback reason) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sliceHandle` | `string` | Yes | Handle from a previous `sdl.slice.build` |
| `knownVersion` | `string` | Yes | Version ID the client currently holds |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `spilloverHandle` | `string` | Yes | Spillover handle from a truncated slice |
| `cursor` | `string` | No | Pagination cursor from previous page |
| `pageSize` | `integer` | No | Items per page (1-100, default: 20) |

**Response:** `{ spilloverHandle, cursor?, hasMore, symbols: SymbolCard[] }`

**Example:**

```json
{ "spilloverHandle": "sp_abc123", "pageSize": 20 }
```

---

## Delta and Risk (2 tools)

### `sdl.delta.get`

Compute a delta pack between two ledger versions, showing changed symbols and blast radius.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `fromVersion` | `string` | Yes | Base version ID |
| `toVersion` | `string` | Yes | Target version ID |
| `budget` | `{ maxCards?, maxEstimatedTokens? }` | No | Budget to constrain blast-radius work |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `fromVersion` | `string` | Yes | Base version ID |
| `toVersion` | `string` | Yes | Target version ID |
| `riskThreshold` | `integer` | No | Risk threshold 0-100 (raise to focus on highest-risk changes) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolId` | `string` | No* | Symbol to get skeleton for |
| `file` | `string` | No* | File path to get skeleton for |
| `exportedOnly` | `boolean` | No | Only show exported symbols (file mode) |
| `maxLines` | `integer` | No | Max output lines (min: 1) |
| `maxTokens` | `integer` | No | Max output tokens (min: 1) |
| `identifiersToFind` | `string[]` | No | Highlight specific identifiers |
| `skeletonOffset` | `integer` | No | Resume from a previous truncation point (line offset, min: 0) |

*Either `symbolId` or `file` must be provided.

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolId` | `string` | Yes | Symbol to search within |
| `identifiersToFind` | `string[]` | Yes | Identifiers to locate (min: 1) |
| `contextLines` | `integer` | No | Lines of context around matches (default: 3, min: 0) |
| `maxLines` | `integer` | No | Max output lines (min: 1) |
| `maxTokens` | `integer` | No | Max output tokens (min: 1) |

The `matchedIdentifiers` field in the response contains only identifiers that were actually found in the AST, not the full request list.

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolId` | `string` | Yes | Symbol to get code for |
| `reason` | `string` | Yes | Justification for raw code access (min length: 1) |
| `expectedLines` | `integer` | Yes | Expected lines needed (min: 1, clamped to policy max: 180) |
| `identifiersToFind` | `string[]` | Yes | Identifiers expected in the code (required by policy) |
| `granularity` | `"symbol" \| "block" \| "fileWindow"` | No | Code extraction scope |
| `maxTokens` | `integer` | No | Max tokens (min: 1, clamped to policy max: 1400) |
| `sliceContext` | `object` | No | Slice context for approval scoring |

`sliceContext` fields: `taskText`, `stackTrace`, `failingTestPath`, `editedFiles`, `entrySymbols`, `budget`.

The `expectedLines` and `maxTokens` values are clamped to the effective policy limits, so requests exceeding policy caps are silently reduced rather than rejected.

Approval can proceed when one or more requested identifiers match the candidate window. Prefer a short list of precise identifiers instead of long all-or-nothing lists.

**Response (approved):** `{ approved: true, symbolId, file, range, code, whyApproved, estimatedTokens, downgradedFrom?, matchedIdentifiers?, matchedLineNumbers?, truncation? }`

**Response (denied):** `{ approved: false, whyDenied, suggestedNextRequest?, nextBestAction? }`

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `policyPatch` | `object` | Yes | Partial policy to apply |

`policyPatch` fields (all optional):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxWindowLines` | `integer` | 180 | Max lines per code window |
| `maxWindowTokens` | `integer` | 1400 | Max tokens per code window |
| `requireIdentifiers` | `boolean` | true | Require identifiersToFind in needWindow |
| `allowBreakGlass` | `boolean` | false | Allow break-glass override for denied requests |

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

## Agent Context and Feedback (3 tools)

### `sdl.agent.context`

Retrieve task-shaped code context with rung path selection and evidence capture. The planner selects an optimal path through the context ladder (card -> skeleton -> hotPath -> raw) based on the task type, budget, and context mode.

**Context modes:**

- **`"precise"`** — Returns minimal, chain-efficient context. Adaptive symbol selection (1 symbol per rung), stripped response envelope (no `actionsTaken`, `summary`, `answer`, `nextBestAction`). Designed to beat manual `sdl.workflow` on token efficiency.
- **`"broad"`** (default) — Returns richer surrounding context with adaptive selection based on task relevance. Full response envelope with diagnostics.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `taskType` | `"debug" \| "review" \| "implement" \| "explain"` | Yes | Type of task |
| `taskText` | `string` | Yes | Task description or prompt |
| `budget` | `object` | No | Budget constraints |
| `options` | `object` | No | Task-specific options |

`budget` fields (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `maxTokens` | `number` | Maximum tokens to consume |
| `maxActions` | `number` | Maximum number of actions to execute |
| `maxDurationMs` | `number` | Maximum duration in milliseconds |

`options` fields (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `contextMode` | `"precise" \| "broad"` | Context breadth. `"precise"` returns minimal context; `"broad"` (default) returns richer surrounding context |
| `focusSymbols` | `string[]` | Symbol IDs to focus on |
| `focusPaths` | `string[]` | File paths to focus on |
| `includeTests` | `boolean` | Include test files in analysis |
| `requireDiagnostics` | `boolean` | Include diagnostic info (may add a raw rung) |

**Response:**

In **broad** mode (default): `taskId`, `taskType`, `success`, `path`, `finalEvidence`, `metrics`, `summary`, `answer`, `actionsTaken`, `nextBestAction?`, `retrievalEvidence?`

In **precise** mode: `taskId`, `taskType`, `success`, `path`, `finalEvidence`, `metrics` — envelope fields stripped for token efficiency.

Planner token estimates: card ~50, skeleton ~200, hotPath ~500, raw ~2000. When over budget, the planner trims rungs from the end while keeping at least one.

When Code Mode is enabled, `sdl.context` accepts the same task envelope and should be preferred over `sdl.workflow` for `debug`, `review`, `implement`, and `explain` retrieval.

**Precise mode rung strategies:**

| Task Type | Precise Rungs | Broad Rungs |
|-----------|--------------|-------------|
| `debug` | card + hotPath | card + skeleton + hotPath |
| `explain` | card + skeleton | card + skeleton |
| `review` | card | card + skeleton |
| `implement` | card + skeleton | card + skeleton + hotPath |

**Examples:**

```json
{
  "repoId": "my-repo",
  "taskType": "debug",
  "taskText": "check NaN handling in normalizeEdgeConfidence",
  "budget": { "maxTokens": 4000 },
  "options": { "contextMode": "precise", "focusPaths": ["src/graph/slice/beam-search-engine.ts"] }
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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `versionId` | `string` | Yes | Version ID (from `sdl.repo.status`) |
| `sliceHandle` | `string` | Yes | Slice handle used during the task |
| `usefulSymbols` | `string[]` | Yes | Symbol IDs that were useful (min: 1) |
| `missingSymbols` | `string[]` | No | Symbol IDs that were expected but missing |
| `taskTags` | `string[]` | No | Tags describing the task type |
| `taskType` | `"debug" \| "review" \| "implement" \| "explain"` | No | Type of task performed |
| `taskText` | `string` | No | Task description for context |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `versionId` | `string` | No | Filter by version |
| `limit` | `integer` | No | Max records to return (1-1000) |
| `since` | `string` | No | ISO timestamp to filter feedback from |

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

## File Access (1 tool)

### `sdl.file.read`

Read non-indexed files (templates, configs, docs, YAML, SQL, etc.) with optional line range, regex search, or JSON path extraction. Returns content directly without runtime execution overhead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `filePath` | `string` | Yes | Path relative to repo root |
| `maxBytes` | `number` | No | Max bytes to read (default 512KB) |
| `offset` | `number` | No | Start line (0-based) |
| `limit` | `number` | No | Max lines to return |
| `search` | `string` | No | Regex pattern (case-insensitive) |
| `searchContext` | `number` | No | Context lines around matches (default 2) |
| `jsonPath` | `string` | No | Dot-separated key path for JSON extraction (YAML accepted only if JSON-compatible) |

**Blocked extensions:** Indexed source files (.ts, .js, .py, .go, .rs, etc.) are rejected with guidance to use SDL code tools.

**Modes:**
- **Line range**: `offset` + `limit` — returns numbered lines
- **Search**: `search` — returns matching lines with context, matches prefixed with `>`
- **JSON path**: `jsonPath` — parses JSON and returns extracted subtree
- **Full read**: no params — returns entire file (subject to `maxBytes`)

---

## Runtime Execution (2 tools)

### `sdl.runtime.execute`

Run a command in a repo-scoped subprocess. Runtime execution is enabled by default; set `runtime.enabled: false` to disable it.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `runtime` | `string` | Yes | Runtime environment. Supported: `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp` |
| `executable` | `string` | No | Custom executable path |
| `args` | `string[]` | No | Command arguments (max 100) |
| `code` | `string` | No | Inline code to execute (max 1 MB) |
| `relativeCwd` | `string` | No | Working directory relative to repo root (default: `"."`) |
| `timeoutMs` | `integer` | No | Timeout in milliseconds (100-300,000) |
| `queryTerms` | `string[]` | No | Filter output to lines matching these terms (max 10) |
| `maxResponseLines` | `integer` | No | Max output lines returned (10-1,000, default: 100) |
| `persistOutput` | `boolean` | No | Save full output to an artifact handle (default: true) |
| `outputMode` | `"minimal"` \| `"summary"` \| `"intent"` | No | Controls response verbosity. `"minimal"` (default): ~50 tokens, status + artifact handle only. `"summary"`: head+tail excerpts (legacy). `"intent"`: only `queryTerms`-matched excerpts. |

Use `code` for inline snippets or `args` for invoking files/commands. `queryTerms` acts like a built-in grep, extracting only matching lines from long output.

**Response** varies by `outputMode`:

- **All modes:** `status`, `exitCode`, `signal`, `durationMs`, `artifactHandle`, `policyDecision`
- **`"minimal"` (default):** adds `outputLines`, `outputBytes` — no stdout/stderr content. Use `sdl.runtime.queryOutput` to search the artifact.
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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `artifactHandle` | `string` | Yes | Handle returned by `sdl.runtime.execute` |
| `queryTerms` | `string[]` | Yes | Keywords to search for in the output |
| `maxExcerpts` | `integer` | No | Max excerpt windows to return (default: 10) |
| `contextLines` | `integer` | No | Lines of context around each match (default: 3) |
| `stream` | `"stdout"` \| `"stderr"` \| `"both"` | No | Which stream(s) to search (default: `"both"`) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `type` | `"decision" \| "bugfix" \| "task_context" \| "pattern" \| "convention" \| "architecture" \| "performance" \| "security"` | Yes | Memory type |
| `title` | `string` | Yes | Short title (1-120 chars) |
| `content` | `string` | Yes | Memory content (1-50,000 chars) |
| `tags` | `string[]` | No | Categorization tags (max 20) |
| `confidence` | `number` | No | Confidence score (0-1) |
| `symbolIds` | `string[]` | No | Link memory to symbols (max 100) |
| `fileRelPaths` | `string[]` | No | Link memory to files (max 100) |
| `memoryId` | `string` | No | Existing memory ID for upsert |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `query` | `string` | No | Full-text search query (max 1,000 chars) |
| `types` | `("decision" \| "bugfix" \| "task_context")[]` | No | Filter by memory types |
| `tags` | `string[]` | No | Filter by tags (max 20) |
| `symbolIds` | `string[]` | No | Filter by linked symbols (max 100) |
| `staleOnly` | `boolean` | No | Return only stale memories (linked symbols have changed) |
| `limit` | `integer` | No | Max results (1-100) |
| `sortBy` | `"recency" \| "confidence"` | No | Sort order |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `memoryId` | `string` | Yes | Memory ID to remove |
| `deleteFile` | `boolean` | No | Also delete the backing `.sdl-memory/*.md` file |

**Response:** `{ ok: boolean, memoryId: string, fileDeleted?: boolean }`

**Example:**

```json
{ "repoId": "my-repo", "memoryId": "<memory-id>", "deleteFile": true }
```

---

### `sdl.memory.surface`

Auto-surface memories relevant to a set of symbols or task type. Memories are ranked by `confidence × recencyFactor × overlapFactor`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | Yes | Repository identifier |
| `symbolIds` | `string[]` | No | Symbols to find related memories for (max 500) |
| `taskType` | `"decision" \| "bugfix" \| "task_context"` | No | Filter by memory type |
| `limit` | `integer` | No | Max memories to return (1-50) |

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | `string` | No | Repository identifier (omit for global stats) |
| `scope` | `"session" \| "history" \| "both"` | No | Stats scope (default: `"both"`) |
| `persist` | `boolean` | No | Whether to persist current session stats |
| `since` | `string` | No | ISO timestamp to filter historical stats from |
| `limit` | `integer` | No | Max historical entries to return (1-100) |

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

## Code Mode (4 tools)

### `sdl.context`

Retrieve task-shaped context inside Code Mode. Parameters and response shape mirror `sdl.agent.context`.

Use `sdl.context` first for `debug`, `review`, `implement`, and `explain` requests when you are already operating through the Code Mode surfaces.

### `sdl.workflow`

Execute a multi-step workflow of SDL-MCP actions and internal transforms in one round trip.

Use this for runtime execution, data shaping, batch mutations, and reusable multi-step pipelines. Do not use it for context retrieval; route that work to `sdl.context` or `sdl.agent.context`.

### `sdl.manual`

Return a compact API reference for the SDL action surface.

Use this before `sdl.context` or `sdl.workflow` when the model needs a narrow, typed subset of the API instead of the full tool surface.

---

## Tool-Usage Pattern for Agents

Use tools in this order for most tasks:

1. `sdl.repo.status` — check repo state and version
2. `sdl.repo.overview` — understand codebase structure (start with `level: "stats"`)
3. `sdl.symbol.search` — find relevant symbols (start with tight limits)
4. `sdl.agent.context` / `sdl.context` — get task-shaped context first for explain/debug/review/implement work
5. `sdl.symbol.getCard` / `sdl.symbol.getCards` — understand what symbols do
6. `sdl.slice.build` — get related symbols for a task (auto-surfaces relevant memories when memory is enabled)
7. `sdl.code.getSkeleton` — see code structure without full bodies
8. `sdl.code.getHotPath` — find specific identifiers in code
9. `sdl.code.needWindow` — raw code only when necessary
10. `sdl.agent.feedback` — record which symbols were useful after completing a task
11. `sdl.memory.store` — persist important decisions, bugfixes, or context for future sessions (requires memory enabled in config)

### Task-Specific Workflows

| Task | Workflow |
|------|----------|
| **Explain / Debug / Review** | `sdl.agent.context` or `sdl.context` first -> direct ladder follow-up only if still ambiguous |
| **Debug (manual)** | search -> card -> slice.build -> hotPath -> needWindow (if still ambiguous) |
| **Debug (auto)** | slice.build with `taskText` + `stackTrace` -> hotPath -> needWindow with `sliceContext` |
| **Feature** | repo.overview -> search -> card -> slice.build (use `editedFiles` for impact) |
| **PR Review** | delta.get -> pr.risk.analyze -> card/hotPath for high-risk symbols |
| **Cross-session** | memory.surface -> slice.build -> work -> memory.store when done |

---

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
