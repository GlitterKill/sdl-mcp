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

const SCALAR_DESTINATIONS = Object.fromEntries([
  "generatedAt", "repoId",
  "cache.overallHitRatePct", "cache.totalHits", "cache.totalMisses", "cache.avgLookupLatencyMs",
  "retrieval.totalRetrievals", "retrieval.avgLatencyMs", "retrieval.p95LatencyMs", "retrieval.emptyResultCount",
  "beam.totalSliceBuilds", "beam.avgBuildMs", "beam.p95BuildMs", "beam.avgAccepted", "beam.avgEvicted",
  "beam.avgRejected", "beam.avgFrontierMaxSize", "beam.p95FrontierMaxSize", "beam.retainedExplainHandles",
  "delta.totalBlastRadiusComputations", "delta.avgBlastRadiusLatencyMs", "delta.p95BlastRadiusLatencyMs",
  "delta.avgDbRoundTripsPerChangedSymbol", "delta.avgPathExplanationLatencyMs", "delta.p95PathExplanationLatencyMs",
  "delta.fallbackPathQueryCount", "indexing.totalEvents", "indexing.filesPerMinute", "indexing.avgPass1Ms",
  "indexing.avgPass2Ms", "indexing.failures", "indexing.derivedStateLagMs", "tokenEfficiency.totalUsed",
  "tokenEfficiency.totalSaved", "tokenEfficiency.savingsRatio", "tokenEfficiency.avgPerCall",
  "predictiveContext.policyMode", "predictiveContext.outcomeSamples", "predictiveContext.suppressedPrefetch",
  "predictiveContext.acceptedPrefetch", "predictiveContext.hitRatePct", "predictiveContext.wasteRatePct",
  "predictiveContext.avgLatencyReductionMs", "health.score", "health.watcherRunning", "health.watcherProvider",
  "health.watcherConfiguredProvider", "health.watcherFallbackReason", "health.watcherQueueDepth", "health.watcherStale",
  "health.watcherErrors", "health.watcherRestartCount", "health.watcherWatchmanWarningCount",
  "health.watcherWatchmanRecrawlCount", "health.watcherWatchmanFreshInstanceCount", "latency.avgMs", "latency.p50Ms",
  "latency.p95Ms", "latency.p99Ms", "latency.maxMs", "scip.totalIngests", "scip.successCount",
  "scip.failureCount", "scip.totalEdgesCreated", "scip.totalEdgesUpgraded", "scip.avgIngestMs", "scip.lastIngestAt",
  "ppr.totalRuns", "ppr.nativeRatio", "ppr.avgComputeMs", "ppr.p95ComputeMs", "ppr.avgTouched", "ppr.avgSeedCount",
  "toolVolume.totalCalls", "toolVolume.callsPerMinute", "postIndexSession.totalSessions",
  "postIndexSession.avgDurationMs", "postIndexSession.p50DurationMs", "postIndexSession.p95DurationMs",
  "postIndexSession.p99DurationMs", "postIndexSession.maxDurationMs", "postIndexSession.timeoutCount",
  "postIndexSession.lastDurationMs", "postIndexSession.lastTimedOut", "postIndexSession.lastEndedAt",
].map((path) => [path, path.split(".").at(-1)]));
SCALAR_DESTINATIONS["cache.overallHitRatePct"] = "hitRate";

class FakeDashboardElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeDashboardElement[] = [];
  readonly fields = new Map<string, FakeDashboardElement>();
  readonly style: Record<string, string | ((name: string, value: string) => void)> = {
    setProperty: (name: string, value: string) => { this.style[name] = value; },
  };
  className = "";
  dataset: Record<string, string> = {};
  hidden = false;
  innerHTML = "";
  scope = "";
  textContent = "";
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; } };

  append(...children: FakeDashboardElement[]) { this.children.push(...children); }
  replaceChildren(...children: FakeDashboardElement[]) {
    this.children.splice(0, this.children.length, ...children);
    this.innerHTML = "";
    this.textContent = "";
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  querySelector(selector: string): FakeDashboardElement | null {
    const field = selector.match(/^\[data-field="(.+)"\]$/)?.[1];
    if (field) {
      if (!this.fields.has(field)) this.fields.set(field, new FakeDashboardElement());
      return this.fields.get(field) ?? null;
    }
    const series = selector.match(/^\[data-series="(.+)"\]$/)?.[1];
    const matches = (element: FakeDashboardElement) => series !== undefined
      ? element.dataset.series === series
      : selector === ".trend-bank" && element.className.split(/\s+/).includes("trend-bank");
    for (const child of this.children) {
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    if (series === undefined && selector !== ".trend-bank") {
      if (!this.fields.has(selector)) this.fields.set(selector, new FakeDashboardElement());
      return this.fields.get(selector) ?? null;
    }
    return null;
  }
  serialize(): string {
    const fields = [...this.fields.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}:${value.serialize()}`).join("|");
    const children = this.children.map((child) => child.serialize()).join("|");
    return JSON.stringify({
      attributes: [...this.attributes.entries()].sort(), children, className: this.className,
      dataset: this.dataset, fields, hidden: this.hidden, innerHTML: this.innerHTML,
      scope: this.scope, style: this.style, textContent: this.textContent,
    });
  }
}

function installFakeDashboardDocument() {
  const panels = new Map(
    [...new Set(Object.values(METRIC_DISPOSITIONS).map(({ panel }) => panel))]
      .map((panel) => [panel, new FakeDashboardElement()]),
  );
  const dashboardFields = new Map<string, FakeDashboardElement>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      readyState: "loading",
      addEventListener() {},
      createElement: () => new FakeDashboardElement(),
      createElementNS: () => new FakeDashboardElement(),
      querySelector(selector: string) {
        const panel = selector.match(/^\[data-panel="(.+)"\]$/)?.[1];
        if (panel) return panels.get(panel) ?? null;
        const field = selector.match(/^\[data-dashboard-field="(.+)"\]$/)?.[1];
        if (field) {
          if (!dashboardFields.has(field)) dashboardFields.set(field, new FakeDashboardElement());
          return dashboardFields.get(field) ?? null;
        }
        return null;
      },
    },
  });
  return { dashboardFields, panels };
}

function mutateClaimedPath(snapshot: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let current: unknown = snapshot;
  const changed = (value: unknown): unknown => typeof value === "number"
    ? value + 91
    : typeof value === "boolean"
      ? !value
      : typeof value === "string"
        ? `${value}__sentinel`
        : 91;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = index === parts.length - 1;
    const collection = part.endsWith("[]");
    const key = collection ? part.slice(0, -2) : part;
    const record = current as Record<string, unknown>;
    if (!collection) {
      if (last) record[key] = changed(record[key]);
      else current = record[key];
      continue;
    }
    const values = record[key] as unknown[] | Record<string, unknown>;
    if (Array.isArray(values)) {
      if (last) values[0] = changed(values[0]);
      else current = values[0];
    } else {
      const first = Object.keys(values)[0];
      const identity = parts[index + 1];
      const item = values[first] as Record<string, unknown>;
      if (
        index + 1 === parts.length - 1 &&
        (identity === "source" || identity === "tool") &&
        item?.[identity] === undefined
      ) {
        values[`${first}__sentinel`] = values[first];
        delete values[first];
        return;
      }
      if (last) values[first] = changed(values[first]);
      else current = values[first];
    }
  }
}

function createMetricConsumerVerifier() {
  const baselineSnapshot = structuredClone(runtimeSnapshot()) as unknown as Record<string, unknown>;
  const indexing = baselineSnapshot.indexing as { engineDispatch: { rust: number } };
  indexing.engineDispatch.rust = 1;
  const ppr = baselineSnapshot.ppr as { jsCount: number };
  ppr.jsCount = 1;
  return function verifyMetricConsumer(
    path: string,
    disposition: (typeof METRIC_DISPOSITIONS)[string],
    render: (snapshot: unknown, rendered: Set<unknown>) => void,
  ): void {
    const baselineDom = installFakeDashboardDocument();
    render(structuredClone(baselineSnapshot), new Set());
    const baselinePanel = baselineDom.panels.get(disposition.panel)?.serialize() ?? "";
    const baselineDashboard = [...baselineDom.dashboardFields.entries()].map(([name, value]) => `${name}:${value.serialize()}`).join("|");

    const mutatedSnapshot = structuredClone(baselineSnapshot);
    mutateClaimedPath(mutatedSnapshot, path);
    const mutatedDom = installFakeDashboardDocument();
    render(mutatedSnapshot, new Set());
    const mutatedPanel = mutatedDom.panels.get(disposition.panel)?.serialize() ?? "";
    const mutatedDashboard = [...mutatedDom.dashboardFields.entries()].map(([name, value]) => `${name}:${value.serialize()}`).join("|");
    if (`${mutatedPanel}|${mutatedDashboard}` === `${baselinePanel}|${baselineDashboard}`) {
      assert.fail(`${path} produced no observable output change`);
    }

    const scalarField = SCALAR_DESTINATIONS[path];
    if (scalarField) {
      const baselineValue = path === "repoId" || path === "generatedAt"
        ? baselineDom.dashboardFields.get(scalarField)?.textContent
        : baselineDom.panels.get(disposition.panel)?.fields.get(scalarField)?.textContent;
      const mutatedValue = path === "repoId" || path === "generatedAt"
        ? mutatedDom.dashboardFields.get(scalarField)?.textContent
        : mutatedDom.panels.get(disposition.panel)?.fields.get(scalarField)?.textContent;
      if (mutatedValue === baselineValue) {
        assert.fail(`${path} did not update ${disposition.panel}.${scalarField}`);
      }
    }
  };
}

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
      | ((
        dispositions: typeof METRIC_DISPOSITIONS,
        renderers: Record<string, unknown>,
        verify?: ReturnType<typeof createMetricConsumerVerifier>,
      ) => void)
      | undefined;
    assert.ok(registry);
    assert.equal(typeof assertCoverage, "function");
    const claimed = Object.entries(METRIC_DISPOSITIONS)
      .filter(([, entry]) => entry.disposition !== "sessionOnly")
      .map(([path]) => path);
    assert.deepEqual(Object.keys(registry).sort(), claimed.sort());
    for (const path of claimed) assert.equal(typeof registry[path], "function", path);

    assertCoverage?.(METRIC_DISPOSITIONS, registry, createMetricConsumerVerifier());
    const encoderDom = installFakeDashboardDocument();
    (registry["packed.perEncoder[]"] as Function)(runtimeSnapshot(), new Set());
    const encoderTable = encoderDom.panels.get("tokenEfficiency")?.fields.get("packedByEncoder")?.serialize() ?? "";
    assert.match(encoderTable, /Per-encoder count/);
    assert.match(encoderTable, /Total decisions/);

    const mutated = { ...registry };
    delete mutated["retrieval.p95LatencyMs"];
    assert.throws(
      () => assertCoverage?.(METRIC_DISPOSITIONS, mutated),
      /retrieval\.p95LatencyMs/,
    );
    const groupedPath = "latency.perTool[].phases[].maxMs";
    assert.throws(
      () => assertCoverage?.(METRIC_DISPOSITIONS, {
        ...registry,
        [groupedPath]: () => {},
      }, createMetricConsumerVerifier()),
      new RegExp(groupedPath.replace(/[.[\]]/g, "\\$&")),
    );
    assert.throws(
      () => assertCoverage?.(METRIC_DISPOSITIONS, {
        ...registry,
        [groupedPath]: registry["ppr.nativeCount"],
      }, createMetricConsumerVerifier()),
      new RegExp(groupedPath.replace(/[.[\]]/g, "\\$&")),
    );
    assert.throws(
      () => assertCoverage?.(METRIC_DISPOSITIONS, {
        ...registry,
        "retrieval.p95LatencyMs": registry["retrieval.avgLatencyMs"],
      }, createMetricConsumerVerifier()),
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
    const assertCoverage = dashboard.assertTimeseriesRendererCoverage as
      | ((
        destinations: typeof TIMESERIES_PANEL_MAP,
        renderers: Record<string, unknown>,
        verify?: (series: string, destination: { panel: string; field: string }, render: (points: object[]) => void) => void,
      ) => void)
      | undefined;
    assert.ok(consumers);
    assert.equal(typeof assertCoverage, "function");
    assert.deepEqual(Object.keys(consumers), Object.keys(TIMESERIES_PANEL_MAP));
    for (const [series, destination] of Object.entries(TIMESERIES_PANEL_MAP)) {
      assert.equal(typeof consumers[series], "function", `${series}:${destination.panel}.${destination.field}`);
    }
    const missing = { ...consumers };
    delete missing.p95LatencyMs;
    assert.throws(() => assertCoverage?.(TIMESERIES_PANEL_MAP, missing), /p95LatencyMs/);

    const verifySeriesConsumer = (
      series: string,
      destination: { panel: string; field: string },
      render: (points: object[]) => void,
    ) => {
        const { panels } = installFakeDashboardDocument();
        render([{ t: 1, value: 1 }, { t: 2, value: 2 }]);
        render([{ t: 1, value: 2 }, { t: 2, value: 3 }]);
        const panel = panels.get(destination.panel);
        if (!panel?.querySelector(`[data-series="${series}"]`)) {
          assert.fail(`${series} did not render in ${destination.panel}.${destination.field}`);
        }
        assert.match(panel.serialize(), new RegExp(destination.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        const matches = (element: FakeDashboardElement): number =>
          (element.dataset.series === series ? 1 : 0) + element.children.reduce((sum, child) => sum + matches(child), 0);
        assert.equal(matches(panel), 1, `${series} must update idempotently`);
    };
    assertCoverage?.(TIMESERIES_PANEL_MAP, consumers, verifySeriesConsumer);
    assert.throws(
      () => assertCoverage?.(
        TIMESERIES_PANEL_MAP,
        { ...consumers, p95LatencyMs: () => {} },
        verifySeriesConsumer,
      ),
      /p95LatencyMs/,
    );
    assert.throws(
      () => assertCoverage?.(
        TIMESERIES_PANEL_MAP,
        { ...consumers, p95LatencyMs: consumers.cacheHitRate },
        verifySeriesConsumer,
      ),
      /p95LatencyMs/,
    );
    assert.doesNotMatch(readFileSync("src/ui/observability.js", "utf8"), /hitRateHistory/);
    assert.doesNotMatch(
      readFileSync("src/ui/observability.js", "utf8"),
      /Object\.keys\(TIMESERIES_PANEL_MAP\)[\s\S]{0,200}renderMappedSeries/,
    );
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
