import { cpus } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { mkdir } from "node:fs/promises";

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
import { getToolDispatchStats } from "../mcp/dispatch-limiter.js";
import { logger } from "../util/logger.js";
import { Aggregator, DEFAULT_AGGREGATOR_OPTIONS } from "./aggregator.js";
import {
  admitRepository,
  canonicalDynamicKey,
  dynamicMapLimit,
  emptyLifetimeSections,
  emptyRepositoryLifetime,
  incrementSessionCount,
  lifetimeView,
  mergeProcessPeaks,
  mergeRepositoryLifetime,
  mergeSample,
  resetRepositoryLifetime,
  saturatingAdd,
} from "./lifetime-accumulator.js";
import type {
  IndexPhaseTapEvent,
  CacheLookupTapEvent,
  DeltaBlastRadiusTapEvent,
  ObservabilityTap,
  PackedWireTapEvent,
  PoolSampleTapEvent,
  PprTapEvent,
  ResourceSampleTapEvent,
  ScipIngestTapEvent,
  SliceBuildTapEvent,
  AuditBufferTapEvent,
  PostIndexSessionTapEvent,
  TokenSavingsTapEvent,
} from "./event-tap.js";
import {
  openLifetimeStore,
  type LifetimeStore,
  type PublishOutcome,
} from "./lifetime-store.js";
import {
  LIFETIME_SCHEMA_VERSION,
  OVERFLOW_KEY,
  SECTION_IDS,
  repositoryStorageKey,
  type DurableLifetimeRepository,
  type DurableLifetimeRoot,
  type DurableLifetimeSections,
  type LifetimeEnvelopeV1,
  type LifetimeFreshness,
  type LifetimeReadyV1,
  type ProcessPeaks,
  type RecoveryReason,
  type SampleTotal,
  type SectionId,
  type ToolOutputLifetimeCounters,
} from "./lifetime-types.js";
import { RingBuffer } from "./ring-buffer.js";
import type {
  BeamExplainResponse,
  ObservabilitySnapshot,
  TimeseriesResponse,
  TimeseriesWindow,
  GraphActivityEvent,
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
  size?(): number;
};

type SnapshotSubscriber = (snapshot: ObservabilitySnapshot) => void;
type GraphSubscriber = (event: GraphActivityEvent) => void;

interface IntervalHandle {
  unref?(): void;
}

export interface ObservabilityServiceOptions {
  readonly lifetimeDirectory?: string;
  readonly openLifetimeStore?: (directory: string) => Promise<LifetimeStore>;
  readonly now?: () => Date;
  readonly isRegisteredRepoId?: (repoId: string) => boolean;
  readonly scheduleInterval?: (callback: () => void, delayMs: number) => IntervalHandle;
  readonly clearScheduledInterval?: (timer: IntervalHandle) => void;
}

interface LifetimeRepositoryState {
  baseline: DurableLifetimeRepository;
  active: DurableLifetimeRepository;
  eventProduced: boolean;
  sessionCounted: boolean;
}

interface SessionRepositoryState {
  readonly aggregator: Aggregator;
  readonly freshness: LifetimeFreshness;
}

interface PublicationBoundary {
  readonly actives: Map<string, DurableLifetimeRepository>;
  readonly eventProduced: Map<string, boolean>;
  readonly processPeaks: ProcessPeaks | null;
}

interface PendingReset {
  readonly targetRepoId: string;
  readonly boundary: PublicationBoundary;
  readonly interleaved: Map<string, DurableLifetimeRepository>;
  readonly eventProduced: Set<string>;
}

const CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * Per-repo observability service.
 *
 * Owns one `Aggregator` per repository, samples process resources at a
 * configurable cadence, and exposes the `ObservabilityTap` surface that
 * `src/mcp/telemetry.ts` forwards into.
 *
 * All `ObservabilityTap` methods swallow exceptions internally â€” a metrics
 * bug must never crash the host. Errors are logged at `warn` level via
 * `src/util/logger.ts`.
 */
export class ObservabilityService implements ObservabilityTap {
  private readonly config: ObservabilityConfig;
  private readonly options: Required<Pick<ObservabilityServiceOptions,
    "now" | "isRegisteredRepoId" | "scheduleInterval" | "clearScheduledInterval"
  >> & Pick<ObservabilityServiceOptions, "lifetimeDirectory" | "openLifetimeStore">;
  private readonly aggregators = new Map<string, SessionRepositoryState>();
  private readonly subscribers = new Set<SnapshotSubscriber>();
  private readonly graphSubscribers = new Set<GraphSubscriber>();
  private readonly graphEvents = new RingBuffer<GraphActivityEvent>(200);

  private sampleTimer: IntervalHandle | null = null;
  private checkpointTimer: IntervalHandle | null = null;
  private eventLoopHistogram: IntervalHistogram | null = null;
  private prevCpuUsage: NodeJS.CpuUsage | null = null;
  private prevCpuSampleAt: number = 0;
  private startedAt: number = 0;
  private beamExplainStore: BeamExplainStoreLike | null = null;
  private lifetimeStore: LifetimeStore | null = null;
  private committedLifetime: DurableLifetimeRoot | null = null;
  private readonly lifetimeRepositories = new Map<string, LifetimeRepositoryState>();
  private readonly processFreshness = emptyFreshness();
  private processPeakEpoch: ProcessPeaks | null = null;
  private lifetimeWriter = false;
  private lifetimeFrozen = false;
  private lifetimeOpenFailed = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lifetimeTail: Promise<void> = Promise.resolve();
  private pendingCheckpoint: PublicationBoundary | null = null;
  private pendingReset: PendingReset | null = null;
  private readonly watcherCumulative = new Map<
    string,
    NonNullable<DurableLifetimeSections["health"]>
  >();
  private readonly prefetchCumulative = new Map<
    string,
    NonNullable<DurableLifetimeSections["predictiveContext"]>
  >();

  constructor(config: ObservabilityConfig, options: ObservabilityServiceOptions = {}) {
    this.config = config;
    this.options = {
      lifetimeDirectory: options.lifetimeDirectory,
      openLifetimeStore: options.openLifetimeStore,
      now: options.now ?? (() => new Date()),
      isRegisteredRepoId: options.isRegisteredRepoId ?? (() => false),
      scheduleInterval: options.scheduleInterval
        ?? ((callback, delayMs) => setInterval(callback, delayMs)),
      clearScheduledInterval: options.clearScheduledInterval
        ?? ((timer) => clearInterval(timer as NodeJS.Timeout)),
    };
  }

  /**
   * Begin sampling resources and emitting periodic snapshots.
   *
   * Idempotent: calling `start()` after a previous `start()` (without
   * `stop()`) is a no-op. The interval timer is `.unref()`-ed so it does
   * not keep the process alive.
   */
  start(): Promise<void> {
    if (this.stopPromise !== null) {
      if (this.startPromise !== null) return this.startPromise;
      const stopping = this.stopPromise;
      // A restart requested during shutdown shares one continuation behind close.
      const restarting = stopping.then(() => {
        if (this.stopPromise === stopping) this.stopPromise = null;
        return this.startInternal();
      });
      this.startPromise = restarting;
      void restarting.catch(() => {
        if (this.stopPromise === stopping) this.stopPromise = null;
        if (this.startPromise === restarting) this.startPromise = null;
      });
      return restarting;
    }
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.lifetimeOpenFailed = false;
    if (this.options.lifetimeDirectory !== undefined || this.options.openLifetimeStore !== undefined) {
      const directory = this.options.lifetimeDirectory ?? "";
      try {
        if (this.options.openLifetimeStore === undefined) await mkdir(directory, { recursive: true });
        this.lifetimeStore = await (this.options.openLifetimeStore?.(directory)
          ?? openLifetimeStore({ directory, now: this.options.now }));
        const state = this.lifetimeStore.state();
        this.committedLifetime = state.root ?? emptyLifetimeRoot(this.nowIso());
        this.lifetimeWriter = state.mode === "writer" || state.mode === "degraded";
        this.lifetimeFrozen = state.mode === "recoveryRequired";
      } catch (err) {
        this.logWarn("lifetime store open failed", err);
        this.committedLifetime = emptyLifetimeRoot(this.nowIso());
        this.lifetimeWriter = false;
        this.lifetimeOpenFailed = true;
      }
    }
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
    const timer = this.options.scheduleInterval(() => {
      this.tick();
    }, interval);
    // Required so the sampler does not keep the process alive (round 8 fix).
    timer.unref?.();
    this.sampleTimer = timer;
    if (this.lifetimeStore !== null && this.lifetimeWriter) {
      const checkpointTimer = this.options.scheduleInterval(() => {
        void this.queueLifetimeOperation(() => this.checkpointLifetime()).catch((err) => {
          this.logWarn("lifetime checkpoint failed", err);
        });
      }, CHECKPOINT_INTERVAL_MS);
      checkpointTimer.unref?.();
      this.checkpointTimer = checkpointTimer;
    }
  }

