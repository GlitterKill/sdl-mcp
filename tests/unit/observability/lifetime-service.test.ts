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
  resetOutcome: PublishOutcome | null = null;
  onRefresh: (() => void) | null = null;
  onReset: ((snapshot: DurableLifetimeRoot) => Promise<PublishOutcome>) | null = null;

  constructor(state: StoreState = { mode: "writer", root: null, generation: null }) {
    this.current = state;
  }

  state(): StoreState {
    return structuredClone(this.current);
  }

  async checkpoint(snapshot: DurableLifetimeRoot): Promise<PublishOutcome> {
    this.checkpoints.push(structuredClone(snapshot));
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

  async refreshReadOnly(): Promise<void> {
    this.refreshes += 1;
    this.onRefresh?.();
  }

  async close(finalSnapshot?: DurableLifetimeRoot): Promise<void> {
    this.closed += 1;
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
    readOnlyStore.onRefresh = () => {
      readOnlyStore.current = { mode: "readOnly", root: root(4, { [key]: repository({ sections: higherSections, sessionCount: 3 }) }), generation: 4 };
    };
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
    readOnlyStore.onRefresh = () => {
      readOnlyStore.current = {
        mode: "recoveryRequired",
        root: readOnlyStore.current.root,
        generation: readOnlyStore.current.generation,
        reason: "unknownSchema",
      };
    };
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
    assert.equal(getObservabilityTap(), service);
    await service.stop();
    assert.equal(base.store.closed, 1);
    resetObservabilityTap();
  });
});
