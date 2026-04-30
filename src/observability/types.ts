/**
 * Public type surface for the observability dashboard.
 *
 * These shapes are CONSUMED by Agents B/C/D/E:
 *   - Agent B populates BeamExplain* via the BeamExplainStore.
 *   - Agent C wires telemetry forwards into ObservabilityTap.
 *   - Agent D reads ObservabilitySnapshot/TimeseriesResponse over HTTP.
 *   - Agent E renders every field in the dashboard UI.
 *
 * Stability contract: field names must remain camelCase and semantics must
 * not change between minor versions. New fields may be added; existing fields
 * must use the same units. Numeric percentages are 0-100 (not 0-1) unless the
 * field is explicitly named *Ratio. Latency values are milliseconds.
 */

/* -------------------------------------------------------------------------- */
/* Sub-shapes                                                                  */
/* -------------------------------------------------------------------------- */

export interface CacheMetrics {
  /** Hit rate as a percentage 0-100 across all cache sources. */
  overallHitRatePct: number;
  /** Total hits since service start. */
  totalHits: number;
  /** Total misses since service start. */
  totalMisses: number;
  /** Per-source breakdown keyed by source name (cardCache, sliceCache, etc.). */
  perSource: Record<string, CacheSourceMetrics>;
  /** Average lookup latency in milliseconds across all sources. */
  avgLookupLatencyMs: number;
}

export interface CacheSourceMetrics {
  source: string;
  hits: number;
  misses: number;
  hitRatePct: number;
  avgLatencyMs: number;
}

export interface RetrievalMetrics {
  /** Total semantic-search style retrievals. */
  totalRetrievals: number;
  /** Average end-to-end retrieval time in milliseconds. */
  avgLatencyMs: number;
  /** P95 latency in milliseconds. */
  p95LatencyMs: number;
  /** Retrieval mode dispatch counts. */
  byMode: Record<string, number>;
  /** FTS / vector / PPR / hybrid candidate volume per source. */
  candidateCountPerSource: Record<string, number>;
  /** Count by retrievalType (e.g. "context", "search"). */
  byRetrievalType: Record<string, number>;
  /** Count of empty-result retrievals. */
  emptyResultCount: number;
}

export interface BeamSummary {
  /** Total beam-search slice builds observed. */
  totalSliceBuilds: number;
  /** Average slice build duration in milliseconds. */
  avgBuildMs: number;
  /** P95 slice build duration in milliseconds. */
  p95BuildMs: number;
  /** Average accepted node count per slice. */
  avgAccepted: number;
  /** Average evicted node count per slice. */
  avgEvicted: number;
  /** Average rejected node count per slice. */
  avgRejected: number;
  /** Number of slice handles currently retained for explain queries. */
  retainedExplainHandles: number;
}

export interface IndexingMetrics {
  /** Total indexing events (file-level) since service start. */
  totalEvents: number;
  /** Files per minute averaged over the short window. */
  filesPerMinute: number;
  /** Average duration of pass-1 phase across runs in milliseconds. */
  avgPass1Ms: number;
  /** Average duration of pass-2 phase across runs in milliseconds. */
  avgPass2Ms: number;
  /** Phase counts keyed by phase name (pass1, pass2, drain, scip, etc.). */
  phaseCounts: Record<string, number>;
  /** Per-language average parse duration in milliseconds. */
  perLanguageAvgMs: Record<string, number>;
  /** Engine dispatch counts (rust vs ts). */
  engineDispatch: { rust: number; ts: number };
  /** Failed indexing events since service start. */
  failures: number;
  /** Lag between latest version and computed derived state in milliseconds, or null if not yet measured. */
  derivedStateLagMs: number | null;
}

export interface TokenEfficiencyMetrics {
  /** Total tokens used (sum of all tool requests/responses observed). */
  totalUsed: number;
  /** Estimated tokens saved vs raw-equivalent baseline. */
  totalSaved: number;
  /** Saved-vs-used ratio (0-1) — 0 means no savings, 1 means infinite savings. */
  savingsRatio: number;
  /** Average tokens per tool call. */
  avgPerCall: number;
}

export interface HealthMetrics {
  /** Composite health score 0-100. */
  score: number;
  /** Individual contributing health components 0-1 each. */
  components: {
    freshness: number;
    coverage: number;
    errorRate: number;
    edgeQuality: number;
    callResolution: number;
  };
  /** Watcher running flag. */
  watcherRunning: boolean;
  /** Watcher event queue depth. */
  watcherQueueDepth: number;
  /** True when watcher is reporting stale state. */
  watcherStale: boolean;
}

export interface LatencyMetrics {
  /** Average tool-call duration in milliseconds. */
  avgMs: number;
  /** P50 duration in milliseconds. */
  p50Ms: number;
  /** P95 duration in milliseconds. */
  p95Ms: number;
  /** P99 duration in milliseconds. */
  p99Ms: number;
  /** Maximum observed duration in milliseconds. */
  maxMs: number;
  /** Tool-call counts keyed by tool name. */
  perTool: Record<string, LatencyPerTool>;
}

