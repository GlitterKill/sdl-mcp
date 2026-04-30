import { cpus } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { ObservabilityConfig } from "../config/types.js";
import type {
  EdgeResolutionTelemetryEvent,
  IndexEvent,
  PolicyDecisionEvent,
  PrefetchTelemetryEvent,
  RuntimeExecutionEvent,
  SemanticSearchTelemetryEvent,
  SetupPipelineEvent,
  SummaryGenerationEvent,
  SummaryQualityTelemetryEvent,
  ToolCallEvent,
  WatcherHealthTelemetryEvent,
} from "../mcp/telemetry.js";
import { logger } from "../util/logger.js";
import { Aggregator, DEFAULT_AGGREGATOR_OPTIONS } from "./aggregator.js";
import type {
  IndexPhaseTapEvent,
  CacheLookupTapEvent,
  ObservabilityTap,
  PackedWireTapEvent,
  PoolSampleTapEvent,
  PprTapEvent,
  ResourceSampleTapEvent,
  ScipIngestTapEvent,
  SliceBuildTapEvent,
  AuditBufferTapEvent,
  PostIndexSessionTapEvent,
} from "./event-tap.js";
import type {
  BeamExplainResponse,
  ObservabilitySnapshot,
  TimeseriesResponse,
  TimeseriesWindow,
} from "./types.js";

/**
 * Structural type for the beam-explain store published by Agent B.
 *
 * The dashboard service only needs a single `get` accessor; the concrete
 * implementation lives in `src/graph/slice/`. By using a structural type
 * we avoid an import-cycle with the slice module and let Agent B evolve
 * the underlying store freely.
 */
export type BeamExplainStoreLike = {
  get(
    repoId: string,
    sliceHandle: string,
    symbolId?: string,
  ): BeamExplainResponse | null;
};

type SnapshotSubscriber = (snapshot: ObservabilitySnapshot) => void;

/**
 * Per-repo observability service.
 *
 * Owns one `Aggregator` per repository, samples process resources at a
 * configurable cadence, and exposes the `ObservabilityTap` surface that
 * `src/mcp/telemetry.ts` forwards into.
 *
 * All `ObservabilityTap` methods swallow exceptions internally — a metrics
 * bug must never crash the host. Errors are logged at `warn` level via
 * `src/util/logger.ts`.
 */
export class ObservabilityService implements ObservabilityTap {
  private readonly config: ObservabilityConfig;
  private readonly aggregators = new Map<string, Aggregator>();
  private readonly subscribers = new Set<SnapshotSubscriber>();

  private sampleTimer: NodeJS.Timeout | null = null;
  private eventLoopHistogram: IntervalHistogram | null = null;
  private prevCpuUsage: NodeJS.CpuUsage | null = null;
  private prevCpuSampleAt: number = 0;
  private startedAt: number = 0;
  private beamExplainStore: BeamExplainStoreLike | null = null;

  constructor(config: ObservabilityConfig) {
    this.config = config;
  }

  /**
   * Begin sampling resources and emitting periodic snapshots.
   *
   * Idempotent: calling `start()` after a previous `start()` (without
   * `stop()`) is a no-op. The interval timer is `.unref()`-ed so it does
   * not keep the process alive.
   */
  start(): void {
    if (this.sampleTimer !== null) return;
    this.startedAt = Date.now();
    try {
      this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
      this.eventLoopHistogram.enable();
    } catch (err) {
      this.logWarn("eventLoopHistogram.enable failed", err);
      this.eventLoopHistogram = null;
    }
    try {
      this.prevCpuUsage = process.cpuUsage();
      this.prevCpuSampleAt = Date.now();
    } catch (err) {
      this.logWarn("initial cpuUsage failed", err);
      this.prevCpuUsage = null;
    }
    const interval = clampInterval(this.config.sampleIntervalMs);
    const timer = setInterval(() => {
      this.tick();
    }, interval);
    // Required so the sampler does not keep the process alive (round 8 fix).
    timer.unref();
    this.sampleTimer = timer;
  }

