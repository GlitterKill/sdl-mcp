import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LIFETIME_SCHEMA_VERSION,
  MAX_REPOSITORIES,
  MAX_SAMPLE_INTERVAL_MS,
  MAX_STORE_BYTES,
  MIN_SAMPLE_INTERVAL_MS,
  OVERFLOW_KEY,
  SECTION_IDS,
  LIFETIME_ROUTE_ERROR_CODES,
  parseDurableLifetimeRoot,
  parseLifetimeEnvelope,
  parseLifetimeRouteError,
  parseResetRequest,
  repositoryStorageKey,
  type DurableLifetimeRoot,
  type DurableLifetimeRepository,
  type DurableLifetimeSections,
  type LifetimeRouteErrorV1,
  type LifetimeResetSuccessV1,
} from "../../../dist/observability/lifetime-types.js";
import {
  DYNAMIC_MAP_LOCATIONS,
  admitDynamicMapEntry,
  admitRepository,
  canonicalDynamicKey,
  dynamicMapLimit,
  emptyRepositoryLifetime,
  incrementSessionCount,
  lifetimeView,
  mergeCounter,
  mergeDynamicMaps,
  mergeProcessPeaks,
  mergeRepositoryLifetime,
  mergeSample,
  mergeSampleWithSaturation,
  normalizeDynamicMap,
  reservedSerializedBytes,
  resetRepositoryLifetime,
  saturatingAdd,
  saturatingAddWithSaturation,
} from "../../../dist/observability/lifetime-accumulator.js";

const ISO = "2026-08-19T12:34:56.789Z";
const REPOSITORY_KEY =
  "sha256:351fd6257aec4d4e1eb66c2a91150162c6f0fad3eb086851e1c7ca1f2e0527f9";

const sample = { count: 1, sum: 2, max: 2 };
const counterMap = { "k:z": 2, "k:a": 1 };
const sampleMap = {
  "k:z": { count: 2, sum: 4, max: 3 },
  "k:a": { count: 1, sum: 1, max: 1 },
};

const sections = {
  cache: {
    hits: 1,
    misses: 2,
    lookupMs: sample,
    perSource: {
      "k:z": { hits: 2, misses: 1, lookupMs: sample },
      __other__: { hits: 1, misses: 0, lookupMs: sample },
      "k:a": { hits: 3, misses: 4, lookupMs: sample },
    },
  },
  retrieval: {
    calls: 1,
    emptyResults: 2,
    latencyMs: sample,
    byMode: counterMap,
    byType: counterMap,
    candidatesBySource: counterMap,
    phaseLatencyMs: sampleMap,
  },
  beam: {
    builds: 1,
    buildMs: sample,
    accepted: 2,
    evicted: 3,
    rejected: 4,
    frontierMax: sample,
    retainedHandlesPeak: 5,
  },
  delta: {
    computations: 1,
    blastRadiusMs: sample,
    dbRoundTrips: sample,
    pathExplanationMs: sample,
    fallbackPathQueries: 2,
  },
  indexing: {
    events: 1,
    pass1Ms: sample,
    pass2Ms: sample,
    failures: 2,
    phaseCounts: counterMap,
    languageMs: sampleMap,
    engineDispatch: counterMap,
    derivedLagMs: sample,
  },
  tokenEfficiency: {
    calls: 1,
    usedTokens: 2,
    savedTokens: 3,
    compressionBySource: {
      "k:z": {
        events: 1,
        realizedEvents: 2,
        estimatedTokensAvoided: 3,
        originalTokens: 4,
        returnedTokens: 5,
        savedTokens: 6,
        opportunities: 7,
        hits: 8,
        storedBytes: 9,
      },
      "k:a": {
        events: 1,
        realizedEvents: 2,
        estimatedTokensAvoided: 3,
        originalTokens: 4,
        returnedTokens: 5,
        savedTokens: 6,
        opportunities: 7,
        hits: 8,
        storedBytes: 9,
      },
    },
  },
  predictiveContext: {
    outcomeSamples: 1,
    hitOutcomes: 2,
    wasteOutcomes: 3,
    accepted: 4,
    suppressed: 5,
    latencyReductionMs: sample,
    byStrategy: {
      "k:z": {
        samples: 1,
        hits: 2,
        wasted: 3,
        accepted: 4,
        suppressed: 5,
        latencyReductionMs: sample,
      },
      "k:a": {
        samples: 1,
        hits: 2,
        wasted: 3,
        accepted: 4,
        suppressed: 5,
        latencyReductionMs: sample,
      },
    },
  },
  health: {
    watcherErrors: 1,
    watcherRestarts: 2,
    watchmanWarnings: 3,
    watchmanRecrawls: 4,
    watchmanFreshInstances: 5,
  },
  latency: {
    calls: 1,
    errors: 2,
    durationMs: sample,
    perTool: {
      "k:z": { calls: 1, errors: 2, durationMs: sample },
      "k:a": { calls: 3, errors: 4, durationMs: sample },
    },
  },
  pool: null,
  scip: {
    ingests: 1,
    successes: 2,
    failures: 3,
    edgesCreated: 4,
    edgesUpgraded: 5,
    ingestMs: sample,
  },
  packed: {
    decisions: 1,
    packed: 2,
    fallback: 3,
    packedBytes: 4,
    baselineBytes: 5,
    packedTokens: 6,
    baselineTokens: 7,
    axisHits: counterMap,
    byEncoder: {
      "k:z": {
        decisions: 1,
        packed: 2,
        fallback: 3,
        packedBytes: 4,
        baselineBytes: 5,
        packedTokens: 6,
        baselineTokens: 7,
      },
      "k:a": {
        decisions: 1,
        packed: 2,
        fallback: 3,
        packedBytes: 4,
        baselineBytes: 5,
        packedTokens: 6,
        baselineTokens: 7,
      },
    },
  },
  ppr: {
    runs: 1,
    native: 2,
    javascript: 3,
    fallback: 4,
    computeMs: sample,
    touched: sample,
    seeds: sample,
  },
  auditBuffer: null,
  postIndex: { sessions: 1, durationMs: sample, timeouts: 2 },
  toolOutput: {
    calls: 1,
    errors: 2,
    rawBytes: 3,
    projectedBytes: 4,
    rawTokens: 5,
    projectedTokens: 6,
    removedFields: 7,
    handled: 8,
    truncated: 9,
    recoveryEmitted: 10,
    invalidRecovery: 11,
    projectedBytesMax: 12,
    projectedTokensMax: 13,
    detailCounts: counterMap,
    profileCounts: counterMap,
    perTool: {
      "k:z": {
        calls: 1,
        errors: 2,
        rawBytes: 3,
        projectedBytes: 4,
        rawTokens: 5,
        projectedTokens: 6,
        removedFields: 7,
        handled: 8,
        truncated: 9,
        recoveryEmitted: 10,
        invalidRecovery: 11,
        projectedBytesMax: 12,
        projectedTokensMax: 13,
        detailCounts: counterMap,
        profileCounts: counterMap,
      },
      "k:a": {
        calls: 1,
        errors: 2,
        rawBytes: 3,
        projectedBytes: 4,
        rawTokens: 5,
        projectedTokens: 6,
        removedFields: 7,
        handled: 8,
        truncated: 9,
        recoveryEmitted: 10,
        invalidRecovery: 11,
        projectedBytesMax: 12,
        projectedTokensMax: 13,
        detailCounts: counterMap,
        profileCounts: counterMap,
      },
    },
  },
  resources: null,
};

const freshness = {
  cache: ISO,
  retrieval: null,
  beam: ISO,
  delta: null,
  indexing: ISO,
  tokenEfficiency: null,
  predictiveContext: ISO,
  health: null,
  latency: ISO,
  pool: null,
  scip: ISO,
  packed: null,
  ppr: ISO,
  auditBuffer: null,
  postIndex: ISO,
  toolOutput: null,
  resources: ISO,
};

const emptySections = {
  cache: null,
  retrieval: null,
  beam: null,
  delta: null,
  indexing: null,
  tokenEfficiency: null,
  predictiveContext: null,
  health: null,
  latency: null,
  pool: null,
  scip: null,
  packed: null,
  ppr: null,
  auditBuffer: null,
  postIndex: null,
  toolOutput: null,
  resources: null,
};

const durableRootFixture = {
  schemaVersion: 1,
  generation: 7,
  updatedAt: ISO,
  processPeaks: {
    cpuPct: 1,
    rssMb: 2,
    heapUsedMb: 3,
    heapTotalMb: 4,
    eventLoopLagMs: 5,
  },
  repositories: {
    [REPOSITORY_KEY]: {
      epoch: 2,
      resetAt: null,
      lastCheckpointAt: ISO,
      sessionCount: 3,
      saturated: false,
      sections,
    },
  },
};