export interface LatencyPerTool {
  count: number;
  avgMs: number;
  p95Ms: number;
  errorCount: number;
}

export interface PoolMetrics {
  /** Average write-pool queued depth. */
  avgWriteQueued: number;
  /** Maximum observed write-pool queued depth. */
  maxWriteQueued: number;
  /** Average write-pool active workers. */
  avgWriteActive: number;
  /** Average drain queue depth. */
  avgDrainQueueDepth: number;
  /** Maximum observed drain queue depth. */
  maxDrainQueueDepth: number;
  /** Total drain failures since service start. */
  totalDrainFailures: number;
}

export interface ScipMetrics {
  /** Total SCIP ingest invocations. */
  totalIngests: number;
  /** Successful ingests since service start. */
  successCount: number;
  /** Failed ingests since service start. */
  failureCount: number;
  /** Total edges newly created across all ingests. */
  totalEdgesCreated: number;
  /** Total heuristic-to-exact edge upgrades. */
  totalEdgesUpgraded: number;
  /** Average ingest duration in milliseconds. */
  avgIngestMs: number;
  /** Last ingest ISO timestamp, or null if never run. */
  lastIngestAt: string | null;
}

export interface PackedWireMetrics {
  /** Total packed-wire encode decisions observed. */
  totalDecisions: number;
  /** Count where the packed encoder was used. */
  packedCount: number;
  /** Count where the encoder fell back to legacy JSON. */
  fallbackCount: number;
  /** Adoption rate as a percentage 0-100. */
  packedAdoptionPct: number;
  /** Cumulative bytes of packed-encoded responses. */
  packedBytesTotal: number;
  /** Cumulative bytes had we used JSON instead. */
  jsonBaselineBytesTotal: number;
  /** Bytes saved vs JSON baseline. */
  bytesSaved: number;
  /** Savings ratio (0-1). */
  bytesSavedRatio: number;
  /** Hits broken down by axis the gate tripped on. */
  axisHits: { bytes: number; tokens: number; none: number };
  /** Per-encoder counts. */
  perEncoder: Record<string, number>;
  /** Per-encoder breakdown including bytes saved and adoption. */
  byEncoder: Record<
    string,
    {
      totalDecisions: number;
      packedCount: number;
      fallbackCount: number;
      packedAdoptionPct: number;
      jsonBaselineBytesTotal: number;
      packedBytesTotal: number;
      bytesSaved: number;
      bytesSavedRatio: number;
    }
  >;
}

export interface PprMetrics {
  /** Total PPR runs observed. */
  totalRuns: number;
  /** Native (Rust) backend dispatch count. */
  nativeCount: number;
  /** JS backend dispatch count. */
  jsCount: number;
  /** Fallback BFS dispatch count. */
  fallbackCount: number;
  /** Native dispatch ratio (0-1). */
  nativeRatio: number;
  /** Average compute duration in milliseconds. */
  avgComputeMs: number;
  /** P95 compute duration in milliseconds. */
  p95ComputeMs: number;
  /** Average touched-node count. */
  avgTouched: number;
  /** Average seed count per run. */
  avgSeedCount: number;
}

export interface ResourceMetrics {
  /** Average CPU percent (0-100, summed over all cores divided by core count). */
  cpuPctAvg: number;
  /** Maximum CPU percent observed. */
  cpuPctMax: number;
  /** Resident set size in MB (latest sample). */
  rssMb: number;
  /** Maximum RSS observed in MB. */
  rssMbMax: number;
  /** Heap used in MB (latest sample). */
  heapUsedMb: number;
  /** Heap total in MB (latest sample). */
  heapTotalMb: number;
  /** P95 event-loop lag in milliseconds. */
  eventLoopLagP95Ms: number;
  /** Maximum event-loop lag in milliseconds. */
  eventLoopLagMaxMs: number;
}

export type BottleneckClass =
  | "cpu_bound"
  | "memory_pressure"
  | "db_latency"
  | "indexer_parse"
  | "io_throughput"
  | "balanced";

export interface BottleneckSummary {
  dominant: BottleneckClass;
  /** Confidence in the dominant classification (0-1). */
  confidence: number;
  /** Top contributing signals, ordered by weight descending. */
  topSignals: Array<{
    name: string;
    value: number;
    unit: string;
    weight: number;
  }>;
}

export interface ToolVolume {
  /** Total tool calls observed since service start. */
  totalCalls: number;
  /** Per-tool call counts. Keys include "sdl.file", "sdl.search.edit", "sdl.context", etc. */
  perTool: Record<string, number>;
  /** Per-tool error counts. */
  perToolErrors: Record<string, number>;
  /** Calls per minute averaged over the short window. */
  callsPerMinute: number;
}

/* -------------------------------------------------------------------------- */
/* Top-level snapshot                                                          */
/* -------------------------------------------------------------------------- */