  /**
   * Stop sampling. Releases the interval timer and disables the
   * event-loop histogram. Safe to call when not started.
   */
  stop(): void {
    if (this.sampleTimer !== null) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.eventLoopHistogram !== null) {
      try {
        this.eventLoopHistogram.disable();
      } catch (err) {
        this.logWarn("eventLoopHistogram.disable failed", err);
      }
      this.eventLoopHistogram = null;
    }
    this.prevCpuUsage = null;
  }

  /**
   * Internal sampler — invoked by the interval timer. Pulls CPU/memory/event-loop
   * lag, fans the sample out to every known aggregator, then notifies subscribers.
   * Exceptions are caught locally so the timer keeps firing.
   */
  private tick(): void {
    try {
      const sample = this.collectResourceSample();
      for (const aggregator of this.aggregators.values()) {
        try {
          aggregator.recordResourceSample(sample);
        } catch (err) {
          this.logWarn("aggregator.recordResourceSample failed", err);
        }
        try {
          aggregator.computeAndRecordHealth();
        } catch (err) {
          this.logWarn("aggregator.computeAndRecordHealth failed", err);
        }
      }
      this.emitSnapshot();
    } catch (err) {
      this.logWarn("observability tick failed", err);
    }
  }

  private collectResourceSample(): ResourceSampleTapEvent {
    let cpuPct = 0;
    try {
      const now = Date.now();
      const usage = process.cpuUsage(this.prevCpuUsage ?? undefined);
      const elapsedMs = Math.max(1, now - this.prevCpuSampleAt);
      const cpuMicros = usage.user + usage.system;
      // cpuUsage returns microseconds across all cores combined; normalize to
      // a 0-100% scale as a fraction of one core.
      const cores = Math.max(1, getCoreCount());
      cpuPct = (cpuMicros / 1000 / elapsedMs / cores) * 100;
      if (!Number.isFinite(cpuPct) || cpuPct < 0) cpuPct = 0;
      if (cpuPct > 100) cpuPct = 100;
      this.prevCpuUsage = process.cpuUsage();
      this.prevCpuSampleAt = now;
    } catch (err) {
      this.logWarn("cpuUsage sample failed", err);
    }

    let rssMb = 0;
    let heapUsedMb = 0;
    let heapTotalMb = 0;
    try {
      const mem = process.memoryUsage();
      rssMb = mem.rss / (1024 * 1024);
      heapUsedMb = mem.heapUsed / (1024 * 1024);
      heapTotalMb = mem.heapTotal / (1024 * 1024);
    } catch (err) {
      this.logWarn("memoryUsage sample failed", err);
    }

    let eventLoopLagMs = 0;
    if (this.eventLoopHistogram !== null) {
      try {
        // p95 in nanoseconds → ms.
        const p95Nanos = this.eventLoopHistogram.percentile(95);
        eventLoopLagMs = Number.isFinite(p95Nanos) ? p95Nanos / 1e6 : 0;
        this.eventLoopHistogram.reset();
      } catch (err) {
        this.logWarn("eventLoopHistogram read failed", err);
      }
    }

    return {
      cpuPct,
      rssMb,
      heapUsedMb,
      heapTotalMb,
      eventLoopLagMs,
    };
  }

  /**
   * Get-or-create the aggregator for a repository.
   */
  private getAggregator(repoId: string): Aggregator {
    let agg = this.aggregators.get(repoId);
    if (!agg) {
      const shortMin = this.config.retentionShortMinutes;
      const longHr = this.config.retentionLongHours;
      agg = new Aggregator({
        shortWindowMs: shortMin * 60_000,
        shortCapacity: shortMin * 60,
        longWindowMs: longHr * 3_600_000,
        longCapacity: longHr * 60,
        ioThroughputSaturationMbPerSec:
          DEFAULT_AGGREGATOR_OPTIONS.ioThroughputSaturationMbPerSec,
      });
      this.aggregators.set(repoId, agg);
    }
    return agg;
  }

  /**
   * Compute and return a snapshot for the given repository.
   * Lazily creates the aggregator if needed.
   */
  getSnapshot(repoId: string): ObservabilitySnapshot {
    return this.getAggregator(repoId).getSnapshot(repoId);
  }

  /**
   * Compute and return time-series data for the given repository.
   */
  getTimeseries(repoId: string, window: TimeseriesWindow): TimeseriesResponse {
    return this.getAggregator(repoId).getTimeseries(repoId, window);
  }

  /**
   * Inject the beam-explain store. Replacing the previously installed store
   * is allowed; pass `null` to clear it (used by tests + service teardown).
   */
  setBeamExplainStore(store: BeamExplainStoreLike | null): void {
    this.beamExplainStore = store;
  }

  /**
   * Look up a beam-explain trace from the configured store, if any.
   * Returns `null` when no store is installed or the slice handle is unknown.
   */
  getBeamExplain(
    repoId: string,
    sliceHandle: string,
    symbolId?: string,
  ): BeamExplainResponse | null {
    const store = this.beamExplainStore;
    if (store === null) return null;
    try {
      return store.get(repoId, sliceHandle, symbolId);
    } catch (err) {
      this.logWarn("beamExplainStore.get failed", err);
      return null;
    }
  }

  /**
   * Subscribe to snapshot emissions. The callback fires after each
   * resource-sample tick. Returns an unsubscribe lambda.
   */
  onSnapshot(cb: SnapshotSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Fire a snapshot for every known repository. Subscriber failures are
   * isolated — one bad subscriber cannot kill the rest.
   */
  private emitSnapshot(): void {
    if (this.subscribers.size === 0) return;
    for (const repoId of this.aggregators.keys()) {
      let snapshot: ObservabilitySnapshot;
      try {
        snapshot = this.getSnapshot(repoId);
      } catch (err) {
        this.logWarn("emitSnapshot.getSnapshot failed", err);
        continue;
      }
      for (const cb of this.subscribers) {
        try {
          cb(snapshot);
        } catch (err) {
          this.logWarn("snapshot subscriber failed", err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // ObservabilityTap surface — every method routes to the relevant aggregator
  // and is wrapped in try/catch.
  // -------------------------------------------------------------------------

  toolCall(event: ToolCallEvent): void {
    try {
      const repoId = event.repoId ?? "_global";
      this.getAggregator(repoId).recordToolCall(event);
    } catch (err) {
      this.logWarn("toolCall failed", err);
    }
  }

  indexEvent(event: IndexEvent): void {
    try {
      this.getAggregator(event.repoId).recordIndexEvent(event);
    } catch (err) {
      this.logWarn("indexEvent failed", err);
    }
  }

  semanticSearch(event: SemanticSearchTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordSemanticSearch(event);
    } catch (err) {
      this.logWarn("semanticSearch failed", err);
    }
  }

  policyDecision(event: PolicyDecisionEvent): void {
    try {
      this.getAggregator(event.repoId).recordPolicyDecision(event);
    } catch (err) {
      this.logWarn("policyDecision failed", err);
    }
  }

  prefetch(event: PrefetchTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordPrefetch(event);
    } catch (err) {
      this.logWarn("prefetch failed", err);
    }
  }

  watcherHealth(event: WatcherHealthTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordWatcherHealth(event);
    } catch (err) {
      this.logWarn("watcherHealth failed", err);
    }
  }

  edgeResolution(event: EdgeResolutionTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordEdgeResolution(event);
    } catch (err) {
      this.logWarn("edgeResolution failed", err);
    }
  }

  runtimeExecution(event: RuntimeExecutionEvent): void {
    try {
      this.getAggregator(event.repoId).recordRuntimeExecution(event);
    } catch (err) {
      this.logWarn("runtimeExecution failed", err);
    }
  }

  setupPipeline(_event: SetupPipelineEvent): void {
    // Reserved — setup pipeline is one-shot; no per-repo aggregation needed yet.
  }

  summaryGeneration(_event: SummaryGenerationEvent): void {
    // Reserved — summary cost/duration surfaced via tool-call telemetry already.
  }

  summaryQuality(_event: SummaryQualityTelemetryEvent): void {
    // Reserved — quality divergence surfaced via dedicated quality dashboard.
  }

  pprResult(event: PprTapEvent): void {
    try {
      this.getAggregator(event.repoId).recordPprResult({
        backend: event.backend,
        computeMs: event.computeMs,
        touched: event.touched,
        seedCount: event.seedCount,
        iterations: event.iterations,
      });
    } catch (err) {
      this.logWarn("pprResult failed", err);
    }
  }

  scipIngest(event: ScipIngestTapEvent): void {
    try {
      this.getAggregator(event.repoId).recordScipIngest({
        edgesCreated: event.edgesCreated,
        edgesUpgraded: event.edgesUpgraded,
        durationMs: event.durationMs,
        failed: event.failed,
      });
    } catch (err) {
      this.logWarn("scipIngest failed", err);
    }
  }

  packedWire(event: PackedWireTapEvent): void {
    try {
      // packedWire is process-global (no repoId) — fan out to every aggregator.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordPackedWire(event);
      }
    } catch (err) {
      this.logWarn("packedWire failed", err);
    }
  }

  poolSample(event: PoolSampleTapEvent): void {
    try {
      // Pool depths are process-global — fan out to every aggregator.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordPoolSample(event);
      }
    } catch (err) {
      this.logWarn("poolSample failed", err);
    }
  }

  resourceSample(event: ResourceSampleTapEvent): void {
    try {
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordResourceSample(event);
      }
    } catch (err) {
      this.logWarn("resourceSample failed", err);
    }
  }

  indexPhase(event: IndexPhaseTapEvent): void {
    try {
      // indexPhase events do not carry repoId; apply to every aggregator.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordIndexPhase({
          phase: event.phase,
          language: event.language,
          durationMs: event.durationMs,
        });
      }
    } catch (err) {
      this.logWarn("indexPhase failed", err);
    }
  }

  cacheLookup(event: CacheLookupTapEvent): void {
    try {
      this.getAggregator(event.repoId ?? "_global").recordCacheOutcome({
        source: event.source,
        hit: event.hit,
        latencyMs: event.latencyMs,
        count: event.count,
        hits: event.hits,
      });
    } catch (err) {
      this.logWarn("cacheLookup failed", err);
    }
  }

  sliceBuild(event: SliceBuildTapEvent): void {
    try {
      this.getAggregator(event.repoId ?? "_global").recordBeamBuild({
        durationMs: event.durationMs,
        accepted: event.accepted,
        evicted: event.evicted,
        rejected: event.rejected,
      });
    } catch (err) {
      this.logWarn("sliceBuild failed", err);
    }
  }

  auditBufferSample(event: AuditBufferTapEvent): void {
    try {
      // Audit buffer is process-global; fan out to all aggregators so any
      // active repo's snapshot reflects the same gauge value.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordAuditBufferSample({
          depth: event.depth,
          droppedTotal: event.droppedTotal,
          sessionActive: event.sessionActive,
        });
      }
      // Always populate the _global aggregator so dashboards have a target
      // even before any repo has been registered.
      this.getAggregator("_global").recordAuditBufferSample({
        depth: event.depth,
        droppedTotal: event.droppedTotal,
        sessionActive: event.sessionActive,
      });
    } catch (err) {
      this.logWarn("auditBufferSample failed", err);
    }
  }

  postIndexSession(event: PostIndexSessionTapEvent): void {
    try {
      // Post-index session ends are process-global (no repoId on the event).
      const rec = {
        durationMs: event.durationMs,
        timedOut: event.timedOut,
        endedAt: new Date().toISOString(),
      };
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordPostIndexSession(rec);
      }
      this.getAggregator("_global").recordPostIndexSession(rec);
    } catch (err) {
      this.logWarn("postIndexSession failed", err);
    }
  }

  /**
   * Service uptime in milliseconds since `start()` was called.
   * Returns 0 when not started.
   */
  getUptimeMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  private logWarn(message: string, err: unknown): void {
    try {
      logger.warn?.(`[observability] ${message}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Logger itself failed — give up silently so a metrics bug cannot crash the host.
    }
  }
}

/**
 * Construct an `ObservabilityService` configured from the provided
 * `ObservabilityConfig`. The service is returned in a stopped state;
 * callers should invoke `.start()` to begin sampling.
 */
export function createObservabilityService(
  config: ObservabilityConfig,
): ObservabilityService {
  return new ObservabilityService(config);
}

export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 2000;
  if (ms < 250) return 250;
  if (ms > 60_000) return 60_000;
  return Math.floor(ms);
}

function getCoreCount(): number {
  try {
    const list = cpus();
    if (Array.isArray(list) && list.length > 0) return list.length;
  } catch {
    // Fall through to default.
  }
  return 1;
}
