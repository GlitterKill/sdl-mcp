import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

import {
  METRIC_DISPOSITIONS,
  SCOPE_LABELS,
  TIMESERIES_PANEL_MAP,
  lifetimePresentation,
  sessionPanelState,
  stableArrayRows,
  stableRecordRows,
} from "../../../dist/ui/observability-dashboard-model.js";
import {
  Aggregator,
  DEFAULT_AGGREGATOR_OPTIONS,
} from "../../../dist/observability/aggregator.js";
import { SECTION_IDS } from "../../../dist/observability/lifetime-types.js";

const TYPES_PATH = "src/observability/types.ts";
const GENERATED_AT = "2026-08-20T12:01:00.000Z";
const LAST_EVENT_AT = "2026-08-20T12:00:00.000Z";

function snapshotTypeLeaves(): string[] {
  const program = ts.createProgram([TYPES_PATH], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    target: ts.ScriptTarget.ES2024,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(TYPES_PATH);
  assert.ok(source);
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "ObservabilitySnapshot",
  );
  assert.ok(declaration);
  const symbol = checker.getSymbolAtLocation(declaration.name);
  assert.ok(symbol);

  const leaves: string[] = [];
  const primitiveFlags =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;

  function visit(rawType: ts.Type, path: string): void {
    const type = checker.getNonNullableType(rawType);
    if (
      (type.flags & primitiveFlags) !== 0 ||
      (type.isUnion() && type.types.every((member) => (member.flags & primitiveFlags) !== 0))
    ) {
      leaves.push(path);
      return;
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const element = checker.getTypeArguments(type as ts.TypeReference)[0];
      assert.ok(element, `Missing array element type for ${path}`);
      visit(element, `${path}[]`);
      return;
    }
    const stringValue = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const properties = checker.getPropertiesOfType(type);
    if (stringValue && properties.length === 0) {
      visit(stringValue, `${path}[]`);
      return;
    }
    assert.ok(properties.length > 0, `Unsupported snapshot type at ${path}`);
    for (const property of properties) {
      const location = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
      visit(checker.getTypeOfSymbolAtLocation(property, location), `${path}.${property.name}`);
    }
  }

  for (const property of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
    const location = property.valueDeclaration ?? property.declarations?.[0] ?? declaration;
    visit(checker.getTypeOfSymbolAtLocation(property, location), property.name);
  }
  return leaves;
}

const DYNAMIC_RECORD_PATHS = new Set([
  "cache.perSource",
  "retrieval.byMode",
  "retrieval.candidateCountPerSource",
  "retrieval.phaseLatencyMs",
  "retrieval.byRetrievalType",
  "indexing.phaseCounts",
  "indexing.perLanguageAvgMs",
  "tokenEfficiency.compressionLayers.bySource",
  "tokenEfficiency.compressionLayers.byTool",
  "latency.perTool",
  "latency.perTool[].phases",
  "packed.perEncoder",
  "packed.byEncoder",
  "toolVolume.perTool",
  "toolVolume.perToolErrors",
  "toolOutput.overall.profileCounts",
  "toolOutput.perTool[].profileCounts",
]);

