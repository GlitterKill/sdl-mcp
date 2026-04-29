# Observability Dashboard

<div align="right">
<details>
<summary><strong>Docs Navigation</strong></summary>

- [Overview](../../README.md)
- [Documentation Hub](../README.md)
  - [Getting Started](../getting-started.md)
  - [CLI Reference](../cli-reference.md)
  - [Configuration Reference](../configuration-reference.md)
  - [Architecture](../architecture.md)
  - [Troubleshooting](../troubleshooting.md)

</details>
</div>

## Overview

The **observability dashboard** is a built-in, read-only operational surface that exposes
every metric needed to diagnose SDL-MCP behaviour without parsing stderr logs. It ships
in V1 as:

- **HTTP REST + SSE APIs** under `/api/observability/*` (snapshot, timeseries, beam-explain, stream)
- **Web UI** at `/ui/observability` with a cyberpunk-corporate dark theme, 12 metric panels,
  and a System Stats toggle for raw process counters
- **Per-repo aggregation** of every existing telemetry event plus new probes for the DB write
  pool, indexer drain, CPU, RSS, heap, and event-loop lag

V1 is intentionally **read-only**: the dashboard does not expose tuning knobs, write to the
graph, or accept commands. It is a side-channel observer of the same telemetry events the
existing log pipeline consumes. V2 will likely add live tuning controls and a persistent
warehouse — see [V1 limitations + V2 roadmap](#v1-limitations--v2-roadmap).

The dashboard lives on the **HTTP transport** (`sdl-mcp serve --http`). Stdio transport
does not expose the routes — there is no static-file server when stdio is the only
transport active. Bearer-token authentication gates the `/api/observability/*` endpoints
identically to the rest of the `/api/*` surface.

### Enabling the dashboard

Observability is enabled by default in v0.10.11+. To disable it, set:

```json
{
  "observability": { "enabled": false }
}
```

The full config block, with every key, is documented in
[Configuration reference](#configuration-reference).

---

## Architecture

The observability subsystem is a **side-channel** observer that sits in parallel with the
MCP request path — it does not block tool dispatch and does not write to the graph
database. Data flows in one direction: telemetry events fan out to the tap, the tap
forwards to the per-repo aggregator, and HTTP routes pull synchronous snapshots when
requested.

```
[ MCP tool handlers ]                [ getPoolStats() / drain / cpu / rss / heap / eventLoop ]
       |                                              |
       | logToolCall(...)                             | sample tick (sampleIntervalMs)
       v                                              v
[ src/mcp/telemetry.ts ] ---------------------> [ src/observability/event-tap.ts ]
                                                       |
                                                       | onTool / onIndex / onPolicy /
                                                       | onPpr / onPacked / onScip / onPool /
                                                       | onResource / onIndexPhase / ...
                                                       v
                                              [ ObservabilityService (singleton) ]
                                                       |
                                                       |---> Aggregator(repoId-1)  (dual window)
                                                       |---> Aggregator(repoId-2)
                                                       |---> Aggregator(repoId-N)
                                                       |
                                                       v
                                              [ BeamExplainStore (LRU, separate) ]
                                                       |
       +-----------------------------------------------+
       |
       v
[ /api/observability/snapshot   ] -- json --> caller
[ /api/observability/timeseries ] -- json --> caller
[ /api/observability/beam-explain ] -- json --> caller
[ /api/observability/stream    ] -- SSE  --> caller (initial snapshot + tick + heartbeat)
       |
       +--> [ /ui/observability  HTML/JS/CSS ]
```

**Key components:**

| Component                    | File                                           | Role                                                                                                                                                                                            |
| :--------------------------- | :--------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ObservabilityTap` interface | `src/observability/event-tap.ts`               | Receives forwarded telemetry events. The tap is registered once at startup and kept on the existing `logger` channel.                                                                           |
| `ObservabilityService`       | `src/observability/service.ts`                 | Owns one `Aggregator` per repo, samples the runtime probes at `sampleIntervalMs`, and exposes `getSnapshot`, `getTimeseries`, `getBeamExplain`, and `onSnapshot` (subscriber callback for SSE). |
| `Aggregator`                 | `src/observability/service.ts`                 | Per-repo state container. Maintains dual retention windows (short, default 15 min; long, default 24 h) over the same metric streams.                                                            |
| `BeamExplainStore`           | `src/observability/beam-explain-store.ts`      | Independent LRU. Insertion order is tracked via `Map` iteration; every `publish` deletes-then-re-inserts to keep the most-recently-used slice handle at the tail.                               |
| `classifyBottleneck`         | `src/observability/bottleneck-classifier.ts`   | Pure deterministic classifier that takes a snapshot of resource and queue signals and returns `{dominant, confidence, topSignals}`.                                                             |
| HTTP routes                  | `src/cli/transport/http.ts` (lines ~1030–1230) | Bearer-auth gated handlers for the four `/api/observability/*` paths plus static asset routes for `/ui/observability{,.js,.css}`.                                                               |

**Sampling tick** — when the service is `start()`ed, it sets a recurring timer at the
configured `sampleIntervalMs` (default 2000 ms). On each tick the service samples:

- CPU percent (averaged over cores) and the running max
- RSS in MB, heap used / total in MB, event-loop lag (P95 + max)
- DB write-pool stats via `getPoolStats()` from `src/db/ladybug-core.ts`
- Indexer drain stats via `getActiveDrainStats()` from `src/indexer/`

These samples feed both the `ResourceMetrics` block in the snapshot and the timeseries
buffer. The 2-second cadence is tuned to avoid contention with the serialized DB write
connection — see [Operational overhead](#operational-overhead).

---

## HTTP API reference

All four routes require `Authorization: Bearer <token>`. The token is printed to stderr
when `sdl-mcp serve --http` starts, or set explicitly via the `httpAuth.token` config key.
Requests without a valid token receive `401 Unauthorized` from the shared `/api/*`
middleware. Requests when `observability.enabled` is `false` receive `503` with body
`{"error":"observability_disabled"}`.

### `GET /api/observability/snapshot`

Returns a complete `ObservabilitySnapshot` for a single repo, computed on demand.

| Query param | Type   | Required | Description                                              |
| :---------- | :----- | :------- | :------------------------------------------------------- |
| `repoId`    | string | yes      | Identifier of a registered repo (matches `Repo.repoId`). |

**Response**: `ObservabilitySnapshot` (see [Metric definitions](#metric-definitions)).

**Status codes:**

| Code | Body                                 | Meaning                               |
| :--- | :----------------------------------- | :------------------------------------ |
| 200  | `ObservabilitySnapshot` JSON         | OK.                                   |
| 400  | `{"error":"missing_repoId"}`         | `repoId` query param empty or absent. |
| 401  | `{"error":"Unauthorized: ..."}`      | Bearer token invalid or missing.      |
| 404  | `{"error":"repo_not_found"}`         | `repoId` not registered.              |
| 503  | `{"error":"observability_disabled"}` | `observability.enabled = false`.      |

### `GET /api/observability/timeseries`

Returns a `TimeseriesResponse` containing per-metric arrays of `{t, value}` points.

| Query param | Type                         | Required             | Description                                                                                            |
| :---------- | :--------------------------- | :------------------- | :----------------------------------------------------------------------------------------------------- |
| `repoId`    | string                       | yes                  | Repo identifier.                                                                                       |
| `window`    | `"15m"` \| `"1h"` \| `"24h"` | no (default `"15m"`) | Retention window to draw points from. `15m` and `1h` use the short buffer; `24h` uses the long buffer. |

**Response shape** — `TimeseriesResponse` from `src/observability/types.ts`:

```ts
interface TimeseriesResponse {
  schemaVersion: 1;
  repoId: string;
  window: "15m" | "1h" | "24h";
  resolutionMs: number;
  series: Record<string, TimeseriesPoint[]>;
}
```

**Standard series keys** (see the `series` JSDoc on `TimeseriesResponse`):
`cacheHitRate`, `p95LatencyMs`, `queueDepth`, `cpuPct`, `rssMb`, `heapUsedMb`,
`eventLoopLagMs`, `tokensUsedPerMin`, `tokensSavedPerMin`, `filesPerMinute`, `errorRate`,
`drainQueueDepth`. Additional series may appear; consumers should treat unknown keys as
opaque numeric streams.

**Status codes**: 200 (OK), 400 (`invalid_window`, `missing_repoId`), 401, 404, 503.

### `GET /api/observability/beam-explain`

Returns a `BeamExplainResponse` recording the per-iteration decisions of a beam-search
slice build. The slice handle must still be retained in the LRU; the cap is set by
`beamExplainCapacity` (default 128 most-recent slice builds).

| Query param   | Type   | Required | Description                                              |
| :------------ | :----- | :------- | :------------------------------------------------------- |
| `repoId`      | string | yes      | Repo identifier.                                         |
| `sliceHandle` | string | yes      | Slice handle returned from `sdl.slice.build`.            |
| `symbolId`    | string | no       | When present, only entries for this symbol are returned. |

**Response shape** — `BeamExplainResponse` from `src/observability/types.ts`:

```ts
interface BeamExplainResponse {
  schemaVersion: 1;
  repoId: string;
  sliceHandle: string;
  builtAt: string; // ISO 8601
  entries: BeamExplainEntry[];
  truncated: boolean;
  edgeWeights: {
    call: number;
    import: number;
    config: number;
    implements: number;
  };
  thresholds: { sliceScoreThreshold: number; maxFrontier: number };
}
```

Each `BeamExplainEntry` carries `symbolId`, `decision`
(`"accepted" | "evicted" | "rejected"`), `totalScore`, a `BeamScoreComponents` breakdown
(`query`, `stacktrace`, `hotness`, `structure`, `kind`, optional `centrality`, optional
`ppr`), a human-readable `why` rationale, optional edge metadata
(`edgeFromSymbolId`, `edgeType`, `edgeWeight`), the iteration index, and a unix-millis
`timestamp`. The per-slice cap is `beamExplainEntriesPerSlice` (default 512); when entries
were dropped, `truncated` is `true`.

**Status codes**: 200, 400 (`missing_repoId`, `missing_sliceHandle`), 401, 404, 503.

### `GET /api/observability/stream`

Server-sent events. Emits one `snapshot` event immediately for the requested repo, then
one `snapshot` event per service sampling tick, plus a `heartbeat` event every
`sseHeartbeatMs` milliseconds (default 15000) so reverse proxies do not idle-close the
connection.

| Query param | Type   | Required | Description      |
| :---------- | :----- | :------- | :--------------- |
| `repoId`    | string | yes      | Repo identifier. |

**Event format:**

```
event: snapshot
data: {"schemaVersion":1,"repoId":"...","generatedAt":"...","cache":{...},...}

event: heartbeat
data: {"t":1735632000000}
```

The connection ends cleanly if the client disconnects or if the response stream errors;
the service automatically `unsubscribe()`s. Implementations should reconnect with
exponential backoff if the stream drops.

**Status codes**: 200 with `Content-Type: text/event-stream`, 400, 401, 404, 503.

---

## Configuration reference

All settings live under the top-level `observability` key in `sdlmcp.config.json`. Defaults
are loaded from `ObservabilityConfigSchema` in `src/config/types.ts`.

| Key                          | Type    | Default | Range          | Description                                                                                                                                                                          |
| :--------------------------- | :------ | :------ | :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                    | boolean | `true`  | —              | Master switch. When `false`, the service is not started, the four `/api/observability/*` routes return `503`, and the UI shell still serves but shows a "disabled" badge.            |
| `sampleIntervalMs`           | integer | `2000`  | `250`–`60000`  | Interval between resource and pool/drain samples. Lowering this increases per-sample overhead; the default 2 s is tuned to avoid contention with the serialized DB write connection. |
| `retentionShortMinutes`      | integer | `15`    | `1`–`60`       | Retention for the short timeseries buffer. Backs the `15m` window. The dashboard's high-resolution panels read from here.                                                            |
| `retentionLongHours`         | integer | `24`    | `1`–`168`      | Retention for the long buffer. Backs the `24h` window. Hourly aggregates land here.                                                                                                  |
| `pprMetricsEnabled`          | boolean | `true`  | —              | When `false`, the `ppr.*` block of the snapshot is held at zero and PPR tap events are dropped. Useful when PPR is disabled across the deployment.                                   |
| `packedStatsEnabled`         | boolean | `true`  | —              | Disable to suppress `packed.*` metrics if the wire-format gate is not relevant to your deployment.                                                                                   |
| `scipIngestMetrics`          | boolean | `true`  | —              | Disable to suppress `scip.*` metrics for deployments not using SCIP.                                                                                                                 |
| `beamExplainCapacity`        | integer | `128`   | `8`–`2048`     | Maximum number of slice builds retained in the beam-explain LRU. Older slices are evicted when the cap is reached.                                                                   |
| `beamExplainEntriesPerSlice` | integer | `512`   | `16`–`8192`    | Maximum number of decision entries retained per slice. When exceeded, the oldest entries are dropped and the response sets `truncated: true`.                                        |
| `sseHeartbeatMs`             | integer | `15000` | `1000`–`60000` | Heartbeat interval on `/api/observability/stream`. Increase for proxies with longer idle timeouts; decrease when running behind aggressive timeouts.                                 |

Example override (only the fields you need to change need appear):

```json
{
  "observability": {
    "enabled": true,
    "sampleIntervalMs": 5000,
    "retentionShortMinutes": 30,
    "retentionLongHours": 48,
    "sseHeartbeatMs": 10000
  }
}
```

---

## Metric definitions

Every field below is taken verbatim from `src/observability/types.ts`. Field names are
camelCase; numeric percentages are 0–100 unless explicitly suffixed `Ratio` (in which case
they are 0–1). Latency values are milliseconds. New fields may be added in minor versions;
existing fields will not change semantics.

### `ObservabilitySnapshot` (top level)

| Field           | Type            | Meaning                                         |
| :-------------- | :-------------- | :---------------------------------------------- |
| `schemaVersion` | `1`             | Reserved for future evolution.                  |
| `generatedAt`   | ISO 8601 string | When the service materialized the snapshot.     |
| `repoId`        | string          | Repo this snapshot scopes to.                   |
| `uptimeMs`      | number          | Service uptime in milliseconds since `start()`. |

### `cache: CacheMetrics`

Tracks all in-process caches (card cache, slice cache, embedding cache, query plans, etc.).

| Field                | Type                                 | Meaning / interpretation                                                                                                                                                                             |
| :------------------- | :----------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overallHitRatePct`  | number 0–100                         | Aggregate cache hit rate across all sources. <60% on a long-lived process suggests churn; >95% with low traffic suggests warm hot keys.                                                              |
| `totalHits`          | number                               | Hits since service start. Combine with `totalMisses` for sanity checks.                                                                                                                              |
| `totalMisses`        | number                               | Misses since service start.                                                                                                                                                                          |
| `perSource`          | `Record<string, CacheSourceMetrics>` | Keyed by source name (`cardCache`, `sliceCache`, `embeddingCache`, etc.). Each entry has `source`, `hits`, `misses`, `hitRatePct`, `avgLatencyMs`. Use this to find a single under-performing cache. |
| `avgLookupLatencyMs` | number                               | Average lookup time across all caches. Spikes imply lock contention or oversized cache scans.                                                                                                        |

### `retrieval: RetrievalMetrics`

Hybrid retrieval pipeline (FTS + vector + PPR + RRF fusion).

| Field                     | Type                     | Meaning                                                                                                         |
| :------------------------ | :----------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `totalRetrievals`         | number                   | Lifetime retrievals observed.                                                                                   |
| `avgLatencyMs`            | number                   | Mean end-to-end retrieval time.                                                                                 |
| `p95LatencyMs`            | number                   | 95th percentile latency. The dashboard "Retrieval" panel surfaces this prominently.                             |
| `byMode`                  | `Record<string, number>` | Dispatch counts per retrieval mode (`hybrid`, `lexical`, `semantic`, etc.).                                     |
| `candidateCountPerSource` | `Record<string, number>` | Volume of candidates per source — `fts`, `vector`, `ppr`, `hybrid`, etc. Imbalance suggests a mis-tuned source. |
| `byRetrievalType`         | `Record<string, number>` | Counts by call site (`context`, `search`, ...).                                                                 |
| `emptyResultCount`        | number                   | Number of retrievals returning zero results. A rising number is an early warning for index drift.               |

### `beam: BeamSummary`

Beam-search slice builds. Detailed per-slice traces live behind `/api/observability/beam-explain`.

| Field                                        | Type   | Meaning                                                                                                                                                                                                               |
| :------------------------------------------- | :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalSliceBuilds`                           | number | Lifetime slice builds.                                                                                                                                                                                                |
| `avgBuildMs` / `p95BuildMs`                  | number | Mean / P95 wall-clock duration.                                                                                                                                                                                       |
| `avgAccepted` / `avgEvicted` / `avgRejected` | number | Mean per-slice frontier statistics — accepted nodes win and stay, evicted nodes lost the score race, rejected nodes were filtered before scoring. High eviction with low acceptance suggests the budget is too tight. |
| `retainedExplainHandles`                     | number | Live entries in the beam-explain LRU. Bounded by `beamExplainCapacity`.                                                                                                                                               |

### `indexing: IndexingMetrics`

| Field                       | Type                           | Meaning                                                                                                                                                                             |
| :-------------------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `totalEvents`               | number                         | File-level indexing events since start.                                                                                                                                             |
| `filesPerMinute`            | number                         | Throughput averaged over the short window. Compare to `health.watcherStale` when investigating slowdowns.                                                                           |
| `avgPass1Ms` / `avgPass2Ms` | number                         | Mean phase durations. Pass-1 = local extraction, pass-2 = cross-file resolution.                                                                                                    |
| `phaseCounts`               | `Record<string, number>`       | Counts per phase (`pass1`, `pass2`, `drain`, `scip`, etc.).                                                                                                                         |
| `perLanguageAvgMs`          | `Record<string, number>`       | Mean parse duration per language. Use to find the slowest adapter.                                                                                                                  |
| `engineDispatch`            | `{ rust: number; ts: number }` | Dispatch counts. A nonzero `ts` count outside fallback scenarios indicates the native addon is unavailable.                                                                         |
| `failures`                  | number                         | Total failed indexing events.                                                                                                                                                       |
| `derivedStateLagMs`         | `number \| null`               | Lag between the latest version and the computed derived state. `null` means not yet measured. Lag growing without bound indicates the cluster/process/summary pipeline is starving. |

### `tokenEfficiency: TokenEfficiencyMetrics`

| Field          | Type       | Meaning                                                                                |
| :------------- | :--------- | :------------------------------------------------------------------------------------- |
| `totalUsed`    | number     | Sum of tokens across all observed tool calls.                                          |
| `totalSaved`   | number     | Estimated tokens saved versus a raw-file equivalent baseline.                          |
| `savingsRatio` | number 0–1 | `totalSaved / (totalSaved + totalUsed)` — 0 = no savings, 1 = effectively infinite.    |
| `avgPerCall`   | number     | Mean tokens per call. Spikes suggest agents are taking the raw-window path more often. |

### `health: HealthMetrics`

| Field               | Type         | Meaning                                                                                                  |
| :------------------ | :----------- | :------------------------------------------------------------------------------------------------------- |
| `score`             | number 0–100 | Composite health score (matches `repo.status.healthScore`).                                              |
| `components`        | object       | Individual contributors 0–1 each: `freshness`, `coverage`, `errorRate`, `edgeQuality`, `callResolution`. |
| `watcherRunning`    | boolean      | True when the file watcher loop is alive.                                                                |
| `watcherQueueDepth` | number       | Pending watcher events. Sustained nonzero depth = watcher saturating.                                    |
| `watcherStale`      | boolean      | True when the watcher reports it has not made forward progress.                                          |

### `latency: LatencyMetrics`

End-to-end MCP tool dispatch latency.

| Field                                       | Type                             | Meaning                                                                                                      |
| :------------------------------------------ | :------------------------------- | :----------------------------------------------------------------------------------------------------------- |
| `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`, `maxMs` | number                           | Aggregate distribution.                                                                                      |
| `perTool`                                   | `Record<string, LatencyPerTool>` | Each entry carries `count`, `avgMs`, `p95Ms`, `errorCount`. The dashboard's per-tool panel sorts by `p95Ms`. |

### `pool: PoolMetrics`

DB write-pool and indexer drain saturation.

| Field                                       | Type   | Meaning                                                                                     |
| :------------------------------------------ | :----- | :------------------------------------------------------------------------------------------ |
| `avgWriteQueued` / `maxWriteQueued`         | number | Write-pool queue depth. >0 mean and a high max indicates writes are backing up.             |
| `avgWriteActive`                            | number | Mean active workers. With single-writer serialization this is bounded at 1.0.               |
| `avgDrainQueueDepth` / `maxDrainQueueDepth` | number | Drain queue depth from `getActiveDrainStats()`. Indexer batch-persist saturation indicator. |
| `totalDrainFailures`                        | number | Lifetime drain failures.                                                                    |

### `scip: ScipMetrics`

| Field                           | Type             | Meaning                                                  |
| :------------------------------ | :--------------- | :------------------------------------------------------- |
| `totalIngests`                  | number           | Lifetime ingest invocations.                             |
| `successCount` / `failureCount` | number           | Outcome counts.                                          |
| `totalEdgesCreated`             | number           | Newly created edges across all ingests.                  |
| `totalEdgesUpgraded`            | number           | Heuristic-to-exact upgrades — the primary value of SCIP. |
| `avgIngestMs`                   | number           | Mean ingest duration.                                    |
| `lastIngestAt`                  | `string \| null` | ISO 8601 timestamp, `null` if never run.                 |

### `packed: PackedWireMetrics`

Two-axis packed wire format adoption.

| Field                                                      | Type                      | Meaning                                                                                          |
| :--------------------------------------------------------- | :------------------------ | :----------------------------------------------------------------------------------------------- |
| `totalDecisions`                                           | number                    | Encode decisions observed.                                                                       |
| `packedCount` / `fallbackCount`                            | number                    | Times the packed encoder won / fell back to JSON.                                                |
| `packedAdoptionPct`                                        | number 0–100              | `packedCount / totalDecisions * 100`.                                                            |
| `packedBytesTotal`, `jsonBaselineBytesTotal`, `bytesSaved` | number                    | Raw byte accounting.                                                                             |
| `bytesSavedRatio`                                          | number 0–1                | `bytesSaved / jsonBaselineBytesTotal`.                                                           |
| `axisHits`                                                 | `{ bytes, tokens, none }` | Which gate axis tripped per decision. `tokens` dominating is expected for slice-shaped payloads. |
| `perEncoder`                                               | `Record<string, number>`  | Per-encoder counts (`sl1`, `ss1`, `ctx1`, `gen1`).                                               |

### `ppr: PprMetrics`

Personalized PageRank dispatch metrics.

| Field                                       | Type       | Meaning                                                              |
| :------------------------------------------ | :--------- | :------------------------------------------------------------------- |
| `totalRuns`                                 | number     | Lifetime runs.                                                       |
| `nativeCount` / `jsCount` / `fallbackCount` | number     | Backend dispatch breakdown. `nativeRatio = nativeCount / totalRuns`. |
| `nativeRatio`                               | number 0–1 | Native dispatch ratio.                                               |
| `avgComputeMs` / `p95ComputeMs`             | number     | Compute time distribution.                                           |
| `avgTouched`                                | number     | Mean nodes touched per run.                                          |
| `avgSeedCount`                              | number     | Mean seed count per run.                                             |

### `resources: ResourceMetrics`

Process-level samples taken at `sampleIntervalMs`.

| Field                                     | Type         | Meaning                                                                               |
| :---------------------------------------- | :----------- | :------------------------------------------------------------------------------------ |
| `cpuPctAvg` / `cpuPctMax`                 | number 0–100 | CPU summed over cores divided by core count.                                          |
| `rssMb` / `rssMbMax`                      | number       | Resident set size in MB.                                                              |
| `heapUsedMb` / `heapTotalMb`              | number       | V8 heap state. Rising used while total stays flat = memory pressure.                  |
| `eventLoopLagP95Ms` / `eventLoopLagMaxMs` | number       | Event-loop lag from `monitorEventLoopDelay`. >50 ms P95 is a strong CPU-bound signal. |

### `bottleneck: BottleneckSummary`

| Field        | Type                                 | Meaning                                                                                                                                                 |
| :----------- | :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dominant`   | `BottleneckClass`                    | One of `cpu_bound`, `memory_pressure`, `db_latency`, `indexer_parse`, `io_throughput`, `balanced`. See [Bottleneck classifier](#bottleneck-classifier). |
| `confidence` | number 0–1                           | Margin of the dominant class over the runner-up.                                                                                                        |
| `topSignals` | `Array<{name, value, unit, weight}>` | Ordered by weight descending. The UI renders these as the top three pill labels in the bottleneck panel.                                                |

### `toolVolume: ToolVolume`

| Field            | Type                     | Meaning                                                                         |
| :--------------- | :----------------------- | :------------------------------------------------------------------------------ |
| `totalCalls`     | number                   | Lifetime tool calls observed.                                                   |
| `perTool`        | `Record<string, number>` | Counts keyed by tool name (`sdl.file`, `sdl.search.edit`, `sdl.context`, etc.). |
| `perToolErrors`  | `Record<string, number>` | Per-tool error counts.                                                          |
| `callsPerMinute` | number                   | Throughput averaged over the short window.                                      |

---

## Bottleneck classifier

`classifyBottleneck` is a pure deterministic function in
`src/observability/bottleneck-classifier.ts`. Given a `ClassifierInput` snapshot, it scores
each rule independently in `[0, 1]`, picks the highest-scoring class as `dominant`, and
computes confidence as `(top - runnerUp) / max(top, 1e-6)` clamped to `[0, 1]`.

### Rules (taken from the function JSDoc)

| Class             | Heuristic                                            | What it means                                                                           | Suggested action                                                                                                                                            |
| :---------------- | :--------------------------------------------------- | :-------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpu_bound`       | `cpuPctAvg > 75` AND `eventLoopLagP95Ms < 50`        | High CPU but the event loop is healthy — work is in worker threads or busy native code. | Profile native pass-1 / pass-2; consider reducing `indexing.maxConcurrency` if multiple workers are saturating cores.                                       |
| `memory_pressure` | `rssMb > 1500` OR `heapUsed / heapTotal > 0.85`      | RSS over 1.5 GB or heap over 85% utilized.                                              | Check for embedding-cache bloat, slice-cache size limits, or a leaked subscriber. Reduce `retentionLongHours` if it is set high.                            |
| `db_latency`      | `dbLatencyP95Ms > 200` OR `poolWriteQueuedAvg > 5`   | DB write path saturating — write-pool queue is filling.                                 | Check for long-running write transactions; lower indexer batch sizes; verify `getActiveDrainStats()` is not stuck.                                          |
| `indexer_parse`   | `indexerParseP95Ms > 500`                            | Per-file parse times are above 500 ms P95.                                              | Identify the slow language adapter via `indexing.perLanguageAvgMs`. Check for very large source files; raise `maxFileBytes` cap if files are being skipped. |
| `io_throughput`   | `ioThroughputMbPerSec / saturationThreshold >= 0.85` | I/O is approaching the configured saturation threshold.                                 | Verify the saturation threshold is realistic for the host; check for noisy-neighbor disk usage; consider relocating the graph DB file to a faster volume.   |
| `balanced`        | always 0.1 (floor)                                   | No rule scored higher. The system is healthy.                                           | None — this is the steady state.                                                                                                                            |

The `topSignals` array carries the strongest contributors to the dominant class so
operators can see _why_ the classifier picked it. For example, a `cpu_bound` decision
with `cpuPctAvg = 92, cpuPctMax = 99, eventLoopLagP95Ms = 8` makes the diagnosis
obvious without consulting raw timeseries.

### Determinism

The function is **pure**: same input always produces the same output. This makes it safe
to run inside the SSE tick loop without introducing nondeterministic noise into the
dashboard. It is a heuristic — not a substitute for `clinic`, `0x`, or VTune — but it is
extremely useful for at-a-glance triage.

---

## Beam explain

The `/api/observability/beam-explain` endpoint and the dashboard's "Beam Explain" panel
share the same data: a per-slice trace of every iteration of the beam-search engine.

### Using the UI

1. Run a slice build via `sdl.slice.build` and copy the returned `sliceHandle`.
2. Open `/ui/observability` in a browser.
3. Paste the slice handle into the Beam Explain panel input.
4. The panel renders one row per `BeamExplainEntry` with `decision`, `totalScore`, the
   `BeamScoreComponents` breakdown, the rationale (`why`), and edge metadata if present.
5. Optionally filter by `symbolId` to focus on one node's history.

### `decision` enum

| Value      | Meaning                                                                                                                                  |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted` | The node won its score race for the current iteration. It is included in the slice and may seed further expansion.                       |
| `evicted`  | The node had been previously accepted but was kicked out by a higher-scoring competitor when the frontier filled.                        |
| `rejected` | The node never made it past the candidate filter — its score was below threshold or it failed an early filter (kind, depth, confidence). |

### `BeamScoreComponents`

The serializer breaks down the total score into:

| Component               | Source                                                                   |
| :---------------------- | :----------------------------------------------------------------------- |
| `query`                 | Lexical or semantic match against the task text / entry symbols.         |
| `stacktrace`            | Boost for symbols mentioned in a supplied stack trace (when applicable). |
| `hotness`               | Centrality and churn-derived hotness signal.                             |
| `structure`             | Graph-structural fit — fan-in / fan-out balance.                         |
| `kind`                  | Symbol-kind weight (function vs. variable vs. interface, etc.).          |
| `centrality` (optional) | Cluster-level centrality when computed.                                  |
| `ppr` (optional)        | Personalized PageRank score from start nodes when PPR is on.             |

### LRU eviction

The store is bounded by two caps:

- **Slice cap** (`beamExplainCapacity`, default 128) — when a 129th slice publishes, the
  least-recently-used slice handle is evicted in full.
- **Per-slice cap** (`beamExplainEntriesPerSlice`, default 512) — once a slice's entry
  count reaches this cap, the oldest entries are dropped and the slice's
  `truncated` flag flips to `true`.

LRU order is maintained via `Map` insertion order: every publish or query for an entry
deletes-and-re-inserts so the most-recently-used handle sits at the tail.

---

## Operational overhead

The observability subsystem is designed to add **under 2% extra CPU** and **under 100 MB
extra RSS** at default settings on a steady-state server. These targets are met by:

- Forwarding every event in-process — no IPC, no socket, no extra serialization layer.
- Using ring buffers for both retention windows; old samples are overwritten in place.
- Running the sampling tick at 2-second cadence (`sampleIntervalMs = 2000`) — this is
  intentionally tuned so the sample tick does not race the **serialized DB write
  connection** under load. Samples that race the write connection are skipped rather
  than queued.
- Computing snapshots **on demand** when `/api/observability/snapshot` is called, not on
  every tick. The SSE stream pushes the same on-demand snapshot at the sample cadence.

### When to disable

For ultra-low-overhead deployments where every joule matters:

```json
{ "observability": { "enabled": false } }
```

Disabling the service fully short-circuits the tap (events are not forwarded), the
sampling timer is never set, and the four `/api/observability/*` routes return `503`.

For deployments that want most of the benefit at lower cost:

```json
{
  "observability": {
    "enabled": true,
    "sampleIntervalMs": 5000,
    "retentionShortMinutes": 5,
    "retentionLongHours": 6,
    "beamExplainCapacity": 32,
    "beamExplainEntriesPerSlice": 128
  }
}
```

Cuts memory by roughly 4x and per-tick CPU by roughly 2.5x without losing the qualitative
signal.

---

## V1 limitations + V2 roadmap

V1 is **read-only** and **in-memory**. The following are out of scope for V1 and planned
for V2:

| Limitation (V1)                                                                  | V2 plan                                                                                                                                                                                               |
| :------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No live tuning controls — every knob is config-file only and requires a restart. | Add authenticated mutation endpoints under `/api/observability/admin/*` with audit logging.                                                                                                           |
| In-memory windows only. Metrics are lost on process restart.                     | Optional persistence to a small SQLite or DuckDB warehouse, retained across restarts and queryable via SQL.                                                                                           |
| HTTP transport required. Stdio agents see no dashboard.                          | The HTTP transport requirement is structural — V2 will keep this constraint, but add a "satellite" mode that streams snapshots over MCP notifications so stdio agents can visualize them out-of-band. |
| Bottleneck classifier is heuristic.                                              | V2 will keep the deterministic heuristic but add a learned model that runs alongside as a comparison signal.                                                                                          |
| No alerting.                                                                     | Add threshold-based alert rules driven by the classifier and configurable webhooks.                                                                                                                   |

---

## Troubleshooting

### `/api/observability/*` returns `401 Unauthorized`

Bearer token is missing or wrong. The token is printed to stderr at server startup (look
for `[sdl-mcp] HTTP auth token: ...`). Pass it as `Authorization: Bearer <token>` on every
request. To set a static token instead of a generated one, configure
`httpAuth.token` — see [Configuration reference → httpAuth](../configuration-reference.md#httpauth-optional).

To temporarily disable auth on a trusted local machine:

```json
{ "httpAuth": { "enabled": false } }
```

### `/api/observability/*` returns `503 observability_disabled`

The `observability.enabled` config key is `false`. Set it to `true` (or remove the
override; it defaults to `true`) and restart the server.

### `/api/observability/*` returns `404 repo_not_found`

The `repoId` you passed is not registered. List registered repos via
`sdl.repo.status` or `/api/repo/<repoId>/status`. Repo identifiers are case-sensitive.

### SSE drops connection after ~30–60 seconds

Some reverse proxies idle-close streams without traffic. Lower `sseHeartbeatMs` so the
server emits heartbeats more frequently:

```json
{ "observability": { "sseHeartbeatMs": 5000 } }
```

If you control the proxy, raise its idle timeout instead — heartbeats are cheap but
they are still bytes on the wire.

### "model not yet downloaded" badge in the embedding-cache panel

The embedding cache reports zero hits because the configured ONNX model has not been
fetched yet. The bundled model (`all-MiniLM-L6-v2`) is always present; `nomic-embed-text-v1.5`
and `jina-embeddings-v2-base-code` are fetched on `npm install` postinstall. If postinstall
was skipped (`npm ci --ignore-scripts`), run `npm rebuild` or wait for the lazy fetch to
complete on the first semantic search. See
[Semantic Embeddings Setup](./semantic-embeddings-setup.md) for the full model matrix.

### Beam-explain returns `404` for a slice handle that just resolved

The slice handle has been evicted from the LRU. By default the LRU keeps the 128
most-recent slice builds (`beamExplainCapacity`). Rebuild the slice or raise the cap if
you need a longer retention window.

### Bottleneck classifier always reports `balanced` under load

The signals fed to the classifier are read straight from the snapshot. If `cpuPctAvg`,
`rssMb`, `dbLatencyP95Ms`, etc. are all reading zero, either:

- The sample tick has not fired yet (give it `sampleIntervalMs` to warm up).
- A required probe is unavailable on this host (event-loop monitor unavailable on very
  old Node) — check `sdl-mcp info` for probe availability.

### Dashboard panels show stale data

The UI subscribes to `/api/observability/stream`. If the SSE connection has been closed
the page does not auto-refresh. Reload the page or check the browser devtools network tab
for a closed `text/event-stream` request.

---

[Back to documentation hub](../README.md)