  /**
   * Stop sampling. Releases the interval timer and disables the
   * event-loop histogram. Safe to call when not started.
   */
  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;
    const starting = this.startPromise;
    this.startPromise = null;
    const stopping = this.stopInternal(starting);
    const settled = stopping.finally(() => {
      if (this.stopPromise === settled) this.stopPromise = null;
    });
    this.stopPromise = settled;
    return settled;
  }

  private async stopInternal(starting: Promise<void> | null): Promise<void> {
    if (starting !== null) await starting;
    if (this.sampleTimer !== null) {
      this.options.clearScheduledInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.checkpointTimer !== null) {
      this.options.clearScheduledInterval(this.checkpointTimer);
      this.checkpointTimer = null;
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
    const store = this.lifetimeStore;
    try {
      if (store !== null) {
        await this.queueLifetimeOperation(async () => {
          let boundary: PublicationBoundary | null = null;
          try {
            boundary = this.lifetimeWriter && !this.lifetimeFrozen
              ? this.capturePublicationBoundary()
              : null;
            const snapshot = boundary === null
              ? undefined
              : this.buildLifetimeCandidate(this.nowIso(), boundary);
            await store.close(snapshot);
            if (snapshot !== undefined && boundary !== null) {
              this.acceptCommittedLifetime(snapshot, boundary);
            }
          } catch (error) {
            if (boundary !== null) this.restorePublicationBoundary(boundary);
            throw error;
          }
        });
      }
    } finally {
      this.lifetimeStore = null;
    }
  }

  /**
   * Internal sampler â€” invoked by the interval timer. Pulls CPU/memory/event-loop
   * lag, fans the sample out to every known aggregator, then notifies subscribers.
   * Exceptions are caught locally so the timer keeps firing.
   */
  private tick(): void {
    try {
      const sample = this.collectResourceSample();
      const dispatchSample = getToolDispatchStats();
      this.recordProcessFreshness("resources");
      if (this.lifetimeWriter && !this.lifetimeFrozen) {
        this.processPeakEpoch = mergeProcessPeaks(this.processPeakEpoch, {
          cpuPct: safeTotal(sample.cpuPct),
          rssMb: safeTotal(sample.rssMb),
          heapUsedMb: safeTotal(sample.heapUsedMb),
          heapTotalMb: safeTotal(sample.heapTotalMb),
          eventLoopLagMs: safeTotal(sample.eventLoopLagMs),
        });
      }
      for (const { aggregator } of this.aggregators.values()) {
        try {
          aggregator.recordResourceSample(sample);
        } catch (err) {
          this.logWarn("aggregator.recordResourceSample failed", err);
        }
        try {
          aggregator.recordDispatchSample(dispatchSample);
        } catch (err) {
          this.logWarn("aggregator.recordDispatchSample failed", err);
        }
        try {
          aggregator.computeAndRecordHealth();
        } catch (err) {
          this.logWarn("aggregator.computeAndRecordHealth failed", err);
        }
      }
      // Beam: surface retained explain-handle count.
      try {
        const beamStore = this.beamExplainStore;
        if (beamStore !== null) {
          const size = beamStore.size === undefined ? 0 : beamStore.size();
          for (const { aggregator } of this.aggregators.values()) {
            aggregator.setBeamRetainedHandles(size);
          }
        }
      } catch (err) {
        this.logWarn("beamExplainStore.size failed", err);
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
        // p95 in nanoseconds â†’ ms.
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
    return this.getSessionRepository(repoId).aggregator;
  }

  private getSessionRepository(repoId: string): SessionRepositoryState {
    let entry = this.aggregators.get(repoId);
    if (entry === undefined) {
      entry = { aggregator: this.newAggregator(), freshness: emptyFreshness() };
      this.aggregators.set(repoId, entry);
    }
    return entry;
  }

  private newAggregator(): Aggregator {
    const shortMin = this.config.retentionShortMinutes;
    const longHr = this.config.retentionLongHours;
    return new Aggregator({
      shortWindowMs: shortMin * 60_000,
      shortCapacity: shortMin * 60,
      longWindowMs: longHr * 3_600_000,
      longCapacity: longHr * 60,
      ioThroughputSaturationMbPerSec:
        DEFAULT_AGGREGATOR_OPTIONS.ioThroughputSaturationMbPerSec,
    });
  }

  /**
   * Compute and return a snapshot for the given repository.
   * Lazily creates the aggregator if needed.
   */
  getSnapshot(repoId: string): ObservabilitySnapshot {
    const aggregator = this.getAggregator(repoId);
    try {
      aggregator.recordDispatchSample(getToolDispatchStats());
    } catch (err) {
      this.logWarn("aggregator.recordDispatchSample failed", err);
    }
    return aggregator.getSnapshot(repoId);
  }

  /**
   * Compute and return time-series data for the given repository.
   */
  getTimeseries(repoId: string, window: TimeseriesWindow): TimeseriesResponse {
    return this.getAggregator(repoId).getTimeseries(repoId, window);
  }

  async getLifetime(repoId: string): Promise<LifetimeEnvelopeV1> {
    if (this.startPromise !== null) await this.startPromise;
    const store = this.lifetimeStore;
    let refreshRecoveryReason: RecoveryReason | null = null;
    if (store !== null && store.state().mode === "readOnly") {
      try {
        const outcome = await store.refreshReadOnly();
        if (outcome.status === "refreshed") {
          this.committedLifetime = outcome.root;
        } else if (outcome.status === "ioFailure") {
          this.logWarn("lifetime read-only refresh failed", outcome.status);
        } else if (outcome.status === "recoveryRequired") {
          refreshRecoveryReason = outcome.reason;
        }
      } catch (err) {
        this.logWarn("lifetime read-only refresh failed", err);
      }
    }

    const state = store?.state();
    const generatedAt = this.nowIso();
    if (this.lifetimeFrozen || refreshRecoveryReason !== null || state?.mode === "recoveryRequired") {
      return {
        schemaVersion: LIFETIME_SCHEMA_VERSION,
        sampleIntervalMs: clampInterval(this.config.sampleIntervalMs),
        generatedAt,
        repoId,
        persistenceState: "recoveryRequired",
        recoveryReason: refreshRecoveryReason
          ?? (state?.mode === "recoveryRequired" ? state.reason : "indeterminatePublication"),
      };
    }

    const stored = this.committedLifetime?.repositories[repositoryStorageKey(repoId)];
    const live = this.lifetimeRepositories.get(repoId);
    const readOnly = state?.mode === "readOnly";
    const session = this.aggregators.get(repoId);
    const hasRepositoryEvent = session !== undefined
      && SECTION_IDS.some((section) => session.freshness[section] !== null);
    const capacityExceeded = !readOnly
      && hasRepositoryEvent
      && stored === undefined
      && live === undefined
      && !admitRepository(
        this.buildCurrentLifetimeRoot(generatedAt),
        repoId,
        emptyRepositoryLifetime(),
      ).admitted;
    const value = capacityExceeded
      ? emptyRepositoryLifetime()
      : readOnly
        ? stored ?? emptyRepositoryLifetime()
        : live === undefined
          ? stored ?? emptyRepositoryLifetime()
          : lifetimeView(live.baseline, this.visibleActiveLifetime(repoId, live));
    return {
      schemaVersion: LIFETIME_SCHEMA_VERSION,
      sampleIntervalMs: clampInterval(this.config.sampleIntervalMs),
      generatedAt,
      repoId,
      epoch: value.epoch,
      resetAt: value.resetAt,
      lastCheckpointAt: value.lastCheckpointAt,
      persistenceState: readOnly
        ? "readOnly"
        : capacityExceeded
          ? "capacityExceeded"
          : state?.mode === "degraded" || this.lifetimeOpenFailed
            ? "degraded"
            : "ready",
      sessionCount: value.sessionCount,
      saturated: value.saturated,
      sections: capacityExceeded ? emptyLifetimeSections() : structuredClone(value.sections),
      freshness: this.responseFreshness(repoId),
      processPeaks: this.lifetimeWriter && !this.lifetimeFrozen
        ? this.visibleProcessPeaks()
        : this.committedLifetime?.processPeaks ?? null,
    };
  }

  async resetLifetime(repoId: string): Promise<LifetimeReadyV1> {
    if (this.startPromise !== null) await this.startPromise;
    return this.queueLifetimeOperation(async () => {
      const store = this.lifetimeStore;
      const mode = store?.state().mode;
      if (store === null || mode === "readOnly") throw new Error("Lifetime store is read-only");
      if (this.lifetimeFrozen || mode === "recoveryRequired") {
        throw new Error("Lifetime recovery required");
      }
      if (!this.isRegisteredRepoId(repoId)) throw new Error("Repository is not registered");
      const target = this.ensureLifetimeRepository(repoId);
      if (target === null) throw new Error("Lifetime repository capacity exceeded");

      const resetAt = this.nowIso();
      const oldTargetBaseline = structuredClone(target.baseline);
      const capturedActive = structuredClone(target.active);
      const capturedProduced = target.eventProduced;
      const boundary = this.snapshotPublicationBoundary();
      target.active = activeLifetimeMetadata(oldTargetBaseline);
      target.eventProduced = false;
      const rollback = (): void => {
        this.pendingReset = null;
        target.baseline = oldTargetBaseline;
        target.active = mergeRepositoryLifetime(
          capturedActive,
          activeLifetimeMetadata(oldTargetBaseline, target.active),
        );
        target.eventProduced = capturedProduced || target.eventProduced;
      };
      let candidate: DurableLifetimeRoot;
      let resetValue: DurableLifetimeRepository;
      try {
        candidate = this.buildResetCandidate(repoId, resetAt, boundary);
        const candidateValue = candidate.repositories[repositoryStorageKey(repoId)];
        if (candidateValue === undefined) throw new Error("Reset repository is unavailable");
        resetValue = candidateValue;
        // Events arriving while reset publishes belong to the new epoch.
        target.baseline = resetValue;
        target.active = activeLifetimeMetadata(resetValue, target.active);
        this.pendingReset = {
          targetRepoId: repoId,
          boundary,
          interleaved: new Map(),
          eventProduced: new Set(),
        };
      } catch (error) {
        rollback();
        throw error;
      }
      let outcome: PublishOutcome;
      try {
        outcome = await store.reset(candidate);
      } catch (err) {
        rollback();
        throw err;
      }
      if (outcome.status === "committed") {
        this.acceptCommittedReset(outcome.root, repoId, resetValue, boundary);
        return this.readyLifetime(repoId, "ready");
      }
      if (outcome.status === "notPublished") {
        rollback();
        return this.readyLifetime(repoId, "degraded");
      }
      this.lifetimeFrozen = true;
      throw new Error(`Lifetime reset indeterminate: ${outcome.reason}`);
    });
  }

  private readyLifetime(
    repoId: string,
    persistenceState: LifetimeReadyV1["persistenceState"],
  ): LifetimeReadyV1 {
    const state = this.lifetimeRepositories.get(repoId);
    const value = state === undefined
      ? this.committedLifetime?.repositories[repositoryStorageKey(repoId)]
        ?? emptyRepositoryLifetime()
      : lifetimeView(state.baseline, this.visibleActiveLifetime(repoId, state));
    return {
      schemaVersion: LIFETIME_SCHEMA_VERSION,
      sampleIntervalMs: clampInterval(this.config.sampleIntervalMs),
      generatedAt: this.nowIso(),
      repoId,
      epoch: value.epoch,
      resetAt: value.resetAt,
      lastCheckpointAt: value.lastCheckpointAt,
      persistenceState,
      sessionCount: value.sessionCount,
      saturated: value.saturated,
      sections: structuredClone(value.sections),
      freshness: this.responseFreshness(repoId),
      processPeaks: this.visibleProcessPeaks(),
    };
  }

  private queueLifetimeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifetimeTail.then(operation, operation);
    this.lifetimeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async checkpointLifetime(): Promise<void> {
    const store = this.lifetimeStore;
    if (store === null || !this.lifetimeWriter || this.lifetimeFrozen) return;
    const checkpointAt = this.nowIso();
    const boundary = this.capturePublicationBoundary();
    this.pendingCheckpoint = boundary;
    let candidate: DurableLifetimeRoot;
    try {
      candidate = this.buildLifetimeCandidate(checkpointAt, boundary);
    } catch (error) {
      this.restorePublicationBoundary(boundary);
      throw error;
    }
    let outcome: PublishOutcome;
    try {
      outcome = await store.checkpoint(candidate);
    } catch (err) {
      this.restorePublicationBoundary(boundary);
      throw err;
    }
    if (outcome.status === "committed") {
      this.acceptCommittedLifetime(outcome.root, boundary);
    } else if (outcome.status === "notPublished") {
      this.restorePublicationBoundary(boundary);
    } else {
      this.lifetimeFrozen = true;
    }
  }

  private capturePublicationBoundary(): PublicationBoundary {
    const boundary = this.snapshotPublicationBoundary();
    for (const state of this.lifetimeRepositories.values()) {
      state.active = activeLifetimeMetadata(state.baseline);
      state.eventProduced = false;
    }
    this.processPeakEpoch = null;
    return boundary;
  }

  private snapshotPublicationBoundary(): PublicationBoundary {
    const actives = new Map<string, DurableLifetimeRepository>();
    const eventProduced = new Map<string, boolean>();
    for (const [repoId, state] of this.lifetimeRepositories) {
      actives.set(repoId, structuredClone(state.active));
      eventProduced.set(repoId, state.eventProduced);
    }
    const processPeaks = this.processPeakEpoch === null
      ? null
      : structuredClone(this.processPeakEpoch);
    return { actives, eventProduced, processPeaks };
  }

  private restorePublicationBoundary(boundary: PublicationBoundary): void {
    for (const [repoId, active] of boundary.actives) {
      const state = this.lifetimeRepositories.get(repoId);
      if (state === undefined) continue;
      state.active = mergeRepositoryLifetime(active, state.active);
      state.eventProduced = (boundary.eventProduced.get(repoId) ?? false)
        || state.eventProduced;
    }
    this.processPeakEpoch = mergeProcessPeaks(boundary.processPeaks, this.processPeakEpoch);
    if (this.pendingCheckpoint === boundary) this.pendingCheckpoint = null;
  }

  private buildLifetimeCandidate(
    timestamp: string,
    boundary: PublicationBoundary,
  ): DurableLifetimeRoot {
    const base = structuredClone(this.committedLifetime ?? emptyLifetimeRoot(timestamp));
    for (const [repoId, state] of this.lifetimeRepositories) {
      const active = boundary.actives.get(repoId) ?? activeLifetimeMetadata(state.baseline);
      let repository = lifetimeView(state.baseline, active);
      const produced = boundary.eventProduced.get(repoId) ?? false;
      if (produced && !state.sessionCounted) {
        repository = incrementSessionCount(repository).value;
      }
      repository = { ...repository, lastCheckpointAt: timestamp };
      base.repositories[repositoryStorageKey(repoId)] = repository;
    }
    return {
      ...base,
      generation: Math.min(Number.MAX_SAFE_INTEGER, base.generation + 1),
      updatedAt: timestamp,
      processPeaks: mergeProcessPeaks(
        base.processPeaks,
        boundary.processPeaks,
      ),
      repositories: orderedRecord(base.repositories),
    };
  }

  private buildResetCandidate(
    repoId: string,
    timestamp: string,
    boundary: PublicationBoundary,
  ): DurableLifetimeRoot {
    const base = structuredClone(this.committedLifetime ?? emptyLifetimeRoot(timestamp));
    for (const [currentRepoId, state] of this.lifetimeRepositories) {
      const captured = boundary.actives.get(currentRepoId)
        ?? activeLifetimeMetadata(state.baseline);
      let repository = lifetimeView(state.baseline, captured);
      if (currentRepoId === repoId) {
        repository = resetRepositoryLifetime(repository, timestamp);
      } else {
        if ((boundary.eventProduced.get(currentRepoId) ?? false) && !state.sessionCounted) {
          repository = incrementSessionCount(repository).value;
        }
        repository = { ...repository, lastCheckpointAt: timestamp };
      }
      base.repositories[repositoryStorageKey(currentRepoId)] = repository;
    }
    return {
      ...base,
      generation: Math.min(Number.MAX_SAFE_INTEGER, base.generation + 1),
      updatedAt: timestamp,
      processPeaks: mergeProcessPeaks(base.processPeaks, boundary.processPeaks),
      repositories: orderedRecord(base.repositories),
    };
  }

  private acceptCommittedReset(
    root: DurableLifetimeRoot,
    targetRepoId: string,
    resetValue: DurableLifetimeRepository,
    boundary: PublicationBoundary,
  ): void {
    const pending = this.pendingReset;
    this.committedLifetime = structuredClone(root);
    for (const [repoId, state] of this.lifetimeRepositories) {
      const stored = root.repositories[repositoryStorageKey(repoId)];
      if (repoId === targetRepoId) {
        state.baseline = stored ?? resetValue;
        state.active = activeLifetimeMetadata(state.baseline, state.active);
        state.sessionCounted = false;
        continue;
      }
      if (stored !== undefined) state.baseline = stored;
      if (boundary.eventProduced.get(repoId) ?? false) state.sessionCounted = true;
      const interleaved = pending?.interleaved.get(repoId)
        ?? activeLifetimeMetadata(state.baseline);
      state.active = activeLifetimeMetadata(state.baseline, interleaved);
      state.eventProduced = pending?.eventProduced.has(repoId) ?? false;
    }
    this.pendingReset = null;
  }

  private acceptCommittedLifetime(
    root: DurableLifetimeRoot,
    boundary: PublicationBoundary,
  ): void {
    this.committedLifetime = structuredClone(root);
    for (const [repoId, state] of this.lifetimeRepositories) {
      const stored = root.repositories[repositoryStorageKey(repoId)];
      if (stored !== undefined) state.baseline = stored;
      if (boundary.eventProduced.get(repoId) ?? false) {
        state.sessionCounted = true;
      }
      state.active = activeLifetimeMetadata(state.baseline, state.active);
    }
    if (this.pendingCheckpoint === boundary) this.pendingCheckpoint = null;
  }

  private buildCurrentLifetimeRoot(timestamp: string): DurableLifetimeRoot {
    const root = structuredClone(this.committedLifetime ?? emptyLifetimeRoot(timestamp));
    for (const [repoId, state] of this.lifetimeRepositories) {
      root.repositories[repositoryStorageKey(repoId)] = lifetimeView(
        state.baseline,
        this.visibleActiveLifetime(repoId, state),
      );
    }
    root.processPeaks = mergeProcessPeaks(root.processPeaks, this.processPeakEpoch);
    return root;
  }

  private ensureLifetimeRepository(repoId: string): LifetimeRepositoryState | null {
    const existing = this.lifetimeRepositories.get(repoId);
    if (existing !== undefined) return existing;
    const stored = this.committedLifetime?.repositories[repositoryStorageKey(repoId)];
    const baseline = stored ?? emptyRepositoryLifetime();
    const admission = admitRepository(
      this.buildCurrentLifetimeRoot(this.nowIso()),
      repoId,
      baseline,
    );
    if (!admission.admitted) return null;
    const created: LifetimeRepositoryState = {
      baseline,
      active: activeLifetimeMetadata(baseline),
      eventProduced: false,
      sessionCounted: false,
    };
    this.lifetimeRepositories.set(repoId, created);
    return created;
  }

  private recordLifetimeEvent(
    repoId: string | undefined,
    sections: readonly SectionId[],
    createDelta: () => DurableLifetimeRepository,
  ): void {
    if (repoId === undefined || !this.isRegisteredRepoId(repoId)) return;
    const timestamp = this.nowIso();
    const freshness = this.getSessionRepository(repoId).freshness;
    for (const section of sections) freshness[section] = timestamp;
    if (!this.lifetimeWriter || this.lifetimeFrozen) return;
    const state = this.ensureLifetimeRepository(repoId);
    if (state === null) return;
    const delta = createDelta();
    state.active = mergeRepositoryLifetime(state.active, delta);
    state.eventProduced = true;
    const pending = this.pendingReset;
    if (pending !== null && pending.targetRepoId !== repoId) {
      const interleaved = pending.interleaved.get(repoId)
        ?? activeLifetimeMetadata(state.baseline);
      pending.interleaved.set(repoId, mergeRepositoryLifetime(interleaved, delta));
      pending.eventProduced.add(repoId);
    }
  }

  private visibleActiveLifetime(
    repoId: string,
    state: LifetimeRepositoryState,
  ): DurableLifetimeRepository {
    const captured = this.pendingCheckpoint?.actives.get(repoId);
    return captured === undefined
      ? state.active
      : mergeRepositoryLifetime(captured, state.active);
  }

  private visibleProcessPeaks(): ProcessPeaks | null {
    return mergeProcessPeaks(
      mergeProcessPeaks(
        this.committedLifetime?.processPeaks ?? null,
        this.pendingCheckpoint?.processPeaks ?? null,
      ),
      this.processPeakEpoch,
    );
  }

  private recordProcessFreshness(section: "pool" | "auditBuffer" | "resources"): void {
    this.processFreshness[section] = this.nowIso();
  }

  private responseFreshness(repoId: string): LifetimeFreshness {
    const freshness = this.aggregators.get(repoId)?.freshness ?? emptyFreshness();
    return {
      ...freshness,
      pool: this.processFreshness.pool,
      auditBuffer: this.processFreshness.auditBuffer,
      resources: this.processFreshness.resources,
    };
  }

  private isRegisteredRepoId(repoId: string): boolean {
    try {
      repositoryStorageKey(repoId);
      return repoId !== "_global" && this.options.isRegisteredRepoId(repoId);
    } catch {
      return false;
    }
  }

  private watcherHealthLifetimeDelta(
    event: WatcherHealthTelemetryEvent,
  ): DurableLifetimeRepository {
    const current = watcherHealthCumulativeSnapshot(event);
    const previous = this.watcherCumulative.get(event.repoId);
    this.watcherCumulative.set(event.repoId, current);
    return sectionDelta("health", cumulativeHealthDelta(current, previous));
  }

  private prefetchLifetimeDelta(
    event: PrefetchTelemetryEvent,
  ): DurableLifetimeRepository {
    const snapshot = prefetchCumulativeSnapshot(event);
    const current = snapshot.sections.predictiveContext;
    if (current === null) return emptyRepositoryLifetime();
    const previous = this.prefetchCumulative.get(event.repoId);
    const retained = retainPrefetchCumulativeShadow(current, previous);
    const delta = cumulativePrefetchDelta(retained.current, previous);
    const overflowDelta = delta.byStrategy[OVERFLOW_KEY];
    if (overflowDelta !== undefined) {
      const previousOverflow = previous?.byStrategy[OVERFLOW_KEY];
      retained.next.byStrategy[OVERFLOW_KEY] = previousOverflow === undefined
        ? structuredClone(overflowDelta)
        : mergePrefetchStrategySnapshots(previousOverflow, overflowDelta);
    }
    this.prefetchCumulative.set(event.repoId, {
      ...retained.next,
      byStrategy: orderedRecord(retained.next.byStrategy),
    });
    return sectionDelta("predictiveContext", delta);
  }

  private nowIso(): string {
    return this.options.now().toISOString();
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
   * isolated â€” one bad subscriber cannot kill the rest.
   */
  onGraphEvent(cb: GraphSubscriber): () => void {
    this.graphSubscribers.add(cb);
    return () => {
      this.graphSubscribers.delete(cb);
    };
  }

  getRecentGraphEvents(limit = 200): GraphActivityEvent[] {
    return this.graphEvents.snapshot().slice(-limit).map((entry) => entry.v);
  }

  graphEvent(event: GraphActivityEvent): void {
    this.recordGraphEvent(event);
  }

  recordGraphEvent(event: GraphActivityEvent): void {
    try {
      this.graphEvents.push(event);
      for (const cb of this.graphSubscribers) {
        try {
          cb(event);
        } catch (err) {
          this.logWarn("graph subscriber failed", err);
        }
      }
    } catch (err) {
      this.logWarn("recordGraphEvent failed", err);
    }
  }

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
  // ObservabilityTap surface â€” every method routes to the relevant aggregator
  // and is wrapped in try/catch.
  // -------------------------------------------------------------------------

  toolCall(event: ToolCallEvent): void {
    try {
      const repoId = event.repoId ?? "_global";
      this.getAggregator(repoId).recordToolCall(event);
      const sections: SectionId[] = ["latency"];
      if (event.tokensUsed !== undefined || event.tokensSaved !== undefined) {
        sections.push("tokenEfficiency");
      }
      if (event.projection !== undefined) sections.push("toolOutput");
      this.recordLifetimeEvent(event.repoId, sections, () => toolCallLifetimeDelta(event));
    } catch (err) {
      this.logWarn("toolCall failed", err);
    }
  }

  indexEvent(event: IndexEvent): void {
    try {
      this.getAggregator(event.repoId).recordIndexEvent(event);
      this.recordLifetimeEvent(event.repoId, ["indexing"], () => indexEventLifetimeDelta(event));
    } catch (err) {
      this.logWarn("indexEvent failed", err);
    }
    this.recordGraphEvent({
      type: "graph.index.completed",
      repoId: event.repoId,
      mode: "refresh",
      symbolCount: event.stats.symbolsExtracted,
    });
    if (event.stats.symbolsExtracted > 0) {
      this.recordGraphEvent({
        type: "graph.symbols.upserted",
        repoId: event.repoId,
        count: event.stats.symbolsExtracted,
        clusterIds: [],
        symbolIds: [],
      });
    }
  }

  semanticSearch(event: SemanticSearchTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordSemanticSearch(event);
      this.recordLifetimeEvent(event.repoId, ["retrieval"], () =>
        semanticSearchLifetimeDelta(event));
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
      this.recordLifetimeEvent(event.repoId, ["predictiveContext"], () =>
        this.prefetchLifetimeDelta(event));
    } catch (err) {
      this.logWarn("prefetch failed", err);
    }
  }

  watcherHealth(event: WatcherHealthTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordWatcherHealth(event);
      this.recordLifetimeEvent(event.repoId, ["health"], () =>
        this.watcherHealthLifetimeDelta(event));
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
      this.recordLifetimeEvent(event.repoId, ["latency"], () => runtimeLifetimeDelta(event));
    } catch (err) {
      this.logWarn("runtimeExecution failed", err);
    }
  }

  dbLatency(event: {
    operation: "queryAll" | "exec";
    latencyMs: number;
    queueMs?: number;
    nativeMs?: number;
    success?: boolean;
  }): void {
    try {
      const latencyMs =
        typeof event.nativeMs === "number" && Number.isFinite(event.nativeMs)
          ? event.nativeMs
          : event.latencyMs;
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordDbLatency(latencyMs);
      }
    } catch (err) {
      this.logWarn("dbLatency failed", err);
    }
  }

  setupPipeline(_event: SetupPipelineEvent): void {
    // Reserved â€” setup pipeline is one-shot; no per-repo aggregation needed yet.
  }

  summaryGeneration(_event: SummaryGenerationEvent): void {
    // Reserved â€” summary cost/duration surfaced via tool-call telemetry already.
  }

  summaryQuality(_event: SummaryQualityTelemetryEvent): void {
    // Reserved â€” quality divergence surfaced via dedicated quality dashboard.
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
      this.recordLifetimeEvent(event.repoId, ["ppr"], () => pprLifetimeDelta(event));
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
      this.recordLifetimeEvent(event.repoId, ["scip"], () => scipLifetimeDelta(event));
    } catch (err) {
      this.logWarn("scipIngest failed", err);
    }
    const edgeCount = event.edgesCreated + event.edgesUpgraded;
    if (!event.failed && edgeCount > 0) {
      this.recordGraphEvent({
        type: "graph.edges.added",
        repoId: event.repoId,
        count: edgeCount,
        kinds: { dependency: edgeCount },
      });
    }
  }

  packedWire(event: PackedWireTapEvent): void {
    try {
      // Session snapshots fan out globally; lifetime attribution stays repo-scoped.
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordPackedWire(event);
      }
      this.recordLifetimeEvent(event.repoId, ["packed", "tokenEfficiency"], () =>
        packedLifetimeDelta(event));
    } catch (err) {
      this.logWarn("packedWire failed", err);
    }
  }

  tokenSavings(event: TokenSavingsTapEvent): void {
    try {
      this.getAggregator(event.repoId ?? "_global").recordTokenSavingsEvent({
        source: event.source,
        tool: event.tool,
        estimatedTokensAvoided: event.estimatedTokensAvoided,
        storedBytes: event.storedBytes,
        opportunity: event.opportunity,
        hit: event.hit,
        realized: event.realized,
      });
      this.recordLifetimeEvent(event.repoId, ["tokenEfficiency"], () =>
        tokenSavingsLifetimeDelta(event));
    } catch (err) {
      this.logWarn("tokenSavings failed", err);
    }
  }

  poolSample(event: PoolSampleTapEvent): void {
    try {
      // Pool depths are process-global â€” fan out to every aggregator.
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordPoolSample(event);
      }
      this.recordProcessFreshness("pool");
    } catch (err) {
      this.logWarn("poolSample failed", err);
    }
  }

  resourceSample(event: ResourceSampleTapEvent): void {
    try {
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordResourceSample(event);
      }
      this.recordProcessFreshness("resources");
      if (this.lifetimeWriter && !this.lifetimeFrozen) {
        this.processPeakEpoch = mergeProcessPeaks(this.processPeakEpoch, {
          cpuPct: safeTotal(event.cpuPct),
          rssMb: safeTotal(event.rssMb),
          heapUsedMb: safeTotal(event.heapUsedMb),
          heapTotalMb: safeTotal(event.heapTotalMb),
          eventLoopLagMs: safeTotal(event.eventLoopLagMs),
        });
      }
    } catch (err) {
      this.logWarn("resourceSample failed", err);
    }
  }

  indexPhase(event: IndexPhaseTapEvent): void {
    try {
      const targetRepoId = event.repoId;
      if (targetRepoId !== undefined && targetRepoId.length > 0) {
        // Scoped event - apply only to the named aggregator.
        this.getAggregator(targetRepoId).recordIndexPhase({
          phase: event.phase,
          language: event.language,
          engine: event.engine,
          durationMs: event.durationMs,
        });
        this.recordLifetimeEvent(targetRepoId, ["indexing"], () =>
          indexPhaseLifetimeDelta(event));
        if (event.phase.toLowerCase().includes("start")) {
          this.recordGraphEvent({ type: "graph.index.started", repoId: targetRepoId, mode: event.phase });
        }
        return;
      }
      // Legacy unscoped event - fan out to every known aggregator.
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordIndexPhase({
          phase: event.phase,
          language: event.language,
          engine: event.engine,
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
      this.recordLifetimeEvent(event.repoId, ["cache"], () => cacheLifetimeDelta(event));
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
        maxFrontierSize: event.maxFrontierSize,
      });
      this.recordLifetimeEvent(event.repoId, ["beam"], () => beamLifetimeDelta(event));
    } catch (err) {
      this.logWarn("sliceBuild failed", err);
    }
    this.recordGraphEvent({
      type: "graph.slice.built",
      repoId: event.repoId ?? "_global",
      entrySymbols: [],
      cardCount: event.accepted,
    });
  }

  deltaBlastRadius(event: DeltaBlastRadiusTapEvent): void {
    try {
      this.getAggregator(event.repoId ?? "_global").recordDeltaBlastRadius({
        changedSymbolCount: event.changedSymbolCount,
        blastRadiusCount: event.blastRadiusCount,
        durationMs: event.durationMs,
        dbRoundTrips: event.dbRoundTrips,
        fallbackPathQueryCount: event.fallbackPathQueryCount,
        pathExplanationLatencyMs: event.pathExplanationLatencyMs,
      });
      this.recordLifetimeEvent(event.repoId, ["delta"], () => deltaLifetimeDelta(event));
    } catch (err) {
      this.logWarn("deltaBlastRadius failed", err);
    }
    this.recordGraphEvent({
      type: "graph.delta.computed",
      repoId: event.repoId ?? "_global",
      changedCount: event.changedSymbolCount,
      blastCount: event.blastRadiusCount,
    });
  }

  auditBufferSample(event: AuditBufferTapEvent): void {
    try {
      // Audit buffer is process-global; fan out to all aggregators so any
      // active repo's snapshot reflects the same gauge value.
      for (const { aggregator } of this.aggregators.values()) {
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
      this.recordProcessFreshness("auditBuffer");
    } catch (err) {
      this.logWarn("auditBufferSample failed", err);
    }
  }

  postIndexSession(event: PostIndexSessionTapEvent): void {
    try {
      // Session snapshots fan out globally; lifetime attribution stays repo-scoped.
      const rec = {
        durationMs: event.durationMs,
        timedOut: event.timedOut,
        endedAt: new Date().toISOString(),
      };
      for (const { aggregator } of this.aggregators.values()) {
        aggregator.recordPostIndexSession(rec);
      }
      this.getAggregator("_global").recordPostIndexSession(rec);
      this.recordLifetimeEvent(event.repoId, ["postIndex"], () => postIndexLifetimeDelta(event));
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
      // Logger itself failed â€” give up silently so a metrics bug cannot crash the host.
    }
  }
}