function runtimeSnapshot(): ReturnType<Aggregator["getSnapshot"]> {
  const aggregator = new Aggregator(DEFAULT_AGGREGATOR_OPTIONS);
  aggregator.recordCacheOutcome({ source: "cache-source", hit: true, latencyMs: 1 });
  aggregator.recordToolCall({
    tool: "sdl.test",
    request: {},
    response: {},
    durationMs: 2,
    diagnostics: { timings: { totalMs: 2, phases: { dispatch: 1 } } },
    tokensUsed: 8,
    tokensSaved: 3,
    projection: {
      profile: {
        projector: "test",
        observabilityProfile: "standard",
        defaultDetail: "compact",
        budgetClass: "small",
        largeResponseStrategy: "truncate",
        recoveryPolicy: "none",
      },
      effectiveDetail: "compact",
      diagnosticsIncluded: false,
      rawBytes: 20,
      rawTokens: 5,
      projectedBytes: 12,
      projectedTokens: 3,
      removedFieldCount: 1,
      truncated: true,
      responseHandled: true,
      recoveryEmitted: true,
      invalidRecoveryCount: 1,
    },
  });
  aggregator.recordToolCall({
    tool: "sdl.test",
    request: {},
    response: {},
    durationMs: 1,
    projection: {
      profile: {
        projector: "test",
        observabilityProfile: "standard",
        defaultDetail: "summary",
        budgetClass: "summary",
        largeResponseStrategy: "truncate",
        recoveryPolicy: "none",
      },
      effectiveDetail: "summary",
      diagnosticsIncluded: false,
      rawBytes: 1,
      rawTokens: 1,
      projectedBytes: 1,
      projectedTokens: 1,
      removedFieldCount: 0,
      truncated: false,
      responseHandled: true,
      recoveryEmitted: false,
      invalidRecoveryCount: 0,
    },
  });
  aggregator.recordTokenSavingsEvent({
    source: "responseArtifact",
    tool: "sdl.test",
    estimatedTokensAvoided: 2,
    originalTokens: 5,
    returnedTokens: 3,
    savedTokens: 2,
    storedBytes: 10,
    opportunity: true,
    hit: true,
  });
  aggregator.recordSemanticSearch({
    repoId: "repo-a" as never,
    semanticEnabled: true,
    latencyMs: 3,
    candidateCount: 4,
    alpha: 0.5,
    retrievalMode: "hybrid",
    retrievalType: "hybrid",
    candidateCountPerSource: { fts: 4 },
    phaseLatencyMs: { fusion: 1 },
    finalResultCount: 1,
  });
  aggregator.recordIndexEvent({
    repoId: "repo-a",
    kind: "full",
    filesIndexed: 1,
    durationMs: 4,
    language: "typescript",
    engine: "ts",
    stats: { edgesExtracted: 1, errors: 0 },
  } as never);
  aggregator.recordIndexPhase({ phase: "pass1", durationMs: 2, language: "typescript" });
  aggregator.recordPrefetch({
    repoId: "repo-a" as never,
    hitRate: 0.5,
    wasteRate: 0.25,
    avgLatencyReductionMs: 2,
    queueDepth: 1,
    policyMode: "observe",
    outcomeSamples: 1,
    suppressedPrefetch: 1,
    acceptedPrefetch: 1,
    topStrategies: [{
      strategy: "imports",
      resourceKind: "symbol",
      samples: 1,
      hitRate: 0.5,
      acceptedRate: 0.5,
      wasteRate: 0.25,
      score: 1,
      suppressed: 1,
    }],
  });
  aggregator.recordWatcherHealth({
    repoId: "repo-a" as never,
    enabled: true,
    running: true,
    provider: "watchman",
    configuredProvider: "auto",
    fallbackReason: "test",
    stale: false,
    errors: 1,
    queueDepth: 1,
    eventsReceived: 1,
    eventsProcessed: 1,
    restartCount: 1,
    watchmanVersion: "1",
    watchmanWarningCount: 1,
    watchmanWarnings: ["warning"],
    watchmanRecrawlCount: 1,
    watchmanFreshInstanceCount: 1,
    watchmanWatchRoot: "/repo",
    watchmanRelativePath: "src",
    watchmanLastClock: "c:1",
  });
  aggregator.recordPprResult({ backend: "native", computeMs: 2, touched: 3, seedCount: 1 });
  aggregator.recordPackedWire({
    decision: "packed",
    encoderId: "encoder",
    axisHit: "bytes",
    jsonBytes: 20,
    packedBytes: 10,
    jsonTokens: 5,
    packedTokens: 3,
  });
  aggregator.recordScipIngest({ edgesCreated: 1, edgesUpgraded: 1, durationMs: 2, failed: false });
  aggregator.recordResourceSample({
    cpuPct: 100,
    rssMb: 100,
    heapUsedMb: 40,
    heapTotalMb: 80,
    eventLoopLagMs: 3,
  });
  aggregator.recordPoolSample({ writeQueued: 1, writeActive: 1, drainQueueDepth: 1, drainFailures: 1 });
  aggregator.recordDispatchSample({ active: 1, queued: 1, maxConcurrency: 2 });
  aggregator.recordHealth(90, { freshness: 1, coverage: 1, errorRate: 1, edgeQuality: 1, callResolution: 1 });
  aggregator.recordBeamBuild({ durationMs: 2, accepted: 1, evicted: 1, rejected: 1, maxFrontierSize: 2 });
  aggregator.setBeamRetainedHandles(1);
  aggregator.recordDeltaBlastRadius({
    changedSymbolCount: 1,
    blastRadiusCount: 1,
    durationMs: 2,
    dbRoundTrips: 1,
    fallbackPathQueryCount: 1,
    pathExplanationLatencyMs: 1,
  });
  aggregator.recordAuditBufferSample({ depth: 1, droppedTotal: 1, sessionActive: true });
  aggregator.recordPostIndexSession({ durationMs: 2, timedOut: false, endedAt: GENERATED_AT });
  return aggregator.getSnapshot("repo-a");
}

function runtimeLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  function visit(current: unknown, path: string): void {
    if (Array.isArray(current)) {
      assert.ok(current.length > 0, `Runtime array fixture is empty at ${path}`);
      for (const item of current) visit(item, `${path}[]`);
      return;
    }
    if (current !== null && typeof current === "object") {
      const entries = Object.entries(current);
      if (DYNAMIC_RECORD_PATHS.has(path)) {
        assert.ok(entries.length > 0, `Runtime record fixture is empty at ${path}`);
        for (const [, item] of entries) visit(item, `${path}[]`);
        return;
      }
      for (const [key, item] of entries) visit(item, path ? `${path}.${key}` : key);
      return;
    }
    leaves.push(path);
  }
  visit(value, "");
  return [...new Set(leaves)];
}

function readyEnvelope(persistenceState = "ready") {
  return {
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: GENERATED_AT,
    repoId: "repo-a",
    epoch: 1,
    resetAt: null,
    lastCheckpointAt: "2026-08-20T12:00:30.000Z",
    persistenceState,
    sessionCount: 2,
    saturated: false,
    sections: { cache: { hits: 3 } },
    freshness: { cache: LAST_EVENT_AT },
    processPeaks: { cpuPct: 50 },
  };
}

test("disposition map covers the compiler and runtime snapshot contracts", () => {
  const sourceLeaves = snapshotTypeLeaves();
  const orderedRuntimeLeaves = runtimeLeaves(runtimeSnapshot());
  const dispositionLeaves = Object.keys(METRIC_DISPOSITIONS);

  assert.deepEqual(new Set(orderedRuntimeLeaves), new Set(sourceLeaves));
  assert.deepEqual(new Set(dispositionLeaves), new Set(sourceLeaves));
  for (const entry of Object.values(METRIC_DISPOSITIONS)) {
    assert.deepEqual(Object.keys(entry), ["disposition", "panel"]);
    assert.ok(["rendered", "derived", "sessionOnly"].includes(entry.disposition));
    assert.match(entry.panel, /^[a-z][A-Za-z0-9]*$/);
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(METRIC_DISPOSITIONS));
  assert.equal(sourceLeaves.length, 273);
});