export interface AuditBufferMetrics {
  /** Current in-memory audit buffer depth. */
  depth: number;
  /** Maximum depth observed since service start. */
  maxDepth: number;
  /** Cumulative dropped audit events since process start. */
  droppedTotal: number;
  /** True when a post-index write session is currently active. */
  sessionActive: boolean;
}

export interface PostIndexSessionMetrics {
  /** Total post-index sessions observed since service start. */
  totalSessions: number;
  /** Average session duration in milliseconds. */
  avgDurationMs: number;
  /** P50 session duration in milliseconds. */
  p50DurationMs: number;
  /** P95 session duration in milliseconds. */
  p95DurationMs: number;
  /** P99 session duration in milliseconds. */
  p99DurationMs: number;
  /** Maximum session duration in milliseconds. */
  maxDurationMs: number;
  /** Sessions that aborted with timeout since service start. */
  timeoutCount: number;
  /** Most recent session duration in milliseconds. */
  lastDurationMs: number;
  /** Whether the most recent session timed out. */
  lastTimedOut: boolean;
  /** ISO 8601 timestamp when the most recent session ended, or null. */
  lastEndedAt: string | null;
}

export interface ObservabilitySnapshot {
  schemaVersion: 1;
  /** ISO 8601 timestamp at which the snapshot was generated. */
  generatedAt: string;
  /** Repository identifier the snapshot is scoped to. */
  repoId: string;
  /** Service uptime in milliseconds (since `start()`). */
  uptimeMs: number;

  cache: CacheMetrics;
  retrieval: RetrievalMetrics;
  beam: BeamSummary;
  indexing: IndexingMetrics;
  tokenEfficiency: TokenEfficiencyMetrics;
  health: HealthMetrics;
  latency: LatencyMetrics;
  pool: PoolMetrics;
  scip: ScipMetrics;
  packed: PackedWireMetrics;
  ppr: PprMetrics;
  resources: ResourceMetrics;
  bottleneck: BottleneckSummary;
  toolVolume: ToolVolume;
  auditBuffer: AuditBufferMetrics;
  postIndexSession: PostIndexSessionMetrics;
}

/* -------------------------------------------------------------------------- */
/* Timeseries                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A single timeseries point. The `t` field is a unix-millis timestamp.
 * Other fields vary by series — consumers should look up the specific
 * series key to know which fields to expect.
 */
export interface TimeseriesPoint {
  t: number;
  [field: string]: number;
}

export type TimeseriesWindow = "15m" | "1h" | "24h";

export interface TimeseriesResponse {
  schemaVersion: 1;
  repoId: string;
  window: TimeseriesWindow;
  /** Resolution between adjacent points in milliseconds. */
  resolutionMs: number;
  /** Series keyed by metric name. Standard keys:
   *  - cacheHitRate
   *  - p95LatencyMs
   *  - queueDepth
   *  - cpuPct
   *  - rssMb
   *  - heapUsedMb
   *  - eventLoopLagMs
   *  - tokensUsedPerMin
   *  - tokensSavedPerMin
   *  - filesPerMinute
   *  - errorRate
   *  - drainQueueDepth
   */
  series: Record<string, TimeseriesPoint[]>;
}

/* -------------------------------------------------------------------------- */
/* Beam explain (Agent B owns population; Agent A owns the wire surface)       */
/* -------------------------------------------------------------------------- */

export type BeamDecision = "accepted" | "evicted" | "rejected";
export type BeamEdgeType = "call" | "import" | "config" | "implements";

export interface BeamScoreComponents {
  query: number;
  stacktrace: number;
  hotness: number;
  structure: number;
  kind: number;
  centrality?: number;
  ppr?: number;
}

export interface BeamExplainEntry {
  symbolId: string;
  decision: BeamDecision;
  totalScore: number;
  components: BeamScoreComponents;
  /** Human-readable rationale for the decision. */
  why: string;
  edgeFromSymbolId?: string;
  edgeType?: BeamEdgeType;
  edgeWeight?: number;
  /** Iteration index within the slice build. */
  iteration: number;
  /** Unix-millis timestamp of the decision. */
  timestamp: number;
}

export interface BeamExplainResponse {
  schemaVersion: 1;
  repoId: string;
  sliceHandle: string;
  /** ISO 8601 timestamp when the slice was built. */
  builtAt: string;
  /** Bounded list of decision entries. */
  entries: BeamExplainEntry[];
  /** True when entries were dropped to fit the per-slice cap. */
  truncated: boolean;
  /** Effective edge weights used during the slice build. */
  edgeWeights: {
    call: number;
    import: number;
    config: number;
    implements: number;
  };
  /** Effective thresholds used during the slice build. */
  thresholds: { sliceScoreThreshold: number; maxFrontier: number };
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

/** Default cap per Aggregator on remembered beam-explain entries (Agent B uses this). */
export const BEAM_EXPLAIN_MAX_ENTRIES = 512;