function emptyLifetimeRoot(updatedAt: string): DurableLifetimeRoot {
  return {
    schemaVersion: LIFETIME_SCHEMA_VERSION,
    generation: 0,
    updatedAt,
    processPeaks: null,
    repositories: {},
  };
}

function emptyFreshness(): LifetimeFreshness {
  return Object.fromEntries(SECTION_IDS.map((section) => [section, null])) as LifetimeFreshness;
}

function activeLifetimeMetadata(
  baseline: DurableLifetimeRepository,
  existing = emptyRepositoryLifetime(),
): DurableLifetimeRepository {
  return {
    ...structuredClone(existing),
    epoch: baseline.epoch,
    resetAt: null,
    lastCheckpointAt: null,
    sessionCount: 0,
  };
}

function safeCounter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

function safeTotal(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value)
    : 0;
}

function exactSample(value: unknown, count = 1): SampleTotal {
  const total = safeTotal(value);
  return total === 0 && value !== 0
    ? { count: 0, sum: 0, max: 0 }
    : { count: safeCounter(count), sum: total, max: total };
}

function aggregateSample(count: unknown, average: unknown): SampleTotal {
  const safeCount = safeCounter(count);
  const sum = safeTotal(safeCount * safeTotal(average));
  return { count: safeCount, sum, max: 0 };
}