test("timeseries destinations and row builders have stable immutable order", () => {
  assert.deepEqual(Object.keys(TIMESERIES_PANEL_MAP), [
    "cacheHitRate", "p95LatencyMs", "queueDepth", "drainQueueDepth",
    "filesPerMinute", "errorRate", "tokensUsedPerMin", "tokensSavedPerMin",
    "toolOutputRawBytes", "toolOutputProjectedBytes", "toolOutputRawTokens",
    "toolOutputProjectedTokens", "cpuPct", "rssMb", "heapUsedMb", "eventLoopLagMs",
  ]);
  assert.deepEqual(stableRecordRows({ z: 1, a: 2 }), [
    { key: "a", value: 2 },
    { key: "z", value: 1 },
  ]);
  assert.deepEqual(stableArrayRows([{ tool: "z" }, { tool: "a" }], "tool"), [
    { tool: "a" },
    { tool: "z" },
  ]);
  assert.ok(Object.isFrozen(stableRecordRows({ a: 1 })));
  assert.ok(Object.isFrozen(stableRecordRows({ a: 1 })[0]));
  assert.ok(Object.isFrozen(stableArrayRows([{ tool: "a" }], "tool")));
  assert.ok(Object.isFrozen(TIMESERIES_PANEL_MAP));
  for (const destination of Object.values(TIMESERIES_PANEL_MAP)) {
    assert.deepEqual(Object.keys(destination), ["panel", "field"]);
    assert.ok(Object.isFrozen(destination));
  }
  assert.deepEqual(SCOPE_LABELS, {
    session: "SESSION",
    repositoryLifetime: "REPO LIFETIME",
    current: "CURRENT",
    serverPeak: "SERVER PEAK",
  });
});

