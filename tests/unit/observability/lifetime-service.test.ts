import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ObservabilityConfigSchema } from "../../../dist/config/types.js";
import {
  emptyLifetimeSections,
  emptyRepositoryLifetime,
} from "../../../dist/observability/lifetime-accumulator.js";
import type {
  LifetimeStore,
  PublishOutcome,
  ReadOnlyRefreshOutcome,
  StoreState,
} from "../../../dist/observability/lifetime-store.js";
import {
  LIFETIME_SCHEMA_VERSION,
  MAX_REPOSITORIES,
  SECTION_IDS,
  repositoryStorageKey,
  type DurableLifetimeRepository,
  type DurableLifetimeRoot,
} from "../../../dist/observability/lifetime-types.js";
import {
  ObservabilityService,
  type ObservabilityServiceOptions,
} from "../../../dist/observability/service.js";
import {
  getObservabilityTap,
  resetObservabilityTap,
} from "../../../dist/observability/event-tap.js";
import { logger } from "../../../dist/util/logger.js";

const CONFIG = ObservabilityConfigSchema.parse({ sampleIntervalMs: 2_000 });

function repository(overrides: Partial<DurableLifetimeRepository> = {}): DurableLifetimeRepository {
  return { ...emptyRepositoryLifetime(), ...overrides };
}

function root(
  generation = 0,
  repositories: Record<string, DurableLifetimeRepository> = {},
): DurableLifetimeRoot {
  return {
    schemaVersion: LIFETIME_SCHEMA_VERSION,
    generation,
    updatedAt: "2026-08-20T12:00:00.000Z",
    processPeaks: null,
    repositories,
  };
}

class FakeStore implements LifetimeStore {
  current: StoreState;
  checkpoints: DurableLifetimeRoot[] = [];
  resets: DurableLifetimeRoot[] = [];
  refreshes = 0;
  closed = 0;
  checkpointOutcomes: PublishOutcome[] = [];
  refreshOutcomes: ReadOnlyRefreshOutcome[] = [];
  resetOutcome: PublishOutcome | null = null;
  onRefresh: (() => void) | null = null;
  onCheckpoint: ((snapshot: DurableLifetimeRoot) => Promise<PublishOutcome>) | null = null;
  onReset: ((snapshot: DurableLifetimeRoot) => Promise<PublishOutcome>) | null = null;
  onClose: ((snapshot?: DurableLifetimeRoot) => Promise<void>) | null = null;
  closeSnapshots: Array<DurableLifetimeRoot | undefined> = [];

  constructor(state: StoreState = { mode: "writer", root: null, generation: null }) {
    this.current = state;
  }

  state(): StoreState {
    return structuredClone(this.current);
  }

  async checkpoint(snapshot: DurableLifetimeRoot): Promise<PublishOutcome> {
    this.checkpoints.push(structuredClone(snapshot));
    if (this.onCheckpoint) {
      const outcome = await this.onCheckpoint(snapshot);
      this.apply(outcome);
      return outcome;
    }
    const queued = this.checkpointOutcomes.shift();
    const outcome: PublishOutcome = queued?.status === "committed" ? {
      status: "committed",
      root: structuredClone(snapshot),
      generation: snapshot.generation,
    } : queued ?? {
      status: "committed" as const,
      root: structuredClone(snapshot),
      generation: snapshot.generation,
    };
    this.apply(outcome);
    return outcome;
  }

  async reset(snapshot: DurableLifetimeRoot): Promise<PublishOutcome> {
    this.resets.push(structuredClone(snapshot));
    const outcome = this.onReset
      ? await this.onReset(snapshot)
      : this.resetOutcome ?? {
        status: "committed" as const,
        root: structuredClone(snapshot),
        generation: snapshot.generation,
      };
    this.apply(outcome);
    return outcome;
  }

  async refreshReadOnly(): Promise<ReadOnlyRefreshOutcome> {
    this.refreshes += 1;
    this.onRefresh?.();
    const outcome = this.refreshOutcomes.shift() ?? { status: "unchanged" };
    if (outcome.status === "refreshed") {
      this.current = {
        mode: "readOnly",
        root: structuredClone(outcome.root),
        generation: outcome.generation,
      };
    } else if (outcome.status === "recoveryRequired") {
      this.current = {
        mode: "recoveryRequired",
        root: this.current.root,
        generation: this.current.generation,
        reason: outcome.reason,
      };
    }
    return outcome;
  }

  async close(finalSnapshot?: DurableLifetimeRoot): Promise<void> {
    this.closed += 1;
    this.closeSnapshots.push(finalSnapshot === undefined ? undefined : structuredClone(finalSnapshot));
    if (this.onClose) return this.onClose(finalSnapshot);
    if (finalSnapshot) await this.checkpoint(finalSnapshot);
  }

  private apply(outcome: PublishOutcome): void {
    if (outcome.status === "committed") {
      this.current = {
        mode: this.current.mode === "readOnly" ? "readOnly" : "writer",
        root: structuredClone(outcome.root),
        generation: outcome.generation,
      };
    } else if (outcome.status === "notPublished") {
      this.current = { mode: "degraded", root: this.current.root, generation: this.current.generation };
    } else {
      this.current = {
        mode: "recoveryRequired",
        root: this.current.root,
        generation: this.current.generation,
        reason: "indeterminatePublication",
      };
    }
  }
}

interface FakeTimer {
  callback: () => void;
  delay: number;
  cleared: boolean;
  unref(): void;
}