function sectionDelta<K extends keyof DurableLifetimeSections>(
  section: K,
  value: DurableLifetimeSections[K],
): DurableLifetimeRepository {
  return {
    ...emptyRepositoryLifetime(),
    sections: { ...emptyLifetimeSections(), [section]: value } as DurableLifetimeSections,
  };
}

function combineLifetimeDeltas(
  deltas: readonly DurableLifetimeRepository[],
): DurableLifetimeRepository {
  return deltas.reduce(
    (active, delta) => mergeRepositoryLifetime(active, delta),
    emptyRepositoryLifetime(),
  );
}

function dynamicEntry<T>(rawIdentifier: string, value: T): Record<string, T> {
  return { [canonicalDynamicKey(rawIdentifier)]: value };
}

function emptyRetrievalSection(): NonNullable<DurableLifetimeSections["retrieval"]> {
  return {
    calls: 0, emptyResults: 0, latencyMs: exactSample(0, 0), byMode: {}, byType: {},
    candidatesBySource: {}, phaseLatencyMs: {},
  };
}

function emptyIndexingSection(): NonNullable<DurableLifetimeSections["indexing"]> {
  return {
    events: 0, pass1Ms: exactSample(0, 0), pass2Ms: exactSample(0, 0), failures: 0,
    phaseCounts: {}, languageMs: {}, engineDispatch: {}, derivedLagMs: exactSample(0, 0),
  };
}