const readyEnvelopeFixture = {
  schemaVersion: 1,
  sampleIntervalMs: 1_000,
  generatedAt: ISO,
  repoId: "repo-alpha",
  epoch: 2,
  resetAt: null,
  lastCheckpointAt: ISO,
  persistenceState: "ready",
  sessionCount: 3,
  saturated: false,
  sections,
  freshness,
  processPeaks: durableRootFixture.processPeaks,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function repositoryMap(count: number) {
  const entry = durableRootFixture.repositories[REPOSITORY_KEY];
  assert.ok(entry);
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `sha256:${index.toString(16).padStart(64, "0")}`,
    clone(entry),
  ]));
}

function boundedCounterMap(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `k:key${index.toString().padStart(3, "0")}`,
    index,
  ]));
}

describe("lifetime observability contract", () => {
  it("exports the exact constants and fixed section order", () => {
    assert.deepEqual(SECTION_IDS, [
      "cache", "retrieval", "beam", "delta", "indexing",
      "tokenEfficiency", "predictiveContext", "health", "latency",
      "pool", "scip", "packed", "ppr", "auditBuffer",
      "postIndex", "toolOutput", "resources",
    ]);
    assert.equal(LIFETIME_SCHEMA_VERSION, 1);
    assert.equal(MIN_SAMPLE_INTERVAL_MS, 250);
    assert.equal(MAX_SAMPLE_INTERVAL_MS, 60_000);
    assert.equal(MAX_STORE_BYTES, 2 * 1024 * 1024);
    assert.equal(MAX_REPOSITORIES, 32);
    assert.equal(OVERFLOW_KEY, "__other__");
  });

  it("normalizes durable root, repository, section, and map key order", () => {
    const parsed = parseDurableLifetimeRoot(durableRootFixture);
    assert.deepEqual(Object.keys(parsed), [
      "schemaVersion", "generation", "updatedAt", "processPeaks", "repositories",
    ]);
    assert.deepEqual(Object.keys(parsed.processPeaks ?? {}), [
      "cpuPct", "rssMb", "heapUsedMb", "heapTotalMb", "eventLoopLagMs",
    ]);
    const repository = parsed.repositories[REPOSITORY_KEY];
    assert.ok(repository);
    assert.deepEqual(Object.keys(repository), [
      "epoch", "resetAt", "lastCheckpointAt", "sessionCount", "saturated", "sections",
    ]);
    assert.deepEqual(Object.keys(repository.sections), [
      "cache", "retrieval", "beam", "delta", "indexing",
      "tokenEfficiency", "predictiveContext", "health", "latency",
      "pool", "scip", "packed", "ppr", "auditBuffer",
      "postIndex", "toolOutput", "resources",
    ]);
    assert.deepEqual(Object.keys(repository.sections.cache ?? {}), [
      "hits", "misses", "lookupMs", "perSource",
    ]);
    assert.deepEqual(Object.keys(repository.sections.retrieval ?? {}), [
      "calls", "emptyResults", "latencyMs", "byMode", "byType",
      "candidatesBySource", "phaseLatencyMs",
    ]);
    assert.deepEqual(Object.keys(repository.sections.beam ?? {}), [
      "builds", "buildMs", "accepted", "evicted", "rejected",
      "frontierMax", "retainedHandlesPeak",
    ]);
    assert.deepEqual(Object.keys(repository.sections.delta ?? {}), [
      "computations", "blastRadiusMs", "dbRoundTrips", "pathExplanationMs",
      "fallbackPathQueries",
    ]);
    assert.deepEqual(Object.keys(repository.sections.indexing ?? {}), [
      "events", "pass1Ms", "pass2Ms", "failures", "phaseCounts",
      "languageMs", "engineDispatch", "derivedLagMs",
    ]);
    assert.deepEqual(Object.keys(repository.sections.tokenEfficiency ?? {}), [
      "calls", "usedTokens", "savedTokens", "compressionBySource",
    ]);
    assert.deepEqual(Object.keys(repository.sections.predictiveContext ?? {}), [
      "outcomeSamples", "hitOutcomes", "wasteOutcomes", "accepted", "suppressed",
      "latencyReductionMs", "byStrategy",
    ]);
    assert.deepEqual(Object.keys(repository.sections.health ?? {}), [
      "watcherErrors", "watcherRestarts", "watchmanWarnings", "watchmanRecrawls",
      "watchmanFreshInstances",
    ]);
    assert.deepEqual(Object.keys(repository.sections.latency ?? {}), [
      "calls", "errors", "durationMs", "perTool",
    ]);
    assert.deepEqual(Object.keys(repository.sections.scip ?? {}), [
      "ingests", "successes", "failures", "edgesCreated", "edgesUpgraded", "ingestMs",
    ]);
    assert.deepEqual(Object.keys(repository.sections.packed ?? {}), [
      "decisions", "packed", "fallback", "packedBytes", "baselineBytes",
      "packedTokens", "baselineTokens", "axisHits", "byEncoder",
    ]);
    assert.deepEqual(Object.keys(repository.sections.ppr ?? {}), [
      "runs", "native", "javascript", "fallback", "computeMs", "touched", "seeds",
    ]);
    assert.deepEqual(Object.keys(repository.sections.postIndex ?? {}), [
      "sessions", "durationMs", "timeouts",
    ]);
    assert.deepEqual(Object.keys(repository.sections.toolOutput ?? {}), [
      "calls", "errors", "rawBytes", "projectedBytes", "rawTokens",
      "projectedTokens", "removedFields", "handled", "truncated",
      "recoveryEmitted", "invalidRecovery", "projectedBytesMax",
      "projectedTokensMax", "detailCounts", "profileCounts", "perTool",
    ]);
    assert.deepEqual(
      Object.keys(repository.sections.cache?.perSource["k:a"] ?? {}),
      ["hits", "misses", "lookupMs"],
    );
    assert.deepEqual(
      Object.keys(repository.sections.tokenEfficiency?.compressionBySource["k:a"] ?? {}),
      [
        "events", "realizedEvents", "estimatedTokensAvoided", "originalTokens",
        "returnedTokens", "savedTokens", "opportunities", "hits", "storedBytes",
      ],
    );
    assert.deepEqual(
      Object.keys(repository.sections.predictiveContext?.byStrategy["k:a"] ?? {}),
      ["samples", "hits", "wasted", "accepted", "suppressed", "latencyReductionMs"],
    );
    assert.deepEqual(
      Object.keys(repository.sections.latency?.perTool["k:a"] ?? {}),
      ["calls", "errors", "durationMs"],
    );
    assert.deepEqual(
      Object.keys(repository.sections.packed?.byEncoder["k:a"] ?? {}),
      [
        "decisions", "packed", "fallback", "packedBytes", "baselineBytes",
        "packedTokens", "baselineTokens",
      ],
    );
    assert.deepEqual(
      Object.keys(repository.sections.toolOutput?.perTool["k:a"] ?? {}),
      [
        "calls", "errors", "rawBytes", "projectedBytes", "rawTokens",
        "projectedTokens", "removedFields", "handled", "truncated",
        "recoveryEmitted", "invalidRecovery", "projectedBytesMax",
        "projectedTokensMax", "detailCounts", "profileCounts",
      ],
    );
    assert.deepEqual(
      Object.keys(repository.sections.cache?.perSource ?? {}),
      ["__other__", "k:a", "k:z"],
    );
    assert.deepEqual(
      Object.keys(repository.sections.retrieval?.byMode ?? {}),
      ["k:a", "k:z"],
    );
  });

  it("normalizes exact ready and recovery envelope orders", () => {
    const ready = parseLifetimeEnvelope(readyEnvelopeFixture);
    assert.deepEqual(Object.keys(ready), [
      "schemaVersion", "sampleIntervalMs", "generatedAt", "repoId", "epoch",
      "resetAt", "lastCheckpointAt", "persistenceState", "sessionCount",
      "saturated", "sections", "freshness", "processPeaks",
    ]);
    assert.deepEqual(Object.keys(ready.freshness), [
      "cache", "retrieval", "beam", "delta", "indexing",
      "tokenEfficiency", "predictiveContext", "health", "latency",
      "pool", "scip", "packed", "ppr", "auditBuffer",
      "postIndex", "toolOutput", "resources",
    ]);

    const recovery = parseLifetimeEnvelope({
      schemaVersion: 1,
      sampleIntervalMs: 1_000,
      generatedAt: ISO,
      repoId: "repo-alpha",
      persistenceState: "recoveryRequired",
      recoveryReason: "corruptCandidates",
    });
    assert.deepEqual(Object.keys(recovery), [
      "schemaVersion", "sampleIntervalMs", "generatedAt", "repoId",
      "persistenceState", "recoveryReason",
    ]);
  });

  it("defines exact reset-success and route-error key order", () => {
    const success: LifetimeResetSuccessV1 = {
      schemaVersion: 1,
      repoId: "repo-alpha",
      epoch: 3,
      resetAt: ISO,
      lastCheckpointAt: ISO,
      persistenceState: "ready",
    };
    const error: LifetimeRouteErrorV1 = {
      schemaVersion: 1,
      error: {
        code: "persistence_failed",
        message: "Lifetime persistence failed.",
        retryable: true,
      },
    };
    assert.deepEqual(Object.keys(success), [
      "schemaVersion", "repoId", "epoch", "resetAt", "lastCheckpointAt",
      "persistenceState",
    ]);
    assert.deepEqual(Object.keys(error), ["schemaVersion", "error"]);
    assert.deepEqual(Object.keys(error.error), ["code", "message", "retryable"]);
    assert.deepEqual(LIFETIME_ROUTE_ERROR_CODES, [
      "invalid_query",
      "invalid_json",
      "invalid_body",
      "repository_not_found",
      "read_only",
      "lifetime_capacity_exceeded",
      "recovery_required",
      "body_too_large",
      "unsupported_media_type",
      "confirmation_mismatch",
      "persistence_failed",
      "persistence_indeterminate",
    ]);
    const approvedCodes = [
      "invalid_query",
      "invalid_json",
      "invalid_body",
      "repository_not_found",
      "read_only",
      "lifetime_capacity_exceeded",
      "recovery_required",
      "body_too_large",
      "unsupported_media_type",
      "confirmation_mismatch",
      "persistence_failed",
      "persistence_indeterminate",
    ] as const;
    const errors = approvedCodes.map((code) => ({
      schemaVersion: 1,
      error: { code, message: "fixed", retryable: code === "persistence_failed" },
    }));
    assert.deepEqual(errors.map((value) => parseLifetimeRouteError(value).error.code), [
      "invalid_query",
      "invalid_json",
      "invalid_body",
      "repository_not_found",
      "read_only",
      "lifetime_capacity_exceeded",
      "recovery_required",
      "body_too_large",
      "unsupported_media_type",
      "confirmation_mismatch",
      "persistence_failed",
      "persistence_indeterminate",
    ]);

    const retryable: LifetimeRouteErrorV1 = {
      schemaVersion: 1,
      error: { code: "persistence_failed", message: "fixed", retryable: true },
    };
    const nonRetryable: LifetimeRouteErrorV1 = {
      schemaVersion: 1,
      error: { code: "persistence_indeterminate", message: "fixed", retryable: false },
    };
    assert.equal(parseLifetimeRouteError(retryable).error.retryable, true);
    assert.equal(parseLifetimeRouteError(nonRetryable).error.retryable, false);
    assert.throws(() => parseLifetimeRouteError({
      schemaVersion: 1,
      error: { code: "persistence_failed", message: "fixed", retryable: false },
    }));
    for (const code of [
      "invalid_query",
      "invalid_json",
      "invalid_body",
      "repository_not_found",
      "read_only",
      "lifetime_capacity_exceeded",
      "recovery_required",
      "body_too_large",
      "unsupported_media_type",
      "confirmation_mismatch",
      "persistence_indeterminate",
    ]) {
      assert.throws(() => parseLifetimeRouteError({
        schemaVersion: 1,
        error: { code, message: "fixed", retryable: true },
      }));
    }
  });

  it("enforces sample interval and discriminant bounds", () => {
    for (const sampleIntervalMs of [250, 60_000]) {
      assert.equal(
        parseLifetimeEnvelope({ ...readyEnvelopeFixture, sampleIntervalMs }).sampleIntervalMs,
        sampleIntervalMs,
      );
    }
    for (const sampleIntervalMs of [249, 60_001, 250.5]) {
      assert.throws(() =>
        parseLifetimeEnvelope({ ...readyEnvelopeFixture, sampleIntervalMs }));
    }
    assert.throws(() => parseLifetimeEnvelope({
      ...readyEnvelopeFixture,
      persistenceState: "recoveryRequired",
    }));
    assert.throws(() => parseLifetimeEnvelope({
      schemaVersion: 1,
      sampleIntervalMs: 1_000,
      generatedAt: ISO,
      repoId: "repo-alpha",
      persistenceState: "recoveryRequired",
      recoveryReason: "diskFailure",
    }));

    for (const persistenceState of [
      "ready", "degraded", "readOnly", "capacityExceeded",
    ] as const) {
      const envelope = persistenceState === "capacityExceeded"
        ? {
            ...readyEnvelopeFixture,
            epoch: 0,
            resetAt: null,
            lastCheckpointAt: null,
            persistenceState,
            sessionCount: 0,
            saturated: false,
            sections: emptySections,
          }
        : { ...readyEnvelopeFixture, persistenceState };
      assert.equal(
        parseLifetimeEnvelope(envelope).persistenceState,
        persistenceState,
      );
    }
    for (const recoveryReason of [
      "unknownSchema", "corruptCandidates", "indeterminatePublication",
    ] as const) {
      const parsed = parseLifetimeEnvelope({
        schemaVersion: 1,
        sampleIntervalMs: 1_000,
        generatedAt: ISO,
        repoId: "repo-alpha",
        persistenceState: "recoveryRequired",
        recoveryReason,
      });
      assert.equal(parsed.persistenceState, "recoveryRequired");
      assert.equal(parsed.recoveryReason, recoveryReason);
    }
  });

  it("enforces the capacityExceeded empty-lifetime invariant", () => {
    const valid = {
      ...readyEnvelopeFixture,
      epoch: 0,
      resetAt: null,
      lastCheckpointAt: null,
      persistenceState: "capacityExceeded",
      sessionCount: 0,
      saturated: false,
      sections: emptySections,
    };
    const parsed = parseLifetimeEnvelope(valid);
    assert.equal(parsed.persistenceState, "capacityExceeded");
    assert.deepEqual(parsed.sections, emptySections);
    assert.deepEqual(parsed.processPeaks, durableRootFixture.processPeaks);

    for (const invalid of [
      { ...valid, epoch: 1 },
      { ...valid, sessionCount: 1 },
      { ...valid, resetAt: ISO },
      { ...valid, lastCheckpointAt: ISO },
      { ...valid, saturated: true },
      { ...valid, sections: { ...emptySections, cache: sections.cache } },
    ]) {
      assert.throws(() => parseLifetimeEnvelope(invalid));
    }
  });

  it("enforces repository and dynamic-map cardinality boundaries independently", () => {
    const repositories32 = parseDurableLifetimeRoot({
      ...durableRootFixture,
      repositories: repositoryMap(32),
    });
    assert.equal(Object.keys(repositories32.repositories).length, 32);
    assert.throws(() => parseDurableLifetimeRoot({
      ...durableRootFixture,
      repositories: repositoryMap(33),
    }));

    const real32 = clone(durableRootFixture);
    const real32Repository = real32.repositories[REPOSITORY_KEY];
    assert.ok(real32Repository?.sections.retrieval);
    real32Repository.sections.retrieval.byMode = boundedCounterMap(32);
    assert.equal(Object.keys(parseDurableLifetimeRoot(real32)
      .repositories[REPOSITORY_KEY]?.sections.retrieval?.byMode ?? {}).length, 32);

    const real32WithOverflow = clone(durableRootFixture);
    const real32WithOverflowRepository = real32WithOverflow.repositories[REPOSITORY_KEY];
    assert.ok(real32WithOverflowRepository?.sections.retrieval);
    real32WithOverflowRepository.sections.retrieval.byMode = {
      ...boundedCounterMap(32),
      __other__: 99,
    };
    const parsedMap32 = parseDurableLifetimeRoot(real32WithOverflow)
      .repositories[REPOSITORY_KEY]?.sections.retrieval?.byMode ?? {};
    assert.equal(Object.keys(parsedMap32).length, 33);
    assert.equal(Object.keys(parsedMap32)[0], "__other__");

    const real33 = clone(durableRootFixture);
    const real33Repository = real33.repositories[REPOSITORY_KEY];
    assert.ok(real33Repository?.sections.retrieval);
    real33Repository.sections.retrieval.byMode = boundedCounterMap(33);
    assert.throws(() => parseDurableLifetimeRoot(real33));

    const real33WithOverflow = clone(durableRootFixture);
    const real33WithOverflowRepository = real33WithOverflow.repositories[REPOSITORY_KEY];
    assert.ok(real33WithOverflowRepository?.sections.retrieval);
    real33WithOverflowRepository.sections.retrieval.byMode = {
      ...boundedCounterMap(33),
      __other__: 99,
    };
    assert.throws(() => parseDurableLifetimeRoot(real33WithOverflow));
  });

  it("enforces independent perTool and byEncoder 128-key boundaries", () => {
    for (const field of ["perTool", "byEncoder"] as const) {
      const real128 = clone(durableRootFixture);
      const real128Repository = real128.repositories[REPOSITORY_KEY];
      assert.ok(real128Repository?.sections.latency);
      assert.ok(real128Repository.sections.packed);
      if (field === "perTool") {
        const value = real128Repository.sections.latency.perTool["k:a"];
        assert.ok(value);
        real128Repository.sections.latency.perTool = Object.fromEntries(
          Object.keys(boundedCounterMap(128)).map((key) => [key, clone(value)]),
        );
      } else {
        const value = real128Repository.sections.packed.byEncoder["k:a"];
        assert.ok(value);
        real128Repository.sections.packed.byEncoder = Object.fromEntries(
          Object.keys(boundedCounterMap(128)).map((key) => [key, clone(value)]),
        );
      }
      const parsedReal128 = parseDurableLifetimeRoot(real128)
        .repositories[REPOSITORY_KEY]?.sections;
      const parsedReal128Map = field === "perTool"
        ? parsedReal128?.latency?.perTool
        : parsedReal128?.packed?.byEncoder;
      assert.equal(Object.keys(parsedReal128Map ?? {}).length, 128);

      const real128WithOverflow = clone(real128);
      const overflowRepository = real128WithOverflow.repositories[REPOSITORY_KEY];
      assert.ok(overflowRepository?.sections.latency);
      assert.ok(overflowRepository.sections.packed);
      if (field === "perTool") {
        const value = overflowRepository.sections.latency.perTool["k:key000"];
        assert.ok(value);
        overflowRepository.sections.latency.perTool.__other__ = clone(value);
      } else {
        const value = overflowRepository.sections.packed.byEncoder["k:key000"];
        assert.ok(value);
        overflowRepository.sections.packed.byEncoder.__other__ = clone(value);
      }
      const parsedOverflow = parseDurableLifetimeRoot(real128WithOverflow)
        .repositories[REPOSITORY_KEY]?.sections;
      const parsedOverflowMap = field === "perTool"
        ? parsedOverflow?.latency?.perTool
        : parsedOverflow?.packed?.byEncoder;
      assert.equal(Object.keys(parsedOverflowMap ?? {}).length, 129);
      assert.equal(Object.keys(parsedOverflowMap ?? {})[0], "__other__");

      const real129 = clone(real128);
      const real129Repository = real129.repositories[REPOSITORY_KEY];
      assert.ok(real129Repository?.sections.latency);
      assert.ok(real129Repository.sections.packed);
      if (field === "perTool") {
        const value = real129Repository.sections.latency.perTool["k:key000"];
        assert.ok(value);
        real129Repository.sections.latency.perTool["k:key128"] = clone(value);
      } else {
        const value = real129Repository.sections.packed.byEncoder["k:key000"];
        assert.ok(value);
        real129Repository.sections.packed.byEncoder["k:key128"] = clone(value);
      }
      assert.throws(() => parseDurableLifetimeRoot(real129));

      const real129WithOverflow = clone(real128WithOverflow);
      const rejectedOverflowRepository = real129WithOverflow.repositories[REPOSITORY_KEY];
      assert.ok(rejectedOverflowRepository?.sections.latency);
      assert.ok(rejectedOverflowRepository.sections.packed);
      if (field === "perTool") {
        const value = rejectedOverflowRepository.sections.latency.perTool["k:key000"];
        assert.ok(value);
        rejectedOverflowRepository.sections.latency.perTool["k:key128"] = clone(value);
      } else {
        const value = rejectedOverflowRepository.sections.packed.byEncoder["k:key000"];
        assert.ok(value);
        rejectedOverflowRepository.sections.packed.byEncoder["k:key128"] = clone(value);
      }
      assert.throws(() => parseDurableLifetimeRoot(real129WithOverflow));
    }
  });

  it("rejects unknown keys recursively", () => {
    const root = clone(durableRootFixture) as typeof durableRootFixture & {
      unexpected?: boolean;
    };
    root.unexpected = true;
    assert.throws(() => parseDurableLifetimeRoot(root));

    const nested = clone(durableRootFixture);
    const repository = nested.repositories[REPOSITORY_KEY];
    assert.ok(repository);
    (repository.sections.cache as typeof repository.sections.cache & {
      unexpected?: boolean;
    }).unexpected = true;
    assert.throws(() => parseDurableLifetimeRoot(nested));

    const request = { repoId: "repo-alpha", confirmation: "RESET", extra: true };
    assert.throws(() => parseResetRequest(request));
  });

  it("rejects invalid numeric values at every numeric boundary", () => {
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const counter = clone(durableRootFixture);
      counter.generation = invalid;
      assert.throws(() => parseDurableLifetimeRoot(counter));

      const sampleValue = clone(durableRootFixture);
      const repository = sampleValue.repositories[REPOSITORY_KEY];
      assert.ok(repository?.sections.cache);
      repository.sections.cache.lookupMs.sum = invalid;
      assert.throws(() => parseDurableLifetimeRoot(sampleValue));
    }

    const maximum = clone(durableRootFixture);
    const maximumRepository = maximum.repositories[REPOSITORY_KEY];
    assert.ok(maximumRepository?.sections.cache);
    maximum.generation = Number.MAX_SAFE_INTEGER;
    maximumRepository.epoch = Number.MAX_SAFE_INTEGER;
    maximumRepository.sessionCount = Number.MAX_SAFE_INTEGER;
    maximumRepository.sections.cache.hits = Number.MAX_SAFE_INTEGER;
    maximumRepository.sections.cache.lookupMs = {
      count: Number.MAX_SAFE_INTEGER,
      sum: Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    };
    assert.equal(parseDurableLifetimeRoot(maximum).generation, Number.MAX_SAFE_INTEGER);
  });

  it("rejects invalid timestamps, overlong strings, and malformed storage keys", () => {
    assert.throws(() => parseDurableLifetimeRoot({
      ...durableRootFixture,
      updatedAt: "not-a-timestamp",
    }));
    assert.throws(() => parseLifetimeEnvelope({
      ...readyEnvelopeFixture,
      generatedAt: "2026-08-19",
    }));
    for (const generatedAt of [
      "2026-02-30T00:00:00Z",
      "2026-08-19T24:00:00Z",
      "2026-08-19T12:60:00Z",
      "2026-08-19T12:34:60Z",
      "2026-08-19T12:34:56+24:00",
      "2026-08-19T12:34:56+01:60",
      "2".repeat(65),
    ]) {
      assert.throws(() => parseLifetimeEnvelope({ ...readyEnvelopeFixture, generatedAt }));
    }
    for (const generatedAt of [
      "2024-02-29T23:59:59Z",
      "2026-08-19T12:34:56.789Z",
      "2026-08-19T12:34:56+05:30",
    ]) {
      assert.equal(
        parseLifetimeEnvelope({ ...readyEnvelopeFixture, generatedAt }).generatedAt,
        generatedAt,
      );
    }
    assert.throws(() => parseResetRequest({
      repoId: "r".repeat(129),
      confirmation: "RESET",
    }));
    assert.throws(() => parseResetRequest({
      repoId: "repo-alpha",
      confirmation: "x".repeat(157),
    }));
    assert.throws(() => parseDurableLifetimeRoot({
      ...durableRootFixture,
      repositories: { [REPOSITORY_KEY.toUpperCase()]: durableRootFixture.repositories[REPOSITORY_KEY] },
    }));
  });

  it("accepts only reserved or prefixed canonical dynamic map keys", () => {
    assert.equal(
      parseDurableLifetimeRoot(durableRootFixture)
        .repositories[REPOSITORY_KEY]?.sections.cache?.perSource.__other__?.hits,
      1,
    );
    for (const invalidKey of [
      "plain", "__OTHER__", "__other__2", "k:", `k:${"a".repeat(65)}`, "k:has space",
    ]) {
      const invalid = clone(durableRootFixture);
      const repository = invalid.repositories[REPOSITORY_KEY];
      assert.ok(repository?.sections.retrieval);
      repository.sections.retrieval.byMode = { [invalidKey]: 1 };
      assert.throws(() => parseDurableLifetimeRoot(invalid));
    }
  });

  it("hashes UTF-8 repository identifiers and enforces exact reset confirmation", () => {
    assert.equal(repositoryStorageKey("repo-alpha"), REPOSITORY_KEY);
    assert.throws(() => repositoryStorageKey(""));
    assert.deepEqual(
      parseResetRequest({
        repoId: "repo-alpha",
        confirmation: "RESET REPOSITORY LIFETIME: repo-alpha",
      }),
      {
        repoId: "repo-alpha",
        confirmation: "RESET REPOSITORY LIFETIME: repo-alpha",
      },
    );
    for (const confirmation of [
      "RESET: repo-alpha",
      "reset repository lifetime: repo-alpha",
      "RESET REPOSITORY LIFETIME: repo-beta",
    ]) {
      assert.throws(() => parseResetRequest({ repoId: "repo-alpha", confirmation }));
    }
    assert.throws(() => parseResetRequest({ repoId: "", confirmation: "RESET" }));
    assert.throws(() => parseResetRequest({ repoId: "repo-alpha", confirmation: 1 }));
  });

  it("returns newly allocated values rather than retaining caller objects", () => {
    const parsed = parseDurableLifetimeRoot(durableRootFixture) as DurableLifetimeRoot;
    assert.notEqual(parsed, durableRootFixture);
    assert.notEqual(parsed.repositories, durableRootFixture.repositories);
    assert.notEqual(
      parsed.repositories[REPOSITORY_KEY]?.sections,
      durableRootFixture.repositories[REPOSITORY_KEY]?.sections,
    );
  });
});