function harness(
  store = new FakeStore(),
  registered = new Set(["repo-a", "repo-b"]),
) {
  let nowMs = Date.parse("2026-08-20T12:00:00.000Z");
  const timers: FakeTimer[] = [];
  const options: ObservabilityServiceOptions = {
    lifetimeDirectory: "ignored-by-fake",
    openLifetimeStore: async () => store,
    now: () => new Date(nowMs),
    isRegisteredRepoId: (repoId) => registered.has(repoId),
    scheduleInterval: (callback, delay) => {
      const timer: FakeTimer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearScheduledInterval: (timer) => {
      (timer as FakeTimer).cleared = true;
    },
  };
  const service = new ObservabilityService(CONFIG, options);
  return {
    service,
    store,
    timers,
    registered,
    options,
    setNow(iso: string) { nowMs = Date.parse(iso); },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function cache(service: ObservabilityService, repoId?: string, hit = true): void {
  service.cacheLookup({ repoId, source: "card", hit, latencyMs: 4 });
}

function resource(service: ObservabilityService, cpuPct: number): void {
  service.resourceSample({
    cpuPct,
    rssMb: cpuPct * 10,
    heapUsedMb: cpuPct * 4,
    heapTotalMb: cpuPct * 5,
    eventLoopLagMs: cpuPct / 10,
  });
}

describe("ObservabilityService lifetime integration", () => {
  it("attributes accepted repository events without leaking freshness across repositories", async () => {
    const h = harness();
    await h.service.start();

    h.setNow("2026-08-20T12:00:01.000Z");
    cache(h.service, "repo-a");
    cache(h.service);
    cache(h.service, "unregistered");
    cache(h.service, "_global");
    h.service.poolSample({ writeQueued: 1, writeActive: 0, drainQueueDepth: 2, drainFailures: 0 });

    const a = await h.service.getLifetime("repo-a");
    const b = await h.service.getLifetime("repo-b");
    assert.equal(a.persistenceState, "ready");
    assert.equal(b.persistenceState, "ready");
    if (a.persistenceState === "recoveryRequired" || b.persistenceState === "recoveryRequired") return;
    assert.equal(a.sections.cache?.hits, 1);
    assert.equal(b.sections.cache, null);
    assert.equal(a.freshness.cache, "2026-08-20T12:00:01.000Z");
    assert.equal(b.freshness.cache, null);
    assert.equal(a.freshness.pool, "2026-08-20T12:00:01.000Z");
    assert.equal(b.freshness.pool, "2026-08-20T12:00:01.000Z");
    assert.equal(a.sections.pool, null);
    assert.equal(h.service.getSnapshot("unregistered").cache.totalHits, 1);
  });

  it("updates the closed fixed-section freshness set only on accepted events", async () => {
    const h = harness();
    await h.service.start();
    const times = new Map<string, string>();
    let second = 1;
    const at = (section: string, call: () => void) => {
      const iso = `2026-08-20T12:00:${String(second++).padStart(2, "0")}.000Z`;
      h.setNow(iso);
      call();
      times.set(section, iso);
    };

    at("cache", () => cache(h.service, "repo-a"));
    at("retrieval", () => h.service.semanticSearch({ repoId: "repo-a", semanticEnabled: true, latencyMs: 3, candidateCount: 1, alpha: 0.5 }));
    at("beam", () => h.service.sliceBuild({ repoId: "repo-a", durationMs: 2, accepted: 1, evicted: 0, rejected: 0 }));
    at("delta", () => h.service.deltaBlastRadius({ repoId: "repo-a", changedSymbolCount: 1, blastRadiusCount: 1, durationMs: 2, dbRoundTrips: 1, fallbackPathQueryCount: 0, pathExplanationLatencyMs: 0 }));
    at("indexing", () => h.service.indexPhase({ repoId: "repo-a", phase: "pass1", durationMs: 2 }));
    at("tokenEfficiency", () => h.service.tokenSavings({ repoId: "repo-a", source: "etag", estimatedTokensAvoided: 2 }));
    at("predictiveContext", () => h.service.prefetch({ repoId: "repo-a", hitRate: 0.5, wasteRate: 0.1, avgLatencyReductionMs: 2, queueDepth: 0, policyMode: "safe", outcomeSamples: 2, suppressedPrefetch: 0, acceptedPrefetch: 1 }));
    at("health", () => h.service.watcherHealth({ repoId: "repo-a", errors: 1, restartCount: 0 }));
    at("latency", () => h.service.toolCall({ tool: "sdl.context", repoId: "repo-a", request: {}, response: {}, durationMs: 2 }));
    at("pool", () => h.service.poolSample({ writeQueued: 1, writeActive: 0, drainQueueDepth: 0, drainFailures: 0 }));
    at("scip", () => h.service.scipIngest({ repoId: "repo-a", edgesCreated: 1, edgesUpgraded: 0, durationMs: 2, failed: false }));
    at("packed", () => h.service.packedWire({ repoId: "repo-a", encoderId: "v1", jsonBytes: 10, packedBytes: 5, decision: "packed", axisHit: "bytes" }));
    times.set("tokenEfficiency", times.get("packed") as string);
    at("ppr", () => h.service.pprResult({ repoId: "repo-a", backend: "native", computeMs: 2, touched: 3, seedCount: 1 }));
    at("auditBuffer", () => h.service.auditBufferSample({ depth: 1, droppedTotal: 0, sessionActive: true }));
    at("postIndex", () => h.service.postIndexSession({ repoId: "repo-a", sessionId: "s", durationMs: 2, timedOut: false }));
    at("toolOutput", () => h.service.toolCall({
      tool: "sdl.context", repoId: "repo-a", request: {}, response: {}, durationMs: 2,
      projection: {
        profile: { projector: "test", observabilityProfile: "standard", defaultDetail: "compact", budgetClass: "small", largeResponseStrategy: "truncate", recoveryPolicy: "none" },
        effectiveDetail: "compact", diagnosticsIncluded: false, rawBytes: 10, rawTokens: 4,
        projectedBytes: 5, projectedTokens: 2, removedFieldCount: 1, truncated: false,
        responseHandled: false, recoveryEmitted: false, invalidRecoveryCount: 0,
      },
    }));
    times.set("latency", times.get("toolOutput") as string);
    at("resources", () => resource(h.service, 3));

    const value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") return;
    assert.deepEqual(Object.keys(value.freshness), SECTION_IDS);
    for (const section of SECTION_IDS) assert.equal(value.freshness[section], times.get(section));
  });

  it("combines a writer baseline with active events and refreshes read-only generations without promotion", async () => {
    const key = repositoryStorageKey("repo-a");
    const baselineSections = emptyLifetimeSections();
    baselineSections.cache = { hits: 5, misses: 0, lookupMs: { count: 5, sum: 20, max: 4 }, perSource: {} };
    const writerStore = new FakeStore({ mode: "writer", root: root(3, { [key]: repository({ sections: baselineSections, sessionCount: 2 }) }), generation: 3 });
    const writer = harness(writerStore);
    await writer.service.start();
    cache(writer.service, "repo-a");
    const writerValue = await writer.service.getLifetime("repo-a");
    assert.notEqual(writerValue.persistenceState, "recoveryRequired");
    if (writerValue.persistenceState !== "recoveryRequired") assert.equal(writerValue.sections.cache?.hits, 6);

    const readOnlyStore = new FakeStore({ mode: "readOnly", root: root(3, { [key]: repository({ sections: baselineSections, sessionCount: 2 }) }), generation: 3 });
    const secondary = harness(readOnlyStore);
    await secondary.service.start();
    cache(secondary.service, "repo-a");
    const higherSections = structuredClone(baselineSections);
    if (higherSections.cache) higherSections.cache.hits = 9;
    const higherRoot = root(4, {
      [key]: repository({ sections: higherSections, sessionCount: 3 }),
    });
    readOnlyStore.refreshOutcomes.push({
      status: "refreshed", root: higherRoot, generation: 4,
    });
    const readOnlyValue = await secondary.service.getLifetime("repo-a");
    assert.equal(readOnlyValue.persistenceState, "readOnly");
    if (readOnlyValue.persistenceState !== "recoveryRequired") {
      assert.equal(readOnlyValue.sections.cache?.hits, 9);
      assert.equal(readOnlyValue.sessionCount, 3);
      assert.notEqual(readOnlyValue.freshness.cache, null);
    }
    assert.equal(readOnlyStore.checkpoints.length, 0);

    readOnlyStore.onRefresh = () => { throw new Error("transient read failure"); };
    const retained = await secondary.service.getLifetime("repo-a");
    assert.equal(retained.persistenceState, "readOnly");
    if (retained.persistenceState !== "recoveryRequired") {
      assert.equal(retained.sections.cache?.hits, 9);
    }
    readOnlyStore.onRefresh = null;
    readOnlyStore.refreshOutcomes.push({
      status: "recoveryRequired", reason: "unknownSchema",
    });
    const recovery = await secondary.service.getLifetime("repo-a");
    assert.equal(recovery.persistenceState, "recoveryRequired");
    if (recovery.persistenceState === "recoveryRequired") {
      assert.equal(recovery.recoveryReason, "unknownSchema");
    }
  });

  it("checkpoints first at 30 seconds, retains failed epochs, counts a session once, and freezes on indeterminate", async () => {
    const h = harness();
    h.store.checkpointOutcomes.push(
      { status: "notPublished", reason: "ioFailure" },
      { status: "committed", generation: 1, root: root(1) },
      { status: "committed", generation: 2, root: root(2) },
      { status: "indeterminate", reason: "authorityUncertain", stage: "commit" },
    );
    await h.service.start();
    cache(h.service, "repo-a");
    resource(h.service, 10);
    const checkpointTimer = h.timers.find((timer) => timer.delay === 30_000);
    assert.ok(checkpointTimer);
    assert.equal(h.store.checkpoints.length, 0);

    checkpointTimer.callback();
    await settle();
    let value = await h.service.getLifetime("repo-a");
    assert.equal(value.persistenceState, "degraded");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.sections.cache?.hits, 1);
      assert.equal(value.sessionCount, 0);
    }

    checkpointTimer.callback();
    await settle();
    value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.sections.cache?.hits, 1);
      assert.equal(value.sessionCount, 1);
      assert.equal(value.processPeaks?.cpuPct, 10);
    }
    cache(h.service, "repo-a");
    checkpointTimer.callback();
    await settle();
    value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") assert.equal(value.sessionCount, 1);
    checkpointTimer.callback();
    await settle();
    cache(h.service, "repo-a");
    resource(h.service, 20);
    value = await h.service.getLifetime("repo-a");
    assert.equal(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") {
      assert.equal(value.recoveryReason, "indeterminatePublication");
    }
    assert.equal(h.service.getSnapshot("repo-a").cache.totalHits, 3);
  });

  it("resets one repository independently and rolls back not-published resets with interleaved events", async () => {
    const committed = harness();
    await committed.service.start();
    cache(committed.service, "repo-a");
    cache(committed.service, "repo-b");
    resource(committed.service, 12);
    const timer = committed.timers.find((entry) => entry.delay === 30_000);
    assert.ok(timer);
    timer.callback();
    await settle();
    committed.store.onReset = async (snapshot) => {
      cache(committed.service, "repo-a");
      cache(committed.service, "repo-b");
      return { status: "committed", root: structuredClone(snapshot), generation: snapshot.generation };
    };
    const reset = await committed.service.resetLifetime("repo-a");
    assert.equal(reset.epoch, 1);
    const a = await committed.service.getLifetime("repo-a");
    const b = await committed.service.getLifetime("repo-b");
    if (a.persistenceState !== "recoveryRequired" && b.persistenceState !== "recoveryRequired") {
      assert.equal(a.sections.cache?.hits, 1);
      assert.equal(b.sections.cache?.hits, 2);
      assert.equal(a.processPeaks?.cpuPct, 12);
      assert.equal(b.processPeaks?.cpuPct, 12);
    }

    const rolledBack = harness();
    await rolledBack.service.start();
    cache(rolledBack.service, "repo-a");
    rolledBack.store.onReset = async () => {
      cache(rolledBack.service, "repo-a");
      return { status: "notPublished", reason: "ioFailure" };
    };
    const result = await rolledBack.service.resetLifetime("repo-a");
    assert.equal(result.persistenceState, "degraded");
    const rolledBackValue = await rolledBack.service.getLifetime("repo-a");
    if (rolledBackValue.persistenceState !== "recoveryRequired") {
      assert.equal(rolledBackValue.epoch, 0);
      assert.equal(rolledBackValue.sections.cache?.hits, 2);
    }
  });

  it("re-arms the writer session count only after a committed reset", async () => {
    const h = harness();
    await h.service.start();
    const timer = h.timers.find((entry) => entry.delay === 30_000);
    assert.ok(timer);
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    timer.callback();
    await settle();
    assert.equal((await h.service.getLifetime("repo-a")).sessionCount, 1);

    const reset = await h.service.resetLifetime("repo-a");
    assert.equal(reset.sessionCount, 0);
    assert.equal((await h.service.getLifetime("repo-b")).sessionCount, 1);
    cache(h.service, "repo-a");
    timer.callback();
    await settle();
    assert.equal((await h.service.getLifetime("repo-a")).sessionCount, 1);
    cache(h.service, "repo-a");
    timer.callback();
    await settle();
    assert.equal((await h.service.getLifetime("repo-a")).sessionCount, 1);

    h.store.resetOutcome = { status: "notPublished", reason: "ioFailure" };
    await h.service.resetLifetime("repo-a");
    cache(h.service, "repo-a");
    timer.callback();
    await settle();
    assert.equal((await h.service.getLifetime("repo-a")).sessionCount, 1);
    assert.equal((await h.service.getLifetime("repo-b")).sessionCount, 1);
    await h.service.stop();
  });

  it("freezes all durable accumulation after an indeterminate reset while session metrics continue", async () => {
    const h = harness();
    await h.service.start();
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    h.store.onReset = async () => {
      cache(h.service, "repo-b");
      resource(h.service, 25);
      return { status: "indeterminate", reason: "publicationCommitUncertain", stage: "commit" };
    };
    await assert.rejects(h.service.resetLifetime("repo-a"), /indeterminate/);
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    resource(h.service, 50);
    assert.equal((await h.service.getLifetime("repo-b")).persistenceState, "recoveryRequired");
    assert.equal(h.service.getSnapshot("repo-b").cache.totalHits, 3);
  });

  it("returns the exact empty capacity envelope for the thirty-third event-producing repository", async () => {
    const registered = new Set(Array.from({ length: MAX_REPOSITORIES + 1 }, (_, index) => `repo-${index}`));
    const h = harness(new FakeStore(), registered);
    await h.service.start();
    for (const repoId of registered) cache(h.service, repoId);
    h.setNow("2026-08-20T12:05:00.000Z");
    const value = await h.service.getLifetime(`repo-${MAX_REPOSITORIES}`);
    assert.deepEqual(value, {
      schemaVersion: 1,
      sampleIntervalMs: 2_000,
      generatedAt: "2026-08-20T12:05:00.000Z",
      repoId: `repo-${MAX_REPOSITORIES}`,
      epoch: 0,
      resetAt: null,
      lastCheckpointAt: null,
      persistenceState: "capacityExceeded",
      sessionCount: 0,
      saturated: false,
      sections: emptyLifetimeSections(),
      freshness: Object.fromEntries(SECTION_IDS.map((section) => [section,
        section === "cache" ? "2026-08-20T12:00:00.000Z" : null])),
      processPeaks: null,
    });
    assert.equal(Object.hasOwn(h.service, "capacityExceeded"), false);
  });

  it("does not allocate durable state on GET and keeps eventless/read-only session counts at zero", async () => {
    const writer = harness();
    await writer.service.start();
    const value = await writer.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") assert.equal(value.sessionCount, 0);
    assert.equal(writer.store.checkpoints.length, 0);

    const secondary = harness(new FakeStore({ mode: "readOnly", root: root(), generation: 0 }));
    await secondary.service.start();
    cache(secondary.service, "repo-a");
    const readOnly = await secondary.service.getLifetime("repo-a");
    assert.equal(readOnly.persistenceState, "readOnly");
    if (readOnly.persistenceState !== "recoveryRequired") assert.equal(readOnly.sessionCount, 0);
  });

  it("awaits store classification before installing timers and releases it on stop", async () => {
    resetObservabilityTap();
    let resolveStore!: (store: LifetimeStore) => void;
    const deferred = new Promise<LifetimeStore>((resolve) => { resolveStore = resolve; });
    const base = harness();
    const service = new ObservabilityService(CONFIG, {
      ...base.options,
      openLifetimeStore: async () => deferred,
    });
    const starting = service.start();
    assert.equal(base.timers.length, 0);
    assert.equal(getObservabilityTap(), null);
    resolveStore(base.store);
    await starting;
    assert.equal(getObservabilityTap(), null);
    await service.stop();
    assert.equal(base.store.closed, 1);
    resetObservabilityTap();
  });

  it("keeps a pending checkpoint visible and restores or commits its boundary exactly once", async () => {
    for (const outcomeKind of ["notPublished", "committed"] as const) {
      const h = harness();
      let resolveCheckpoint!: (outcome: PublishOutcome) => void;
      h.store.onCheckpoint = async () => new Promise<PublishOutcome>((resolve) => {
        resolveCheckpoint = resolve;
      });
      await h.service.start();
      cache(h.service, "repo-a");
      const timer = h.timers.find((entry) => entry.delay === 30_000);
      assert.ok(timer);
      timer.callback();
      await settle();
      cache(h.service, "repo-a");
      const pending = await h.service.getLifetime("repo-a");
      assert.notEqual(pending.persistenceState, "recoveryRequired");
      if (pending.persistenceState !== "recoveryRequired") {
        assert.equal(pending.sections.cache?.hits, 2);
      }
      const candidate = h.store.checkpoints[0];
      assert.ok(candidate);
      resolveCheckpoint(outcomeKind === "committed"
        ? { status: "committed", root: candidate, generation: candidate.generation }
        : { status: "notPublished", reason: "ioFailure" });
      await settle();
      const settled = await h.service.getLifetime("repo-a");
      assert.notEqual(settled.persistenceState, "recoveryRequired");
      if (settled.persistenceState !== "recoveryRequired") {
        assert.equal(settled.sections.cache?.hits, 2);
      }
      h.store.onCheckpoint = null;
      await h.service.stop();
    }
  });

  it("serializes stop after a pending checkpoint and surfaces final-close failure", async () => {
    const h = harness();
    let resolveCheckpoint!: (outcome: PublishOutcome) => void;
    h.store.onCheckpoint = async () => new Promise<PublishOutcome>((resolve) => {
      resolveCheckpoint = resolve;
    });
    h.store.onClose = async () => { throw new Error("final checkpoint not committed"); };
    await h.service.start();
    cache(h.service, "repo-a");
    const timer = h.timers.find((entry) => entry.delay === 30_000);
    assert.ok(timer);
    timer.callback();
    await settle();
    cache(h.service, "repo-a");
    const stopping = h.service.stop();
    const sameStop = h.service.stop();
    assert.strictEqual(sameStop, stopping);
    await settle();
    assert.equal(h.store.closed, 0);
    const candidate = h.store.checkpoints[0];
    assert.ok(candidate);
    resolveCheckpoint({ status: "committed", root: candidate, generation: candidate.generation });
    const outcomes = await Promise.allSettled([stopping, sameStop]);
    assert.equal(outcomes[0]?.status, "rejected");
    assert.equal(outcomes[1]?.status, "rejected");
    if (outcomes[0]?.status === "rejected" && outcomes[1]?.status === "rejected") {
      assert.strictEqual(outcomes[0].reason, outcomes[1].reason);
      assert.match(String(outcomes[0].reason), /final checkpoint not committed/);
    }
    assert.equal(h.store.closed, 1);
    const finalSnapshot = h.store.closeSnapshots[0];
    assert.ok(finalSnapshot);
    assert.equal(finalSnapshot.generation, candidate.generation + 1);
    assert.equal(finalSnapshot.repositories[repositoryStorageKey("repo-a")]?.sections.cache?.hits, 2);
    assert.ok(h.timers.every((entry) => entry.cleared));
  });

  it("shares a successful concurrent stop and starts a fresh stop lifecycle after restart", async () => {
    const h = harness();
    let releaseClose!: () => void;
    h.store.onClose = async (snapshot) => new Promise<void>((resolve) => {
      releaseClose = () => {
        assert.ok(snapshot);
        h.store.current = {
          mode: "writer", root: structuredClone(snapshot), generation: snapshot.generation,
        };
        resolve();
      };
    });
    await h.service.start();
    cache(h.service, "repo-a");
    const first = h.service.stop();
    const concurrent = h.service.stop();
    assert.strictEqual(concurrent, first);
    await settle();
    assert.equal(h.store.closed, 1);
    assert.equal(h.store.closeSnapshots[0]?.generation, 1);
    assert.equal(
      h.store.closeSnapshots[0]?.repositories[repositoryStorageKey("repo-a")]?.sections.cache?.hits,
      1,
    );
    cache(h.service, "repo-a");
    releaseClose();
    await first;
    assert.equal(h.store.closed, 1);
    assert.equal((await h.service.getLifetime("repo-a")).sessionCount, 1);
    assert.equal((await h.service.getLifetime("repo-a")).sections.cache?.hits, 2);

    h.store.onClose = null;
    await h.service.start();
    const restarted = h.service.stop();
    assert.notStrictEqual(restarted, first);
    await restarted;
    assert.equal(h.store.closed, 2);
  });

  it("keeps non-target repository state live throughout a pending reset", async () => {
    const h = harness();
    let resolveReset!: (outcome: PublishOutcome) => void;
    h.store.onReset = async () => new Promise<PublishOutcome>((resolve) => {
      resolveReset = resolve;
    });
    await h.service.start();
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    const resetting = h.service.resetLifetime("repo-a");
    await settle();
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    const bPending = await h.service.getLifetime("repo-b");
    assert.notEqual(bPending.persistenceState, "recoveryRequired");
    if (bPending.persistenceState !== "recoveryRequired") {
      assert.equal(bPending.sections.cache?.hits, 2);
      assert.equal(bPending.epoch, 0);
    }
    resolveReset({ status: "notPublished", reason: "ioFailure" });
    const resetResult = await resetting;
    assert.equal(resetResult.persistenceState, "degraded");
    const a = await h.service.getLifetime("repo-a");
    const b = await h.service.getLifetime("repo-b");
    if (a.persistenceState !== "recoveryRequired" && b.persistenceState !== "recoveryRequired") {
      assert.equal(a.sections.cache?.hits, 2);
      assert.equal(b.sections.cache?.hits, 2);
    }
    await h.service.stop();
  });

  it("uses exact sample algebra and bounded canonical dynamic maps", async () => {
    const h = harness();
    await h.service.start();
    h.service.cacheLookup({ repoId: "repo-a", source: "card", hit: true, latencyMs: 1 });
    h.service.cacheLookup({ repoId: "repo-a", source: "card", hit: true, latencyMs: 9 });
    h.service.indexPhase({ repoId: "repo-a", phase: "pass1", language: "ts", durationMs: 2 });
    h.service.indexPhase({ repoId: "repo-a", phase: "pass1", language: "ts", durationMs: 7 });
    h.service.semanticSearch({
      repoId: "repo-a", semanticEnabled: true, latencyMs: 3, candidateCount: 1, alpha: 0.5,
      candidateCountPerSource: Object.fromEntries([
        ...Array.from({ length: 34 }, (_, index) => [`source-${String(index).padStart(2, "0")}`, 1]),
        ["bad key", 2], ["__other__", 3],
      ]),
    });
    for (let index = 0; index < 129; index += 1) {
      h.service.toolCall({
        tool: `tool-${String(index).padStart(3, "0")}`,
        repoId: "repo-a", request: {}, response: {}, durationMs: 1,
        projection: {
          profile: { projector: "test", observabilityProfile: "standard", defaultDetail: "compact", budgetClass: "small", largeResponseStrategy: "truncate", recoveryPolicy: "none" },
          effectiveDetail: "compact", diagnosticsIncluded: false, rawBytes: 2, rawTokens: 2,
          projectedBytes: 1, projectedTokens: 1, removedFieldCount: 0, truncated: false,
          responseHandled: true, recoveryEmitted: false, invalidRecoveryCount: 0,
        },
      });
    }
    for (let index = 0; index < 34; index += 1) {
      h.service.toolCall({
        tool: "nested-tool", repoId: "repo-a", request: {}, response: {}, durationMs: 1,
        projection: {
          profile: { projector: "test", observabilityProfile: "standard", defaultDetail: "compact", budgetClass: "small", largeResponseStrategy: "truncate", recoveryPolicy: "none" },
          effectiveDetail: `detail-${String(index).padStart(2, "0")}`,
          diagnosticsIncluded: false, rawBytes: 2, rawTokens: 2, projectedBytes: 1,
          projectedTokens: 1, removedFieldCount: 0, truncated: false,
          responseHandled: true, recoveryEmitted: false, invalidRecoveryCount: 0,
        },
      });
    }
    h.service.toolCall({ tool: "bad key", repoId: "repo-a", request: {}, response: {}, durationMs: 1 });
    h.service.toolCall({ tool: "__other__", repoId: "repo-a", request: {}, response: {}, durationMs: 1 });
    const value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") return;
    assert.deepEqual(value.sections.cache?.lookupMs, { count: 2, sum: 10, max: 9 });
    assert.deepEqual(value.sections.indexing?.languageMs["k:ts"], { count: 2, sum: 9, max: 7 });
    assert.equal(Object.keys(value.sections.retrieval?.candidatesBySource ?? {}).length, 33);
    assert.equal(Object.values(value.sections.retrieval?.candidatesBySource ?? {}).reduce((a, b) => a + b, 0), 39);
    assert.equal(Object.keys(value.sections.latency?.perTool ?? {}).length, 129);
    assert.equal(value.sections.latency?.perTool.__other__?.calls, 4);
    assert.equal(Object.keys(value.sections.toolOutput?.perTool ?? {}).length, 129);
    assert.equal(value.sections.toolOutput?.perTool["k:tool-000"]?.detailCounts["k:compact"], 1);
    const nestedDetails = value.sections.toolOutput?.perTool["k:nested-tool"]?.detailCounts ?? {};
    assert.equal(Object.keys(nestedDetails).length, 33);
    assert.equal(Object.values(nestedDetails).reduce((a, b) => a + b, 0), 34);
    await h.service.stop();
  });

  it("records every SampleTotal from exact event values without percentile-derived maxima", async () => {
    const h = harness();
    await h.service.start();
    h.service.semanticSearch({
      repoId: "repo-a", semanticEnabled: true, latencyMs: 3, candidateCount: 1, alpha: 0.5,
      phaseLatencyMs: { fusion: 4 }, finalResultCount: 1,
    });
    h.service.sliceBuild({
      repoId: "repo-a", durationMs: 5, accepted: 2, evicted: 1, rejected: 0,
      maxFrontierSize: 6,
    });
    h.service.deltaBlastRadius({
      repoId: "repo-a", changedSymbolCount: 2, blastRadiusCount: 3, durationMs: 7,
      dbRoundTrips: 8, fallbackPathQueryCount: 1, pathExplanationLatencyMs: 9,
    });
    h.service.prefetch({
      repoId: "repo-a", hitRate: 0.5, wasteRate: 0.25, avgLatencyReductionMs: 10,
      queueDepth: 0, outcomeSamples: 4,
    });
    h.service.scipIngest({
      repoId: "repo-a", edgesCreated: 1, edgesUpgraded: 2, durationMs: 11, failed: false,
    });
    h.service.pprResult({
      repoId: "repo-a", backend: "native", computeMs: 12, touched: 13, seedCount: 14,
    });
    h.service.postIndexSession({
      repoId: "repo-a", sessionId: "sample-audit", durationMs: 15, timedOut: false,
    });
    const value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") return;
    assert.deepEqual(value.sections.retrieval?.latencyMs, { count: 1, sum: 3, max: 3 });
    assert.deepEqual(value.sections.retrieval?.phaseLatencyMs["k:fusion"], { count: 1, sum: 4, max: 4 });
    assert.deepEqual(value.sections.beam?.buildMs, { count: 1, sum: 5, max: 5 });
    assert.deepEqual(value.sections.beam?.frontierMax, { count: 1, sum: 6, max: 6 });
    assert.deepEqual(value.sections.delta?.blastRadiusMs, { count: 1, sum: 7, max: 7 });
    assert.deepEqual(value.sections.delta?.dbRoundTrips, { count: 1, sum: 4, max: 4 });
    assert.deepEqual(value.sections.delta?.pathExplanationMs, { count: 1, sum: 9, max: 9 });
    assert.deepEqual(value.sections.predictiveContext?.latencyReductionMs, { count: 4, sum: 40, max: 0 });
    assert.deepEqual(value.sections.scip?.ingestMs, { count: 1, sum: 11, max: 11 });
    assert.deepEqual(value.sections.ppr?.computeMs, { count: 1, sum: 12, max: 12 });
    assert.deepEqual(value.sections.ppr?.touched, { count: 1, sum: 13, max: 13 });
    assert.deepEqual(value.sections.ppr?.seeds, { count: 1, sum: 14, max: 14 });
    assert.deepEqual(value.sections.postIndex?.durationMs, { count: 1, sum: 15, max: 15 });
    await h.service.stop();
  });

  it("keeps canonical session and lifetime empty and error totals aligned", async () => {
    const h = harness();
    await h.service.start();
    h.service.semanticSearch({
      repoId: "repo-a", semanticEnabled: true, latencyMs: 3, candidateCount: 1,
      alpha: 0.5, finalResultCount: 1,
    });
    h.service.toolCall({
      repoId: "repo-a", tool: "sdl.context", request: {}, durationMs: 2,
      response: { error: { message: "failed" } },
      projection: {
        profile: {
          projector: "test", observabilityProfile: "standard", defaultDetail: "compact",
          budgetClass: "small", largeResponseStrategy: "truncate", recoveryPolicy: "none",
        },
        effectiveDetail: "compact", diagnosticsIncluded: false,
        rawBytes: 2, rawTokens: 2, projectedBytes: 1, projectedTokens: 1,
        removedFieldCount: 0, truncated: false, responseHandled: false,
        recoveryEmitted: false, invalidRecoveryCount: 0,
      },
    });

    const session = h.service.getSnapshot("repo-a");
    const lifetime = await h.service.getLifetime("repo-a");
    assert.notEqual(lifetime.persistenceState, "recoveryRequired");
    if (lifetime.persistenceState !== "recoveryRequired") {
      assert.equal(session.retrieval.emptyResultCount, lifetime.sections.retrieval?.emptyResults);
      assert.equal(session.latency.perTool["sdl.context"]?.errorCount, 1);
      assert.equal(session.toolOutput.overall.errors, lifetime.sections.toolOutput?.errors);
      assert.equal(lifetime.sections.latency?.perTool["k:sdl.context"]?.errors, 1);
    }
    await h.service.stop();
  });

  it("clips direct and nested totals atomically and propagates saturation", async () => {
    const h = harness();
    await h.service.start();
    h.service.cacheLookup({
      repoId: "repo-a", source: "card", hit: true, latencyMs: Number.MAX_SAFE_INTEGER,
      count: Number.MAX_SAFE_INTEGER, hits: Number.MAX_SAFE_INTEGER,
    });
    h.service.cacheLookup({ repoId: "repo-a", source: "card", hit: true, latencyMs: 1 });
    const value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") return;
    assert.equal(value.saturated, true);
    assert.equal(value.sections.cache?.hits, Number.MAX_SAFE_INTEGER);
    assert.equal(value.sections.cache?.lookupMs.count, Number.MAX_SAFE_INTEGER);
    assert.equal(value.sections.cache?.lookupMs.sum, Number.MAX_SAFE_INTEGER);
    assert.equal(value.sections.cache?.perSource["k:card"]?.hits, Number.MAX_SAFE_INTEGER);
    await h.service.stop();
  });

  it("keeps pending process peaks visible without loss across checkpoint outcomes", async () => {
    for (const outcomeKind of ["committed", "notPublished", "indeterminate"] as const) {
      const h = harness();
      let resolveCheckpoint!: (outcome: PublishOutcome) => void;
      h.store.onCheckpoint = async () => new Promise<PublishOutcome>((resolve) => {
        resolveCheckpoint = resolve;
      });
      await h.service.start();
      resource(h.service, 20);
      const timer = h.timers.find((entry) => entry.delay === 30_000);
      assert.ok(timer);
      timer.callback();
      await settle();
      resource(h.service, 10);
      const pending = await h.service.getLifetime("repo-a");
      assert.notEqual(pending.persistenceState, "recoveryRequired");
      if (pending.persistenceState !== "recoveryRequired") {
        assert.equal(pending.processPeaks?.cpuPct, 20);
      }
      const candidate = h.store.checkpoints[0];
      assert.ok(candidate);
      resolveCheckpoint(outcomeKind === "committed"
        ? { status: "committed", root: candidate, generation: candidate.generation }
        : outcomeKind === "notPublished"
          ? { status: "notPublished", reason: "ioFailure" }
          : { status: "indeterminate", reason: "authorityUncertain", stage: "commit" });
      await settle();
      const settled = await h.service.getLifetime("repo-a");
      if (outcomeKind === "indeterminate") {
        assert.equal(settled.persistenceState, "recoveryRequired");
      } else {
        assert.notEqual(settled.persistenceState, "recoveryRequired");
        if (settled.persistenceState !== "recoveryRequired") {
          assert.equal(settled.processPeaks?.cpuPct, 20);
        }
        h.store.onCheckpoint = null;
        await h.service.stop();
      }
    }
  });

  it("includes pending process peaks in a capacity-exceeded envelope", async () => {
    const registered = new Set(Array.from({ length: MAX_REPOSITORIES + 1 }, (_, index) => `peak-${index}`));
    const h = harness(new FakeStore(), registered);
    let resolveCheckpoint!: (outcome: PublishOutcome) => void;
    h.store.onCheckpoint = async () => new Promise<PublishOutcome>((resolve) => {
      resolveCheckpoint = resolve;
    });
    await h.service.start();
    for (const repoId of registered) cache(h.service, repoId);
    resource(h.service, 22);
    const timer = h.timers.find((entry) => entry.delay === 30_000);
    assert.ok(timer);
    timer.callback();
    await settle();
    resource(h.service, 11);
    const value = await h.service.getLifetime(`peak-${MAX_REPOSITORIES}`);
    assert.equal(value.persistenceState, "capacityExceeded");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.processPeaks?.cpuPct, 22);
    }
    resolveCheckpoint({ status: "notPublished", reason: "ioFailure" });
    await settle();
    h.store.onCheckpoint = null;
    await h.service.stop();
  });

  it("publishes non-target active epochs and process peaks in a reset generation", async () => {
    const h = harness();
    let resolveReset!: (outcome: PublishOutcome) => void;
    h.store.onReset = async () => new Promise<PublishOutcome>((resolve) => {
      resolveReset = resolve;
    });
    await h.service.start();
    cache(h.service, "repo-a");
    cache(h.service, "repo-b");
    resource(h.service, 12);
    const resetting = h.service.resetLifetime("repo-a");
    await settle();
    const candidate = h.store.resets[0];
    assert.ok(candidate);
    const aCandidate = candidate.repositories[repositoryStorageKey("repo-a")];
    const bCandidate = candidate.repositories[repositoryStorageKey("repo-b")];
    assert.equal(aCandidate?.epoch, 1);
    assert.equal(aCandidate?.sections.cache, null);
    assert.equal(bCandidate?.sections.cache?.hits, 1);
    assert.equal(bCandidate?.sessionCount, 1);
    assert.equal(candidate.processPeaks?.cpuPct, 12);
    cache(h.service, "repo-b");
    resolveReset({ status: "committed", root: candidate, generation: candidate.generation });
    await resetting;
    const b = await h.service.getLifetime("repo-b");
    assert.notEqual(b.persistenceState, "recoveryRequired");
    if (b.persistenceState !== "recoveryRequired") {
      assert.equal(b.sections.cache?.hits, 2);
      assert.equal(b.sessionCount, 1);
      assert.equal(b.processPeaks?.cpuPct, 12);
    }

    const crashed = harness(new FakeStore({
      mode: "readOnly", root: structuredClone(candidate), generation: candidate.generation,
    }));
    await crashed.service.start();
    const recovered = await crashed.service.getLifetime("repo-b");
    assert.equal(recovered.persistenceState, "readOnly");
    if (recovered.persistenceState !== "recoveryRequired") {
      assert.equal(recovered.sections.cache?.hits, 1);
      assert.equal(recovered.processPeaks?.cpuPct, 12);
    }
  });

  it("turns cumulative watcher and prefetch snapshots into isolated forward deltas", async () => {
    const h = harness();
    await h.service.start();
    const watcher = (repoId: string, errors: number, restartCount: number) => h.service.watcherHealth({
      repoId, enabled: true, running: true, stale: false, errors, queueDepth: 0,
      eventsReceived: 0, eventsProcessed: 0, restartCount,
    });
    const prefetch = (repoId: string, outcomeSamples: number, accepted: number, suppressed: number) =>
      h.service.prefetch({
        repoId, hitRate: 0.5, wasteRate: 0.25, avgLatencyReductionMs: 10,
        queueDepth: 0, outcomeSamples, acceptedPrefetch: accepted,
        suppressedPrefetch: suppressed,
        topStrategies: [{
          strategy: "beam", resourceKind: "symbol", samples: outcomeSamples,
          hitRate: 0.5, acceptedRate: 0.5, wasteRate: 0.25, score: 1,
          suppressed,
        }],
      });

    watcher("repo-a", 1, 1);
    watcher("repo-a", 1, 1);
    watcher("repo-a", 3, 2);
    watcher("repo-a", 1, 0);
    watcher("repo-b", 1, 0);
    prefetch("repo-a", 4, 2, 1);
    prefetch("repo-a", 4, 2, 1);
    prefetch("repo-a", 6, 3, 2);
    prefetch("repo-a", 2, 1, 0);
    prefetch("repo-b", 2, 1, 0);

    const a = await h.service.getLifetime("repo-a");
    const b = await h.service.getLifetime("repo-b");
    assert.notEqual(a.persistenceState, "recoveryRequired");
    assert.notEqual(b.persistenceState, "recoveryRequired");
    if (a.persistenceState !== "recoveryRequired" && b.persistenceState !== "recoveryRequired") {
      assert.equal(a.sections.health?.watcherErrors, 4);
      assert.equal(a.sections.health?.watcherRestarts, 2);
      assert.equal(b.sections.health?.watcherErrors, 1);
      assert.equal(a.sections.predictiveContext?.outcomeSamples, 8);
      assert.equal(a.sections.predictiveContext?.accepted, 4);
      assert.equal(a.sections.predictiveContext?.byStrategy["k:beam"]?.samples, 8);
      assert.equal(b.sections.predictiveContext?.outcomeSamples, 2);
    }
    await h.service.stop();
  });

  it("uses owning prefetch counts and retains omitted strategy shadows", async () => {
    const h = harness();
    await h.service.start();
    const prefetch = (
      repoId: string,
      outcomeSamples: number,
      hitRate: number,
      wasteRate: number,
      avgLatencyReductionMs: number,
      strategies: Array<{ strategy: string; samples: number }>,
    ) => h.service.prefetch({
      repoId,
      outcomeSamples,
      hitRate,
      wasteRate,
      avgLatencyReductionMs,
      queueDepth: 0,
      acceptedPrefetch: 0,
      suppressedPrefetch: 0,
      topStrategies: strategies.map(({ strategy, samples }) => ({
        strategy,
        resourceKind: "symbol",
        samples,
        hitRate,
        acceptedRate: 0,
        wasteRate,
        score: 1,
        suppressed: 0,
      })),
    });

    prefetch("repo-a", 4, 0.5, 0.25, 10, [{ strategy: "A", samples: 4 }]);
    prefetch("repo-a", 4, 0.25, 0, 5, [{ strategy: "A", samples: 4 }]);
    prefetch("repo-b", 4, 0.5, 0.25, 10, [{ strategy: "A", samples: 4 }]);
    prefetch("repo-b", 10, 0.5, 0.25, 10, [{ strategy: "B", samples: 6 }]);
    prefetch("repo-b", 14, 0.5, 0.25, 10, [{ strategy: "A", samples: 8 }]);

    const unchangedOwner = await h.service.getLifetime("repo-a");
    const rotatingTopFive = await h.service.getLifetime("repo-b");
    assert.notEqual(unchangedOwner.persistenceState, "recoveryRequired");
    assert.notEqual(rotatingTopFive.persistenceState, "recoveryRequired");
    if (
      unchangedOwner.persistenceState !== "recoveryRequired"
      && rotatingTopFive.persistenceState !== "recoveryRequired"
    ) {
      assert.equal(unchangedOwner.sections.predictiveContext?.outcomeSamples, 4);
      assert.equal(unchangedOwner.sections.predictiveContext?.hitOutcomes, 2);
      assert.equal(unchangedOwner.sections.predictiveContext?.wasteOutcomes, 1);
      assert.deepEqual(unchangedOwner.sections.predictiveContext?.latencyReductionMs, {
        count: 4, sum: 40, max: 0,
      });
      assert.equal(
        unchangedOwner.sections.predictiveContext?.byStrategy["k:A"]?.samples,
        4,
      );
      assert.equal(rotatingTopFive.sections.predictiveContext?.outcomeSamples, 14);
      assert.equal(rotatingTopFive.sections.predictiveContext?.byStrategy["k:A"]?.samples, 8);
      assert.equal(rotatingTopFive.sections.predictiveContext?.byStrategy["k:B"]?.samples, 6);
    }

    await h.service.resetLifetime("repo-a");
    prefetch("repo-a", 6, 0.5, 0.25, 10, [{ strategy: "A", samples: 6 }]);
    const afterReset = await h.service.getLifetime("repo-a");
    assert.notEqual(afterReset.persistenceState, "recoveryRequired");
    if (afterReset.persistenceState !== "recoveryRequired") {
      assert.equal(afterReset.sections.predictiveContext?.outcomeSamples, 2);
      assert.equal(afterReset.sections.predictiveContext?.byStrategy["k:A"]?.samples, 2);
    }
    await h.service.stop();
  });

  it("reconciles bounded strategy overflow from global cumulative owners", async () => {
    const h = harness();
    await h.service.start();
    const emit = (
      outcomeSamples: number,
      strategies: Array<{ strategy: string; samples: number }>,
    ) => h.service.prefetch({
      repoId: "repo-a",
      outcomeSamples,
      hitRate: 0,
      wasteRate: 0,
      avgLatencyReductionMs: 0,
      queueDepth: 0,
      acceptedPrefetch: 0,
      suppressedPrefetch: 0,
      topStrategies: strategies.map(({ strategy, samples }) => ({
        strategy,
        resourceKind: "symbol",
        samples,
        hitRate: 0,
        acceptedRate: 0,
        wasteRate: 0,
        score: 1,
        suppressed: 0,
      })),
    });
    const retained = Array.from(
      { length: 32 },
      (_, index) => ({ strategy: `retained-${index}`, samples: 1 }),
    );

    emit(32, retained);
    emit(33, [{ strategy: "overflow-X", samples: 1 }]);
    emit(34, [{ strategy: "overflow-Y", samples: 1 }]);
    let value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.sections.predictiveContext?.outcomeSamples, 34);
      assert.equal(value.sections.predictiveContext?.byStrategy.__other__?.samples, 2);
      assert.equal(Object.keys(value.sections.predictiveContext?.byStrategy ?? {}).length, 33);
    }

    emit(36, [{ strategy: "overflow-Y", samples: 3 }]);
    emit(2, [{ strategy: "overflow-Z", samples: 2 }]);
    emit(2, [{ strategy: "overflow-Z", samples: 2 }]);
    value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.sections.predictiveContext?.outcomeSamples, 38);
      assert.equal(value.sections.predictiveContext?.byStrategy.__other__?.samples, 6);
      assert.equal(Object.keys(value.sections.predictiveContext?.byStrategy ?? {}).length, 33);
    }
    await h.service.stop();
  });

  it("counts engine dispatch only from authoritative IndexEvent file totals", async () => {
    const h = harness();
    await h.service.start();
    h.service.indexPhase({ repoId: "repo-a", phase: "pass1", engine: "rust", durationMs: 2 });
    h.service.indexPhase({ repoId: "repo-a", phase: "_meta.engine", engine: "rust", durationMs: 0 });
    h.service.indexEvent({
      repoId: "repo-a", versionId: "v1",
      stats: {
        filesScanned: 1, symbolsExtracted: 1, edgesExtracted: 0, durationMs: 2, errors: 0,
        pass1Engine: { rustFiles: 1, tsFiles: 0, rustFallbackFiles: 0, perLanguageFallback: {} },
      },
    });
    const value = await h.service.getLifetime("repo-a");
    assert.notEqual(value.persistenceState, "recoveryRequired");
    if (value.persistenceState !== "recoveryRequired") {
      assert.equal(value.sections.indexing?.engineDispatch["k:rust"], 1);
      assert.deepEqual(value.sections.indexing?.pass1Ms, { count: 1, sum: 2, max: 2 });
      assert.equal(value.sections.indexing?.phaseCounts["k:pass1"], 1);
    }
    await h.service.stop();
  });

  it("logs only read-only ioFailure refresh outcomes and retains validated state", async (t) => {
    const key = repositoryStorageKey("repo-a");
    const baselineSections = emptyLifetimeSections();
    baselineSections.cache = {
      hits: 5, misses: 0, lookupMs: { count: 5, sum: 5, max: 1 }, perSource: {},
    };
    const store = new FakeStore({
      mode: "readOnly",
      root: root(2, { [key]: repository({ sections: baselineSections }) }),
      generation: 2,
    });
    const warn = t.mock.method(logger, "warn");
    const h = harness(store);
    await h.service.start();
    store.refreshOutcomes.push({ status: "ioFailure" });
    let value = await h.service.getLifetime("repo-a");
    assert.equal(warn.mock.callCount(), 1);
    if (value.persistenceState !== "recoveryRequired") assert.equal(value.sections.cache?.hits, 5);

    store.refreshOutcomes.push({ status: "unchanged" });
    await h.service.getLifetime("repo-a");
    assert.equal(warn.mock.callCount(), 1);

    const refreshedSections = structuredClone(baselineSections);
    if (refreshedSections.cache) refreshedSections.cache.hits = 9;
    const refreshedRoot = root(3, { [key]: repository({ sections: refreshedSections }) });
    store.refreshOutcomes.push({ status: "refreshed", root: refreshedRoot, generation: 3 });
    value = await h.service.getLifetime("repo-a");
    assert.equal(warn.mock.callCount(), 1);
    if (value.persistenceState !== "recoveryRequired") assert.equal(value.sections.cache?.hits, 9);

    store.refreshOutcomes.push({ status: "recoveryRequired", reason: "unknownSchema" });
    value = await h.service.getLifetime("repo-a");
    assert.equal(value.persistenceState, "recoveryRequired");
    if (value.persistenceState === "recoveryRequired") {
      assert.equal(value.recoveryReason, "unknownSchema");
    }
    assert.equal(warn.mock.callCount(), 1);
  });

  it("keeps legacy start session-only when lifetime persistence is not configured", async () => {
    resetObservabilityTap();
    const timers: FakeTimer[] = [];
    const service = new ObservabilityService(CONFIG, {
      scheduleInterval: (callback, delay) => {
        const timer: FakeTimer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearScheduledInterval: (timer) => { (timer as FakeTimer).cleared = true; },
    });
    await service.start();
    assert.deepEqual(timers.map((entry) => entry.delay), [2_000]);
    assert.equal(getObservabilityTap(), null);
    cache(service, "legacy-repo");
    assert.equal(service.getSnapshot("legacy-repo").cache.totalHits, 1);
    await service.stop();
  });
});