function emptyTokenSection(): NonNullable<DurableLifetimeSections["tokenEfficiency"]> {
  return { calls: 0, usedTokens: 0, savedTokens: 0, compressionBySource: {} };
}

function emptyToolOutputCounters(): ToolOutputLifetimeCounters {
  return {
    calls: 0, errors: 0, rawBytes: 0, projectedBytes: 0, rawTokens: 0,
    projectedTokens: 0, removedFields: 0, handled: 0, truncated: 0,
    recoveryEmitted: 0, invalidRecovery: 0, projectedBytesMax: 0,
    projectedTokensMax: 0, detailCounts: {}, profileCounts: {},
  };
}

function cacheLifetimeDelta(event: CacheLookupTapEvent): DurableLifetimeRepository {
  const count = event.count !== undefined && event.count > 0 ? safeCounter(event.count) : 1;
  const hits = event.hits === undefined
    ? (event.hit ? count : 0)
    : Math.min(count, safeCounter(event.hits));
  const value = {
    hits, misses: count - hits, lookupMs: exactSample(event.latencyMs, count),
    perSource: dynamicEntry(event.source, {
      hits, misses: count - hits, lookupMs: exactSample(event.latencyMs, count),
    }),
  };
  return sectionDelta("cache", value);
}

function semanticSearchLifetimeDelta(event: SemanticSearchTelemetryEvent): DurableLifetimeRepository {
  const base = emptyRetrievalSection();
  base.calls = 1;
  base.emptyResults = (event.finalResultCount ?? 0) === 0 ? 1 : 0;
  base.latencyMs = exactSample(event.latencyMs);
  base.byMode = dynamicEntry(event.retrievalMode ?? "unknown", 1);
  base.byType = dynamicEntry(event.retrievalType ?? "unknown", 1);
  const deltas = [sectionDelta("retrieval", base)];
  for (const [key, value] of Object.entries(event.candidateCountPerSource ?? {})) {
    deltas.push(sectionDelta("retrieval", {
      ...emptyRetrievalSection(), candidatesBySource: dynamicEntry(key, safeCounter(value)),
    }));
  }
  for (const [key, value] of Object.entries(event.phaseLatencyMs ?? {})) {
    deltas.push(sectionDelta("retrieval", {
      ...emptyRetrievalSection(), phaseLatencyMs: dynamicEntry(key, exactSample(value)),
    }));
  }
  return combineLifetimeDeltas(deltas);
}

