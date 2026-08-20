import { cpus } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  emptyLifetimeSections,
  emptyRepositoryLifetime,
  incrementSessionCount,
  lifetimeView,
  mergeProcessPeaks,
  mergeRepositoryLifetime,
  resetRepositoryLifetime,
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
  getObservabilityTap,
  installObservabilityTap,
  resetObservabilityTap,
} from "./event-tap.js";
import {
  openLifetimeStore,
  type LifetimeStore,
  type PublishOutcome,
} from "./lifetime-store.js";
import {
  LIFETIME_SCHEMA_VERSION,
  SECTION_IDS,
  repositoryStorageKey,
  type DurableLifetimeRepository,
  type DurableLifetimeRoot,
  type LifetimeEnvelopeV1,
  type LifetimeFreshness,
  type LifetimeReadyV1,
  type ProcessPeaks,
  type SectionId,
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
  activeCarry: DurableLifetimeRepository;
  active: Aggregator;
  seen: Set<SectionId>;
  eventProduced: boolean;
  sessionCounted: boolean;
}

interface PublicationBoundary {
  readonly actives: Map<string, DurableLifetimeRepository>;
  readonly eventProduced: Map<string, boolean>;
  readonly processPeaks: ProcessPeaks | null;
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
  private readonly aggregators = new Map<string, Aggregator>();
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
  private readonly lifetimeFreshness = new Map<string, LifetimeFreshness>();
  private readonly capacityExceeded = new Set<string>();
  private readonly processFreshness = emptyFreshness();
  private processPeakEpoch: ProcessPeaks | null = null;
  private lifetimeWriter = false;
  private lifetimeFrozen = false;
  private lifetimeOpenFailed = false;
  private startPromise: Promise<void> | null = null;
  private lifetimeTail: Promise<void> = Promise.resolve();

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
  async start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const directory = this.options.lifetimeDirectory ?? join(homedir(), ".sdl-mcp");
    this.lifetimeOpenFailed = false;
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
    const checkpointTimer = this.options.scheduleInterval(() => {
      void this.queueLifetimeOperation(() => this.checkpointLifetime()).catch((err) => {
        this.logWarn("lifetime checkpoint failed", err);
      });
    }, CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
    this.checkpointTimer = checkpointTimer;
    installObservabilityTap(this);
  }