function maxCanonicalKey(index: number): string {
  return `${index.toString().padStart(3, "0")}${"x".repeat(61)}`;
}

function maximalMap<T>(count: number, value: T): Record<string, T> {
  return Object.fromEntries([
    [OVERFLOW_KEY, clone(value)],
    ...Array.from({ length: count }, (_, index) => [
      `k:${maxCanonicalKey(index)}`,
      clone(value),
    ]),
  ]);
}

function maximalSections(): DurableLifetimeSections {
  const maximal = clone(
    parseDurableLifetimeRoot(durableRootFixture).repositories[REPOSITORY_KEY]?.sections,
  );
  assert.ok(maximal?.cache);
  assert.ok(maximal.retrieval);
  assert.ok(maximal.indexing);
  assert.ok(maximal.tokenEfficiency);
  assert.ok(maximal.predictiveContext);
  assert.ok(maximal.latency);
  assert.ok(maximal.packed);
  assert.ok(maximal.toolOutput);

  const maximum = Number.MAX_SAFE_INTEGER;
  const maximize = (value: unknown): unknown => {
    if (typeof value === "number") return maximum;
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(maximize);
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, maximize(nested)]));
  };
  const filled = maximize(maximal) as DurableLifetimeSections;
  assert.ok(filled.cache);
  assert.ok(filled.retrieval);
  assert.ok(filled.indexing);
  assert.ok(filled.tokenEfficiency);
  assert.ok(filled.predictiveContext);
  assert.ok(filled.latency);
  assert.ok(filled.packed);
  assert.ok(filled.toolOutput);

  filled.cache.perSource = maximalMap(32, filled.cache.perSource["k:a"]);
  filled.retrieval.byMode = maximalMap(32, maximum);
  filled.retrieval.byType = maximalMap(32, maximum);
  filled.retrieval.candidatesBySource = maximalMap(32, maximum);
  filled.retrieval.phaseLatencyMs = maximalMap(32, filled.retrieval.latencyMs);
  filled.indexing.phaseCounts = maximalMap(32, maximum);
  filled.indexing.languageMs = maximalMap(32, filled.indexing.pass1Ms);
  filled.indexing.engineDispatch = maximalMap(32, maximum);
  filled.tokenEfficiency.compressionBySource = maximalMap(
    32,
    filled.tokenEfficiency.compressionBySource["k:a"],
  );
  filled.predictiveContext.byStrategy = maximalMap(
    32,
    filled.predictiveContext.byStrategy["k:a"],
  );
  filled.latency.perTool = maximalMap(128, filled.latency.perTool["k:a"]);
  filled.packed.axisHits = maximalMap(32, maximum);
  filled.packed.byEncoder = maximalMap(128, filled.packed.byEncoder["k:a"]);
  filled.toolOutput.detailCounts = maximalMap(32, maximum);
  filled.toolOutput.profileCounts = maximalMap(32, maximum);
  const maximalTool = clone(filled.toolOutput.perTool["k:a"]);
  maximalTool.detailCounts = maximalMap(32, maximum);
  maximalTool.profileCounts = maximalMap(32, maximum);
  filled.toolOutput.perTool = maximalMap(128, maximalTool);
  return filled;
}