function beamLifetimeDelta(event: SliceBuildTapEvent): DurableLifetimeRepository {
  return sectionDelta("beam", {
    builds: 1, buildMs: exactSample(event.durationMs), accepted: safeCounter(event.accepted),
    evicted: safeCounter(event.evicted), rejected: safeCounter(event.rejected),
    frontierMax: event.maxFrontierSize === undefined
      ? exactSample(0, 0)
      : exactSample(event.maxFrontierSize),
    retainedHandlesPeak: 0,
  });
}

function deltaLifetimeDelta(event: DeltaBlastRadiusTapEvent): DurableLifetimeRepository {
  const perChanged = safeTotal(event.dbRoundTrips) / Math.max(1, safeCounter(event.changedSymbolCount));
  return sectionDelta("delta", {
    computations: 1, blastRadiusMs: exactSample(event.durationMs),
    dbRoundTrips: exactSample(perChanged),
    pathExplanationMs: event.pathExplanationLatencyMs > 0
      ? exactSample(event.pathExplanationLatencyMs)
      : exactSample(0, 0),
    fallbackPathQueries: safeCounter(event.fallbackPathQueryCount),
  });
}

function indexEventLifetimeDelta(event: IndexEvent): DurableLifetimeRepository {
  const section = emptyIndexingSection();
  section.events = 1;
  section.failures = safeCounter(event.stats.errors);
  const engine = event.stats.pass1Engine;
  if (engine !== undefined) {
    section.engineDispatch = dynamicEntry("rust", safeCounter(engine.rustFiles));
    const ts = sectionDelta("indexing", {
      ...emptyIndexingSection(), engineDispatch: dynamicEntry("ts", safeCounter(engine.tsFiles)),
    });
    return combineLifetimeDeltas([sectionDelta("indexing", section), ts]);
  }
  return sectionDelta("indexing", section);
}

