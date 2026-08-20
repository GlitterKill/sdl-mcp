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
import { emptyLifetimeSections } from "../../../dist/observability/lifetime-accumulator.js";
import {
  parseLifetimeEnvelope,
  SECTION_IDS,
} from "../../../dist/observability/lifetime-types.js";

const TYPES_PATH = "src/observability/types.ts";
const GENERATED_AT = "2026-08-20T12:01:00.000Z";
const LAST_EVENT_AT = "2026-08-20T12:00:00.000Z";

const COMPILER_OPTIONS = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    target: ts.ScriptTarget.ES2024,
} as const;

function interfaceTypeLeaves(
  program: ts.Program,
  source: ts.SourceFile,
  interfaceName: string,
): string[] {
  const checker = program.getTypeChecker();
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
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
    if (type.isUnion()) {
      for (const member of type.types) visit(member, path);
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
  return [...new Set(leaves)];
}

function snapshotTypeLeaves(): string[] {
  const program = ts.createProgram([TYPES_PATH], COMPILER_OPTIONS);
  const source = program.getSourceFile(TYPES_PATH);
  assert.ok(source);
  return interfaceTypeLeaves(program, source, "ObservabilitySnapshot");
}

function syntheticTypeLeaves(sourceText: string, interfaceName: string): string[] {
  const fileName = "synthetic-dashboard-model.ts";
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    COMPILER_OPTIONS.target,
    true,
    ts.ScriptKind.TS,
  );
  const defaultHost = ts.createCompilerHost(COMPILER_OPTIONS);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => path === fileName || defaultHost.fileExists(path),
    readFile: (path) => path === fileName ? sourceText : defaultHost.readFile(path),
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      path === fileName
        ? source
        : defaultHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
  };
  const program = ts.createProgram([fileName], COMPILER_OPTIONS, host);
  return interfaceTypeLeaves(program, source, interfaceName);
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
  const sections = emptyLifetimeSections();
  sections.cache = {
    hits: 3,
    misses: 1,
    lookupMs: { count: 4, sum: 10, max: 4 },
    perSource: {},
  };
  const capacityExceeded = persistenceState === "capacityExceeded";
  return {
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: GENERATED_AT,
    repoId: "repo-a",
    epoch: capacityExceeded ? 0 : 1,
    resetAt: null,
    lastCheckpointAt: capacityExceeded ? null : "2026-08-20T12:00:30.000Z",
    persistenceState,
    sessionCount: capacityExceeded ? 0 : 2,
    saturated: false,
    sections: capacityExceeded ? emptyLifetimeSections() : sections,
    freshness: Object.fromEntries(
      SECTION_IDS.map((section) => [section, section === "cache" ? LAST_EVENT_AT : null]),
    ),
    processPeaks: {
      cpuPct: 50,
      rssMb: 100,
      heapUsedMb: 40,
      heapTotalMb: 80,
      eventLoopLagMs: 3,
    },
  };
}