type UnknownMap = Record<string, unknown>;

const DYNAMIC_BUILD_ORDER = [
  ...DYNAMIC_MAP_LOCATIONS.filter((location) =>
    location !== "toolOutput.perTool"
    && !location.startsWith("toolOutput.perTool.")),
  "toolOutput.perTool.detailCounts",
  "toolOutput.perTool.profileCounts",
  "toolOutput.perTool",
] as const;

function isUnknownMap(value: unknown): value is UnknownMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapContainer(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  location: (typeof DYNAMIC_MAP_LOCATIONS)[number],
): { container: UnknownMap; field: string } {
  const repository = root.repositories[repositoryKey];
  assert.ok(repository);
  const [sectionName, field, nestedField] = location.split(".");
  const sections = repository.sections as unknown as UnknownMap;
  const section = sections[sectionName];
  assert.ok(isUnknownMap(section));
  if (nestedField === undefined) return { container: section, field };

  const perTool = section[field];
  assert.ok(isUnknownMap(perTool));
  const toolKey = Object.keys(perTool).filter((key) => key !== OVERFLOW_KEY).sort()[0];
  assert.ok(toolKey);
  const tool = perTool[toolKey];
  assert.ok(isUnknownMap(tool));
  return { container: tool, field: nestedField };
}