function indexPhaseLifetimeDelta(event: IndexPhaseTapEvent): DurableLifetimeRepository {
  const deltas: DurableLifetimeRepository[] = [];
  const section = emptyIndexingSection();
  if (!event.phase.startsWith("_meta.")) section.phaseCounts = dynamicEntry(event.phase, 1);
  if (event.phase === "pass1") section.pass1Ms = exactSample(event.durationMs);
  if (event.phase === "pass2") section.pass2Ms = exactSample(event.durationMs);
  deltas.push(sectionDelta("indexing", section));
  if (event.language !== undefined) {
    deltas.push(sectionDelta("indexing", {
      ...emptyIndexingSection(), languageMs: dynamicEntry(event.language, exactSample(event.durationMs)),
    }));
  }
  return combineLifetimeDeltas(deltas);
}

function tokenSavingsLifetimeDelta(event: TokenSavingsTapEvent): DurableLifetimeRepository {
  const realized = event.realized !== false;
  return sectionDelta("tokenEfficiency", {
    ...emptyTokenSection(),
    compressionBySource: dynamicEntry(event.source, {
      events: 1,
      realizedEvents: realized ? 1 : 0,
      estimatedTokensAvoided: realized ? safeCounter(event.estimatedTokensAvoided) : 0,
      originalTokens: realized ? safeCounter(event.originalTokens) : 0,
      returnedTokens: realized ? safeCounter(event.returnedTokens) : 0,
      savedTokens: realized ? safeCounter(event.savedTokens) : 0,
      opportunities: event.opportunity === true ? 1 : 0,
      hits: event.opportunity === true && event.hit === true ? 1 : 0,
      storedBytes: realized ? safeCounter(event.storedBytes) : 0,
    }),
  });
}

function prefetchCumulativeSnapshot(event: PrefetchTelemetryEvent): DurableLifetimeRepository {
  const samples = safeCounter(event.outcomeSamples);
  const base = sectionDelta("predictiveContext", {
    outcomeSamples: samples,
    hitOutcomes: safeCounter(samples * event.hitRate),
    wasteOutcomes: safeCounter(samples * event.wasteRate),
    accepted: safeCounter(event.acceptedPrefetch),
    suppressed: safeCounter(event.suppressedPrefetch),
    latencyReductionMs: aggregateSample(samples, event.avgLatencyReductionMs),
    byStrategy: {},
  });
  const deltas = [base];
  for (const strategy of event.topStrategies ?? []) {
    const strategySamples = safeCounter(strategy.samples);
    deltas.push(sectionDelta("predictiveContext", {
      outcomeSamples: 0, hitOutcomes: 0, wasteOutcomes: 0, accepted: 0, suppressed: 0,
      latencyReductionMs: exactSample(0, 0),
      byStrategy: dynamicEntry(strategy.strategy, {
        samples: strategySamples,
        hits: safeCounter(strategySamples * strategy.hitRate),
        wasted: safeCounter(strategySamples * strategy.wasteRate),
        accepted: safeCounter(strategySamples * strategy.acceptedRate),
        suppressed: safeCounter(strategy.suppressed),
        latencyReductionMs: aggregateSample(strategySamples, event.avgLatencyReductionMs),
      }),
    }));
  }
  return combineLifetimeDeltas(deltas);
}

function watcherHealthCumulativeSnapshot(
  event: WatcherHealthTelemetryEvent,
): NonNullable<DurableLifetimeSections["health"]> {
  return {
    watcherErrors: safeCounter(event.errors),
    watcherRestarts: safeCounter(event.restartCount),
    watchmanWarnings: safeCounter(event.watchmanWarningCount),
    watchmanRecrawls: safeCounter(event.watchmanRecrawlCount),
    watchmanFreshInstances: safeCounter(event.watchmanFreshInstanceCount),
  };
}

function forwardDelta(current: number, previous: number, restarted: boolean): number {
  return restarted ? current : Math.max(0, current - previous);
}

function cumulativeHealthDelta(
  current: NonNullable<DurableLifetimeSections["health"]>,
  previous: NonNullable<DurableLifetimeSections["health"]> | undefined,
): NonNullable<DurableLifetimeSections["health"]> {
  if (previous === undefined) return structuredClone(current);
  const restarted = current.watcherErrors < previous.watcherErrors
    || current.watcherRestarts < previous.watcherRestarts
    || current.watchmanWarnings < previous.watchmanWarnings
    || current.watchmanRecrawls < previous.watchmanRecrawls
    || current.watchmanFreshInstances < previous.watchmanFreshInstances;
  return {
    watcherErrors: forwardDelta(current.watcherErrors, previous.watcherErrors, restarted),
    watcherRestarts: forwardDelta(current.watcherRestarts, previous.watcherRestarts, restarted),
    watchmanWarnings: forwardDelta(current.watchmanWarnings, previous.watchmanWarnings, restarted),
    watchmanRecrawls: forwardDelta(current.watchmanRecrawls, previous.watchmanRecrawls, restarted),
    watchmanFreshInstances: forwardDelta(
      current.watchmanFreshInstances,
      previous.watchmanFreshInstances,
      restarted,
    ),
  };
}

function cumulativeSampleDelta(
  current: SampleTotal,
  previous: SampleTotal,
  restarted: boolean,
): SampleTotal {
  return {
    count: forwardDelta(current.count, previous.count, restarted),
    sum: forwardDelta(current.sum, previous.sum, restarted),
    max: 0,
  };
}

function cumulativePrefetchDelta(
  current: NonNullable<DurableLifetimeSections["predictiveContext"]>,
  previous: NonNullable<DurableLifetimeSections["predictiveContext"]> | undefined,
): NonNullable<DurableLifetimeSections["predictiveContext"]> {
  const restarted = previous !== undefined && current.outcomeSamples < previous.outcomeSamples;
  const totals = {
    outcomeSamples: forwardDelta(current.outcomeSamples, previous?.outcomeSamples ?? 0, restarted),
    hitOutcomes: forwardDelta(current.hitOutcomes, previous?.hitOutcomes ?? 0, restarted),
    wasteOutcomes: forwardDelta(current.wasteOutcomes, previous?.wasteOutcomes ?? 0, restarted),
    accepted: forwardDelta(current.accepted, previous?.accepted ?? 0, restarted),
    suppressed: forwardDelta(current.suppressed, previous?.suppressed ?? 0, restarted),
    latencyReductionMs: cumulativeSampleDelta(
      current.latencyReductionMs,
      previous?.latencyReductionMs ?? exactSample(0, 0),
      restarted,
    ),
  };
  const byStrategy: typeof current.byStrategy = {};
  let covered: PredictiveStrategy | undefined;
  for (const [key, value] of Object.entries(current.byStrategy)) {
    if (key === OVERFLOW_KEY) continue;
    const old = previous?.byStrategy[key];
    if (old === undefined) {
      byStrategy[key] = structuredClone(value);
    } else {
      const strategyRestarted = value.samples < old.samples;
      byStrategy[key] = {
        samples: forwardDelta(value.samples, old.samples, strategyRestarted),
        hits: forwardDelta(value.hits, old.hits, strategyRestarted),
        wasted: forwardDelta(value.wasted, old.wasted, strategyRestarted),
        accepted: forwardDelta(value.accepted, old.accepted, strategyRestarted),
        suppressed: forwardDelta(value.suppressed, old.suppressed, strategyRestarted),
        latencyReductionMs: cumulativeSampleDelta(
          value.latencyReductionMs,
          old.latencyReductionMs,
          strategyRestarted,
        ),
      };
    }
    covered = covered === undefined
      ? structuredClone(byStrategy[key])
      : mergePrefetchStrategySnapshots(covered, byStrategy[key]);
  }
  const residual: PredictiveStrategy = {
    samples: Math.max(0, totals.outcomeSamples - (covered?.samples ?? 0)),
    hits: Math.max(0, totals.hitOutcomes - (covered?.hits ?? 0)),
    wasted: Math.max(0, totals.wasteOutcomes - (covered?.wasted ?? 0)),
    accepted: Math.max(0, totals.accepted - (covered?.accepted ?? 0)),
    suppressed: Math.max(0, totals.suppressed - (covered?.suppressed ?? 0)),
    latencyReductionMs: {
      count: Math.max(0, totals.latencyReductionMs.count
        - (covered?.latencyReductionMs.count ?? 0)),
      sum: Math.max(0, totals.latencyReductionMs.sum
        - (covered?.latencyReductionMs.sum ?? 0)),
      max: 0,
    },
  };
  if (previous?.byStrategy[OVERFLOW_KEY] !== undefined || hasPrefetchStrategyTotals(residual)) {
    byStrategy[OVERFLOW_KEY] = residual;
  }
  return {
    ...totals,
    byStrategy: orderedRecord(byStrategy),
  };
}

