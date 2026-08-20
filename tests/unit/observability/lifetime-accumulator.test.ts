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
  parseDurableLifetimeRoot,
  parseLifetimeEnvelope,
  parseResetRequest,
  repositoryStorageKey,
  type DurableLifetimeRoot,
  type LifetimeRouteErrorV1,
  type LifetimeResetSuccessV1,
} from "../../../dist/observability/lifetime-types.js";

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
    assert.throws(() => parseResetRequest({
      repoId: "r".repeat(129),
      confirmation: "RESET",
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
    for (const invalidKey of ["plain", "k:", `k:${"a".repeat(65)}`, "k:has space"] ) {
      const invalid = clone(durableRootFixture);
      const repository = invalid.repositories[REPOSITORY_KEY];
      assert.ok(repository?.sections.retrieval);
      repository.sections.retrieval.byMode = { [invalidKey]: 1 };
      assert.throws(() => parseDurableLifetimeRoot(invalid));
    }
  });

  it("hashes UTF-8 repository identifiers and parses reset shape without equality logic", () => {
    assert.equal(repositoryStorageKey("repo-alpha"), REPOSITORY_KEY);
    assert.throws(() => repositoryStorageKey(""));
    assert.deepEqual(
      parseResetRequest({ repoId: "repo-alpha", confirmation: "not-yet-checked" }),
      { repoId: "repo-alpha", confirmation: "not-yet-checked" },
    );
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
