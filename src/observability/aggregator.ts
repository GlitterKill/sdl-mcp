/**
 * Per-repo dual-window aggregator.
 *
 * Maintains short (default 15min @ 1s resolution) and long (default 24h @ 60s
 * resolution) ring buffers of timestamped event records. Cumulative counters
 * are computed continuously since service start. Window snapshots compute
 * deltas across the appropriate ring.
 *
 * Percentile strategy: keep a sorted ring of last N=1024 latencies per dimension
 * and compute p50/p95/p99 on demand. Simpler than P²-quantile, deterministic,
 * and unit-testable.
 */

import type {
  EdgeResolutionTelemetryEvent,
  IndexEvent,
  PolicyDecisionEvent,
  PrefetchTelemetryEvent,
  RuntimeExecutionEvent,
  SemanticSearchTelemetryEvent,
  ToolCallEvent,
  WatcherHealthTelemetryEvent,
} from "../mcp/telemetry.js";
import { classifyBottleneck } from "./bottleneck-classifier.js";
import { RingBuffer } from "./ring-buffer.js";
import type {
  BeamSummary,
  CacheMetrics,
  CacheSourceMetrics,
  HealthMetrics,
  IndexingMetrics,
  LatencyMetrics,
  LatencyPerTool,
  ObservabilitySnapshot,
  PackedWireMetrics,
  PoolMetrics,
  PprMetrics,
  ResourceMetrics,
  RetrievalMetrics,
  ScipMetrics,
  TimeseriesPoint,
  TimeseriesResponse,
  TimeseriesWindow,
  TokenEfficiencyMetrics,
  ToolVolume,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Internal record shapes                                                      */
/* -------------------------------------------------------------------------- */

interface CacheOutcomeRec {
  source: string;
  hit: boolean;
  latencyMs: number;
}

interface IndexEventRec {
  durationMs: number;
  filesIndexed: number;
  failed: boolean;
  language?: string;
  engine?: "rust" | "ts";
}

interface IndexPhaseRec {
  phase: string;
  language?: string;
  durationMs: number;
}

interface PoolSampleRec {
  writeQueued: number;
  writeActive: number;
  drainQueueDepth: number;
  drainFailures: number;
}

interface ResourceSampleRec {
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  eventLoopLagMs: number;
}

interface PprResultRec {
  backend: "native" | "js" | "fallback-bfs" | string;
  computeMs: number;
  touched: number;
  seedCount: number;
  iterations?: number;
}

interface PackedWireRec {
  encoderId: string;
  jsonBytes: number;
  packedBytes: number;
  decision: "packed" | "fallback";
  axisHit: "bytes" | "tokens" | null;
}

/* -------------------------------------------------------------------------- */
/* Aggregator                                                                  */
/* -------------------------------------------------------------------------- */

export interface AggregatorOptions {
  shortWindowMs: number;
  shortCapacity: number;
  longWindowMs: number;
  longCapacity: number;
  ioThroughputSaturationMbPerSec: number;
}

export const DEFAULT_AGGREGATOR_OPTIONS: AggregatorOptions = {
  shortWindowMs: 15 * 60 * 1000,
  shortCapacity: 15 * 60, // 1s resolution
  longWindowMs: 24 * 60 * 60 * 1000,
  longCapacity: 24 * 60, // 60s resolution
  ioThroughputSaturationMbPerSec: 200,
};

const LATENCY_WINDOW_SIZE = 1024;

export class Aggregator {
  private readonly opts: AggregatorOptions;
  private readonly startedAt: number;

  // ----- cache -----
  private cacheTotalHits = 0;
  private cacheTotalMisses = 0;
  private cacheLatencySum = 0;
  private cacheLatencyCount = 0;
  private readonly cachePerSource = new Map<
    string,
    { hits: number; misses: number; latencySum: number; latencyCount: number }
  >();

  // ----- tool calls -----
  private toolCallTotal = 0;
  private readonly toolPerName = new Map<
    string,
    { count: number; durationSum: number; latencies: number[]; errors: number }
  >();
  private readonly toolLatenciesAll: number[] = [];
  private toolLatencyMax = 0;

  // ----- token efficiency -----
  private tokenUsedTotal = 0;
  private tokenSavedTotal = 0;
  private tokenSampledCalls = 0;

  // ----- retrieval -----
  private retrievalTotal = 0;
  private retrievalDurationSum = 0;
  private readonly retrievalLatencies: number[] = [];
  private retrievalEmpty = 0;
  private readonly retrievalByMode = new Map<string, number>();
  private readonly retrievalByType = new Map<string, number>();
  private readonly retrievalCandidatesPerSource = new Map<string, number>();

  // ----- indexing -----
  private indexEventTotal = 0;
  private indexFailures = 0;
  private indexPass1Sum = 0;
  private indexPass1Count = 0;
  private indexPass2Sum = 0;
  private indexPass2Count = 0;
  private readonly indexPhaseCounts = new Map<string, number>();
  private readonly indexLangSum = new Map<
    string,
    { sum: number; count: number }
  >();
  private indexEngineRust = 0;
  private indexEngineTs = 0;
  private indexFilesPerMinuteRing: RingBuffer<IndexEventRec>;
  private indexDerivedStateLagMs: number | null = null;

  // ----- watcher / health -----
  private watcherRunning = false;
  private watcherQueueDepth = 0;
  private watcherStale = false;
  private healthScore = 0;
  private healthComponents: HealthMetrics["components"] = {
    freshness: 0,
    coverage: 0,
    errorRate: 0,
    edgeQuality: 0,
    callResolution: 0,
  };

  // ----- pool -----
  private poolWriteQueuedSum = 0;
  private poolWriteQueuedCount = 0;
  private poolWriteQueuedMax = 0;
  private poolWriteActiveSum = 0;
  private poolWriteActiveCount = 0;
  private poolDrainSum = 0;
  private poolDrainCount = 0;
  private poolDrainMax = 0;
  private poolDrainFailuresTotal = 0;

  // ----- SCIP -----
  private scipTotal = 0;
  private scipSuccess = 0;
  private scipFailure = 0;
  private scipEdgesCreated = 0;
  private scipEdgesUpgraded = 0;
  private scipDurationSum = 0;
  private scipLastAt: string | null = null;

  // ----- packed wire -----
  private packedTotal = 0;
  private packedHits = 0;
  private packedFallback = 0;
  private packedJsonBytes = 0;
  private packedBytes = 0;
  private packedAxisBytes = 0;
  private packedAxisTokens = 0;
  private packedAxisNone = 0;
  private readonly packedPerEncoder = new Map<string, number>();

  // ----- PPR -----
  private pprTotal = 0;
  private pprNative = 0;
  private pprJs = 0;
  private pprFallback = 0;
  private pprComputeSum = 0;
  private readonly pprLatencies: number[] = [];
  private pprTouchedSum = 0;
  private pprSeedSum = 0;

  // ----- resources -----
  private cpuMax = 0;
  private rssMax = 0;
  private resourcesShort: RingBuffer<ResourceSampleRec>;
  private resourcesLong: RingBuffer<ResourceSampleRec>;

  // ----- timeseries-only rings -----
  private cacheHitRateShort: RingBuffer<{ hit: number; total: number }>;
  private cacheHitRateLong: RingBuffer<{ hit: number; total: number }>;
  private latencyShort: RingBuffer<number>;
  private latencyLong: RingBuffer<number>;
  private queueDepthShort: RingBuffer<number>;
  private queueDepthLong: RingBuffer<number>;
  private drainDepthShort: RingBuffer<number>;
  private drainDepthLong: RingBuffer<number>;
  private filesPerMinShort: RingBuffer<number>;
  private filesPerMinLong: RingBuffer<number>;
  private errorRateShort: RingBuffer<{ errors: number; total: number }>;
  private errorRateLong: RingBuffer<{ errors: number; total: number }>;
  private tokensUsedShort: RingBuffer<number>;
  private tokensUsedLong: RingBuffer<number>;
  private tokensSavedShort: RingBuffer<number>;
  private tokensSavedLong: RingBuffer<number>;

  // ----- beam summary tracking -----
  private beamTotalBuilds = 0;
  private readonly beamBuildLatencies: number[] = [];
  private beamAcceptedSum = 0;
  private beamEvictedSum = 0;
  private beamRejectedSum = 0;
  private beamRetainedHandles = 0;

  // ----- DB latency tracking (for bottleneck input) -----
  private readonly dbLatencies: number[] = [];

  constructor(opts: AggregatorOptions = DEFAULT_AGGREGATOR_OPTIONS) {
    this.opts = opts;
    this.startedAt = Date.now();
    this.indexFilesPerMinuteRing = new RingBuffer<IndexEventRec>(
      opts.shortCapacity,
    );
    this.resourcesShort = new RingBuffer<ResourceSampleRec>(opts.shortCapacity);
    this.resourcesLong = new RingBuffer<ResourceSampleRec>(opts.longCapacity);
    this.cacheHitRateShort = new RingBuffer(opts.shortCapacity);
    this.cacheHitRateLong = new RingBuffer(opts.longCapacity);
    this.latencyShort = new RingBuffer<number>(opts.shortCapacity);
    this.latencyLong = new RingBuffer<number>(opts.longCapacity);
    this.queueDepthShort = new RingBuffer<number>(opts.shortCapacity);
    this.queueDepthLong = new RingBuffer<number>(opts.longCapacity);
    this.drainDepthShort = new RingBuffer<number>(opts.shortCapacity);
    this.drainDepthLong = new RingBuffer<number>(opts.longCapacity);
    this.filesPerMinShort = new RingBuffer<number>(opts.shortCapacity);
    this.filesPerMinLong = new RingBuffer<number>(opts.longCapacity);
    this.errorRateShort = new RingBuffer(opts.shortCapacity);
    this.errorRateLong = new RingBuffer(opts.longCapacity);
    this.tokensUsedShort = new RingBuffer<number>(opts.shortCapacity);
    this.tokensUsedLong = new RingBuffer<number>(opts.longCapacity);
    this.tokensSavedShort = new RingBuffer<number>(opts.shortCapacity);
    this.tokensSavedLong = new RingBuffer<number>(opts.longCapacity);
  }

  /* ---------------------- recording ---------------------- */

  recordCacheOutcome(rec: CacheOutcomeRec): void {
    if (rec.hit) this.cacheTotalHits += 1;
    else this.cacheTotalMisses += 1;
    if (Number.isFinite(rec.latencyMs) && rec.latencyMs >= 0) {
      this.cacheLatencySum += rec.latencyMs;
      this.cacheLatencyCount += 1;
    }
    let bucket = this.cachePerSource.get(rec.source);
    if (!bucket) {
      bucket = { hits: 0, misses: 0, latencySum: 0, latencyCount: 0 };
      this.cachePerSource.set(rec.source, bucket);
    }
    if (rec.hit) bucket.hits += 1;
    else bucket.misses += 1;
    if (Number.isFinite(rec.latencyMs) && rec.latencyMs >= 0) {
      bucket.latencySum += rec.latencyMs;
      bucket.latencyCount += 1;
    }
    const total = (rec.hit ? 1 : 0) + (rec.hit ? 0 : 1);
    this.cacheHitRateShort.push({ hit: rec.hit ? 1 : 0, total });
    this.cacheHitRateLong.push({ hit: rec.hit ? 1 : 0, total });
  }

  recordToolCall(
    event: ToolCallEvent & {
      errored?: boolean;
      tokensUsed?: number;
      tokensSaved?: number;
    },
  ): void {
    const tool = event.tool;
    const dur = Number.isFinite(event.durationMs) ? event.durationMs : 0;
    const errored = event.errored === true;
    this.toolCallTotal += 1;
    let bucket = this.toolPerName.get(tool);
    if (!bucket) {
      bucket = { count: 0, durationSum: 0, latencies: [], errors: 0 };
      this.toolPerName.set(tool, bucket);
    }
    bucket.count += 1;
    bucket.durationSum += dur;
    pushBoundedSorted(bucket.latencies, dur, LATENCY_WINDOW_SIZE);
    if (errored) bucket.errors += 1;
    pushBoundedSorted(this.toolLatenciesAll, dur, LATENCY_WINDOW_SIZE);
    if (dur > this.toolLatencyMax) this.toolLatencyMax = dur;

    this.latencyShort.push(dur);
    this.latencyLong.push(dur);
    this.errorRateShort.push({ errors: errored ? 1 : 0, total: 1 });
    this.errorRateLong.push({ errors: errored ? 1 : 0, total: 1 });

    if (
      typeof event.tokensUsed === "number" &&
      Number.isFinite(event.tokensUsed)
    ) {
      this.tokenUsedTotal += event.tokensUsed;
      this.tokenSampledCalls += 1;
      this.tokensUsedShort.push(event.tokensUsed);
      this.tokensUsedLong.push(event.tokensUsed);
    }
    if (
      typeof event.tokensSaved === "number" &&
      Number.isFinite(event.tokensSaved)
    ) {
      this.tokenSavedTotal += event.tokensSaved;
      this.tokensSavedShort.push(event.tokensSaved);
      this.tokensSavedLong.push(event.tokensSaved);
    }
  }

  recordIndexEvent(event: IndexEvent): void {
    this.indexEventTotal += 1;
    const anyEvt = event as IndexEvent & {
      durationMs?: number;
      filesIndexed?: number;
      failed?: boolean;
      language?: string;
      engine?: "rust" | "ts";
    };
    const dur = Number.isFinite(anyEvt.durationMs)
      ? (anyEvt.durationMs ?? 0)
      : 0;
    const files = Number.isFinite(anyEvt.filesIndexed)
      ? (anyEvt.filesIndexed ?? 0)
      : 0;
    const failed = anyEvt.failed === true;
    if (failed) this.indexFailures += 1;
    if (anyEvt.engine === "rust") this.indexEngineRust += 1;
    else if (anyEvt.engine === "ts") this.indexEngineTs += 1;
    if (anyEvt.language) {
      const lang = anyEvt.language;
      let bucket = this.indexLangSum.get(lang);
      if (!bucket) {
        bucket = { sum: 0, count: 0 };
        this.indexLangSum.set(lang, bucket);
      }
      bucket.sum += dur;
      bucket.count += 1;
    }
    this.indexFilesPerMinuteRing.push({
      durationMs: dur,
      filesIndexed: files,
      failed,
      language: anyEvt.language,
      engine: anyEvt.engine,
    });
    this.filesPerMinShort.push(files);
    this.filesPerMinLong.push(files);
  }

  recordIndexPhase(rec: IndexPhaseRec): void {
    const phaseCount = (this.indexPhaseCounts.get(rec.phase) ?? 0) + 1;
    this.indexPhaseCounts.set(rec.phase, phaseCount);
    if (rec.phase === "pass1") {
      this.indexPass1Sum += rec.durationMs;
      this.indexPass1Count += 1;
    } else if (rec.phase === "pass2") {
      this.indexPass2Sum += rec.durationMs;
      this.indexPass2Count += 1;
    }
    if (rec.language) {
      let bucket = this.indexLangSum.get(rec.language);
      if (!bucket) {
        bucket = { sum: 0, count: 0 };
        this.indexLangSum.set(rec.language, bucket);
      }
      bucket.sum += rec.durationMs;
      bucket.count += 1;
    }
  }

  setIndexDerivedStateLag(lagMs: number | null): void {
    this.indexDerivedStateLagMs = lagMs;
  }

  recordSemanticSearch(event: SemanticSearchTelemetryEvent): void {
    this.retrievalTotal += 1;
    const evt = event as SemanticSearchTelemetryEvent & {
      durationMs?: number;
      retrievalMode?: string;
      retrievalType?: string;
      candidateCountPerSource?: Record<string, number>;
      resultCount?: number;
    };
    const dur = Number.isFinite(evt.durationMs) ? (evt.durationMs ?? 0) : 0;
    this.retrievalDurationSum += dur;
    pushBoundedSorted(this.retrievalLatencies, dur, LATENCY_WINDOW_SIZE);
    if ((evt.resultCount ?? 0) === 0) this.retrievalEmpty += 1;
    const mode = evt.retrievalMode ?? "unknown";
    this.retrievalByMode.set(mode, (this.retrievalByMode.get(mode) ?? 0) + 1);
    const rtype = evt.retrievalType ?? "unknown";
    this.retrievalByType.set(rtype, (this.retrievalByType.get(rtype) ?? 0) + 1);
    const candidates = evt.candidateCountPerSource ?? {};
    for (const [src, n] of Object.entries(candidates)) {
      if (typeof n === "number" && Number.isFinite(n)) {
        this.retrievalCandidatesPerSource.set(
          src,
          (this.retrievalCandidatesPerSource.get(src) ?? 0) + n,
        );
      }
    }
  }

  recordPolicyDecision(_event: PolicyDecisionEvent): void {
    // Reserved for future per-decision counters; currently mirrored via tool calls + retrieval.
    // Kept on the tap surface so Agent C can wire it without re-coordinating.
  }

  recordPrefetch(_event: PrefetchTelemetryEvent): void {
    // Reserved — prefetch hit-rate is sampled directly from `repo.status.prefetchStats`
    // in the snapshot path, so no aggregation is required here yet.
  }

  recordWatcherHealth(event: WatcherHealthTelemetryEvent): void {
    const evt = event as WatcherHealthTelemetryEvent & {
      running?: boolean;
      queueDepth?: number;
      stale?: boolean;
    };
    if (typeof evt.running === "boolean") this.watcherRunning = evt.running;
    if (typeof evt.queueDepth === "number")
      this.watcherQueueDepth = evt.queueDepth;
    if (typeof evt.stale === "boolean") this.watcherStale = evt.stale;
  }

  recordEdgeResolution(_event: EdgeResolutionTelemetryEvent): void {
    // Reserved — surfaced via health.callResolution which Agent C samples.
  }

  recordRuntimeExecution(event: RuntimeExecutionEvent): void {
    const evt = event as RuntimeExecutionEvent & {
      durationMs?: number;
      failed?: boolean;
    };
    const dur = Number.isFinite(evt.durationMs) ? (evt.durationMs ?? 0) : 0;
    this.recordToolCall({
      tool: "sdl.runtime.execute",
      request: {
        id: "runtime",
        method: "runtime",
        params: undefined,
      } as ToolCallEvent["request"],
      response: { result: undefined } as ToolCallEvent["response"],
      durationMs: dur,
      errored: evt.failed === true,
    });
  }

  recordPprResult(rec: PprResultRec): void {
    this.pprTotal += 1;
    if (rec.backend === "native") this.pprNative += 1;
    else if (rec.backend === "js") this.pprJs += 1;
    else if (rec.backend === "fallback-bfs") this.pprFallback += 1;
    if (Number.isFinite(rec.computeMs) && rec.computeMs >= 0) {
      this.pprComputeSum += rec.computeMs;
      pushBoundedSorted(this.pprLatencies, rec.computeMs, LATENCY_WINDOW_SIZE);
    }
    if (Number.isFinite(rec.touched)) this.pprTouchedSum += rec.touched;
    if (Number.isFinite(rec.seedCount)) this.pprSeedSum += rec.seedCount;
  }

  recordPackedWire(rec: PackedWireRec): void {
    this.packedTotal += 1;
    if (rec.decision === "packed") this.packedHits += 1;
    else this.packedFallback += 1;
    if (Number.isFinite(rec.jsonBytes)) this.packedJsonBytes += rec.jsonBytes;
    if (Number.isFinite(rec.packedBytes)) this.packedBytes += rec.packedBytes;
    if (rec.axisHit === "bytes") this.packedAxisBytes += 1;
    else if (rec.axisHit === "tokens") this.packedAxisTokens += 1;
    else this.packedAxisNone += 1;
    this.packedPerEncoder.set(
      rec.encoderId,
      (this.packedPerEncoder.get(rec.encoderId) ?? 0) + 1,
    );
  }

  recordScipIngest(rec: {
    edgesCreated: number;
    edgesUpgraded: number;
    durationMs: number;
    failed: boolean;
  }): void {
    this.scipTotal += 1;
    if (rec.failed) this.scipFailure += 1;
    else this.scipSuccess += 1;
    if (Number.isFinite(rec.edgesCreated))
      this.scipEdgesCreated += rec.edgesCreated;
    if (Number.isFinite(rec.edgesUpgraded))
      this.scipEdgesUpgraded += rec.edgesUpgraded;
    if (Number.isFinite(rec.durationMs)) this.scipDurationSum += rec.durationMs;
    this.scipLastAt = new Date().toISOString();
  }

  recordResourceSample(rec: ResourceSampleRec): void {
    if (Number.isFinite(rec.cpuPct) && rec.cpuPct > this.cpuMax)
      this.cpuMax = rec.cpuPct;
    if (Number.isFinite(rec.rssMb) && rec.rssMb > this.rssMax)
      this.rssMax = rec.rssMb;
    this.resourcesShort.push(rec);
    this.resourcesLong.push(rec);
  }

  recordPoolSample(rec: PoolSampleRec): void {
    if (Number.isFinite(rec.writeQueued)) {
      this.poolWriteQueuedSum += rec.writeQueued;
      this.poolWriteQueuedCount += 1;
      if (rec.writeQueued > this.poolWriteQueuedMax)
        this.poolWriteQueuedMax = rec.writeQueued;
      this.queueDepthShort.push(rec.writeQueued);
      this.queueDepthLong.push(rec.writeQueued);
    }
    if (Number.isFinite(rec.writeActive)) {
      this.poolWriteActiveSum += rec.writeActive;
      this.poolWriteActiveCount += 1;
    }
    if (Number.isFinite(rec.drainQueueDepth)) {
      this.poolDrainSum += rec.drainQueueDepth;
      this.poolDrainCount += 1;
      if (rec.drainQueueDepth > this.poolDrainMax)
        this.poolDrainMax = rec.drainQueueDepth;
      this.drainDepthShort.push(rec.drainQueueDepth);
      this.drainDepthLong.push(rec.drainQueueDepth);
    }
    if (Number.isFinite(rec.drainFailures)) {
      this.poolDrainFailuresTotal = Math.max(
        this.poolDrainFailuresTotal,
        rec.drainFailures,
      );
    }
  }

  recordDbLatency(latencyMs: number): void {
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      pushBoundedSorted(this.dbLatencies, latencyMs, LATENCY_WINDOW_SIZE);
    }
  }

  recordHealth(score: number, components: HealthMetrics["components"]): void {
    if (Number.isFinite(score)) this.healthScore = score;
    this.healthComponents = components;
  }

  /**
   * Compute health score + components from aggregator's own state and record
   * via recordHealth(). Called periodically by ObservabilityService.tick().
   *
   * Components are 0..1 each. Score is a weighted-average × 100, rounded.
   * Placeholder values (1.0) are used for components that don't yet have
   * raw signals plumbed; refine when coverage/edgeQuality/callResolution
   * event taps are added.
   */
  computeAndRecordHealth(): void {
    const lagMs = this.indexDerivedStateLagMs ?? 0;
    const freshness = Math.max(0, 1 - Math.min(lagMs / 60_000, 1));

    let errors = 0;
    let total = 0;
    for (const e of this.errorRateShort.snapshot()) {
      errors += e.v.errors;
      total += e.v.total;
    }
    const errorRate = total === 0 ? 1 : Math.max(0, 1 - errors / total);

    const failureRatio =
      this.indexEventTotal === 0 ? 0 : this.indexFailures / this.indexEventTotal;
    const coverage = Math.max(0, 1 - failureRatio);

    const edgeQuality = 1.0;
    const callResolution = 1.0;

    const components = { freshness, coverage, errorRate, edgeQuality, callResolution };
    const score = Math.round(
      (freshness * 0.25 +
        coverage * 0.20 +
        errorRate * 0.30 +
        edgeQuality * 0.10 +
        callResolution * 0.15) *
        100,
    );
    this.recordHealth(score, components);
  }

  recordBeamBuild(rec: {
    durationMs: number;
    accepted: number;
    evicted: number;
    rejected: number;
  }): void {
    this.beamTotalBuilds += 1;
    if (Number.isFinite(rec.durationMs)) {
      pushBoundedSorted(
        this.beamBuildLatencies,
        rec.durationMs,
        LATENCY_WINDOW_SIZE,
      );
    }
    if (Number.isFinite(rec.accepted)) this.beamAcceptedSum += rec.accepted;
    if (Number.isFinite(rec.evicted)) this.beamEvictedSum += rec.evicted;
    if (Number.isFinite(rec.rejected)) this.beamRejectedSum += rec.rejected;
  }

  setBeamRetainedHandles(n: number): void {
    if (Number.isFinite(n) && n >= 0) this.beamRetainedHandles = n;
  }

  /* ---------------------- snapshot ---------------------- */

  getSnapshot(repoId: string): ObservabilitySnapshot {
    const generatedAt = new Date().toISOString();
    const uptimeMs = Date.now() - this.startedAt;

    const cache = this.computeCache();
    const retrieval = this.computeRetrieval();
    const beam = this.computeBeam();
    const indexing = this.computeIndexing();
    const tokenEfficiency = this.computeTokenEfficiency();
    const health = this.computeHealth();
    const latency = this.computeLatency();
    const pool = this.computePool();
    const scip = this.computeScip();
    const packed = this.computePacked();
    const ppr = this.computePpr();
    const resources = this.computeResources();
    const toolVolume = this.computeToolVolume();

    const bottleneck = classifyBottleneck({
      cpuPctAvg: resources.cpuPctAvg,
      cpuPctMax: resources.cpuPctMax,
      rssMb: resources.rssMb,
      heapUsedMb: resources.heapUsedMb,
      heapTotalMb: resources.heapTotalMb,
      eventLoopLagP95Ms: resources.eventLoopLagP95Ms,
      dbLatencyP95Ms: percentile(this.dbLatencies, 0.95),
      indexerParseP95Ms: percentile(this.beamBuildLatencies, 0.95),
      ioThroughputMbPerSec: 0,
      ioThroughputSaturationMbPerSec: this.opts.ioThroughputSaturationMbPerSec,
      poolWriteQueuedAvg: pool.avgWriteQueued,
      drainQueueDepthAvg: pool.avgDrainQueueDepth,
    });

    return {
      schemaVersion: 1,
      generatedAt,
      repoId,
      uptimeMs,
      cache,
      retrieval,
      beam,
      indexing,
      tokenEfficiency,
      health,
      latency,
      pool,
      scip,
      packed,
      ppr,
      resources,
      bottleneck,
      toolVolume,
    };
  }

  /* ---------------------- timeseries ---------------------- */

  getTimeseries(repoId: string, window: TimeseriesWindow): TimeseriesResponse {
    const useShort = window === "15m";
    const resolutionMs = useShort
      ? Math.floor(
          this.opts.shortWindowMs / Math.max(1, this.opts.shortCapacity),
        )
      : Math.floor(
          this.opts.longWindowMs / Math.max(1, this.opts.longCapacity),
        );

    const series: Record<string, TimeseriesPoint[]> = {
      cacheHitRate: ringToHitRateSeries(
        useShort ? this.cacheHitRateShort : this.cacheHitRateLong,
      ),
      p95LatencyMs: ringToScalarSeries(
        useShort ? this.latencyShort : this.latencyLong,
        "p95LatencyMs",
      ),
      queueDepth: ringToScalarSeries(
        useShort ? this.queueDepthShort : this.queueDepthLong,
        "queueDepth",
      ),
      drainQueueDepth: ringToScalarSeries(
        useShort ? this.drainDepthShort : this.drainDepthLong,
        "drainQueueDepth",
      ),
      filesPerMinute: ringToScalarSeries(
        useShort ? this.filesPerMinShort : this.filesPerMinLong,
        "filesPerMinute",
      ),
      errorRate: ringToErrorRateSeries(
        useShort ? this.errorRateShort : this.errorRateLong,
      ),
      tokensUsedPerMin: ringToScalarSeries(
        useShort ? this.tokensUsedShort : this.tokensUsedLong,
        "tokensUsedPerMin",
      ),
      tokensSavedPerMin: ringToScalarSeries(
        useShort ? this.tokensSavedShort : this.tokensSavedLong,
        "tokensSavedPerMin",
      ),
      cpuPct: ringToResourceSeries(
        useShort ? this.resourcesShort : this.resourcesLong,
        "cpuPct",
      ),
      rssMb: ringToResourceSeries(
        useShort ? this.resourcesShort : this.resourcesLong,
        "rssMb",
      ),
      heapUsedMb: ringToResourceSeries(
        useShort ? this.resourcesShort : this.resourcesLong,
        "heapUsedMb",
      ),
      eventLoopLagMs: ringToResourceSeries(
        useShort ? this.resourcesShort : this.resourcesLong,
        "eventLoopLagMs",
      ),
    };

    return { schemaVersion: 1, repoId, window, resolutionMs, series };
  }

  /* ---------------------- compute helpers ---------------------- */

  private computeCache(): CacheMetrics {
    const total = this.cacheTotalHits + this.cacheTotalMisses;
    const overallHitRatePct =
      total === 0 ? 0 : (this.cacheTotalHits / total) * 100;
    const avgLookupLatencyMs =
      this.cacheLatencyCount === 0
        ? 0
        : this.cacheLatencySum / this.cacheLatencyCount;
    const perSource: Record<string, CacheSourceMetrics> = {};
    for (const [source, b] of this.cachePerSource.entries()) {
      const t = b.hits + b.misses;
      perSource[source] = {
        source,
        hits: b.hits,
        misses: b.misses,
        hitRatePct: t === 0 ? 0 : (b.hits / t) * 100,
        avgLatencyMs: b.latencyCount === 0 ? 0 : b.latencySum / b.latencyCount,
      };
    }
    return {
      overallHitRatePct,
      totalHits: this.cacheTotalHits,
      totalMisses: this.cacheTotalMisses,
      perSource,
      avgLookupLatencyMs,
    };
  }

  private computeRetrieval(): RetrievalMetrics {
    const total = this.retrievalTotal;
    const avgLatencyMs = total === 0 ? 0 : this.retrievalDurationSum / total;
    return {
      totalRetrievals: total,
      avgLatencyMs,
      p95LatencyMs: percentile(this.retrievalLatencies, 0.95),
      byMode: Object.fromEntries(this.retrievalByMode),
      candidateCountPerSource: Object.fromEntries(
        this.retrievalCandidatesPerSource,
      ),
      byRetrievalType: Object.fromEntries(this.retrievalByType),
      emptyResultCount: this.retrievalEmpty,
    };
  }

  private computeBeam(): BeamSummary {
    const builds = this.beamTotalBuilds;
    const avgBuildMs = builds === 0 ? 0 : avg(this.beamBuildLatencies);
    return {
      totalSliceBuilds: builds,
      avgBuildMs,
      p95BuildMs: percentile(this.beamBuildLatencies, 0.95),
      avgAccepted: builds === 0 ? 0 : this.beamAcceptedSum / builds,
      avgEvicted: builds === 0 ? 0 : this.beamEvictedSum / builds,
      avgRejected: builds === 0 ? 0 : this.beamRejectedSum / builds,
      retainedExplainHandles: this.beamRetainedHandles,
    };
  }

  private computeIndexing(): IndexingMetrics {
    const filesRecent = this.indexFilesPerMinuteRing.snapshot();
    let filesPerMinute = 0;
    if (filesRecent.length > 0) {
      const totalFiles = filesRecent.reduce(
        (acc, e) => acc + e.v.filesIndexed,
        0,
      );
      const oldest = filesRecent[0].t;
      const newest = filesRecent[filesRecent.length - 1].t;
      const spanMs = Math.max(1, newest - oldest);
      filesPerMinute = (totalFiles / spanMs) * 60_000;
    }
    const perLanguageAvgMs: Record<string, number> = {};
    for (const [lang, b] of this.indexLangSum.entries()) {
      perLanguageAvgMs[lang] = b.count === 0 ? 0 : b.sum / b.count;
    }
    return {
      totalEvents: this.indexEventTotal,
      filesPerMinute,
      avgPass1Ms:
        this.indexPass1Count === 0
          ? 0
          : this.indexPass1Sum / this.indexPass1Count,
      avgPass2Ms:
        this.indexPass2Count === 0
          ? 0
          : this.indexPass2Sum / this.indexPass2Count,
      phaseCounts: Object.fromEntries(this.indexPhaseCounts),
      perLanguageAvgMs,
      engineDispatch: { rust: this.indexEngineRust, ts: this.indexEngineTs },
      failures: this.indexFailures,
      derivedStateLagMs: this.indexDerivedStateLagMs,
    };
  }

  private computeTokenEfficiency(): TokenEfficiencyMetrics {
    const used = this.tokenUsedTotal;
    const saved = this.tokenSavedTotal;
    const totalRef = used + saved;
    const savingsRatio = totalRef === 0 ? 0 : saved / totalRef;
    const avgPerCall =
      this.tokenSampledCalls === 0 ? 0 : used / this.tokenSampledCalls;
    return { totalUsed: used, totalSaved: saved, savingsRatio, avgPerCall };
  }

  private computeHealth(): HealthMetrics {
    return {
      score: this.healthScore,
      components: this.healthComponents,
      watcherRunning: this.watcherRunning,
      watcherQueueDepth: this.watcherQueueDepth,
      watcherStale: this.watcherStale,
    };
  }

  private computeLatency(): LatencyMetrics {
    const avgMs = this.toolCallTotal === 0 ? 0 : avg(this.toolLatenciesAll);
    const perTool: Record<string, LatencyPerTool> = {};
    for (const [name, b] of this.toolPerName.entries()) {
      perTool[name] = {
        count: b.count,
        avgMs: b.count === 0 ? 0 : b.durationSum / b.count,
        p95Ms: percentile(b.latencies, 0.95),
        errorCount: b.errors,
      };
    }
    return {
      avgMs,
      p50Ms: percentile(this.toolLatenciesAll, 0.5),
      p95Ms: percentile(this.toolLatenciesAll, 0.95),
      p99Ms: percentile(this.toolLatenciesAll, 0.99),
      maxMs: this.toolLatencyMax,
      perTool,
    };
  }

  private computePool(): PoolMetrics {
    return {
      avgWriteQueued:
        this.poolWriteQueuedCount === 0
          ? 0
          : this.poolWriteQueuedSum / this.poolWriteQueuedCount,
      maxWriteQueued: this.poolWriteQueuedMax,
      avgWriteActive:
        this.poolWriteActiveCount === 0
          ? 0
          : this.poolWriteActiveSum / this.poolWriteActiveCount,
      avgDrainQueueDepth:
        this.poolDrainCount === 0 ? 0 : this.poolDrainSum / this.poolDrainCount,
      maxDrainQueueDepth: this.poolDrainMax,
      totalDrainFailures: this.poolDrainFailuresTotal,
    };
  }

  private computeScip(): ScipMetrics {
    return {
      totalIngests: this.scipTotal,
      successCount: this.scipSuccess,
      failureCount: this.scipFailure,
      totalEdgesCreated: this.scipEdgesCreated,
      totalEdgesUpgraded: this.scipEdgesUpgraded,
      avgIngestMs:
        this.scipTotal === 0 ? 0 : this.scipDurationSum / this.scipTotal,
      lastIngestAt: this.scipLastAt,
    };
  }

  private computePacked(): PackedWireMetrics {
    const total = this.packedTotal;
    const adoption = total === 0 ? 0 : (this.packedHits / total) * 100;
    const baseline = this.packedJsonBytes;
    const saved = baseline - this.packedBytes;
    const ratio = baseline === 0 ? 0 : Math.max(0, saved) / baseline;
    return {
      totalDecisions: total,
      packedCount: this.packedHits,
      fallbackCount: this.packedFallback,
      packedAdoptionPct: adoption,
      packedBytesTotal: this.packedBytes,
      jsonBaselineBytesTotal: baseline,
      bytesSaved: saved,
      bytesSavedRatio: ratio,
      axisHits: {
        bytes: this.packedAxisBytes,
        tokens: this.packedAxisTokens,
        none: this.packedAxisNone,
      },
      perEncoder: Object.fromEntries(this.packedPerEncoder),
    };
  }

  private computePpr(): PprMetrics {
    const total = this.pprTotal;
    return {
      totalRuns: total,
      nativeCount: this.pprNative,
      jsCount: this.pprJs,
      fallbackCount: this.pprFallback,
      nativeRatio: total === 0 ? 0 : this.pprNative / total,
      avgComputeMs: total === 0 ? 0 : this.pprComputeSum / total,
      p95ComputeMs: percentile(this.pprLatencies, 0.95),
      avgTouched: total === 0 ? 0 : this.pprTouchedSum / total,
      avgSeedCount: total === 0 ? 0 : this.pprSeedSum / total,
    };
  }

  private computeResources(): ResourceMetrics {
    const recent = this.resourcesShort.snapshot().map((e) => e.v);
    const cpuPctAvg =
      recent.length === 0 ? 0 : avg(recent.map((r) => r.cpuPct));
    const rssMb = recent.length === 0 ? 0 : recent[recent.length - 1].rssMb;
    const heapUsedMb =
      recent.length === 0 ? 0 : recent[recent.length - 1].heapUsedMb;
    const heapTotalMb =
      recent.length === 0 ? 0 : recent[recent.length - 1].heapTotalMb;
    const lagSeries = recent.map((r) => r.eventLoopLagMs);
    return {
      cpuPctAvg,
      cpuPctMax: this.cpuMax,
      rssMb,
      rssMbMax: this.rssMax,
      heapUsedMb,
      heapTotalMb,
      eventLoopLagP95Ms: percentile(lagSeries, 0.95),
      eventLoopLagMaxMs: lagSeries.length === 0 ? 0 : Math.max(...lagSeries),
    };
  }

  private computeToolVolume(): ToolVolume {
    const perTool: Record<string, number> = {};
    const perToolErrors: Record<string, number> = {};
    for (const [name, b] of this.toolPerName.entries()) {
      perTool[name] = b.count;
      perToolErrors[name] = b.errors;
    }
    const uptimeMin = Math.max(1, (Date.now() - this.startedAt) / 60_000);
    return {
      totalCalls: this.toolCallTotal,
      perTool,
      perToolErrors,
      callsPerMinute: this.toolCallTotal / uptimeMin,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function pushBoundedSorted(arr: number[], v: number, cap: number): void {
  if (!Number.isFinite(v)) return;
  arr.push(v);
  if (arr.length > cap) arr.shift();
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Compute the p-quantile from an unsorted array. Allocates a sorted copy.
 * Returns 0 for empty input. p must be in [0,1].
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[idx];
}

function ringToHitRateSeries(
  ring: RingBuffer<{ hit: number; total: number }>,
): TimeseriesPoint[] {
  return ring.snapshot().map((e) => ({
    t: e.t,
    hitRate: e.v.total === 0 ? 0 : e.v.hit / e.v.total,
  }));
}

function ringToErrorRateSeries(
  ring: RingBuffer<{ errors: number; total: number }>,
): TimeseriesPoint[] {
  return ring.snapshot().map((e) => ({
    t: e.t,
    errorRate: e.v.total === 0 ? 0 : e.v.errors / e.v.total,
  }));
}

function ringToScalarSeries(
  ring: RingBuffer<number>,
  key: string,
): TimeseriesPoint[] {
  return ring.snapshot().map((e) => ({ t: e.t, [key]: e.v }));
}

function ringToResourceSeries(
  ring: RingBuffer<ResourceSampleRec>,
  key: keyof ResourceSampleRec,
): TimeseriesPoint[] {
  return ring.snapshot().map((e) => ({ t: e.t, [key]: e.v[key] }));
}