function dynamicMapAt(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  location: (typeof DYNAMIC_MAP_LOCATIONS)[number],
): UnknownMap {
  const { container, field } = mapContainer(root, repositoryKey, location);
  const map = container[field];
  assert.ok(isUnknownMap(map));
  return map;
}

function replaceDynamicMap(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  location: (typeof DYNAMIC_MAP_LOCATIONS)[number],
  map: Readonly<UnknownMap>,
): DurableLifetimeRoot {
  const { container, field } = mapContainer(root, repositoryKey, location);
  container[field] = structuredClone(map);
  return root;
}

function firstMapValue(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  location: (typeof DYNAMIC_MAP_LOCATIONS)[number],
): unknown {
  const map = dynamicMapAt(root, repositoryKey, location);
  const key = Object.keys(map).filter((candidate) => candidate !== OVERFLOW_KEY).sort()[0]
    ?? Object.keys(map)[0];
  assert.ok(key);
  return structuredClone(map[key]);
}

function mergeAdmissionValue(a: unknown, b: unknown) {
  return typeof a === "number" && typeof b === "number"
    ? mergeCounter(a, b)
    : { value: structuredClone(b), saturated: false };
}

function admitAtLocation(
  root: DurableLifetimeRoot,
  repositoryKey: string,
  location: (typeof DYNAMIC_MAP_LOCATIONS)[number],
  rawIdentifier: string,
  incoming: unknown,
) {
  return admitDynamicMapEntry(
    root,
    dynamicMapAt(root, repositoryKey, location),
    rawIdentifier,
    incoming,
    {
      location,
      merge: mergeAdmissionValue,
      replaceMap: (candidateRoot, map) =>
        replaceDynamicMap(candidateRoot, repositoryKey, location, map),
    },
  );
}

function maximalRootFixture(): { root: DurableLifetimeRoot; repositoryKey: string } {
  const timestamp = "9999-12-31T23:59:59.999999999+23:59";
  const repositoryKey = repositoryStorageKey("maximal");
  return {
    repositoryKey,
    root: {
      schemaVersion: 1,
      generation: Number.MAX_SAFE_INTEGER,
      updatedAt: timestamp,
      processPeaks: {
        cpuPct: Number.MAX_SAFE_INTEGER,
        rssMb: Number.MAX_SAFE_INTEGER,
        heapUsedMb: Number.MAX_SAFE_INTEGER,
        heapTotalMb: Number.MAX_SAFE_INTEGER,
        eventLoopLagMs: Number.MAX_SAFE_INTEGER,
      },
      repositories: {
        [repositoryKey]: {
          epoch: Number.MAX_SAFE_INTEGER,
          resetAt: timestamp,
          lastCheckpointAt: timestamp,
          sessionCount: Number.MAX_SAFE_INTEGER,
          saturated: false,
          sections: maximalSections(),
        },
      },
    },
  };
}

