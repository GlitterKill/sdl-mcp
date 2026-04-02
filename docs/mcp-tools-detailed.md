# SDL-MCP Tools Reference (Detailed)

This document provides comprehensive documentation for every MCP tool exposed by SDL-MCP. Each entry covers what the tool does, its full parameter schema, response shape, and practical usage guidance.

Flat mode, gateway mode, and the CLI `tool` command share the same normalization path. In addition to canonical camelCase fields, common aliases such as `repo_id`, `root_path`, `symbol_id`, `symbol_ids`, `from_version`, `to_version`, `slice_handle`, `spillover_handle`, `if_none_match`, `known_etags`, `known_card_etags`, `edited_files`, `entry_symbols`, and `relative_cwd` are accepted before strict validation.

---

## Table of Contents

0. [Diagnostics](#0-diagnostics)
   - [sdl.info](#sdlinfo)
1. [Repository Management](#1-repository-management)
   - [sdl.repo.register](#sdlreporegister)
   - [sdl.repo.status](#sdlrepostatus)
   - [sdl.repo.overview](#sdlrepooverview)
   - [sdl.index.refresh](#sdlindexrefresh)
2. [Live Editor Buffer](#2-live-editor-buffer)
   - [sdl.buffer.push](#sdlbufferpush)
   - [sdl.buffer.checkpoint](#sdlbuffercheckpoint)
   - [sdl.buffer.status](#sdlbufferstatus)
3. [Symbol Search & Retrieval](#3-symbol-search--retrieval)
   - [sdl.symbol.search](#sdlsymbolsearch)
   - [sdl.symbol.getCard](#sdlsymbolgetcard)
   - [sdl.symbol.getCards](#sdlsymbolgetcards)
4. [Graph Slices](#4-graph-slices)
   - [sdl.slice.build](#sdlslicebuild)
   - [sdl.slice.refresh](#sdlslicerefresh)
   - [sdl.slice.spillover.get](#sdlslicespilloverget)
5. [Code Access (Iris Gate Ladder)](#5-code-access-iris-gate-ladder)
   - [sdl.code.getSkeleton](#sdlcodegetskeleton)
   - [sdl.code.getHotPath](#sdlcodegethotpath)
   - [sdl.code.needWindow](#sdlcodeneedwindow)
6. [File Access](#6-file-access)
   - [sdl.file.read](#sdlfileread)
7. [Delta & Change Tracking](#7-delta--change-tracking)
   - [sdl.delta.get](#sdldeltaget)
8. [Policy Management](#8-policy-management)
   - [sdl.policy.get](#sdlpolicyget)
   - [sdl.policy.set](#sdlpolicyset)
9. [PR & Risk Analysis](#9-pr--risk-analysis)
   - [sdl.pr.risk.analyze](#sdlprriskanalyze)
10. [Context Summary](#10-context-summary)
    - [sdl.context.summary](#sdlcontextsummary)
11. [Agent Context & Feedback](#11-agent-context--feedback)
    - [sdl.agent.context](#sdlagentcontext)
    - [sdl.agent.feedback](#sdlagentfeedback)
    - [sdl.agent.feedback.query](#sdlagentfeedbackquery)
12. [Runtime Execution](#12-runtime-execution)
    - [sdl.runtime.execute](#sdlruntimeexecute)
    - [sdl.runtime.queryOutput](#sdlruntimequeryoutput)
13. [Development Memories](#13-development-memories)
    - [sdl.memory.store](#sdlmemorystore)
    - [sdl.memory.query](#sdlmemoryquery)
    - [sdl.memory.remove](#sdlmemoryremove)
    - [sdl.memory.surface](#sdlmemorysurface)
14. [Usage Statistics](#14-usage-statistics)
    - [sdl.usage.stats](#sdlusagestats)
15. [Code Mode Tools](#15-code-mode-tools)
    - [sdl.context](#sdlcontext)
    - [sdl.workflow](#sdlworkflow)
    - [sdl.action.search](#sdlactionsearch)
    - [sdl.manual](#sdlmanual)

---

## 0. Diagnostics

### sdl.info

Returns a unified runtime and environment report for SDL-MCP.

**What it does:** Collects the same diagnostic view exposed by the CLI `sdl-mcp info` command. It reports the resolved config path, whether the config loaded, the active log file path, whether log-path fallback to a temp file is active, whether console mirroring is enabled, Ladybug availability, and the current Rust native-addon status.

**Parameters:** none

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `version` | string | SDL-MCP package version |
| `runtime` | object | `{node, platform, arch}` |
| `config` | object | `{path, exists, loaded}` |
| `logging` | object | `{path, consoleMirroring, fallbackUsed}` |
| `ladybug` | object | `{available, activePath}` |
| `native` | object | `{available, sourcePath, disabledByEnv, reason}` |
| `warnings` | string[] | Non-fatal environment warnings |
| `misconfigurations` | string[] | Actionable setup problems |

**Typical use:** Call this when startup, logging, DB, or native-addon behavior looks wrong and you need one consolidated environment snapshot.

---

## 1. Repository Management

### sdl.repo.register

Registers a new repository (or updates an existing one) for indexing. This is typically the first tool called when connecting a new codebase to SDL-MCP.

**What it does:** Creates a repository record in the graph database with the given configuration. Auto-detects `package.json`, `tsconfig.json`, and workspace configuration. Validates that the root path exists and is not a path-traversal attempt.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Unique identifier for the repository (e.g., `"my-app"`) |
| `rootPath` | string | Yes | Absolute path to the repository root directory |
| `ignore` | string[] | No | Glob patterns to ignore (defaults to `node_modules`, `dist`, `.next`, `build`) |
| `languages` | string[] | No | Language extensions to index. Defaults to all 12 languages (11 adapters): `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `java`, `cs`, `c`, `cpp`, `php`, `rs`, `kt`, `sh` |
| `maxFileBytes` | number | No | Maximum file size to index in bytes (default: 2,000,000) |

**Response:**

```json
{
  "ok": true,
  "repoId": "my-app"
}
```

**Notes:**
- Re-registering an existing `repoId` updates the configuration without losing indexed data.
- The tool does not trigger indexing. Call `sdl.index.refresh` afterward.

---

### sdl.repo.status

Returns the current indexing state and health metrics for a registered repository.

**What it does:** Queries the graph database for the repository's latest version, file count, symbol count, health score, watcher health, prefetch statistics, and live-index status. Provides a single-call snapshot of everything happening in the repository.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `surfaceMemories` | boolean | No | Include relevant development memories in the response (default: `false`) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `repoId` | string | Repository identifier |
| `rootPath` | string | Absolute path to the repository root |
| `latestVersionId` | string \| null | Most recent ledger version, or null if never indexed |
| `filesIndexed` | number | Total files currently tracked |
| `symbolsIndexed` | number | Total symbols in the graph |
| `lastIndexedAt` | string \| null | ISO timestamp of the most recent indexing |
| `healthScore` | number (0-100) | Composite health score |
| `healthComponents` | object | Breakdown: `freshness`, `coverage`, `errorRate`, `edgeQuality`, `callResolution` (each 0-1) |
| `healthAvailable` | boolean | Whether health metrics are populated |
| `watcherHealth` | object \| null | File watcher state: `enabled`, `running`, `filesWatched`, `eventsReceived`, `eventsProcessed`, `errors`, `queueDepth`, `restartCount`, `stale`, `lastEventAt`, `lastSuccessfulReindexAt` |
| `watcherNote` | string | Guidance when watcher is inactive |
| `prefetchStats` | object | Predictive prefetch metrics: `enabled`, `queueDepth`, `running`, `completed`, `cancelled`, `cacheHits`, `cacheMisses`, `wastedPrefetch`, `hitRate`, `wasteRate`, `avgLatencyReductionMs`, `lastRunAt` |
| `liveIndexStatus` | object | Live editor buffer state: `enabled`, `pendingBuffers`, `dirtyBuffers`, `parseQueueDepth`, `checkpointPending`, `lastBufferEventAt`, `lastCheckpointAt`, `lastCheckpointResult`, `reconcileQueueDepth`, etc. |
| `memories` | array \| null | Relevant development memories auto-surfaced for this repo (when `surfaceMemories` is true) |

**Typical use:** Call this first in any session to understand the state of the index before doing deeper queries.

---

### sdl.repo.overview

Returns a token-efficient summary of the entire codebase structure, tunable from a cheap stats-only view up to a full architectural overview with hotspots.

**What it does:** Aggregates file counts, symbol counts by kind, edge counts by type, directory summaries with top exports, fan-in hotspots, churn leaders, cluster/community detection summaries, process (call-chain) summaries, and token compression metrics. The response is designed to give agents a birds-eye understanding of a codebase in a single call.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `level` | `"stats"` \| `"directories"` \| `"full"` | Yes | Detail level. `stats` is cheapest (~100 tokens). `directories` adds per-directory summaries. `full` adds hotspots + architecture. |
| `includeHotspots` | boolean | No | Force hotspot inclusion at any level (auto-enabled at `full`) |
| `directories` | string[] | No | Filter to specific directory paths |
| `maxDirectories` | number (1-200) | No | Limit the number of directories returned |
| `maxExportsPerDirectory` | number (1-50) | No | Limit exports listed per directory |

**Response includes:**

| Field | Type | Description |
|:------|:-----|:------------|
| `stats` | object | `fileCount`, `symbolCount`, `edgeCount`, `exportedSymbolCount`, `byKind` (function/class/interface/type/method/variable/module/constructor counts), `byEdgeType` (call/import/config counts), `avgSymbolsPerFile`, `avgEdgesPerSymbol` |
| `directories` | array | Per-directory: `path`, `fileCount`, `symbolCount`, `exportedCount`, `byKind`, `exports`, `topByFanIn`, `topByChurn`, `subdirectories`, `estimatedFullTokens`, `summaryTokens` |
| `hotspots` | object | `mostDepended` (highest fan-in symbols), `mostChanged` (highest churn), `largestFiles`, `mostConnected` (files with most edges) |
| `clusters` | object | `totalClusters`, `averageClusterSize`, `largestClusters` (list of `{clusterId, label, size}`) |
| `processes` | object | `totalProcesses`, `averageDepth`, `entryPoints`, `longestProcesses` (list of `{processId, label, depth}`) |
| `tokenMetrics` | object | `fullCardsEstimate`, `overviewTokens`, `compressionRatio` |

**Token guidance:**
- `level: "stats"` is the cheapest entry point for any new task.
- Use `directories` filter + `maxDirectories` to bound payload for large repos.

---

### sdl.index.refresh

Triggers re-indexing of a repository in either full or incremental mode.

**What it does:** Scans the repository for changed files, parses them with the configured indexer (Rust native or tree-sitter TypeScript), extracts symbols and edges, runs pass-2 call resolution, and writes the results to the graph database. Creates a new ledger version. Clears slice and card caches. Supports MCP progress notifications.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `mode` | `"full"` \| `"incremental"` | Yes | `full` re-indexes everything; `incremental` only processes files changed since the last index |
| `reason` | string | No | Optional reason for the refresh (logged) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `ok` | boolean | Success flag |
| `repoId` | string | Repository identifier |
| `versionId` | string | The new ledger version ID |
| `changedFiles` | number | Number of files processed |

**Notes:**
- Incremental mode compares file content hashes to detect changes. Only changed files are re-parsed.
- After indexing, all slice caches and card caches are invalidated.

---

## 2. Live Editor Buffer

These tools enable real-time indexing of unsaved editor content. They are primarily consumed by the VSCode extension or other IDE integrations, allowing symbol search, card, and slice tools to reflect the latest edits before the file is saved to disk.

### sdl.buffer.push

Pushes an editor buffer event (open, change, save, close, checkpoint) to the live-index overlay.

**What it does:** Accepts the full content of an editor buffer along with metadata (cursor position, selections, dirty state). The overlay store tracks the buffer and schedules a background parse to extract symbols from the unsaved content. On `save` events, the overlay is checkpointed into the durable graph database.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `eventType` | `"open"` \| `"change"` \| `"save"` \| `"close"` \| `"checkpoint"` | Yes | Type of editor event |
| `filePath` | string | Yes | Relative file path within the repo (must not contain `..`) |
| `content` | string | Yes | Full file content (max 5 MB) |
| `language` | string | No | Language identifier (e.g., `"typescript"`) |
| `version` | number | Yes | Editor buffer version number (monotonically increasing) |
| `dirty` | boolean | Yes | Whether the buffer has unsaved changes |
| `timestamp` | string | Yes | ISO timestamp of the event |
| `cursor` | `{line, col}` | No | Current cursor position |
| `selections` | array of `{startLine, startCol, endLine, endCol}` | No | Active text selections |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `accepted` | boolean | Whether the event was accepted |
| `repoId` | string | Repository identifier |
| `overlayVersion` | number | Current overlay version |
| `parseScheduled` | boolean | Whether a background parse was queued |
| `checkpointScheduled` | boolean | Whether a checkpoint was queued |
| `warnings` | string[] | Any warnings (e.g., max draft files exceeded) |

---

### sdl.buffer.checkpoint

Requests a manual checkpoint of all pending live draft buffers to the durable graph database.

**What it does:** Forces the overlay store to write all pending buffer parses into the graph database immediately, rather than waiting for the idle checkpoint timer. Returns the count of files checkpointed and any failures.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `reason` | string | No | Optional reason for the checkpoint |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `repoId` | string | Repository identifier |
| `requested` | boolean | Whether the checkpoint was initiated |
| `checkpointId` | string | Unique checkpoint identifier |
| `pendingBuffers` | number | Buffers pending at time of request |
| `checkpointedFiles` | number | Files successfully checkpointed |
| `failedFiles` | number | Files that failed to checkpoint |
| `lastCheckpointAt` | string \| null | ISO timestamp of last successful checkpoint |

---

### sdl.buffer.status

Returns the current state of the live editor buffer system for a repository.

**What it does:** Reports whether live indexing is enabled, how many buffers are pending/dirty, the parse queue depth, whether a checkpoint is pending, and reconciliation state. This is a diagnostic tool for IDE integrations.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `repoId` | string | Repository identifier |
| `enabled` | boolean | Whether live indexing is active |
| `pendingBuffers` | number | Buffers awaiting processing |
| `dirtyBuffers` | number | Buffers with unsaved changes |
| `parseQueueDepth` | number | Background parse queue size |
| `checkpointPending` | boolean | Whether a checkpoint is queued |
| `lastBufferEventAt` | string \| null | ISO timestamp of last buffer event |
| `lastCheckpointAt` | string \| null | ISO timestamp of last checkpoint |
| `lastCheckpointResult` | `"success"` \| `"partial"` \| `"failed"` \| null | Result of last checkpoint |
| `lastCheckpointError` | string \| null | Error message if last checkpoint failed |
| `reconcileQueueDepth` | number | Pending reconciliation tasks |
| `reconcileInflight` | boolean | Whether reconciliation is running |

---

## 3. Symbol Search & Retrieval

### sdl.symbol.search

Searches the symbol graph by name, with optional semantic reranking or hybrid retrieval.

**What it does:** Performs a text search across all symbol names in the repository. Returns matching symbols with their IDs, names, file paths, and kinds. When `semantic: true` is specified, the retrieval path depends on the configured mode: with `semantic.retrieval.mode: "hybrid"`, results are found via FTS + vector search fused with Reciprocal Rank Fusion (RRF); with legacy mode, results are reranked using embedding similarity (alpha-blended lexical + semantic scores). Falls back to legacy automatically if hybrid indexes are unavailable. The tool also triggers predictive prefetch of cards for the top 5 results, anticipating follow-up `getCard` calls.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `query` | string | Yes | Search query (matched against symbol names) |
| `kinds` | string[] | No | Filter by symbol kind (e.g., `["function", "class"]`). Valid kinds: `function`, `class`, `interface`, `type`, `module`, `method`, `constructor`, `variable` |
| `limit` | number (1-1000) | No | Maximum results to return (default: 50) |
| `semantic` | boolean | No | Enable semantic reranking / hybrid retrieval |
| `includeRetrievalEvidence` | boolean | No | Include retrieval evidence in response (sources used, candidate counts, fusion latency, fallback reason) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `results` | array | Each result: `{symbolId, name, file, kind}` where kind is one of `function`, `class`, `interface`, `type`, `module`, `method`, `constructor`, `variable` |
| `truncation` | object | Present if results were truncated: `{truncated, droppedCount, howToResume}` |
| `retrievalEvidence` | object | Present when `includeRetrievalEvidence: true`. Contains `{mode, ftsAvailable, vectorAvailable, candidateCountPerSource, fusionLatencyMs, fallbackReason}` |
| `retrievalMode` | string | `"hybrid"` or `"legacy"` — indicates which retrieval path was used |

**Token guidance:** Start with `limit: 5-20`. Only increase if the initial results don't contain what you need.

---

### sdl.symbol.getCard

Retrieves a single symbol card — the core unit of code understanding in SDL-MCP.

**What it does:** Returns the full metadata record for a symbol: its identity, file location, line range, kind, export status, visibility, parsed signature (with parameter names, types, return type, generics, overloads), a 1-2 line semantic summary, invariants, side effects, dependency edges (imports and calls with labels), metrics (fan-in, fan-out, 30-day churn, test references, canonical test mapping), cluster membership (community detection), process participation (call-chain roles), and optionally detailed call resolution metadata with confidence scores and resolver provenance.

Supports ETag-based conditional requests via `ifNoneMatch` — if the symbol hasn't changed, a `notModified` response is returned with zero data transfer.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Conditional | Symbol identifier (SHA-256 hash) |
| `symbolRef` | object | Conditional | Natural symbol reference: `{name, file?, kind?, exportedOnly?}` |
| `ifNoneMatch` | string | No | ETag from a previous card response. Returns `notModified` if unchanged. |
| `minCallConfidence` | number (0-1) | No | Filter out call edges below this confidence threshold |
| `includeResolutionMetadata` | boolean | No | Include full call resolution details (resolver ID, resolution phase, reason) |

Provide exactly one of `symbolId` or `symbolRef`.

**Response (full card):**

| Field | Type | Description |
|:------|:-----|:------------|
| `symbolId` | string | Unique symbol identifier |
| `repoId` | string | Repository identifier |
| `file` | string | Relative file path |
| `range` | object | `{startLine, startCol, endLine, endCol}` |
| `kind` | string | `function`, `class`, `interface`, `type`, `module`, `method`, `constructor`, or `variable` |
| `name` | string | Symbol name |
| `exported` | boolean | Whether the symbol is exported |
| `visibility` | string | `public`, `protected`, `private`, `exported`, or `internal` |
| `signature` | object | `{name, params: [{name, type}], returns, generics, overloads}` |
| `summary` | string | 1-2 line semantic summary |
| `invariants` | string[] | Known invariants (e.g., "returns non-null") |
| `sideEffects` | string[] | Known side effects (e.g., "writes to disk") |
| `cluster` | object | `{clusterId, label, memberCount}` — community detection result |
| `processes` | array | `{processId, label, role: "entry"|"intermediate"|"exit", depth}` — call-chain participation |
| `callResolution` | object | Full resolution metadata: `{minCallConfidence, calls: [{symbolId, label, confidence, resolutionReason, resolverId, resolutionPhase}]}` |
| `deps` | object | `{imports: string[], calls: string[]}` — human-readable dependency labels |
| `metrics` | object | `{fanIn, fanOut, churn30d, testRefs: string[], canonicalTest: {file, symbolId, distance, proximity}}` |
| `detailLevel` | string | Card detail level |
| `etag` | string | Content hash for conditional requests |
| `version` | object | `{ledgerVersion, astFingerprint}` |

**Response (not modified):**

```json
{
  "notModified": true,
  "etag": "abc123...",
  "ledgerVersion": "v42"
}
```

**Natural-reference resolution:** When `symbolRef` resolves to a single high-confidence match, the tool returns the same card payload as an ID lookup. When it is ambiguous or missing, the MCP error payload includes `classification`, `fallbackTools`, `fallbackRationale`, and ranked `candidates`.

**Token cost:** ~50-150 tokens per card. This is Rung 1 of the Iris Gate Ladder and should always be tried before requesting code.

---

### sdl.symbol.getCards

Batch-fetches multiple symbol cards in a single round trip.

**What it does:** Identical to `getCard` but accepts an array of up to 100 symbol IDs. Each symbol is resolved independently, with per-symbol ETag support via `knownEtags`. Symbols whose ETags match return `notModified` instead of the full card. This eliminates N sequential `getCard` calls when building context for a task.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolIds` | string[] (1-100) | Conditional | Array of symbol IDs to fetch |
| `symbolRefs` | object[] (1-100) | Conditional | Array of natural symbol references: `{name, file?, kind?, exportedOnly?}` |
| `knownEtags` | Record<string, string> | No | Map of `symbolId → ETag` for conditional fetching |
| `minCallConfidence` | number (0-1) | No | Filter call edges below this confidence |
| `includeResolutionMetadata` | boolean | No | Include full call resolution details |

Provide exactly one of `symbolIds` or `symbolRefs`.

**Response:**

```json
{
  "cards": [
    { "symbolId": "...", "name": "...", ... },
    { "notModified": true, "etag": "...", "ledgerVersion": "..." }
  ],
  "partial": true,
  "succeeded": ["sym-1"],
  "failed": ["missingNode"],
  "failures": [
    {
      "input": "missingNode",
      "classification": "not_found",
      "fallbackTools": ["sdl.symbol.search"]
    }
  ]
}
```

**Notes:** Use this when you know you need multiple cards (for example after a search or slice). When you pass `symbolRefs`, SDL resolves each input independently and can return partial-success metadata instead of failing the whole batch.

---

## 4. Graph Slices

### sdl.slice.build

Builds a task-scoped dependency subgraph from entry symbols, returning the most relevant symbols for a given task within a token budget.

**What it does:** Starting from one or more entry symbols (or a natural-language `taskText` for auto-discovery), performs a BFS/beam search across the dependency graph. Edges are weighted by type: call (1.0) > config (0.8) > import (0.6). The search expands outward, scoring each symbol by relevance (fan-in, centrality, search-term proximity), and stops when the token budget is reached or the confidence threshold drops below `minConfidence`.

The result is a **slice** containing the N most relevant symbol cards, their interconnecting edges, a frontier of symbols just outside the slice boundary, and a handle/lease for subsequent refresh operations.

Supports three wire format versions for encoding efficiency:
- **V1**: Compact with shortened field names
- **V2** (default): File paths and edge types are deduplicated into lookup tables
- **V3**: Grouped edge encoding for further compression

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `taskText` | string | No | Natural language task description. Can be used *alone* (without `entrySymbols`) to auto-discover relevant symbols via hybrid retrieval (FTS + vector + RRF) or legacy full-text search. |
| `stackTrace` | string | No | Stack trace for debugging tasks |
| `failingTestPath` | string | No | Path to a failing test file |
| `editedFiles` | string[] (max 100) | No | Recently edited file paths |
| `entrySymbols` | string[] (max 100) | No | Symbol IDs to start the BFS from |
| `knownCardEtags` | Record<string, string> | No | Map of `symbolId → ETag`. Matching cards return `cardRefs` instead of full cards. |
| `cardDetail` | `"minimal"` \| `"signature"` \| `"deps"` \| `"compact"` \| `"full"` | No | Detail level for cards in the slice |
| `adaptiveDetail` | boolean | No | Let the system choose detail level per card based on relevance |
| `wireFormat` | `"standard"` \| `"readable"` \| `"compact"` \| `"agent"` | No | Response encoding (default: `"compact"`) |
| `wireFormatVersion` | 1 \| 2 \| 3 | No | Compact format version (default: 2) |
| `budget` | object | No | `{maxCards: 1-500, maxEstimatedTokens: 1-200000}` |
| `minConfidence` | number (0-1) | No | Drop edges below this confidence (default: 0.5) |
| `minCallConfidence` | number (0-1) | No | Filter call edges specifically |
| `includeResolutionMetadata` | boolean | No | Include call resolution details on cards |
| `includeRetrievalEvidence` | boolean | No | Include retrieval evidence showing how start-node seeds were discovered (sources, candidate counts, symptom type, fusion latency) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `sliceHandle` | string | Handle for refresh/spillover operations |
| `ledgerVersion` | string | Version this slice is based on |
| `lease` | object | `{expiresAt, minVersion, maxVersion}` — slice validity window |
| `sliceEtag` | object | `{handle, version, sliceHash}` for conditional refresh |
| `slice` | object | The graph slice containing `cards`, `cardRefs`, `edges`, `frontier`, `truncation`, `symbolIndex`, `budget`, `startSymbols`, `confidenceDistribution` |
| `retrievalEvidence` | object | Present when `includeRetrievalEvidence: true`. Contains `{mode, symptomType, candidateCountPerSource, fusionLatencyMs, fallbackReason}`. `symptomType` classifies the input: `"taskText"`, `"stackTrace"`, `"failingTest"`, or `"editedFiles"`. |

**Token guidance:**
- Set `budget: {maxCards: 30, maxEstimatedTokens: 4000}` as a starting point.
- Use `knownCardEtags` on subsequent calls to avoid re-sending unchanged cards.
- Raise `minConfidence` to 0.8+ for precision-focused work; keep at 0.5 for broader recall.

---

### sdl.slice.refresh

Incrementally updates an existing slice handle, returning only the delta (changed symbols) since the last known version.

**What it does:** Given a `sliceHandle` and `knownVersion`, computes what changed in the ledger since that version and returns a delta pack scoped to the slice's symbols. If nothing changed, returns `notModified: true`. This avoids rebuilding the entire slice from scratch after code changes.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `sliceHandle` | string | Yes | Handle from a previous `slice.build` |
| `knownVersion` | string | Yes | The version your client last saw |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `sliceHandle` | string | The same handle |
| `knownVersion` | string | The version you sent |
| `currentVersion` | string | The current ledger version |
| `notModified` | boolean | True if nothing changed |
| `delta` | object \| null | A delta pack (see `sdl.delta.get`) scoped to the slice's symbols, including `changedSymbols`, `blastRadius`, `trimmedSet`, and `spilloverHandle` |
| `lease` | object | Updated lease |

**Notes:** Always prefer `slice.refresh` over rebuilding when you already have a handle. It is dramatically cheaper.

---

### sdl.slice.spillover.get

Fetches overflow symbols that didn't fit within the slice's token budget, via paginated access.

**What it does:** When a slice is truncated (more relevant symbols exist than the budget allows), the truncation metadata includes a `spilloverHandle`. This tool uses that handle to page through the remaining symbols. Each page returns full symbol cards.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `spilloverHandle` | string | Yes | Handle from `slice.build` truncation metadata |
| `cursor` | string | No | Pagination cursor from the previous page |
| `pageSize` | number (1-100) | No | Number of symbols per page (default: 20) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `spilloverHandle` | string | Same handle |
| `cursor` | string | Cursor for the next page |
| `hasMore` | boolean | Whether more pages exist |
| `symbols` | array | Array of full symbol cards |

---

## 5. Code Access (Iris Gate Ladder)

These three tools form Rungs 2-4 of the Iris Gate Ladder. They should be used in order: skeleton first, then hot-path, then raw window only if the first two are insufficient.

### sdl.code.getSkeleton

Returns a deterministic "table of contents" for a symbol or file — signatures and control flow structures with implementation bodies elided.

**What it does:** Parses the source file and produces a skeleton view that includes function/method signatures, class declarations, control flow structures (`if`, `for`, `while`, `try`), but replaces implementation bodies with `/* ... */`. This lets agents understand the *shape* of the code without reading every line.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Conditional | Symbol to skeletonize (provide either `symbolId` or `file`) |
| `file` | string | Conditional | File path to skeletonize (provide either `symbolId` or `file`) |
| `exportedOnly` | boolean | No | Only include exported symbols (reduces noise in large library files) |
| `maxLines` | number | No | Maximum lines to return |
| `maxTokens` | number | No | Maximum tokens to return |
| `identifiersToFind` | string[] (max 50) | No | Highlight specific identifiers in the skeleton |
| `skeletonOffset` | number (min: 0) | No | Resume from a previous truncation point (line offset for pagination) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `skeleton` | string | The skeleton IR text |
| `file` | string | File path |
| `range` | object | `{startLine, startCol, endLine, endCol}` |
| `estimatedTokens` | number | Token count of the skeleton |
| `originalLines` | number | Line count of the original source |
| `truncated` | boolean | Whether the skeleton was truncated |
| `truncation` | object | Truncation details if applicable |

**Token cost:** ~200-400 tokens. This is Rung 2 of the Iris Gate Ladder.

---

### sdl.code.getHotPath

Extracts only the lines containing specific identifiers, plus surrounding context lines, from a symbol's source code.

**What it does:** Given a symbol and a list of identifiers to find, scans the source code for occurrences of those identifiers and returns a minimal excerpt containing just those lines plus a configurable number of context lines above and below. Irrelevant code between matches is skipped. This is the most efficient way to answer questions like "where is `this.cache` initialized?" or "how is `errorCode` used?".

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol to search within |
| `identifiersToFind` | string[] (1-50) | Yes | Identifiers to locate in the source |
| `maxLines` | number | No | Maximum total lines to return |
| `maxTokens` | number | No | Maximum tokens to return |
| `contextLines` | number | No | Lines of context above/below each match (default: 3) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `excerpt` | string | The hot-path excerpt text |
| `file` | string | File path |
| `range` | object | `{startLine, startCol, endLine, endCol}` |
| `estimatedTokens` | number | Token count |
| `matchedIdentifiers` | string[] | Which of the requested identifiers were found |
| `matchedLineNumbers` | number[] | Line numbers where matches occurred |
| `truncated` | boolean | Whether the excerpt was truncated |

**Token cost:** ~400-800 tokens. This is Rung 3 of the Iris Gate Ladder.

---

### sdl.code.needWindow

Requests raw source code for a symbol. This is the most expensive rung of the Iris Gate Ladder and is policy-gated.

**What it does:** Returns the full source code for a symbol's line range. The request must include a justification (`reason`), expected line count, and identifiers the agent expects to find in the code. The policy engine evaluates whether the request should be approved, denied, or downgraded to a skeleton/hot-path.

Approval criteria include: one or more requested identifiers matching the range, the symbol being in a current slice or frontier, the scorer utility exceeding the threshold, or the agent invoking break-glass with audit logging.

If denied, the response includes `whyDenied` reasons and a `nextBestAction` suggesting an alternative tool and arguments.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolId` | string | Yes | Symbol to read |
| `reason` | string | Yes | Justification for why raw code is needed |
| `expectedLines` | number | Yes | How many lines the agent expects (policy enforces `<= maxWindowLines`) |
| `identifiersToFind` | string[] (max 50) | Yes | Identifiers the agent expects to find (required by policy) |
| `granularity` | `"symbol"` \| `"block"` \| `"fileWindow"` | No | Scope of the code window |
| `maxTokens` | number | No | Maximum tokens (policy enforces `<= maxWindowTokens`) |
| `sliceContext` | object | No | Task context for policy evaluation: `{taskText?, stackTrace?, failingTestPath?, editedFiles?, entrySymbols?, budget?}` |

**Response (approved):**

| Field | Type | Description |
|:------|:-----|:------------|
| `approved` | true | Request was approved |
| `symbolId` | string | Symbol identifier |
| `file` | string | File path |
| `range` | object | `{startLine, startCol, endLine, endCol}` |
| `code` | string | The raw source code |
| `whyApproved` | string[] | Reasons for approval |
| `estimatedTokens` | number | Token count |
| `downgradedFrom` | string | If the request was downgraded (e.g., to skeleton) |
| `matchedIdentifiers` | string[] | Which identifiers were found |
| `matchedLineNumbers` | number[] | Line numbers of matches |

**Response (denied):**

| Field | Type | Description |
|:------|:-----|:------------|
| `approved` | false | Request was denied |
| `whyDenied` | string[] | Reasons for denial |
| `suggestedNextRequest` | object | Modified request parameters that might be approved |
| `nextBestAction` | object | `{tool, args, rationale}` — alternative tool to try |

**Token cost:** ~1,000-4,000 tokens. This is Rung 4 (last resort) of the Iris Gate Ladder.

---

## 6. File Access

### sdl.file.read

Read non-indexed files (templates, configs, docs, YAML, SQL, etc.) with optional line range, regex search, or JSON path extraction.

**What it does:** Reads files that are NOT indexed source code (i.e., not `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.cpp`, `.c`, `.h`, `.php`, `.kt`, `.sh`, etc.). For indexed source files, the tool returns an error directing you to use `sdl.symbol.getCard`, `sdl.code.getSkeleton`, or `sdl.code.getHotPath` instead. The file path is resolved relative to the registered repository root and validated against path traversal attacks.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|:----------|:-----|:---------|:--------|:------------|
| `repoId` | string | Yes | — | Repository identifier |
| `filePath` | string | Yes | — | Path relative to repo root |
| `maxBytes` | number | No | 524288 (512KB) | Max bytes to return before truncation |
| `offset` | number | No | 0 | Start line (0-based) for line range mode |
| `limit` | number | No | all | Max lines to return in line range mode |
| `search` | string | No | — | Regex pattern for search mode (case-insensitive) |
| `searchContext` | number | No | 2 | Lines of context around each match in search mode |
| `jsonPath` | string | No | — | Dot-separated key path for JSON/YAML extraction (e.g., `"scripts.build"`, `"items.0.name"`) |

**Modes** (mutually exclusive, checked in priority order):

1. **JSON path extraction** (`jsonPath` set): Parses the file as JSON and returns the subtree at the given path. Array indexing via numeric segments is supported. YAML files are accepted only if they are JSON-compatible (no comments, anchors, or unquoted strings); use `search` mode for complex YAML.
2. **Regex search** (`search` set): Returns matching lines with `searchContext` lines of surrounding context. Matches are prefixed with `>`. Ranges are merged to avoid duplicate output.
3. **Line range** (`offset` and/or `limit` set): Returns numbered lines in the given range.
4. **Full read** (no mode params): Returns the entire file, truncated at `maxBytes` if necessary.

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `filePath` | string | Normalized relative path |
| `content` | string | File content (formatted per mode) |
| `bytes` | number | Total file size in bytes |
| `totalLines` | number | Total line count in the file |
| `returnedLines` | number | Lines returned in this response |
| `truncated` | boolean | Whether content was truncated |
| `truncatedAt` | number | Byte offset of truncation (only if truncated) |
| `matchCount` | number | Number of regex matches (search mode only) |
| `extractedPath` | string | JSON path that was extracted (jsonPath mode only) |

**Blocked extensions:** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.pyw`, `.go`, `.java`, `.cs`, `.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.php`, `.phtml`, `.rs`, `.kt`, `.kts`, `.sh`, `.bash`, `.zsh`. Use SDL code tools for these.

**Security:** The file path is resolved against the repository root and validated with `validatePathWithinRoot()` to prevent path traversal. Files exceeding `maxBytes` are truncated.

**Token cost:** Variable, depends on file size and mode. JSON path extraction is typically cheapest.

---

## 7. Delta & Change Tracking

### sdl.delta.get

Computes a semantic diff between two ledger versions, including blast radius analysis.

**What it does:** Compares two versions of the ledger and returns all changed symbols with their signature diffs, invariant diffs, and side-effect diffs. For each changed symbol, computes a **blast radius** — the set of dependent symbols that may be affected, ranked by distance (hops in the graph), fan-in, test proximity, and process participation. Also returns **amplifiers** — symbols whose fan-in is growing rapidly between versions.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `fromVersion` | string | Yes | Starting version ID |
| `toVersion` | string | Yes | Ending version ID |
| `budget` | object | No | `{maxCards, maxEstimatedTokens}` — constrain output size |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `delta` | object | The delta pack: `repoId`, `fromVersion`, `toVersion`, `changedSymbols`, `blastRadius`, `diagnosticsSummary`, `diagnosticSuspects`, `truncation`, `trimmedSet`, `spilloverHandle` |
| `delta.changedSymbols` | array | Each: `{symbolId, changeType: "added"|"removed"|"modified", signatureDiff: {before, after}, invariantDiff: {added, removed}, sideEffectDiff: {added, removed}}` |
| `delta.blastRadius` | array | Each: `{symbolId, reason, distance, rank, signal: "diagnostic"|"directDependent"|"graph"|"process", fanInTrend: {previous, current, growthRate, isAmplifier}}` |
| `amplifiers` | array | Each: `{symbolId, growthRate, previous, current}` — symbols with rapidly growing fan-in |

**Notes:** Use `budget` for large version diffs to constrain how many changed symbols and blast radius entries are returned.

---

## 8. Policy Management

### sdl.policy.get

Retrieves the current policy configuration for a repository.

**What it does:** Returns the active policy settings that govern code access gating, including the maximum window size, token limits, and whether identifiers are required for raw code requests.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |

**Response:**

```json
{
  "policy": {
    "maxWindowLines": 180,
    "maxWindowTokens": 1400,
    "requireIdentifiers": true,
    "allowBreakGlass": true
  }
}
```

---

### sdl.policy.set

Updates policy settings for a repository.

**What it does:** Applies a partial patch to the policy configuration. Only the fields provided are updated; omitted fields retain their current values.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `policyPatch` | object | Yes | Partial policy: any subset of `{maxWindowLines, maxWindowTokens, requireIdentifiers, allowBreakGlass}` |

**Response:**

```json
{
  "ok": true,
  "repoId": "my-app"
}
```

---

## 9. PR & Risk Analysis

### sdl.pr.risk.analyze

Analyzes the risk of a code change between two versions, computing a risk score, findings, blast radius, and test recommendations.

**What it does:** Computes a delta between two versions, then analyzes the changes for risk patterns: high-fan-in symbol modifications, signature changes on widely-used interfaces, side-effect changes, missing test coverage, etc. Produces a composite risk score (0-100), categorized findings with severity levels, a list of impacted symbols, evidence supporting each finding, and recommended tests prioritized by risk.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `fromVersion` | string | Yes | Starting version ID |
| `toVersion` | string | Yes | Ending version ID |
| `riskThreshold` | number (0-100) | No | Only return findings above this risk score |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `analysis.riskScore` | number (0-100) | Composite risk score |
| `analysis.riskLevel` | `"low"` \| `"medium"` \| `"high"` | Risk category |
| `analysis.findings` | array | Each: `{type, severity: "low"|"medium"|"high", message, affectedSymbols, metadata}` |
| `analysis.impactedSymbols` | string[] | All symbols affected by the changes |
| `analysis.evidence` | array | Each: `{type, description, symbolId, data}` |
| `analysis.recommendedTests` | array | Each: `{type, description, targetSymbols, priority: "high"|"medium"|"low"}` |
| `analysis.changedSymbolsCount` | number | Total changed symbols |
| `analysis.blastRadiusCount` | number | Total symbols in the blast radius |
| `escalationRequired` | boolean | Whether the risk level warrants review escalation |
| `policyDecision` | object | `{decision, deniedReasons, auditHash}` |

---

## 10. Context Summary

### sdl.context.summary

Generates a structured, token-bounded context briefing for any query against the codebase.

**What it does:** Takes a natural-language query (e.g., `"debug the auth middleware"`, `"src/db/queries.ts"`, or `"handleRepoStatus"`), searches the symbol graph for matching symbols, then assembles a budget-constrained context package. The query scope is auto-detected (symbol, file, or task) based on the query content, or can be specified explicitly.

The summary is assembled from four sections, each progressively trimmed if the token budget is exceeded (dependency graph is trimmed first, then risk areas, then files touched, then key symbols):

1. **Key Symbols** — the most relevant symbols with signatures, summaries, cluster membership, and process (call-chain) participation
2. **Dependency Graph** — how those symbols connect to each other via call/import edges
3. **Risk Areas** — symbols flagged for high fan-in (>= 15) or recent churn (30-day modifications)
4. **Files Touched** — which files contain the matched symbols, ranked by density

Results are cached by `repoId + indexVersion + query` to avoid redundant graph queries.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `query` | string | Yes | Natural-language query, file path, or symbol name |
| `budget` | number | No | Token budget for the summary (default: 2000) |
| `format` | `"markdown"` \| `"json"` \| `"clipboard"` | No | Output format (default: `"markdown"`) |
| `scope` | `"symbol"` \| `"file"` \| `"task"` | No | Query scope (auto-detected if omitted) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `repoId` | string | Repository identifier |
| `format` | string | Output format used |
| `summary` | object | Structured summary: `{repoId, query, scope, keySymbols, dependencyGraph, riskAreas, filesTouched, metadata}` |
| `summary.keySymbols` | array | Each: `{symbolId, name, kind, signature, summary, cluster: {clusterId, label, memberCount}, processes: [{processId, label, role, depth}]}` |
| `summary.dependencyGraph` | array | Each: `{fromSymbolId, toSymbolIds: string[]}` |
| `summary.riskAreas` | array | Each: `{symbolId, name, reasons: string[]}` |
| `summary.filesTouched` | array | Each: `{file, symbolCount}` |
| `summary.metadata` | object | `{query, summaryTokens, budget, truncated, indexVersion}` |
| `content` | string | The rendered summary (markdown or JSON string) |

**Scope auto-detection:**
- Contains `/` or `\` or a file extension → `"file"`
- Contains 3+ words or task-related words (fix, debug, analyze, refactor, etc.) → `"task"`
- Otherwise → `"symbol"`

**Use cases:**
- Copy/paste context into non-MCP environments (Slack, Jira, PRs)
- Quick task briefing before diving into a codebase area
- The CLI `sdl-mcp summary` command wraps this tool

---

## 11. Agent Context & Feedback

### sdl.agent.context

Task-shaped context engine that selects the optimal Iris Gate Ladder path and collects evidence.

**What it does:** Given a task type (`debug`, `review`, `implement`, `explain`) and a text description, the context engine:

1. Plans a **rung path** (e.g., `card → skeleton → hotPath`) based on the task type, budget constraints, and available evidence.
2. Executes each rung in sequence, collecting evidence at each step.
3. Returns the full execution trace: actions taken, evidence collected, metrics, and optionally a synthesized answer.

The planner estimates token costs per rung (`card: ~50`, `skeleton: ~200`, `hotPath: ~500`, `raw: ~2000`) and trims rungs from the end when the budget is tight.

When Code Mode is enabled, `sdl.context` accepts the same task envelope and should be preferred over `sdl.workflow` for retrieval.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `taskType` | `"debug"` \| `"review"` \| `"implement"` \| `"explain"` | Yes | Type of task |
| `taskText` | string | Yes | Task description or prompt |
| `budget` | object | No | `{maxTokens, maxActions, maxDurationMs}` |
| `options` | object | No | `{contextMode?, focusSymbols?, focusPaths?, includeTests?, requireDiagnostics?}` |

`options.contextMode`: `"precise"` returns minimal, chain-efficient context (1 symbol per rung, stripped envelope). `"broad"` (default) returns richer surrounding context with full diagnostics.

**Response (broad mode):**

| Field | Type | Description |
|:------|:-----|:------------|
| `taskId` | string | Unique task identifier |
| `taskType` | string | Task type executed |
| `actionsTaken` | array | Each: `{id, type, status, input, output, error, timestamp, durationMs, evidence}` |
| `path` | object | `{rungs: string[], estimatedTokens, estimatedDurationMs, reasoning}` — the selected rung path |
| `finalEvidence` | array | Each: `{type, reference, summary, timestamp}` |
| `summary` | string | Human-readable execution summary |
| `success` | boolean | Whether the task completed successfully |
| `error` | string | Error message if failed |
| `metrics` | object | `{totalDurationMs, totalTokens, totalActions, successfulActions, failedActions, cacheHits}` |
| `answer` | string | Synthesized answer based on evidence |
| `nextBestAction` | string | Suggested follow-up action |

**Response (precise mode):** Only `taskId`, `taskType`, `success`, `path`, `finalEvidence`, `metrics`. Envelope fields stripped for token efficiency.

**Notes:**
- Use `contextMode: "precise"` for targeted lookups — more token-efficient than manual `sdl.workflow`.
- Use `contextMode: "broad"` (default) for investigation and exploration.
- Always provide `budget` and scope with `focusSymbols`/`focusPaths`.
- Avoid `requireDiagnostics` unless needed — it can force a raw code rung.

---

### sdl.agent.feedback

Records which symbols were useful or missing during a task, enabling offline tuning of slice relevance.

**What it does:** After completing a task with a slice, the agent reports which symbols in the slice were actually useful and which expected symbols were missing. This feedback is stored in the graph database and used to improve future slice quality through reinforcement-style tuning.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `versionId` | string | Yes | Ledger version the feedback applies to |
| `sliceHandle` | string | Yes | Slice handle that was used |
| `usefulSymbols` | string[] (min 1) | Yes | Symbol IDs that were useful |
| `missingSymbols` | string[] | No | Symbol IDs that were expected but absent |
| `taskTags` | string[] | No | Tags describing the task |
| `taskType` | `"debug"` \| `"review"` \| `"implement"` \| `"explain"` | No | Type of task |
| `taskText` | string | No | Task description for context |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `ok` | boolean | Whether the feedback was recorded |
| `feedbackId` | string | Unique feedback record ID |
| `repoId` | string | Repository identifier |
| `versionId` | string | Version identifier |
| `symbolsRecorded` | number | Total symbols in the feedback record |

---

### sdl.agent.feedback.query

Queries stored feedback records and aggregated statistics for offline tuning pipelines.

**What it does:** Retrieves feedback records with optional filtering by version and time range. Returns both raw feedback entries and aggregated statistics showing the most commonly useful and most commonly missing symbols, enabling data-driven improvements to slice construction.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `versionId` | string | No | Filter by version |
| `limit` | number (1-1000) | No | Maximum records to return |
| `since` | string | No | ISO timestamp to filter from |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `repoId` | string | Repository identifier |
| `feedback` | array | Each: `{feedbackId, versionId, sliceHandle, usefulSymbols, missingSymbols, taskTags, taskType, taskText, createdAt}` |
| `aggregatedStats` | object | `{totalFeedback, topUsefulSymbols: [{symbolId, count}], topMissingSymbols: [{symbolId, count}]}` |
| `hasMore` | boolean | Whether more records exist |

---

## 12. Runtime Execution

### sdl.runtime.execute

Runs code in a sandboxed, policy-gated subprocess scoped to a registered repository.

**What it does:** Executes a command using one of 16 supported runtimes (Node.js, TypeScript, Python, Shell, Go, Java, Kotlin, Rust, C, C++, C#, Ruby, PHP, Perl, R, Elixir) within the repository's directory. The execution is fully governed:

1. **Enabled by default** — Set `runtime.enabled: false` to disable subprocess execution in hardened deployments.
2. **Policy evaluation** — The policy engine checks whether the requested runtime, executable, CWD, and timeout are allowed.
3. **Executable validation** — Custom executables must be compatible with the selected runtime (e.g., you can't use `powershell` with the `node` runtime).
4. **Scrubbed environment** — Subprocesses receive only `PATH` and explicitly allowlisted env vars. Secrets do not leak.
5. **CWD jailing** — The working directory is validated to stay within the repository root.
6. **Code mode** — Inline code strings are written to a temp file, executed, then cleaned up.
7. **Concurrency limiting** — A configurable `maxConcurrentJobs` cap prevents resource exhaustion.
8. **Timeout enforcement** — Hard timeout with process-tree kill.
9. **Output handling** — Stdout/stderr are captured with configurable byte limits and persisted as gzip artifacts. The `outputMode` parameter (`"minimal"`, `"summary"`, `"intent"`) controls how much output is returned inline. Use `sdl.runtime.queryOutput` to search artifacts on demand.
10. **Artifact persistence** — Full output can be persisted as gzip artifacts with SHA-256 hashing, TTL, and size limits.
11. **Audit trail** — Every execution is logged with the policy audit hash, duration, exit code, and byte counts.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `runtime` | string | Yes | Runtime to use. Supported: `node`, `typescript`, `python`, `shell`, `ruby`, `php`, `perl`, `r`, `elixir`, `go`, `java`, `kotlin`, `rust`, `c`, `cpp`, `csharp` |
| `executable` | string | No | Override the default executable (e.g., `"bun"` instead of `"node"`) |
| `args` | string[] | No | Arguments to pass to the executable |
| `code` | string | No | Inline code to execute (written to temp file). Mutually exclusive with args-only mode. |
| `relativeCwd` | string | No | Working directory relative to repo root (default: `"."`) |
| `timeoutMs` | number | No | Execution timeout in milliseconds |
| `queryTerms` | string[] (max 10) | No | Keywords for excerpt matching in the output |
| `maxResponseLines` | number (10-1000) | No | Max lines in stdout/stderr summaries (default: 100) |
| `persistOutput` | boolean | No | Whether to persist full output as a gzip artifact (default: true) |
| `outputMode` | `"minimal"` \| `"summary"` \| `"intent"` | No | Controls response verbosity. `"minimal"` (default): ~50 tokens with status and artifact handle only. `"summary"`: head+tail output excerpts (legacy behavior). `"intent"`: only `queryTerms`-matched excerpts. |

**Response (varies by `outputMode`):**

**Common fields (all modes):**

| Field | Type | Description |
|:------|:-----|:------------|
| `status` | `"success"` \| `"failure"` \| `"timeout"` \| `"cancelled"` \| `"denied"` | Execution result |
| `exitCode` | number \| null | Process exit code |
| `signal` | string \| null | Signal that terminated the process (e.g., `"SIGTERM"`) |
| `durationMs` | number | Execution duration |
| `artifactHandle` | string \| null | Handle for the persisted artifact (if `persistOutput` was true) |
| `policyDecision` | object | `{auditHash, deniedReasons}` |

**`outputMode: "minimal"` (default) — adds:**

| Field | Type | Description |
|:------|:-----|:------------|
| `outputLines` | number | Total lines captured across stdout+stderr |
| `outputBytes` | number | Total bytes captured across stdout+stderr |

No `stdoutSummary`, `stderrSummary`, or `excerpts` fields. Use `sdl.runtime.queryOutput` with the `artifactHandle` to retrieve output on demand.

**`outputMode: "summary"` — adds:**

| Field | Type | Description |
|:------|:-----|:------------|
| `stdoutSummary` | string | Head + tail of stdout, truncated to `maxResponseLines` |
| `stderrSummary` | string | Tail of stderr |
| `excerpts` | array | Keyword-matched windows: `{lineStart, lineEnd, content, source: "stdout"\|"stderr"}` |
| `truncation` | object | `{stdoutTruncated, stderrTruncated, totalStdoutBytes, totalStderrBytes}` |

**`outputMode: "intent"` — adds:**

| Field | Type | Description |
|:------|:-----|:------------|
| `excerpts` | array | Only `queryTerms`-matched windows: `{lineStart, lineEnd, content, source}` |
| `truncation` | object | `{stdoutTruncated, stderrTruncated, totalStdoutBytes, totalStderrBytes}` |

No `stdoutSummary` or `stderrSummary` — only matched excerpts are returned.

> **Per-line truncation:** All output modes enforce a 500-character per-line cap. Lines exceeding this limit are truncated with a `[truncated]` suffix.

**Default executables by runtime (common examples):**
- `node` → `node` (or `bun` if available)
- `typescript` → `tsx` / `ts-node`
- `python` → `python3` (Unix) / `python` (Windows)
- `shell` → `bash` (Unix) / `cmd.exe` (Windows)
- `go` → `go run`
- `rust` → `rustc` then execute
- `java` → `javac` then `java`
- `c` / `cpp` → `gcc`/`g++` (Unix) / `cl` (Windows) then execute
- `csharp` → `dotnet-script` / `csc`

See [Runtime Execution deep dive](../feature-deep-dives/runtime-execution.md) for the complete 16-runtime list.

**Use cases:** Running tests, linters, build scripts, or diagnostic commands within SDL-MCP's governance framework.

---

### sdl.runtime.queryOutput

Retrieves and searches stored runtime output artifacts on demand.

**What it does:** Loads a previously persisted runtime artifact (from `sdl.runtime.execute` with `persistOutput: true`) and searches it for matching terms. Returns excerpts with surrounding context lines. This is the companion to `outputMode: "minimal"` — execute first with minimal output, then query the artifact only when you need to inspect the results.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `artifactHandle` | string | Yes | Handle returned by `sdl.runtime.execute` |
| `queryTerms` | string[] | Yes | Keywords to search for in the output |
| `maxExcerpts` | integer (1-100) | No | Maximum excerpt windows to return (default: 10) |
| `contextLines` | integer (0-20) | No | Lines of context around each match (default: 3) |
| `stream` | `"stdout"` \| `"stderr"` \| `"both"` | No | Which stream(s) to search (default: `"both"`) |

**Response:**

| Field | Type | Description |
|:------|:-----|:------------|
| `artifactHandle` | string | Echo of the requested handle |
| `excerpts` | array | Matched windows: `{lineStart, lineEnd, content, source: "stdout"\|"stderr"}` |
| `totalLines` | integer | Total lines in the artifact |
| `totalBytes` | integer | Total bytes in the artifact |
| `searchedStreams` | string[] | Streams that were searched |

**Use cases:** Inspecting test failures after a minimal execute, searching build logs for specific errors, extracting diagnostic output from long-running commands.

---

## 13. Development Memories

### sdl.memory.store

Stores or updates a development memory with optional symbol and file links. Memories persist across sessions and are automatically surfaced in relevant slices.

**What it does:** Creates a `Memory` node in the graph database linked to the repository, and optionally to specific symbols and files via `MEMORY_OF` and `MEMORY_OF_FILE` edges. Also writes a backing `.sdl-memory/*.md` file for version control. Content-addressed deduplication prevents duplicate memories.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `type` | `"decision"` \| `"bugfix"` \| `"task_context"` \| `"pattern"` \| `"convention"` \| `"architecture"` \| `"performance"` \| `"security"` | Yes | Memory type |
| `title` | string (1-120 chars) | Yes | Short, scannable title |
| `content` | string (1-50,000 chars) | Yes | Memory content (include the *why*, not just the *what*) |
| `tags` | string[] (max 20) | No | Categorization tags |
| `confidence` | number (0-1) | No | Confidence score (0.9 for verified facts, 0.7 for hypotheses) |
| `symbolIds` | string[] (max 100) | No | Link memory to specific symbols |
| `fileRelPaths` | string[] (max 100) | No | Link memory to specific files |
| `memoryId` | string | No | Existing memory ID for upsert |

**Response:** `{ ok, memoryId, created, deduplicated? }`

---

### sdl.memory.query

Searches and filters memories by text, type, tags, or linked symbols.

**What it does:** Queries the graph for memories matching the given criteria. Supports full-text search across title and content, filtering by type/tags/symbols, staleness detection, and sorting.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `query` | string (max 1,000) | No | Full-text search query |
| `types` | string[] | No | Filter by memory types |
| `tags` | string[] (max 20) | No | Filter by tags |
| `symbolIds` | string[] (max 100) | No | Filter by linked symbols |
| `staleOnly` | boolean | No | Return only stale memories (linked symbols changed) |
| `limit` | number (1-100) | No | Max results |
| `sortBy` | `"recency"` \| `"confidence"` | No | Sort order |

**Response:** `{ memories, total }`

---

### sdl.memory.remove

Soft-deletes a memory from the graph. Optionally removes the backing `.sdl-memory/*.md` file.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `memoryId` | string | Yes | Memory ID to remove |
| `deleteFile` | boolean | No | Also delete the backing markdown file |

**Response:** `{ ok, memoryId, fileDeleted? }`

---

### sdl.memory.surface

Auto-surfaces memories relevant to a set of symbols or task type. Memories are ranked by `confidence × recencyFactor × overlapFactor`.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository identifier |
| `symbolIds` | string[] (max 500) | No | Symbols to find related memories for |
| `taskType` | string | No | Filter by memory type |
| `limit` | number (1-50) | No | Max memories to return |

**Response:** `{ memories: SurfacedMemory[], total }` — each memory includes a `score` and `matchedSymbols` field.

---

## 14. Usage Statistics

### sdl.usage.stats

Returns cumulative token usage statistics and savings metrics.

**What it does:** Tracks how many tokens SDL-MCP has saved compared to raw file reads across all tool calls. Reports per-tool breakdowns, compression ratios, and session/historical aggregations. `savedTokens` and `overallSavingsPercent` can be negative when SDL overhead exceeds the raw-equivalent estimate.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | No | Repository identifier (omit for global stats) |
| `scope` | `"session"` \| `"history"` \| `"both"` | No | Stats scope (default: `"both"`) |
| `persist` | boolean | No | Whether to persist current session stats |
| `since` | string | No | ISO timestamp to filter historical stats from |
| `limit` | number (1-100) | No | Max historical entries to return |

**Response:** Token usage counters, savings estimates, compression ratios, and per-tool breakdowns when available.

---

## 15. Code Mode Tools

### sdl.context

Retrieves task-shaped code context inside Code Mode.

**What it does:** Mirrors `sdl.agent.context` but lives alongside `sdl.manual` and `sdl.workflow`. Use it first for `explain`, `debug`, `review`, and most `implement` requests when you are already operating through the Code Mode surfaces.

**Parameters:** Same as `sdl.agent.context`.

**Response:** Same as `sdl.agent.context`.

---

### sdl.workflow

Executes a workflow of SDL-MCP operations in a single round-trip with budget tracking and cross-step result passing.

**What it does:** Takes an array of steps, each calling an action from the API manual or an internal transform (`dataPick`, `dataMap`, `dataFilter`, `dataSort`, `dataTemplate`). Results flow between steps via `$N` references (e.g., `$0.results[0].symbolId` or `$0.symbols[0].symbolId`). Includes budget tracking, context-ladder validation, cross-step ETag caching, and optional execution tracing.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `repoId` | string | Yes | Repository scope for all steps |
| `steps` | array (min 1) | Yes | Workflow steps: `[{ fn, args? }]` |
| `budget` | object | No | Budget constraints for the workflow |
| `onError` | `"continue"` \| `"stop"` | No | Error handling mode |
| `trace` | object | No | Enable execution tracing |

Each step has:
- `fn`: Action name (e.g., `"symbolSearch"`, `"dataPick"`)
- `args`: Arguments object (supports `$N` references to previous step results)

**Internal transforms:** `dataPick` (project fields), `dataMap` (project from arrays), `dataFilter` (filter by clauses), `dataSort` (sort by field), `dataTemplate` (render template strings).

**Response:** Array of step results plus budget usage metrics.

---

### sdl.action.search

Searches the SDL action catalog for matching actions. Use this as the first discovery step.

**What it does:** Keyword-searches across all registered SDL actions and returns ranked matches with optional schema summaries and examples.

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `query` | string | Yes | Search query |
| `limit` | number (1-50) | No | Max results |
| `offset` | number (min: 0) | No | Skip the first N ranked results |
| `includeSchemas` | boolean | No | Include parameter schema summaries |
| `includeExamples` | boolean | No | Include usage examples |

**Response:** `{ actions: ActionMatch[], total, hasMore, offset, limit, tokenEstimate }`

Use `offset` with `limit` to page through large result sets such as `query: "*"`.

---

### sdl.manual

Returns the SDL-MCP API manual — a compact reference listing all available functions, their parameters, and return types. Use for focused API reference before calling `sdl.agent.context` / `sdl.context` (context retrieval) or `sdl.workflow` (multi-step operations).

**Parameters:**

| Parameter | Type | Required | Description |
|:----------|:-----|:---------|:------------|
| `query` | string | No | Filter manual to matching actions |
| `actions` | string[] | No | Specific actions to include |
| `format` | `"typescript"` \| `"markdown"` \| `"json"` | No | Output format |
| `includeSchemas` | boolean | No | Include full parameter schemas |
| `includeExamples` | boolean | No | Include usage examples |

**Response:** `{ manual, tokenEstimate }`