function assertUnavailable(envelope: unknown, transportAgeMs = 0): void {
  assert.deepEqual(lifetimePresentation(envelope, transportAgeMs), {
    state: "UNAVAILABLE",
    sections: null,
    processPeaks: null,
    checkpointAgeMs: null,
    warning: "Lifetime metrics are unavailable.",
  });
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

test("compiler oracle includes every discriminated object-union branch once", () => {
  assert.deepEqual(
    syntheticTypeLeaves(`
      interface SyntheticSnapshot {
        payload:
          | { kind: "left"; common: number; leftOnly: { value: string } }
          | { kind: "right"; common: number; rightOnly: boolean };
      }
    `, "SyntheticSnapshot"),
    [
      "payload.kind",
      "payload.common",
      "payload.leftOnly.value",
      "payload.rightOnly",
    ],
  );
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

test("dashboard registers a consuming renderer for every rendered or derived metric", async () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { readyState: "loading", addEventListener() {} },
  });
  try {
    const dashboard = await import("../../../dist/ui/observability.js");
    const registry = dashboard.METRIC_RENDERERS as Record<string, unknown> | undefined;
    const assertCoverage = dashboard.assertMetricRendererCoverage as
      | ((dispositions: typeof METRIC_DISPOSITIONS, renderers: Record<string, unknown>) => void)
      | undefined;
    assert.ok(registry);
    assert.equal(typeof assertCoverage, "function");
    const claimed = Object.entries(METRIC_DISPOSITIONS)
      .filter(([, entry]) => entry.disposition !== "sessionOnly")
      .map(([path]) => path);
    assert.deepEqual(Object.keys(registry).sort(), claimed.sort());
    for (const path of claimed) assert.equal(typeof registry[path], "function", path);

    const output = { textContent: "" };
    const panel = {
      querySelector(selector: string) {
        return selector === '[data-field="p95LatencyMs"]' ? output : null;
      },
    };
    (globalThis.document as unknown as { querySelector(selector: string): unknown }).querySelector =
      (selector: string) => selector === '[data-panel="retrieval"]' ? panel : null;
    (registry["retrieval.p95LatencyMs"] as (snapshot: unknown) => void)({
      retrieval: { p95LatencyMs: 42 },
    });
    assert.equal(output.textContent, "42ms");

    const mutated = { ...registry };
    delete mutated["retrieval.p95LatencyMs"];
    assert.throws(
      () => assertCoverage?.(METRIC_DISPOSITIONS, mutated),
      /retrieval\.p95LatencyMs/,
    );
    assert.doesNotMatch(
      readFileSync("src/ui/observability.js", "utf8"),
      /Object\.entries\(METRIC_DISPOSITIONS\)[\s\S]{0,300}PANEL_RENDERERS/,
    );
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("dashboard consumes every existing 15-minute series without browser history", async () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { readyState: "loading", addEventListener() {} },
  });
  try {
    const dashboard = await import("../../../dist/ui/observability.js");
    const consumers = dashboard.TIMESERIES_RENDERERS as Record<string, unknown> | undefined;
    assert.ok(consumers);
    assert.deepEqual(Object.keys(consumers), Object.keys(TIMESERIES_PANEL_MAP));
    for (const [series, destination] of Object.entries(TIMESERIES_PANEL_MAP)) {
      assert.equal(typeof consumers[series], "function", `${series}:${destination.panel}.${destination.field}`);
    }
    assert.doesNotMatch(readFileSync("src/ui/observability.js", "utf8"), /hitRateHistory/);
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, "document", priorDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
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

test("session state preserves exact server timestamp ordering", () => {
  const older = "2026-08-20T12:00:00.000000001Z";
  const newer = "2026-08-20T12:00:00.000000999Z";
  const parsedLifetime = parseLifetimeEnvelope({
    schemaVersion: 1,
    sampleIntervalMs: 2_000,
    generatedAt: older,
    repoId: "repo-a",
    persistenceState: "recoveryRequired",
    recoveryReason: "corruptCandidates",
  });
  assert.equal(parsedLifetime.generatedAt, older);

  const input = {
    sessionRepoId: "repo-a",
    lifetimeRepoId: "repo-a",
    monotonicNowMs: 20_000,
    sessionReceivedAtMs: 20_000,
    lifetimeReceivedAtMs: 20_000,
    sessionGeneratedAt: newer,
    lifetimeGeneratedAt: older,
    freshnessAvailable: true,
    sectionPresent: true,
    lastEventAt: older,
    sampleIntervalMs: 2_000,
  };

  assert.equal(sessionPanelState(input), "FRESHNESS UNAVAILABLE");
  assert.equal(
    sessionPanelState({ ...input, lifetimeGeneratedAt: newer }),
    "LIVE",
  );
  assert.equal(
    sessionPanelState({
      ...input,
      sessionGeneratedAt: older,
      lifetimeGeneratedAt: newer,
    }),
    "LIVE",
  );
  assert.equal(
    sessionPanelState({
      ...input,
      lifetimeGeneratedAt: "2026-08-20T07:00:00.000000999-05:00",
    }),
    "LIVE",
  );
  assert.equal(
    sessionPanelState({
      ...input,
      sessionGeneratedAt: older,
      lifetimeGeneratedAt: newer,
      lastEventAt: "2026-08-20T11:59:00.000000998Z",
    }),
    "IDLE",
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
  assert.equal(
    sessionPanelState({
      ...input,
      sessionReceivedAtMs: 20_000,
      lifetimeGeneratedAt: "2026-08-20T12:01:00.1234567890Z",
    }),
    "FRESHNESS UNAVAILABLE",
  );
});

test("lifetime presentation applies precedence and value withholding", () => {
  const current = lifetimePresentation(readyEnvelope(), 0);
  assert.equal(current.state, "CURRENT");
  assert.equal(current.sections.cache.hits, 3);
  assert.equal(current.checkpointAgeMs, 30_000);

  const readOnly = lifetimePresentation(readyEnvelope("readOnly"), 0);
  assert.equal(readOnly.state, "READ ONLY");
  assert.equal(readOnly.sections.cache.hits, 3);

  const capacity = lifetimePresentation(readyEnvelope("capacityExceeded"), 0);
  assert.equal(capacity.state, "CAPACITY EXCEEDED");
  assert.equal(capacity.sections, null);
  assert.equal(capacity.processPeaks.cpuPct, 50);
  assert.match(capacity.warning ?? "", /per-directory/i);

  const degraded = lifetimePresentation(readyEnvelope("degraded"), 0);
  assert.equal(degraded.state, "DEGRADED");
  assert.equal(degraded.sections.cache.hits, 3);
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

test("lifetime presentation rejects malformed envelopes before precedence", () => {
  const ready = readyEnvelope();
  const invalid = [
    [],
    new Date(GENERATED_AT),
    { ...ready, schemaVersion: 2 },
    { ...ready, extra: true },
    { ...ready, repoId: "" },
    { ...ready, generatedAt: "hostile" },
    { ...ready, epoch: -1 },
    { ...ready, sessionCount: "1" },
    { ...ready, saturated: 0 },
    { ...ready, resetAt: "hostile" },
    { ...ready, lastCheckpointAt: "hostile" },
    { ...ready, sections: "hostile" },
    {
      ...ready,
      sections: { ...ready.sections, cache: { ...ready.sections.cache, hits: -1 } },
    },
    { ...ready, freshness: "hostile" },
    { ...ready, freshness: { ...ready.freshness, cache: "hostile" } },
    { ...ready, processPeaks: { cpuPct: 1 } },
    { ...ready, processPeaks: { ...ready.processPeaks, rssMb: -1 } },
    { ...ready, persistenceState: "unknown" },
    {
      schemaVersion: 1,
      sampleIntervalMs: 2_000,
      generatedAt: GENERATED_AT,
      repoId: "repo-a",
      persistenceState: "recoveryRequired",
      recoveryReason: "unknown",
    },
    {
      schemaVersion: 1,
      sampleIntervalMs: 2_000,
      generatedAt: GENERATED_AT,
      repoId: "repo-a",
      persistenceState: "recoveryRequired",
      recoveryReason: "corruptCandidates",
      sections: ready.sections,
    },
  ];
  for (const envelope of invalid) assertUnavailable(envelope);
  assertUnavailable({ ...ready, persistenceState: "unknown" }, 10_001);
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