function buildDynamicRoot(realKeyOffset: number, includeOverflow: boolean) {
  const fixture = maximalRootFixture();
  let root = fixture.root;
  for (const location of DYNAMIC_BUILD_ORDER) {
    const template = firstMapValue(root, fixture.repositoryKey, location);
    root = replaceDynamicMap(structuredClone(root), fixture.repositoryKey, location, {});
    const count = dynamicMapLimit(location) - realKeyOffset;
    for (let index = 0; index < count; index += 1) {
      const admission = admitAtLocation(
        root,
        fixture.repositoryKey,
        location,
        maxCanonicalKey(index),
        template,
      );
      assert.equal(admission.status, "admitted");
      root = admission.root;
    }
    if (includeOverflow) {
      const overflow = admitAtLocation(root, fixture.repositoryKey, location, "invalid key", template);
      assert.equal(overflow.status, "overflow");
      root = overflow.root;
    }
  }
  return { root, repositoryKey: fixture.repositoryKey };
}

function emptyDynamicMaps(repository: DurableLifetimeRepository): DurableLifetimeRepository {
  const emptied = structuredClone(repository);
  assert.ok(emptied.sections.cache);
  assert.ok(emptied.sections.retrieval);
  assert.ok(emptied.sections.indexing);
  assert.ok(emptied.sections.tokenEfficiency);
  assert.ok(emptied.sections.predictiveContext);
  assert.ok(emptied.sections.latency);
  assert.ok(emptied.sections.packed);
  assert.ok(emptied.sections.toolOutput);
  emptied.sections.cache.perSource = {};
  emptied.sections.retrieval.byMode = {};
  emptied.sections.retrieval.byType = {};
  emptied.sections.retrieval.candidatesBySource = {};
  emptied.sections.retrieval.phaseLatencyMs = {};
  emptied.sections.indexing.phaseCounts = {};
  emptied.sections.indexing.languageMs = {};
  emptied.sections.indexing.engineDispatch = {};
  emptied.sections.tokenEfficiency.compressionBySource = {};
  emptied.sections.predictiveContext.byStrategy = {};
  emptied.sections.latency.perTool = {};
  emptied.sections.packed.axisHits = {};
  emptied.sections.packed.byEncoder = {};
  emptied.sections.toolOutput.detailCounts = {};
  emptied.sections.toolOutput.profileCounts = {};
  emptied.sections.toolOutput.perTool = {};
  return emptied;
}

const nearLimitRoots = new Map<string, ReturnType<typeof buildDynamicRoot>>();

function nearLimitDynamicRoot(
  emptyTargetLocation?: (typeof DYNAMIC_MAP_LOCATIONS)[number],
) {
  const cacheKey = emptyTargetLocation ?? "reserved-overflows";
  const cached = nearLimitRoots.get(cacheKey);
  if (cached !== undefined) return cached;
  const target = buildDynamicRoot(1, false);
  if (emptyTargetLocation !== undefined) {
    target.root = replaceDynamicMap(
      structuredClone(target.root),
      target.repositoryKey,
      emptyTargetLocation,
      {},
    );
  }
  const maximal = buildDynamicRoot(0, true);
  const maximalRepository = maximal.root.repositories[maximal.repositoryKey];
  assert.ok(maximalRepository);

  const paddingRepoId = "padding";
  const paddingKey = repositoryStorageKey(paddingRepoId);
  const padding = admitRepository(
    target.root,
    paddingRepoId,
    emptyDynamicMaps(maximalRepository),
  );
  assert.equal(padding.admitted, true);
  let root = padding.root;

  for (let index = 0; index < MAX_REPOSITORIES - 2; index += 1) {
    const admission = admitRepository(root, `full-padding-${index}`, maximalRepository);
    if (!admission.admitted) break;
    root = admission.root;
  }

  const paddingOrder = [
    "toolOutput.perTool",
    "latency.perTool",
    "packed.byEncoder",
    "cache.perSource",
    "tokenEfficiency.compressionBySource",
    "predictiveContext.byStrategy",
    "retrieval.phaseLatencyMs",
    "indexing.languageMs",
  ] as const;
  for (const location of paddingOrder) {
    const template = firstMapValue(maximal.root, maximal.repositoryKey, location);
    for (let index = 0; index < dynamicMapLimit(location); index += 1) {
      const admission = admitAtLocation(root, paddingKey, location, maxCanonicalKey(index), template);
      if (admission.status === "capacityRejected") break;
      root = admission.root;
    }
  }

  const counterLocations = [
    "retrieval.byMode",
    "retrieval.byType",
    "retrieval.candidatesBySource",
    "indexing.phaseCounts",
    "indexing.engineDispatch",
    "packed.axisHits",
    "toolOutput.detailCounts",
    "toolOutput.profileCounts",
  ] as const;
  for (const location of counterLocations) {
    for (let index = 0; index < dynamicMapLimit(location); index += 1) {
      const admission = admitAtLocation(root, paddingKey, location, maxCanonicalKey(index), 1);
      if (admission.status === "capacityRejected") break;
      root = admission.root;
    }
    const overflow = admitAtLocation(root, paddingKey, location, "invalid key", 1);
    if (overflow.status === "capacityRejected") {
      const result = { ...target, root };
      nearLimitRoots.set(cacheKey, result);
      return result;
    }
    root = overflow.root;
  }
  throw new Error("Unable to construct a root close enough to the lifetime byte limit");
}