  /**
   * Stop sampling. Releases the interval timer and disables the
   * event-loop histogram. Safe to call when not started.
   */
  async stop(): Promise<void> {
    if (this.startPromise !== null) await this.startPromise;
    if (this.sampleTimer !== null) {
      this.options.clearScheduledInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.checkpointTimer !== null) {
      this.options.clearScheduledInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    if (getObservabilityTap() === this) resetObservabilityTap();
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
    if (store !== null) {
      let snapshot: DurableLifetimeRoot | undefined;
      try {
        snapshot = this.lifetimeWriter && !this.lifetimeFrozen
          ? this.buildLifetimeCandidate(this.nowIso(), true)
          : undefined;
        await store.close(snapshot);
        if (snapshot !== undefined) {
          this.committedLifetime = snapshot;
          for (const [repoId, state] of this.lifetimeRepositories) {
            const stored = snapshot.repositories[repositoryStorageKey(repoId)];
            if (stored !== undefined) state.baseline = stored;
            if (state.eventProduced) state.sessionCounted = true;
            state.activeCarry = activeLifetimeMetadata(state.baseline);
            state.active = this.newAggregator();
            state.seen.clear();
            state.eventProduced = false;
          }
          this.processPeakEpoch = null;
        }
      } catch (err) {
        this.logWarn("lifetime final checkpoint failed", err);
      }
      this.lifetimeStore = null;
    }
    this.startPromise = null;
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
      for (const aggregator of this.aggregators.values()) {
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
          for (const aggregator of this.aggregators.values()) {
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
    let agg = this.aggregators.get(repoId);
    if (!agg) {
      agg = this.newAggregator();
      this.aggregators.set(repoId, agg);
    }
    return agg;
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
    if (store !== null && store.state().mode === "readOnly") {
      try {
        await store.refreshReadOnly();
        const refreshed = store.state();
        if (refreshed.root !== null) this.committedLifetime = refreshed.root;
      } catch (err) {
        this.logWarn("lifetime read-only refresh failed", err);
      }
    }

    const state = store?.state();
    const generatedAt = this.nowIso();
    if (this.lifetimeFrozen || state?.mode === "recoveryRequired") {
      return {
        schemaVersion: LIFETIME_SCHEMA_VERSION,
        sampleIntervalMs: clampInterval(this.config.sampleIntervalMs),
        generatedAt,
        repoId,
        persistenceState: "recoveryRequired",
        recoveryReason: state?.mode === "recoveryRequired"
          ? state.reason
          : "indeterminatePublication",
      };
    }

    const readOnly = state?.mode === "readOnly";
    const capacityExceeded = !readOnly && this.capacityExceeded.has(repoId);
    const stored = this.committedLifetime?.repositories[repositoryStorageKey(repoId)];
    const live = this.lifetimeRepositories.get(repoId);
    const value = capacityExceeded
      ? emptyRepositoryLifetime()
      : readOnly
        ? stored ?? emptyRepositoryLifetime()
        : live === undefined
          ? stored ?? emptyRepositoryLifetime()
          : lifetimeView(live.baseline, this.activeLifetime(repoId, live));
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
      processPeaks: mergeProcessPeaks(
        this.committedLifetime?.processPeaks ?? null,
        this.lifetimeWriter && !this.lifetimeFrozen ? this.processPeakEpoch : null,
      ),
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
      const boundary = this.capturePublicationBoundary();
      const oldTargetBaseline = target.baseline;
      const candidate = this.buildLifetimeCandidate(resetAt, false, boundary, repoId);
      const resetValue = candidate.repositories[repositoryStorageKey(repoId)];
      if (resetValue === undefined) throw new Error("Reset repository is unavailable");

      // Swap before awaiting publication so concurrent events land in the new epoch.
      target.baseline = resetValue;
      target.activeCarry = activeLifetimeMetadata(resetValue);
      target.active = this.newAggregator();
      target.seen.clear();
      target.eventProduced = false;
      let outcome: PublishOutcome;
      try {
        outcome = await store.reset(candidate);
      } catch (err) {
        target.baseline = oldTargetBaseline;
        target.activeCarry = activeLifetimeMetadata(oldTargetBaseline);
        this.restorePublicationBoundary(boundary);
        throw err;
      }
      if (outcome.status === "committed") {
        this.acceptCommittedLifetime(outcome.root, boundary, false);
        return this.readyLifetime(repoId, "ready");
      }
      if (outcome.status === "notPublished") {
        target.baseline = oldTargetBaseline;
        target.activeCarry = activeLifetimeMetadata(oldTargetBaseline);
        this.restorePublicationBoundary(boundary);
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
      : lifetimeView(state.baseline, this.activeLifetime(repoId, state));
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
      processPeaks: mergeProcessPeaks(
        this.committedLifetime?.processPeaks ?? null,
        this.processPeakEpoch,
      ),
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
    const candidate = this.buildLifetimeCandidate(checkpointAt, true, boundary);
    let outcome: PublishOutcome;
    try {
      outcome = await store.checkpoint(candidate);
    } catch (err) {
      this.restorePublicationBoundary(boundary);
      throw err;
    }
    if (outcome.status === "committed") {
      this.acceptCommittedLifetime(outcome.root, boundary, true);
    } else if (outcome.status === "notPublished") {
      this.restorePublicationBoundary(boundary);
    } else {
      this.lifetimeFrozen = true;
    }
  }

  private capturePublicationBoundary(): PublicationBoundary {
    const actives = new Map<string, DurableLifetimeRepository>();
    const eventProduced = new Map<string, boolean>();
    for (const [repoId, state] of this.lifetimeRepositories) {
      actives.set(repoId, this.activeLifetime(repoId, state));
      eventProduced.set(repoId, state.eventProduced);
      state.activeCarry = activeLifetimeMetadata(state.baseline);
      state.active = this.newAggregator();
      state.seen.clear();
      state.eventProduced = false;
    }
    const processPeaks = this.processPeakEpoch;
    this.processPeakEpoch = null;
    return { actives, eventProduced, processPeaks };
  }

  private restorePublicationBoundary(boundary: PublicationBoundary): void {
    for (const [repoId, active] of boundary.actives) {
      const state = this.lifetimeRepositories.get(repoId);
      if (state === undefined) continue;
      state.activeCarry = mergeRepositoryLifetime(active, state.activeCarry);
      state.eventProduced = (boundary.eventProduced.get(repoId) ?? false)
        || state.eventProduced;
    }
    this.processPeakEpoch = mergeProcessPeaks(boundary.processPeaks, this.processPeakEpoch);
  }

  private buildLifetimeCandidate(
    timestamp: string,
    countSessions: boolean,
    boundary?: PublicationBoundary,
    resetRepoId?: string,
  ): DurableLifetimeRoot {
    const base = structuredClone(this.committedLifetime ?? emptyLifetimeRoot(timestamp));
    for (const [repoId, state] of this.lifetimeRepositories) {
      const active = boundary?.actives.get(repoId) ?? this.activeLifetime(repoId, state);
      let repository = lifetimeView(state.baseline, active);
      if (repoId === resetRepoId) {
        repository = resetRepositoryLifetime(repository, timestamp);
      } else {
        const produced = boundary?.eventProduced.get(repoId) ?? state.eventProduced;
        if (countSessions && produced && !state.sessionCounted) {
          repository = incrementSessionCount(repository).value;
        }
        repository = { ...repository, lastCheckpointAt: timestamp };
      }
      base.repositories[repositoryStorageKey(repoId)] = repository;
    }
    return {
      ...base,
      generation: Math.min(Number.MAX_SAFE_INTEGER, base.generation + 1),
      updatedAt: timestamp,
      processPeaks: mergeProcessPeaks(
        base.processPeaks,
        boundary?.processPeaks ?? this.processPeakEpoch,
      ),
      repositories: Object.fromEntries(
        Object.entries(base.repositories).sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  private acceptCommittedLifetime(
    root: DurableLifetimeRoot,
    boundary: PublicationBoundary,
    countSessions: boolean,
  ): void {
    this.committedLifetime = structuredClone(root);
    for (const [repoId, state] of this.lifetimeRepositories) {
      const stored = root.repositories[repositoryStorageKey(repoId)];
      if (stored !== undefined) state.baseline = stored;
      if (countSessions && (boundary.eventProduced.get(repoId) ?? false)) {
        state.sessionCounted = true;
      }
      state.activeCarry = activeLifetimeMetadata(state.baseline, state.activeCarry);
    }
  }

  private buildCurrentLifetimeRoot(timestamp: string): DurableLifetimeRoot {
    const root = structuredClone(this.committedLifetime ?? emptyLifetimeRoot(timestamp));
    for (const [repoId, state] of this.lifetimeRepositories) {
      root.repositories[repositoryStorageKey(repoId)] = lifetimeView(
        state.baseline,
        this.activeLifetime(repoId, state),
      );
    }
    root.processPeaks = mergeProcessPeaks(root.processPeaks, this.processPeakEpoch);
    return root;
  }

  private ensureLifetimeRepository(repoId: string): LifetimeRepositoryState | null {
    const existing = this.lifetimeRepositories.get(repoId);
    if (existing !== undefined) return existing;
    if (this.capacityExceeded.has(repoId)) return null;
    const baseline = this.committedLifetime?.repositories[repositoryStorageKey(repoId)]
      ?? emptyRepositoryLifetime();
    const admission = admitRepository(
      this.buildCurrentLifetimeRoot(this.nowIso()),
      repoId,
      baseline,
    );
    if (!admission.admitted) {
      this.capacityExceeded.add(repoId);
      return null;
    }
    const created: LifetimeRepositoryState = {
      baseline,
      activeCarry: activeLifetimeMetadata(baseline),
      active: this.newAggregator(),
      seen: new Set(),
      eventProduced: false,
      sessionCounted: false,
    };
    this.lifetimeRepositories.set(repoId, created);
    return created;
  }

  private recordLifetimeEvent(
    repoId: string | undefined,
    sections: readonly SectionId[],
    update: (aggregator: Aggregator) => void,
  ): void {
    if (repoId === undefined || !this.isRegisteredRepoId(repoId)) return;
    const timestamp = this.nowIso();
    const freshness = this.lifetimeFreshness.get(repoId) ?? emptyFreshness();
    for (const section of sections) freshness[section] = timestamp;
    this.lifetimeFreshness.set(repoId, freshness);
    if (!this.lifetimeWriter || this.lifetimeFrozen) return;
    const state = this.ensureLifetimeRepository(repoId);
    if (state === null) return;
    update(state.active);
    for (const section of sections) state.seen.add(section);
    state.eventProduced = true;
  }

  private activeLifetime(
    repoId: string,
    state: LifetimeRepositoryState,
  ): DurableLifetimeRepository {
    return mergeRepositoryLifetime(
      state.activeCarry,
      projectLifetimeSnapshot(state.active.getSnapshot(repoId), state.seen, state.baseline),
    );
  }

  private recordProcessFreshness(section: "pool" | "auditBuffer" | "resources"): void {
    this.processFreshness[section] = this.nowIso();
  }

  private responseFreshness(repoId: string): LifetimeFreshness {
    const freshness = this.lifetimeFreshness.get(repoId) ?? emptyFreshness();
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
      this.recordLifetimeEvent(event.repoId, sections, (aggregator) => {
        aggregator.recordToolCall(event);
      });
    } catch (err) {
      this.logWarn("toolCall failed", err);
    }
  }

  indexEvent(event: IndexEvent): void {
    try {
      this.getAggregator(event.repoId).recordIndexEvent(event);
      this.recordLifetimeEvent(event.repoId, ["indexing"], (aggregator) => {
        aggregator.recordIndexEvent(event);
      });
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
      this.recordLifetimeEvent(event.repoId, ["retrieval"], (aggregator) => {
        aggregator.recordSemanticSearch(event);
      });
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
      this.recordLifetimeEvent(event.repoId, ["predictiveContext"], (aggregator) => {
        aggregator.recordPrefetch(event);
      });
    } catch (err) {
      this.logWarn("prefetch failed", err);
    }
  }

  watcherHealth(event: WatcherHealthTelemetryEvent): void {
    try {
      this.getAggregator(event.repoId).recordWatcherHealth(event);
      this.recordLifetimeEvent(event.repoId, ["health"], (aggregator) => {
        aggregator.recordWatcherHealth(event);
      });
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
      this.recordLifetimeEvent(event.repoId, ["latency"], (aggregator) => {
        aggregator.recordRuntimeExecution(event);
      });
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
      for (const aggregator of this.aggregators.values()) {
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
      this.recordLifetimeEvent(event.repoId, ["ppr"], (aggregator) => {
        aggregator.recordPprResult(event);
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
      this.recordLifetimeEvent(event.repoId, ["scip"], (aggregator) => {
        aggregator.recordScipIngest(event);
      });
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
      // packedWire is process-global (no repoId) â€” fan out to every aggregator.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordPackedWire(event);
      }
      this.recordLifetimeEvent(event.repoId, ["packed", "tokenEfficiency"], (aggregator) => {
        aggregator.recordPackedWire(event);
      });
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
      this.recordLifetimeEvent(event.repoId, ["tokenEfficiency"], (aggregator) => {
        aggregator.recordTokenSavingsEvent(event);
      });
    } catch (err) {
      this.logWarn("tokenSavings failed", err);
    }
  }

  poolSample(event: PoolSampleTapEvent): void {
    try {
      // Pool depths are process-global â€” fan out to every aggregator.
      for (const aggregator of this.aggregators.values()) {
        aggregator.recordPoolSample(event);
      }
      this.recordProcessFreshness("pool");
    } catch (err) {
      this.logWarn("poolSample failed", err);
    }
  }

  resourceSample(event: ResourceSampleTapEvent): void {
    try {
      for (const aggregator of this.aggregators.values()) {
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
        this.recordLifetimeEvent(targetRepoId, ["indexing"], (aggregator) => {
          aggregator.recordIndexPhase(event);
        });
        if (event.phase.toLowerCase().includes("start")) {
          this.recordGraphEvent({ type: "graph.index.started", repoId: targetRepoId, mode: event.phase });
        }
        return;
      }
      // Legacy unscoped event - fan out to every known aggregator.
      for (const aggregator of this.aggregators.values()) {
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
      this.recordLifetimeEvent(event.repoId, ["cache"], (aggregator) => {
        aggregator.recordCacheOutcome(event);
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
        maxFrontierSize: event.maxFrontierSize,
      });
      this.recordLifetimeEvent(event.repoId, ["beam"], (aggregator) => {
        aggregator.recordBeamBuild(event);
      });
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
      this.recordLifetimeEvent(event.repoId, ["delta"], (aggregator) => {
        aggregator.recordDeltaBlastRadius(event);
      });
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
      this.recordProcessFreshness("auditBuffer");
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
      this.recordLifetimeEvent(event.repoId, ["postIndex"], (aggregator) => {
        aggregator.recordPostIndexSession(event);
      });
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

function sample(count: unknown, average: unknown, maximum = average) {
  const safeCount = safeCounter(count);
  return {
    count: safeCount,
    sum: Math.min(Number.MAX_SAFE_INTEGER, safeCount * safeTotal(average)),
    max: safeTotal(maximum),
  };
}

function counterMap(value: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(value)
    .map(([key, count]) => [canonicalDynamicKey(key), safeCounter(count)])
    .sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function projectLifetimeSnapshot(
  snapshot: ObservabilitySnapshot,
  seen: ReadonlySet<SectionId>,
  baseline: DurableLifetimeRepository,
): DurableLifetimeRepository {
  const sections = emptyLifetimeSections();
  if (seen.has("cache")) {
    sections.cache = {
      hits: safeCounter(snapshot.cache.totalHits),
      misses: safeCounter(snapshot.cache.totalMisses),
      lookupMs: sample(
        snapshot.cache.totalHits + snapshot.cache.totalMisses,
        snapshot.cache.avgLookupLatencyMs,
      ),
      perSource: Object.fromEntries(Object.entries(snapshot.cache.perSource)
        .map(([key, value]) => [canonicalDynamicKey(key), {
          hits: safeCounter(value.hits),
          misses: safeCounter(value.misses),
          lookupMs: sample(value.hits + value.misses, value.avgLatencyMs),
        }]).sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  if (seen.has("retrieval")) {
    sections.retrieval = {
      calls: safeCounter(snapshot.retrieval.totalRetrievals),
      emptyResults: safeCounter(snapshot.retrieval.emptyResultCount),
      latencyMs: sample(
        snapshot.retrieval.totalRetrievals,
        snapshot.retrieval.avgLatencyMs,
        snapshot.retrieval.p95LatencyMs,
      ),
      byMode: counterMap(snapshot.retrieval.byMode),
      byType: counterMap(snapshot.retrieval.byRetrievalType),
      candidatesBySource: counterMap(snapshot.retrieval.candidateCountPerSource),
      phaseLatencyMs: Object.fromEntries(Object.entries(snapshot.retrieval.phaseLatencyMs)
        .map(([key, value]) => [canonicalDynamicKey(key), sample(value.count, value.avgMs, value.maxMs)])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  if (seen.has("beam")) {
    const value = snapshot.beam;
    sections.beam = {
      builds: safeCounter(value.totalSliceBuilds),
      buildMs: sample(value.totalSliceBuilds, value.avgBuildMs, value.p95BuildMs),
      accepted: safeCounter(value.avgAccepted * value.totalSliceBuilds),
      evicted: safeCounter(value.avgEvicted * value.totalSliceBuilds),
      rejected: safeCounter(value.avgRejected * value.totalSliceBuilds),
      frontierMax: sample(
        value.totalSliceBuilds,
        value.avgFrontierMaxSize,
        value.p95FrontierMaxSize,
      ),
      retainedHandlesPeak: safeCounter(value.retainedExplainHandles),
    };
  }
  if (seen.has("delta")) {
    const value = snapshot.delta;
    sections.delta = {
      computations: safeCounter(value.totalBlastRadiusComputations),
      blastRadiusMs: sample(
        value.totalBlastRadiusComputations,
        value.avgBlastRadiusLatencyMs,
        value.p95BlastRadiusLatencyMs,
      ),
      dbRoundTrips: sample(
        value.totalBlastRadiusComputations,
        value.avgDbRoundTripsPerChangedSymbol,
      ),
      pathExplanationMs: value.avgPathExplanationLatencyMs === 0
        ? sample(0, 0)
        : sample(
          value.totalBlastRadiusComputations,
          value.avgPathExplanationLatencyMs,
          value.p95PathExplanationLatencyMs,
        ),
      fallbackPathQueries: safeCounter(value.fallbackPathQueryCount),
    };
  }
  if (seen.has("indexing")) {
    const value = snapshot.indexing;
    sections.indexing = {
      events: safeCounter(value.totalEvents),
      pass1Ms: sample(value.phaseCounts.pass1 ?? 0, value.avgPass1Ms),
      pass2Ms: sample(value.phaseCounts.pass2 ?? 0, value.avgPass2Ms),
      failures: safeCounter(value.failures),
      phaseCounts: counterMap(value.phaseCounts),
      languageMs: Object.fromEntries(Object.entries(value.perLanguageAvgMs)
        .map(([key, average]) => [canonicalDynamicKey(key), sample(1, average)])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))),
      engineDispatch: counterMap(value.engineDispatch),
      derivedLagMs: value.derivedStateLagMs === null
        ? sample(0, 0)
        : sample(1, value.derivedStateLagMs),
    };
  }
  if (seen.has("tokenEfficiency")) {
    const value = snapshot.tokenEfficiency;
    sections.tokenEfficiency = {
      calls: safeCounter(snapshot.toolVolume.totalCalls),
      usedTokens: safeCounter(value.totalUsed),
      savedTokens: safeCounter(value.totalSaved),
      compressionBySource: Object.fromEntries(
        Object.entries(value.compressionLayers.bySource)
          .filter(([, layer]) => layer.events > 0)
          .map(([key, layer]) => [canonicalDynamicKey(key), {
            events: safeCounter(layer.events),
            realizedEvents: safeCounter(layer.realizedEvents),
            estimatedTokensAvoided: safeCounter(layer.estimatedTokensAvoided),
            originalTokens: safeCounter(layer.originalTokens),
            returnedTokens: safeCounter(layer.returnedTokens),
            savedTokens: safeCounter(layer.savedTokens),
            opportunities: safeCounter(layer.opportunities),
            hits: safeCounter(layer.hits),
            storedBytes: safeCounter(layer.storedBytes),
          }]).sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    };
  }
  if (seen.has("predictiveContext")) {
    const value = snapshot.predictiveContext;
    sections.predictiveContext = {
      outcomeSamples: safeCounter(value.outcomeSamples),
      hitOutcomes: safeCounter(value.outcomeSamples * value.hitRatePct / 100),
      wasteOutcomes: safeCounter(value.outcomeSamples * value.wasteRatePct / 100),
      accepted: safeCounter(value.acceptedPrefetch),
      suppressed: safeCounter(value.suppressedPrefetch),
      latencyReductionMs: sample(value.outcomeSamples, value.avgLatencyReductionMs),
      byStrategy: Object.fromEntries(value.topStrategies.map((strategy) => [
        canonicalDynamicKey(strategy.strategy),
        {
          samples: safeCounter(strategy.samples),
          hits: safeCounter(strategy.samples * strategy.hitRatePct / 100),
          wasted: safeCounter(strategy.samples * strategy.wasteRatePct / 100),
          accepted: safeCounter(strategy.samples * strategy.acceptedRatePct / 100),
          suppressed: safeCounter(strategy.suppressed),
          latencyReductionMs: sample(strategy.samples, value.avgLatencyReductionMs),
        },
      ]).sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  if (seen.has("health")) {
    const value = snapshot.health;
    sections.health = {
      watcherErrors: safeCounter(value.watcherErrors),
      watcherRestarts: safeCounter(value.watcherRestartCount),
      watchmanWarnings: safeCounter(value.watcherWatchmanWarningCount),
      watchmanRecrawls: safeCounter(value.watcherWatchmanRecrawlCount),
      watchmanFreshInstances: safeCounter(value.watcherWatchmanFreshInstanceCount),
    };
  }
  if (seen.has("latency")) {
    const value = snapshot.latency;
    sections.latency = {
      calls: safeCounter(snapshot.toolVolume.totalCalls),
      errors: safeCounter(Object.values(snapshot.toolVolume.perToolErrors)
        .reduce((total, count) => total + count, 0)),
      durationMs: sample(snapshot.toolVolume.totalCalls, value.avgMs, value.maxMs),
      perTool: Object.fromEntries(Object.entries(value.perTool).map(([key, tool]) => [
        canonicalDynamicKey(key),
        {
          calls: safeCounter(tool.count),
          errors: safeCounter(tool.errorCount),
          durationMs: sample(tool.count, tool.avgMs, tool.p95Ms),
        },
      ]).sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  if (seen.has("scip")) {
    const value = snapshot.scip;
    sections.scip = {
      ingests: safeCounter(value.totalIngests),
      successes: safeCounter(value.successCount),
      failures: safeCounter(value.failureCount),
      edgesCreated: safeCounter(value.totalEdgesCreated),
      edgesUpgraded: safeCounter(value.totalEdgesUpgraded),
      ingestMs: sample(value.totalIngests, value.avgIngestMs),
    };
  }
  if (seen.has("packed")) {
    const value = snapshot.packed;
    sections.packed = {
      decisions: safeCounter(value.totalDecisions),
      packed: safeCounter(value.packedCount),
      fallback: safeCounter(value.fallbackCount),
      packedBytes: safeCounter(value.packedBytesTotal),
      baselineBytes: safeCounter(value.jsonBaselineBytesTotal),
      packedTokens: safeCounter(value.packedTokensTotal),
      baselineTokens: safeCounter(value.jsonBaselineTokensTotal),
      axisHits: counterMap(value.axisHits),
      byEncoder: Object.fromEntries(Object.entries(value.byEncoder).map(([key, encoder]) => [
        canonicalDynamicKey(key),
        {
          decisions: safeCounter(encoder.totalDecisions),
          packed: safeCounter(encoder.packedCount),
          fallback: safeCounter(encoder.fallbackCount),
          packedBytes: safeCounter(encoder.packedBytesTotal),
          baselineBytes: safeCounter(encoder.jsonBaselineBytesTotal),
          packedTokens: safeCounter(encoder.packedTokensTotal),
          baselineTokens: safeCounter(encoder.jsonBaselineTokensTotal),
        },
      ]).sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  if (seen.has("ppr")) {
    const value = snapshot.ppr;
    sections.ppr = {
      runs: safeCounter(value.totalRuns),
      native: safeCounter(value.nativeCount),
      javascript: safeCounter(value.jsCount),
      fallback: safeCounter(value.fallbackCount),
      computeMs: sample(value.totalRuns, value.avgComputeMs, value.p95ComputeMs),
      touched: sample(value.totalRuns, value.avgTouched),
      seeds: sample(value.totalRuns, value.avgSeedCount),
    };
  }
  if (seen.has("postIndex")) {
    const value = snapshot.postIndexSession;
    sections.postIndex = {
      sessions: safeCounter(value.totalSessions),
      durationMs: sample(value.totalSessions, value.avgDurationMs, value.maxDurationMs),
      timeouts: safeCounter(value.timeoutCount),
    };
  }
  if (seen.has("toolOutput")) {
    const value = snapshot.toolOutput;
    const counters = (item: typeof value.overall) => ({
      calls: safeCounter(item.calls),
      errors: safeCounter(item.errors),
      rawBytes: safeCounter(item.rawBytesTotal),
      projectedBytes: safeCounter(item.projectedBytesTotal),
      rawTokens: safeCounter(item.rawTokensTotal),
      projectedTokens: safeCounter(item.projectedTokensTotal),
      removedFields: safeCounter(item.removedFieldTotal),
      handled: safeCounter(item.handledCount),
      truncated: safeCounter(item.truncatedCount),
      recoveryEmitted: safeCounter(item.recoveryEmittedCount),
      invalidRecovery: safeCounter(item.invalidRecoveryCount),
      projectedBytesMax: safeCounter(item.maxProjectedBytes),
      projectedTokensMax: safeCounter(item.maxProjectedTokens),
      detailCounts: counterMap(item.detailCounts),
      profileCounts: counterMap(item.profileCounts),
    });
    sections.toolOutput = {
      ...counters(value.overall),
      perTool: Object.fromEntries(value.perTool.map((tool) => [
        canonicalDynamicKey(tool.tool),
        counters(tool),
      ]).sort(([left], [right]) => String(left).localeCompare(String(right)))),
    };
  }
  return {
    epoch: baseline.epoch,
    resetAt: null,
    lastCheckpointAt: null,
    sessionCount: 0,
    saturated: false,
    sections,
  };
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