test("session state keeps transport clocks and repositories independent", () => {
  const input = {
    sessionRepoId: "repo-a",
    lifetimeRepoId: "repo-a",
    monotonicNowMs: 20_000,
    sessionReceivedAtMs: 19_900,
    lifetimeReceivedAtMs: 19_900,
    sessionGeneratedAt: GENERATED_AT,
    lifetimeGeneratedAt: GENERATED_AT,
    freshnessAvailable: true,
    sectionPresent: true,
    lastEventAt: LAST_EVENT_AT,
    sampleIntervalMs: 2_000,
  };

  assert.equal(sessionPanelState(input), "LIVE");
  assert.equal(sessionPanelState({ ...input, sessionReceivedAtMs: 10_000 }), "LIVE");
  assert.equal(sessionPanelState({ ...input, sessionReceivedAtMs: 9_999 }), "STALE");
  assert.equal(
    sessionPanelState({ ...input, lifetimeReceivedAtMs: 10_000 }),
    "LIVE",
  );
  assert.equal(
    sessionPanelState({ ...input, lifetimeReceivedAtMs: 9_999 }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({ ...input, lifetimeGeneratedAt: "2026-08-20T12:00:59.999Z" }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({ ...input, lifetimeRepoId: "repo-b" }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({ ...input, freshnessAvailable: false }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({ ...input, sessionReceivedAtMs: 20_001 }),
    "STALE",
  );
  assert.equal(
    sessionPanelState({ ...input, lifetimeReceivedAtMs: 20_001 }),
    "FRESHNESS UNAVAILABLE",
  );
});

test("session state applies exact no-data and activity boundaries", () => {
  const input = {
    sessionRepoId: "repo-a",
    lifetimeRepoId: "repo-a",
    monotonicNowMs: 20_000,
    sessionReceivedAtMs: 20_000,
    lifetimeReceivedAtMs: 20_000,
    sessionGeneratedAt: GENERATED_AT,
    lifetimeGeneratedAt: GENERATED_AT,
    freshnessAvailable: true,
    sectionPresent: true,
    lastEventAt: LAST_EVENT_AT,
    sampleIntervalMs: 2_000,
  };
  assert.equal(sessionPanelState({ ...input, sectionPresent: false }), "NO DATA");
  assert.equal(sessionPanelState({ ...input, lastEventAt: null }), "NO DATA");
  assert.equal(sessionPanelState(input), "LIVE");
  assert.equal(
    sessionPanelState({ ...input, lastEventAt: "2026-08-20T11:59:59.999Z" }),
    "IDLE",
  );
  assert.equal(
    sessionPanelState({ ...input, lastEventAt: "2026-08-20T12:02:00.000Z" }),
    "LIVE",
  );
});

test("session state fails closed for hostile time values", () => {
  const input = {
    sessionRepoId: "repo-a",
    lifetimeRepoId: "repo-a",
    monotonicNowMs: 20_000,
    sessionReceivedAtMs: Number.NaN,
    lifetimeReceivedAtMs: 20_000,
    sessionGeneratedAt: GENERATED_AT,
    lifetimeGeneratedAt: GENERATED_AT,
    freshnessAvailable: true,
    sectionPresent: true,
    lastEventAt: LAST_EVENT_AT,
    sampleIntervalMs: 2_000,
  };
  assert.equal(sessionPanelState(input), "STALE");
  assert.equal(
    sessionPanelState({ ...input, sessionReceivedAtMs: 20_000, lifetimeGeneratedAt: "hostile" }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({ ...input, sessionReceivedAtMs: 20_000, lastEventAt: "hostile" }),
    "FRESHNESS UNAVAILABLE",
  );
  assert.equal(
    sessionPanelState({
      ...input,
      sessionReceivedAtMs: 20_000,
      lifetimeGeneratedAt: "2026-02-30T12:01:00.000Z",
    }),
    "FRESHNESS UNAVAILABLE",
  );
});

test("lifetime presentation applies precedence and value withholding", () => {
  const current = lifetimePresentation(readyEnvelope(), 0);
  assert.equal(current.state, "CURRENT");
  assert.deepEqual(current.sections, { cache: { hits: 3 } });
  assert.equal(current.checkpointAgeMs, 30_000);

  const readOnly = lifetimePresentation(readyEnvelope("readOnly"), 0);
  assert.equal(readOnly.state, "READ ONLY");
  assert.deepEqual(readOnly.sections, { cache: { hits: 3 } });

  const capacity = lifetimePresentation(readyEnvelope("capacityExceeded"), 0);
  assert.equal(capacity.state, "CAPACITY EXCEEDED");
  assert.equal(capacity.sections, null);
  assert.deepEqual(capacity.processPeaks, { cpuPct: 50 });
  assert.match(capacity.warning ?? "", /per-directory/i);

  const degraded = lifetimePresentation(readyEnvelope("degraded"), 0);
  assert.equal(degraded.state, "DEGRADED");
  assert.deepEqual(degraded.sections, { cache: { hits: 3 } });
  assert.match(degraded.warning ?? "", /checkpoint/i);

  const recoveryEnvelope = {
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: GENERATED_AT,
    repoId: "repo-a",
    persistenceState: "recoveryRequired",
    recoveryReason: "indeterminatePublication",
  };
  const recovery = lifetimePresentation(recoveryEnvelope, 0);
  assert.equal(recovery.state, "RECOVERY REQUIRED");
  assert.equal(recovery.sections, null);
  assert.equal(recovery.processPeaks, null);
  const staleRecovery = lifetimePresentation(recoveryEnvelope, 10_001);
  assert.equal(staleRecovery.state, "STALE");
  assert.equal(staleRecovery.sections, null);
  assert.equal(staleRecovery.processPeaks, null);

  assert.deepEqual(Object.keys(current), [
    "state", "sections", "processPeaks", "checkpointAgeMs", "warning",
  ]);
  assert.equal(lifetimePresentation(readyEnvelope(), 10_001).state, "STALE");
  assert.equal(lifetimePresentation(null, 0).state, "UNAVAILABLE");
  assert.equal(lifetimePresentation(readyEnvelope(), Number.NaN).state, "STALE");
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(current.sections));
});

test("older-server lifetime absence makes every section freshness unavailable", () => {
  const unavailable = lifetimePresentation(null, 0);
  assert.equal(unavailable.state, "UNAVAILABLE");
  for (const [index] of SECTION_IDS.entries()) {
    assert.equal(sessionPanelState({
      sessionRepoId: "repo-a",
      lifetimeRepoId: null,
      monotonicNowMs: 20_000,
      sessionReceivedAtMs: 20_000,
      lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
      sessionGeneratedAt: GENERATED_AT,
      lifetimeGeneratedAt: null,
      freshnessAvailable: false,
      sectionPresent: index % 2 === 0,
      lastEventAt: null,
      sampleIntervalMs: 2_000,
    }), "FRESHNESS UNAVAILABLE");
  }
});

test("compiler source remains the field oracle", () => {
  assert.match(readFileSync(TYPES_PATH, "utf8"), /export interface ObservabilitySnapshot/);
  assert.equal(snapshotTypeLeaves().length, 273);
});