describe("bounded lifetime accumulator", () => {
  it("adds counters and samples without averaging averages", () => {
    assert.equal(saturatingAdd(4, 7), 11);
    assert.deepEqual(mergeCounter(4, 7), { value: 11, saturated: false });
    const left = { count: 2, sum: 20, max: 15 };
    const right = { count: 8, sum: 24, max: 6 };
    assert.deepEqual(mergeSample(left, right), { count: 10, sum: 44, max: 15 });
    assert.equal(mergeSample(left, right).sum / mergeSample(left, right).count, 4.4);
  });

  it("clamps safe-integer additions and reports sample saturation", () => {
    assert.deepEqual(saturatingAddWithSaturation(Number.MAX_SAFE_INTEGER, 1), {
      value: Number.MAX_SAFE_INTEGER,
      saturated: true,
    });
    assert.deepEqual(
      mergeSampleWithSaturation(
        { count: Number.MAX_SAFE_INTEGER, sum: Number.MAX_SAFE_INTEGER - 1, max: 8 },
        { count: 1, sum: 2, max: 9 },
      ),
      {
        value: {
          count: Number.MAX_SAFE_INTEGER,
          sum: Number.MAX_SAFE_INTEGER,
          max: 9,
        },
        saturated: true,
      },
    );
  });

  it("fails closed on invalid counter and sample operands", () => {
    for (const invalidCounter of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => saturatingAdd(invalidCounter, 1));
      assert.throws(() => mergeCounter(invalidCounter, 1));
      assert.throws(() => mergeSample(
        { count: invalidCounter, sum: 1, max: 1 },
        { count: 1, sum: 1, max: 1 },
      ));
    }
    for (const invalidTotal of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => mergeSample(
        { count: 1, sum: invalidTotal, max: 1 },
        { count: 1, sum: 1, max: 1 },
      ));
      assert.throws(() => mergeSample(
        { count: 1, sum: 1, max: invalidTotal },
        { count: 1, sum: 1, max: 1 },
      ));
    }
    assert.deepEqual(
      mergeSample({ count: 1, sum: 0.5, max: 0.5 }, { count: 1, sum: 0.25, max: 1.25 }),
      { count: 2, sum: 0.75, max: 1.25 },
    );
  });

  it("merges repository sections exactly without mutating either input", () => {
    const baseline = parseDurableLifetimeRoot(durableRootFixture).repositories[REPOSITORY_KEY];
    assert.ok(baseline?.sections.cache);
    const epoch = clone(baseline);
    epoch.epoch = 3;
    epoch.sessionCount = 1;
    epoch.sections.cache.hits = 4;
    epoch.sections.cache.lookupMs = { count: 2, sum: 8, max: 7 };
    const baselineBefore = clone(baseline);
    const epochBefore = clone(epoch);

    const merged = lifetimeView(baseline, epoch);

    assert.equal(merged.epoch, 3);
    assert.equal(merged.sessionCount, 4);
    assert.equal(merged.sections.cache?.hits, 5);
    assert.deepEqual(merged.sections.cache?.lookupMs, { count: 3, sum: 10, max: 7 });
    assert.deepEqual(baseline, baselineBefore);
    assert.deepEqual(epoch, epochBefore);
    assert.notEqual(merged.sections, baseline.sections);
  });

  it("propagates saturation to the repository entry", () => {
    const baseline = emptyRepositoryLifetime();
    const epoch = emptyRepositoryLifetime();
    baseline.sessionCount = Number.MAX_SAFE_INTEGER;
    epoch.sessionCount = 1;
    assert.deepEqual(mergeRepositoryLifetime(baseline, epoch), {
      ...baseline,
      saturated: true,
    });

    const sectionBaseline = parseDurableLifetimeRoot(durableRootFixture)
      .repositories[REPOSITORY_KEY];
    assert.ok(sectionBaseline?.sections.cache);
    const sectionEpoch = clone(sectionBaseline);
    sectionBaseline.sections.cache.hits = Number.MAX_SAFE_INTEGER;
    sectionEpoch.sections.cache.hits = 1;
    const sectionMerged = mergeRepositoryLifetime(sectionBaseline, sectionEpoch);
    assert.equal(sectionMerged.sections.cache?.hits, Number.MAX_SAFE_INTEGER);
    assert.equal(sectionMerged.saturated, true);
  });

  it("validates repository metadata and every populated section before merging", () => {
    const valid = parseDurableLifetimeRoot(durableRootFixture).repositories[REPOSITORY_KEY];
    assert.ok(valid?.sections.cache);
    assert.ok(valid.sections.retrieval);
    for (const invalid of [Number.POSITIVE_INFINITY, 0.5, -1]) {
      const invalidEpoch = clone(valid);
      invalidEpoch.epoch = invalid;
      assert.throws(() => mergeRepositoryLifetime(emptyRepositoryLifetime(), invalidEpoch));

      const invalidSession = clone(valid);
      invalidSession.sessionCount = invalid;
      assert.throws(() => mergeRepositoryLifetime(invalidSession, emptyRepositoryLifetime()));
    }

    const invalidTimestamp = clone(valid);
    invalidTimestamp.lastCheckpointAt = "not-a-timestamp";
    assert.throws(() => mergeRepositoryLifetime(emptyRepositoryLifetime(), invalidTimestamp));

    const invalidBoolean = clone(valid);
    invalidBoolean.saturated = "yes";
    assert.throws(() => mergeRepositoryLifetime(invalidBoolean, emptyRepositoryLifetime()));

    const invalidNullSidedSection = clone(valid);
    assert.ok(invalidNullSidedSection.sections.cache);
    invalidNullSidedSection.sections.cache.hits = Number.POSITIVE_INFINITY;
    assert.throws(() => mergeRepositoryLifetime(
      emptyRepositoryLifetime(),
      invalidNullSidedSection,
    ));

    const invalidNestedCounter = clone(valid);
    assert.ok(invalidNestedCounter.sections.retrieval);
    invalidNestedCounter.sections.retrieval.byMode["k:a"] = 0.5;
    assert.throws(() => mergeRepositoryLifetime(valid, invalidNestedCounter));

    const invalidNestedSample = clone(valid);
    assert.ok(invalidNestedSample.sections.cache);
    invalidNestedSample.sections.cache.lookupMs.count = -1;
    assert.throws(() => mergeRepositoryLifetime(invalidNestedSample, valid));
  });

  it("accepts only canonical raw identifiers and never persists invalid raw keys", () => {
    for (const valid of ["a", "A-Z_9", "tool.name:v1", "x".repeat(64)]) {
      assert.equal(canonicalDynamicKey(valid), `k:${valid}`);
    }
    for (const invalid of ["", "has space", "slash/name", "x".repeat(65), OVERFLOW_KEY]) {
      assert.equal(canonicalDynamicKey(invalid), OVERFLOW_KEY);
      const root = replaceDynamicMap(
        parseDurableLifetimeRoot(durableRootFixture),
        REPOSITORY_KEY,
        "retrieval.byMode",
        {},
      );
      const result = admitAtLocation(root, REPOSITORY_KEY, "retrieval.byMode", invalid, 1);
      assert.deepEqual(Object.keys(result.map), [OVERFLOW_KEY]);
      assert.equal(result.status, "overflow");
      assert.ok(result.reservedBytes <= MAX_STORE_BYTES);
      if (invalid !== OVERFLOW_KEY) assert.equal(Object.hasOwn(result.map, invalid), false);
    }
  });

  it("applies every dynamic-map cap and routes the next key to overflow", () => {
    for (const location of DYNAMIC_MAP_LOCATIONS) {
      const limit = dynamicMapLimit(location);
      assert.equal(limit, location.endsWith("perTool") || location === "packed.byEncoder" ? 128 : 32);
      let root = parseDurableLifetimeRoot(durableRootFixture);
      const template = firstMapValue(root, REPOSITORY_KEY, location);
      root = replaceDynamicMap(structuredClone(root), REPOSITORY_KEY, location, {});
      for (let index = limit - 1; index >= 0; index -= 1) {
        const admission = admitAtLocation(
          root,
          REPOSITORY_KEY,
          location,
          `key${index.toString().padStart(3, "0")}`,
          template,
        );
        assert.equal(admission.status, "admitted");
        root = admission.root;
      }
      const map = dynamicMapAt(root, REPOSITORY_KEY, location);
      assert.equal(Object.keys(map).length, limit);
      const overflowed = admitAtLocation(root, REPOSITORY_KEY, location, "beyond-cap", template);
      assert.equal(overflowed.admitted, false);
      assert.equal(overflowed.storageKey, OVERFLOW_KEY);
      assert.equal(overflowed.status, "overflow");
      assert.ok(overflowed.reservedBytes <= MAX_STORE_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(overflowed.root)) <= MAX_STORE_BYTES);
      assert.deepEqual(overflowed.map[OVERFLOW_KEY], template);
      assert.deepEqual(Object.keys(overflowed.map), [...Object.keys(overflowed.map)].sort());
    }
  });

  it("merges and normalizes dynamic maps lexically", () => {
    const left = { "k:z": 1, "k:a": 2 };
    const right = { __other__: 4, "k:a": 3 };
    const merged = mergeDynamicMaps(left, right, {
      location: "retrieval.byMode",
      merge: mergeCounter,
    });
    assert.deepEqual(merged, {
      value: { __other__: 4, "k:a": 5, "k:z": 1 },
      saturated: false,
    });
    assert.deepEqual(normalizeDynamicMap(left), { "k:a": 2, "k:z": 1 });
    assert.deepEqual(left, { "k:z": 1, "k:a": 2 });
    assert.deepEqual(right, { __other__: 4, "k:a": 3 });
  });

  it("keeps 128 perTool and byEncoder keys before overflowing key 129", () => {
    for (const location of ["latency.perTool", "toolOutput.perTool", "packed.byEncoder"] as const) {
      let root = parseDurableLifetimeRoot(durableRootFixture);
      const template = firstMapValue(root, REPOSITORY_KEY, location);
      root = replaceDynamicMap(structuredClone(root), REPOSITORY_KEY, location, {});
      for (let index = 0; index < 128; index += 1) {
        const admission = admitAtLocation(
          root,
          REPOSITORY_KEY,
          location,
          `key${index.toString().padStart(3, "0")}`,
          template,
        );
        assert.equal(admission.status, "admitted");
        root = admission.root;
      }
      const map = dynamicMapAt(root, REPOSITORY_KEY, location);
      assert.equal(Object.keys(map).filter((key) => key !== OVERFLOW_KEY).length, 128);
      const next = admitAtLocation(root, REPOSITORY_KEY, location, "key128", template);
      assert.equal(next.storageKey, OVERFLOW_KEY);
      assert.equal(next.status, "overflow");
      assert.equal(Object.keys(next.map).length, 129);
    }
  });

  it("requires root-backed reservation when creating the first overflow slot", () => {
    const root = parseDurableLifetimeRoot(durableRootFixture);
    const withoutOverflow = replaceDynamicMap(
      structuredClone(root),
      REPOSITORY_KEY,
      "retrieval.byMode",
      {},
    );
    const result = admitAtLocation(withoutOverflow, REPOSITORY_KEY, "retrieval.byMode", "bad key", 4);
    assert.equal(result.status, "overflow");
    assert.deepEqual(result.map, { [OVERFLOW_KEY]: 4 });
    assert.notEqual(result.root, withoutOverflow);
    assert.deepEqual(dynamicMapAt(withoutOverflow, REPOSITORY_KEY, "retrieval.byMode"), {});
    assert.ok(result.reservedBytes <= MAX_STORE_BYTES);
  });

  it("reserves the largest valid value shape for an absent overflow slot", () => {
    const root = parseDurableLifetimeRoot(durableRootFixture);
    const repository = root.repositories[REPOSITORY_KEY];
    assert.ok(repository?.sections.toolOutput);
    const large = clone(repository.sections.toolOutput.perTool["k:z"]);
    assert.ok(large);
    large.detailCounts = maximalMap(32, Number.MAX_SAFE_INTEGER);
    large.profileCounts = maximalMap(32, Number.MAX_SAFE_INTEGER);
    repository.sections.toolOutput.perTool["k:z"] = large;
    delete repository.sections.toolOutput.perTool.__other__;

    const materialized = clone(root);
    const materializedRepository = materialized.repositories[REPOSITORY_KEY];
    assert.ok(materializedRepository?.sections.toolOutput);
    materializedRepository.sections.toolOutput.perTool.__other__ = clone(large);
    assert.equal(reservedSerializedBytes(root), reservedSerializedBytes(materialized));
  });

  it("admits 32 repositories and rejects repository 33 without mutation", () => {
    let root: DurableLifetimeRoot = {
      schemaVersion: 1,
      generation: 0,
      updatedAt: ISO,
      processPeaks: null,
      repositories: {},
    };
    for (let index = 0; index < 32; index += 1) {
      const admission = admitRepository(root, `repo-${index}`, emptyRepositoryLifetime());
      assert.equal(admission.admitted, true);
      root = admission.root;
    }
    const before = clone(root);
    const rejected = admitRepository(root, "repo-32", emptyRepositoryLifetime());
    assert.equal(rejected.admitted, false);
    assert.equal(rejected.reason, "repositoryLimit");
    assert.equal(rejected.root, root);
    assert.deepEqual(root, before);
    assert.equal(Object.keys(root.repositories).length, MAX_REPOSITORIES);
  });

  it("rejects invalid new repositories before changing the store root", () => {
    const root: DurableLifetimeRoot = {
      schemaVersion: 1,
      generation: 0,
      updatedAt: ISO,
      processPeaks: null,
      repositories: {},
    };
    const invalidEpoch = emptyRepositoryLifetime();
    invalidEpoch.epoch = Number.POSITIVE_INFINITY;
    assert.throws(() => admitRepository(root, "invalid-epoch", invalidEpoch));
    assert.deepEqual(root.repositories, {});

    const invalidNested = clone(
      parseDurableLifetimeRoot(durableRootFixture).repositories[REPOSITORY_KEY],
    );
    assert.ok(invalidNested?.sections.retrieval);
    invalidNested.sections.retrieval.byMode["k:a"] = -1;
    assert.throws(() => admitRepository(root, "invalid-nested", invalidNested));
    assert.deepEqual(root.repositories, {});
  });

  it("resets one repository epoch and counts a writer session once", () => {
    const original = emptyRepositoryLifetime();
    const counted = incrementSessionCount(original);
    const countedAgain = incrementSessionCount(counted.value, true);
    assert.equal(counted.value.sessionCount, 1);
    assert.equal(countedAgain.value.sessionCount, 1);
    const reset = resetRepositoryLifetime(counted.value, ISO);
    assert.equal(reset.epoch, 1);
    assert.equal(reset.resetAt, ISO);
    assert.equal(reset.lastCheckpointAt, ISO);
    assert.equal(reset.sessionCount, 0);
    assert.deepEqual(reset.sections, emptySections);
    assert.deepEqual(original, emptyRepositoryLifetime());
  });

  it("merges process peaks by maxima", () => {
    assert.deepEqual(
      mergeProcessPeaks(
        { cpuPct: 10, rssMb: 100, heapUsedMb: 30, heapTotalMb: 50, eventLoopLagMs: 4 },
        { cpuPct: 8, rssMb: 120, heapUsedMb: 20, heapTotalMb: 70, eventLoopLagMs: 2 },
      ),
      { cpuPct: 10, rssMb: 120, heapUsedMb: 30, heapTotalMb: 70, eventLoopLagMs: 4 },
    );
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(() => mergeProcessPeaks(
        { cpuPct: invalid, rssMb: 1, heapUsedMb: 1, heapTotalMb: 1, eventLoopLagMs: 1 },
        null,
      ));
      assert.throws(() => mergeProcessPeaks(
        null,
        { cpuPct: 1, rssMb: 1, heapUsedMb: 1, heapTotalMb: invalid, eventLoopLagMs: 1 },
      ));
    }
  });

  it("builds every maximal dynamic map through root-backed admissions below 2 MiB", () => {
    const { root } = buildDynamicRoot(0, true);
    const normalized = parseDurableLifetimeRoot(root);
    const actualBytes = Buffer.byteLength(JSON.stringify(normalized));
    const reservedBytes = reservedSerializedBytes(normalized);
    assert.ok(reservedBytes >= actualBytes);
    assert.ok(reservedBytes < MAX_STORE_BYTES, `${reservedBytes} reserved bytes`);
    assert.ok(actualBytes < MAX_STORE_BYTES, `${actualBytes} actual bytes`);
    assert.equal(JSON.stringify(normalized).includes("p50"), false);
    assert.equal(JSON.stringify(normalized).includes("percentile"), false);

    const repository = Object.values(normalized.repositories)[0];
    assert.ok(repository);
    let admittedRoot = normalized;
    let rejection: ReturnType<typeof admitRepository> | undefined;
    for (let index = 1; index < MAX_REPOSITORIES; index += 1) {
      const admission = admitRepository(admittedRoot, `maximal-${index}`, repository);
      if (!admission.admitted) {
        rejection = admission;
        break;
      }
      admittedRoot = admission.root;
    }
    assert.ok(rejection);
    assert.equal(rejection.reason, "storeBytes");
    assert.equal(rejection.root, admittedRoot);
  });

  it("routes every byte-rejected real key into its pre-reserved overflow", () => {
    const nearLimit = nearLimitDynamicRoot();
    const reservedBytes = reservedSerializedBytes(nearLimit.root);
    const actualBytes = Buffer.byteLength(JSON.stringify(nearLimit.root));
    assert.ok(reservedBytes <= MAX_STORE_BYTES);
    assert.ok(actualBytes <= MAX_STORE_BYTES);

    for (const location of DYNAMIC_MAP_LOCATIONS) {
      const beforeMap = structuredClone(
        dynamicMapAt(nearLimit.root, nearLimit.repositoryKey, location),
      );
      const template = firstMapValue(nearLimit.root, nearLimit.repositoryKey, location);
      const real = admitAtLocation(
        nearLimit.root,
        nearLimit.repositoryKey,
        location,
        maxCanonicalKey(dynamicMapLimit(location) - 1),
        template,
      );
      assert.equal(real.status, "overflow", `${location} real key`);
      assert.equal(real.reason, null);
      assert.notEqual(real.root, nearLimit.root);
      assert.equal(Object.hasOwn(real.map, `k:${maxCanonicalKey(dynamicMapLimit(location) - 1)}`), false);
      assert.ok(Object.hasOwn(real.map, OVERFLOW_KEY));
      assert.equal(Object.hasOwn(beforeMap, OVERFLOW_KEY), false);
      assert.ok(real.reservedBytes <= MAX_STORE_BYTES);
      assert.ok(Buffer.byteLength(JSON.stringify(real.root)) <= MAX_STORE_BYTES);
    }
  });

  it("merges an existing overflow without new-key admission", () => {
    const nearLimit = nearLimitDynamicRoot();
    const location = "retrieval.byMode" as const;
    const first = admitAtLocation(
      nearLimit.root,
      nearLimit.repositoryKey,
      location,
      maxCanonicalKey(dynamicMapLimit(location) - 1),
      1,
    );
    assert.equal(first.status, "overflow");
    const second = admitAtLocation(
      first.root,
      nearLimit.repositoryKey,
      location,
      "another rejected key",
      1,
    );
    assert.equal(second.status, "overflow");
    assert.equal(second.reason, null);
    assert.equal(second.map[OVERFLOW_KEY], 2);
  });

  it("rejects the first overflow only when its placeholder cannot fit", () => {
    const location = "retrieval.byMode" as const;
    const nearLimit = nearLimitDynamicRoot(location);
    const beforeMap = structuredClone(
      dynamicMapAt(nearLimit.root, nearLimit.repositoryKey, location),
    );
    assert.deepEqual(beforeMap, {});
    const rejected = admitAtLocation(
      nearLimit.root,
      nearLimit.repositoryKey,
      location,
      "invalid key",
      1,
    );
    assert.equal(rejected.status, "capacityRejected");
    assert.equal(rejected.reason, "storeBytes");
    assert.equal(rejected.root, nearLimit.root);
    assert.deepEqual(rejected.map, beforeMap);
    assert.deepEqual(dynamicMapAt(nearLimit.root, nearLimit.repositoryKey, location), beforeMap);
  });
});