type PredictiveContextSection = NonNullable<DurableLifetimeSections["predictiveContext"]>;
type PredictiveStrategy = PredictiveContextSection["byStrategy"][string];

function mergePrefetchStrategySnapshots(
  left: PredictiveStrategy,
  right: PredictiveStrategy,
): PredictiveStrategy {
  return {
    samples: saturatingAdd(left.samples, right.samples),
    hits: saturatingAdd(left.hits, right.hits),
    wasted: saturatingAdd(left.wasted, right.wasted),
    accepted: saturatingAdd(left.accepted, right.accepted),
    suppressed: saturatingAdd(left.suppressed, right.suppressed),
    latencyReductionMs: mergeSample(left.latencyReductionMs, right.latencyReductionMs),
  };
}

function hasPrefetchStrategyTotals(value: PredictiveStrategy): boolean {
  return value.samples > 0 || value.hits > 0 || value.wasted > 0
    || value.accepted > 0 || value.suppressed > 0
    || value.latencyReductionMs.count > 0 || value.latencyReductionMs.sum > 0;
}

function retainPrefetchCumulativeShadow(
  current: PredictiveContextSection,
  previous: PredictiveContextSection | undefined,
): { current: PredictiveContextSection; next: PredictiveContextSection } {
  const currentByStrategy: PredictiveContextSection["byStrategy"] = {};
  const nextByStrategy = structuredClone(previous?.byStrategy ?? {});
  let realKeys = Object.keys(nextByStrategy).filter((key) => key !== OVERFLOW_KEY).length;
  const limit = dynamicMapLimit("predictiveContext.byStrategy");
  for (const [key, value] of Object.entries(current.byStrategy)) {
    if (key === OVERFLOW_KEY) continue;
    const isNewRealKey = key !== OVERFLOW_KEY && !Object.hasOwn(nextByStrategy, key);
    if (isNewRealKey && realKeys >= limit) continue;
    if (isNewRealKey) realKeys += 1;
    currentByStrategy[key] = structuredClone(value);
    nextByStrategy[key] = structuredClone(value);
  }
  return {
    current: { ...current, byStrategy: orderedRecord(currentByStrategy) },
    next: { ...current, byStrategy: orderedRecord(nextByStrategy) },
  };
}

function latencyLifetimeDelta(
  tool: string,
  durationMs: number,
  errored: boolean,
): DurableLifetimeRepository {
  const counters = { calls: 1, errors: errored ? 1 : 0, durationMs: exactSample(durationMs) };
  return sectionDelta("latency", { ...counters, perTool: dynamicEntry(tool, counters) });
}

function toolCallLifetimeDelta(event: ToolCallEvent): DurableLifetimeRepository {
  const deltas = [latencyLifetimeDelta(event.tool, event.durationMs, event.response.error !== undefined)];
  if (event.tokensUsed !== undefined || event.tokensSaved !== undefined) {
    deltas.push(sectionDelta("tokenEfficiency", {
      ...emptyTokenSection(), calls: 1,
      usedTokens: safeCounter(event.tokensUsed), savedTokens: safeCounter(event.tokensSaved),
    }));
  }
  if (event.projection !== undefined) deltas.push(toolOutputLifetimeDelta(event));
  return combineLifetimeDeltas(deltas);
}

function runtimeLifetimeDelta(event: RuntimeExecutionEvent): DurableLifetimeRepository {
  return latencyLifetimeDelta(
    "sdl.runtime.execute",
    event.durationMs,
    event.exitCode !== 0 || event.timedOut,
  );
}

function pprLifetimeDelta(event: PprTapEvent): DurableLifetimeRepository {
  return sectionDelta("ppr", {
    runs: 1, native: event.backend === "native" ? 1 : 0,
    javascript: event.backend === "js" ? 1 : 0,
    fallback: event.backend === "fallback-bfs" ? 1 : 0,
    computeMs: exactSample(event.computeMs), touched: exactSample(event.touched),
    seeds: exactSample(event.seedCount),
  });
}

function scipLifetimeDelta(event: ScipIngestTapEvent): DurableLifetimeRepository {
  return sectionDelta("scip", {
    ingests: 1, successes: event.failed ? 0 : 1, failures: event.failed ? 1 : 0,
    edgesCreated: safeCounter(event.edgesCreated), edgesUpgraded: safeCounter(event.edgesUpgraded),
    ingestMs: exactSample(event.durationMs),
  });
}

function packedLifetimeDelta(event: PackedWireTapEvent): DurableLifetimeRepository {
  const packed = event.decision === "packed";
  const stats = {
    decisions: 1, packed: packed ? 1 : 0, fallback: packed ? 0 : 1,
    packedBytes: packed ? safeCounter(event.packedBytes) : 0,
    baselineBytes: packed ? safeCounter(event.jsonBytes) : 0,
    packedTokens: packed ? safeCounter(event.packedTokens) : 0,
    baselineTokens: packed ? safeCounter(event.jsonTokens) : 0,
  };
  const packedDelta = sectionDelta("packed", {
    ...stats,
    axisHits: dynamicEntry(event.axisHit ?? "none", 1),
    byEncoder: dynamicEntry(event.encoderId, stats),
  });
  const tokenDelta = tokenSavingsLifetimeDelta({
    source: "packedWire", opportunity: true, hit: packed, realized: packed,
    estimatedTokensAvoided: packed
      ? Math.max(0, safeCounter(event.jsonTokens) - safeCounter(event.packedTokens))
      : 0,
    storedBytes: packed
      ? Math.max(0, safeCounter(event.jsonBytes) - safeCounter(event.packedBytes))
      : 0,
  });
  return combineLifetimeDeltas([packedDelta, tokenDelta]);
}

function postIndexLifetimeDelta(event: PostIndexSessionTapEvent): DurableLifetimeRepository {
  return sectionDelta("postIndex", {
    sessions: 1, durationMs: exactSample(event.durationMs), timeouts: event.timedOut ? 1 : 0,
  });
}

function toolOutputLifetimeDelta(event: ToolCallEvent): DurableLifetimeRepository {
  const projection = event.projection;
  if (projection === undefined) return emptyRepositoryLifetime();
  const counters: ToolOutputLifetimeCounters = {
    ...emptyToolOutputCounters(),
    calls: 1,
    errors: event.response.error === undefined ? 0 : 1,
    rawBytes: safeCounter(projection.rawBytes),
    projectedBytes: safeCounter(projection.projectedBytes),
    rawTokens: safeCounter(projection.rawTokens),
    projectedTokens: safeCounter(projection.projectedTokens),
    removedFields: safeCounter(projection.removedFieldCount),
    handled: projection.responseHandled ? 1 : 0,
    truncated: projection.truncated ? 1 : 0,
    recoveryEmitted: projection.recoveryEmitted ? 1 : 0,
    invalidRecovery: safeCounter(projection.invalidRecoveryCount),
    projectedBytesMax: safeCounter(projection.projectedBytes),
    projectedTokensMax: safeCounter(projection.projectedTokens),
    detailCounts: dynamicEntry(projection.effectiveDetail, 1),
    profileCounts: dynamicEntry(projection.profile.observabilityProfile, 1),
  };
  return sectionDelta("toolOutput", {
    ...counters,
    perTool: dynamicEntry(event.tool, counters),
  });
}

function orderedRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
}

export function createObservabilityService(
  config: ObservabilityConfig,
  options?: ObservabilityServiceOptions,
): ObservabilityService {
  return new ObservabilityService(config, options);
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
