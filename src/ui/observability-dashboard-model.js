function dispositions(panel, disposition, paths) {
  return Object.fromEntries(
    paths.map((path) => [path, Object.freeze({ disposition, panel })]),
  );
}

// `[]` is part of the exact canonical path for a collection value; the UI
// never expands or wildcard-matches disposition keys at runtime.
export const METRIC_DISPOSITIONS = Object.freeze({
  ...dispositions("bottleneck", "sessionOnly", ["schemaVersion"]),
  ...dispositions("bottleneck", "derived", ["generatedAt"]),
  ...dispositions("bottleneck", "rendered", ["repoId"]),
  ...dispositions("resources", "sessionOnly", ["uptimeMs"]),
  ...dispositions("cache", "rendered", [
    "cache.overallHitRatePct",
    "cache.totalHits",
    "cache.totalMisses",
    "cache.perSource[].source",
    "cache.perSource[].hits",
    "cache.perSource[].misses",
    "cache.perSource[].hitRatePct",
    "cache.perSource[].avgLatencyMs",
    "cache.avgLookupLatencyMs",
  ]),
  ...dispositions("retrieval", "rendered", [
    "retrieval.totalRetrievals",
    "retrieval.avgLatencyMs",
    "retrieval.p95LatencyMs",
    "retrieval.byMode[]",
    "retrieval.candidateCountPerSource[]",
    "retrieval.phaseLatencyMs[].count",
    "retrieval.phaseLatencyMs[].avgMs",
    "retrieval.phaseLatencyMs[].p95Ms",
    "retrieval.phaseLatencyMs[].maxMs",
    "retrieval.byRetrievalType[]",
    "retrieval.emptyResultCount",
  ]),
  ...dispositions("beam", "rendered", [
    "beam.totalSliceBuilds",
    "beam.avgBuildMs",
    "beam.p95BuildMs",
    "beam.avgAccepted",
    "beam.avgEvicted",
    "beam.avgRejected",
    "beam.avgFrontierMaxSize",
    "beam.p95FrontierMaxSize",
    "beam.retainedExplainHandles",
  ]),
  ...dispositions("delta", "rendered", [
    "delta.totalBlastRadiusComputations",
    "delta.avgBlastRadiusLatencyMs",
    "delta.p95BlastRadiusLatencyMs",
    "delta.avgDbRoundTripsPerChangedSymbol",
    "delta.avgPathExplanationLatencyMs",
    "delta.p95PathExplanationLatencyMs",
    "delta.fallbackPathQueryCount",
  ]),
  ...dispositions("indexing", "rendered", [
    "indexing.totalEvents",
    "indexing.filesPerMinute",
    "indexing.avgPass1Ms",
    "indexing.avgPass2Ms",
    "indexing.phaseCounts[]",
    "indexing.perLanguageAvgMs[]",
    "indexing.engineDispatch.rust",
    "indexing.engineDispatch.ts",
    "indexing.failures",
    "indexing.derivedStateLagMs",
  ]),
  ...dispositions("tokenEfficiency", "rendered", [
    "tokenEfficiency.totalUsed",
    "tokenEfficiency.totalSaved",
    "tokenEfficiency.savingsRatio",
    "tokenEfficiency.avgPerCall",
    "tokenEfficiency.compressionLayers.totalEvents",
    "tokenEfficiency.compressionLayers.totalRealizedEvents",
    "tokenEfficiency.compressionLayers.totalEstimatedTokensAvoided",
    "tokenEfficiency.compressionLayers.totalOriginalTokens",
    "tokenEfficiency.compressionLayers.totalReturnedTokens",
    "tokenEfficiency.compressionLayers.totalSavedTokens",
    "tokenEfficiency.compressionLayers.totalStoredBytes",
    "tokenEfficiency.compressionLayers.bySource[].source",
    "tokenEfficiency.compressionLayers.bySource[].events",
    "tokenEfficiency.compressionLayers.bySource[].realizedEvents",
    "tokenEfficiency.compressionLayers.bySource[].estimatedTokensAvoided",
    "tokenEfficiency.compressionLayers.bySource[].originalTokens",
    "tokenEfficiency.compressionLayers.bySource[].returnedTokens",
    "tokenEfficiency.compressionLayers.bySource[].savedTokens",
    "tokenEfficiency.compressionLayers.bySource[].opportunities",
    "tokenEfficiency.compressionLayers.bySource[].hits",
    "tokenEfficiency.compressionLayers.bySource[].hitRatePct",
    "tokenEfficiency.compressionLayers.bySource[].storedBytes",
    "tokenEfficiency.compressionLayers.byTool[].tool",
    "tokenEfficiency.compressionLayers.byTool[].source",
    "tokenEfficiency.compressionLayers.byTool[].events",
    "tokenEfficiency.compressionLayers.byTool[].realizedEvents",
    "tokenEfficiency.compressionLayers.byTool[].estimatedTokensAvoided",
    "tokenEfficiency.compressionLayers.byTool[].originalTokens",
    "tokenEfficiency.compressionLayers.byTool[].returnedTokens",
    "tokenEfficiency.compressionLayers.byTool[].savedTokens",
    "tokenEfficiency.compressionLayers.byTool[].opportunities",
    "tokenEfficiency.compressionLayers.byTool[].hits",
    "tokenEfficiency.compressionLayers.byTool[].hitRatePct",
    "tokenEfficiency.compressionLayers.byTool[].storedBytes",
    "packed.totalDecisions",
    "packed.packedCount",
    "packed.fallbackCount",
    "packed.packedAdoptionPct",
    "packed.packedBytesTotal",
    "packed.jsonBaselineBytesTotal",
    "packed.bytesSaved",
    "packed.bytesSavedRatio",
    "packed.packedTokensTotal",
    "packed.jsonBaselineTokensTotal",
    "packed.tokensSaved",
    "packed.tokensSavedRatio",
    "packed.axisHits.bytes",
    "packed.axisHits.tokens",
    "packed.axisHits.none",
    "packed.perEncoder[]",
    "packed.byEncoder[].totalDecisions",
    "packed.byEncoder[].packedCount",
    "packed.byEncoder[].fallbackCount",
    "packed.byEncoder[].packedAdoptionPct",
    "packed.byEncoder[].jsonBaselineBytesTotal",
    "packed.byEncoder[].packedBytesTotal",
    "packed.byEncoder[].bytesSaved",
    "packed.byEncoder[].bytesSavedRatio",
    "packed.byEncoder[].jsonBaselineTokensTotal",
    "packed.byEncoder[].packedTokensTotal",
    "packed.byEncoder[].tokensSaved",
    "packed.byEncoder[].tokensSavedRatio",
  ]),
  ...dispositions("predictiveContext", "rendered", [
    "predictiveContext.policyMode",
    "predictiveContext.outcomeSamples",
    "predictiveContext.suppressedPrefetch",
    "predictiveContext.acceptedPrefetch",
    "predictiveContext.hitRatePct",
    "predictiveContext.wasteRatePct",
    "predictiveContext.avgLatencyReductionMs",
    "predictiveContext.topStrategies[].strategy",
    "predictiveContext.topStrategies[].resourceKind",
    "predictiveContext.topStrategies[].samples",
    "predictiveContext.topStrategies[].hitRatePct",
    "predictiveContext.topStrategies[].acceptedRatePct",
    "predictiveContext.topStrategies[].wasteRatePct",
    "predictiveContext.topStrategies[].score",
    "predictiveContext.topStrategies[].suppressed",
  ]),
  ...dispositions("health", "rendered", [
    "health.score",
    "health.components.freshness",
    "health.components.coverage",
    "health.components.errorRate",
    "health.components.edgeQuality",
    "health.components.callResolution",
    "health.watcherRunning",
    "health.watcherProvider",
    "health.watcherConfiguredProvider",
    "health.watcherFallbackReason",
    "health.watcherQueueDepth",
    "health.watcherStale",
    "health.watcherErrors",
    "health.watcherRestartCount",
    "health.watcherWatchmanWarningCount",
    "health.watcherWatchmanWarnings[]",
    "health.watcherWatchmanVersion",
    "health.watcherWatchmanWatchRoot",
    "health.watcherWatchmanRelativePath",
    "health.watcherWatchmanLastClock",
    "health.watcherWatchmanRecrawlCount",
    "health.watcherWatchmanFreshInstanceCount",
  ]),
  ...dispositions("latency", "rendered", [
    "latency.avgMs",
    "latency.p50Ms",
    "latency.p95Ms",
    "latency.p99Ms",
    "latency.maxMs",
    "latency.perTool[].count",
    "latency.perTool[].avgMs",
    "latency.perTool[].p95Ms",
    "latency.perTool[].errorCount",
    "latency.perTool[].phases[].count",
    "latency.perTool[].phases[].avgMs",
    "latency.perTool[].phases[].p95Ms",
    "latency.perTool[].phases[].maxMs",
  ]),
  ...dispositions("resources", "sessionOnly", [
    "pool.dispatchActive",
    "pool.dispatchQueued",
    "pool.dispatchMax",
    "pool.maxDispatchActive",
    "pool.maxDispatchQueued",
    "pool.avgWriteQueued",
    "pool.maxWriteQueued",
    "pool.avgWriteActive",
    "pool.avgDrainQueueDepth",
    "pool.maxDrainQueueDepth",
    "pool.totalDrainFailures",
  ]),
  ...dispositions("scip", "rendered", [
    "scip.totalIngests",
    "scip.successCount",
    "scip.failureCount",
    "scip.totalEdgesCreated",
    "scip.totalEdgesUpgraded",
    "scip.avgIngestMs",
    "scip.lastIngestAt",
  ]),
  ...dispositions("ppr", "rendered", [
    "ppr.totalRuns",
    "ppr.nativeCount",
    "ppr.jsCount",
    "ppr.fallbackCount",
    "ppr.nativeRatio",
    "ppr.avgComputeMs",
    "ppr.p95ComputeMs",
    "ppr.avgTouched",
    "ppr.avgSeedCount",
  ]),
  ...dispositions("resources", "sessionOnly", [
    "resources.cpuPctAvg",
    "resources.cpuPctMax",
    "resources.rssMb",
    "resources.rssMbMax",
    "resources.heapUsedMb",
    "resources.heapTotalMb",
    "resources.eventLoopLagP95Ms",
    "resources.eventLoopLagMaxMs",
  ]),
  ...dispositions("bottleneck", "derived", [
    "bottleneck.dominant",
    "bottleneck.confidence",
    "bottleneck.topSignals[].name",
    "bottleneck.topSignals[].value",
    "bottleneck.topSignals[].unit",
    "bottleneck.topSignals[].weight",
  ]),
  ...dispositions("toolVolume", "rendered", [
    "toolVolume.totalCalls",
    "toolVolume.perTool[]",
    "toolVolume.perToolErrors[]",
    "toolVolume.callsPerMinute",
  ]),
  ...dispositions("postIndex", "sessionOnly", [
    "auditBuffer.depth",
    "auditBuffer.maxDepth",
    "auditBuffer.droppedTotal",
    "auditBuffer.sessionActive",
  ]),
  ...dispositions("postIndex", "rendered", [
    "postIndexSession.totalSessions",
    "postIndexSession.avgDurationMs",
    "postIndexSession.p50DurationMs",
    "postIndexSession.p95DurationMs",
    "postIndexSession.p99DurationMs",
    "postIndexSession.maxDurationMs",
    "postIndexSession.timeoutCount",
    "postIndexSession.lastDurationMs",
    "postIndexSession.lastTimedOut",
    "postIndexSession.lastEndedAt",
  ]),
  ...dispositions("toolOutput", "rendered", [
    "toolOutput.schemaVersion",
    "toolOutput.overall.calls",
    "toolOutput.overall.errors",
    "toolOutput.overall.rawBytesTotal",
    "toolOutput.overall.projectedBytesTotal",
    "toolOutput.overall.rawTokensTotal",
    "toolOutput.overall.projectedTokensTotal",
    "toolOutput.overall.reductionRatio",
    "toolOutput.overall.removedFieldTotal",
    "toolOutput.overall.handledCount",
    "toolOutput.overall.handledRate",
    "toolOutput.overall.truncatedCount",
    "toolOutput.overall.truncatedRate",
    "toolOutput.overall.detailCounts.summary",
    "toolOutput.overall.detailCounts.compact",
    "toolOutput.overall.detailCounts.standard",
    "toolOutput.overall.detailCounts.full",
    "toolOutput.overall.profileCounts[]",
    "toolOutput.overall.recoveryEmittedCount",
    "toolOutput.overall.invalidRecoveryCount",
    "toolOutput.overall.p50ProjectedBytes",
    "toolOutput.overall.p95ProjectedBytes",
    "toolOutput.overall.maxProjectedBytes",
    "toolOutput.overall.p50ProjectedTokens",
    "toolOutput.overall.p95ProjectedTokens",
    "toolOutput.overall.maxProjectedTokens",
    "toolOutput.perTool[].tool",
    "toolOutput.perTool[].calls",
    "toolOutput.perTool[].errors",
    "toolOutput.perTool[].rawBytesTotal",
    "toolOutput.perTool[].projectedBytesTotal",
    "toolOutput.perTool[].rawTokensTotal",
    "toolOutput.perTool[].projectedTokensTotal",
    "toolOutput.perTool[].reductionRatio",
    "toolOutput.perTool[].removedFieldTotal",
    "toolOutput.perTool[].handledCount",
    "toolOutput.perTool[].handledRate",
    "toolOutput.perTool[].truncatedCount",
    "toolOutput.perTool[].truncatedRate",
    "toolOutput.perTool[].detailCounts.summary",
    "toolOutput.perTool[].detailCounts.compact",
    "toolOutput.perTool[].detailCounts.standard",
    "toolOutput.perTool[].detailCounts.full",
    "toolOutput.perTool[].profileCounts[]",
    "toolOutput.perTool[].recoveryEmittedCount",
    "toolOutput.perTool[].invalidRecoveryCount",
    "toolOutput.perTool[].p50ProjectedBytes",
    "toolOutput.perTool[].p95ProjectedBytes",
    "toolOutput.perTool[].maxProjectedBytes",
    "toolOutput.perTool[].p50ProjectedTokens",
    "toolOutput.perTool[].p95ProjectedTokens",
    "toolOutput.perTool[].maxProjectedTokens",
  ]),
});

export const TIMESERIES_PANEL_MAP = Object.freeze({
  cacheHitRate: Object.freeze({ panel: "cache", field: "hitRateSpark" }),
  p95LatencyMs: Object.freeze({ panel: "latency", field: "p95Ms" }),
  queueDepth: Object.freeze({ panel: "resources", field: "avgWriteQueued" }),
  drainQueueDepth: Object.freeze({ panel: "resources", field: "avgDrainQueueDepth" }),
  filesPerMinute: Object.freeze({ panel: "indexing", field: "filesPerMinute" }),
  errorRate: Object.freeze({ panel: "health", field: "components.errorRate" }),
  tokensUsedPerMin: Object.freeze({ panel: "tokenEfficiency", field: "totalUsed" }),
  tokensSavedPerMin: Object.freeze({ panel: "tokenEfficiency", field: "totalSaved" }),
  toolOutputRawBytes: Object.freeze({ panel: "toolOutput", field: "overall.rawBytesTotal" }),
  toolOutputProjectedBytes: Object.freeze({ panel: "toolOutput", field: "overall.projectedBytesTotal" }),
  toolOutputRawTokens: Object.freeze({ panel: "toolOutput", field: "overall.rawTokensTotal" }),
  toolOutputProjectedTokens: Object.freeze({ panel: "toolOutput", field: "overall.projectedTokensTotal" }),
  cpuPct: Object.freeze({ panel: "resources", field: "cpuPctAvg" }),
  rssMb: Object.freeze({ panel: "resources", field: "rssMb" }),
  heapUsedMb: Object.freeze({ panel: "resources", field: "heapUsedMb" }),
  eventLoopLagMs: Object.freeze({ panel: "resources", field: "eventLoopLagP95Ms" }),
});

export const SCOPE_LABELS = Object.freeze({
  session: "SESSION",
  repositoryLifetime: "REPO LIFETIME",
  current: "CURRENT",
  serverPeak: "SERVER PEAK",
});

function compareKeys(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function immutableClone(value) {
  if (value === null || typeof value !== "object") return value;
  const clone = structuredClone(value);
  const freeze = (item) => {
    if (item === null || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const nested of Object.values(item)) freeze(nested);
    return Object.freeze(item);
  };
  return freeze(clone);
}

export function stableRecordRows(record) {
  return Object.freeze(
    Object.keys(record ?? {})
      .sort(compareKeys)
      .map((key) => Object.freeze({ key, value: immutableClone(record[key]) })),
  );
}

export function stableArrayRows(rows, key) {
  return Object.freeze(
    [...(rows ?? [])]
      .sort((left, right) => compareKeys(left?.[key], right?.[key]))
      .map((row) => immutableClone(row)),
  );
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return null;
  const fraction = (match[7] ?? "").padEnd(9, "0");
  const parsed = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction.slice(0, 3)}${match[8]}`,
  );
  return Number.isFinite(parsed)
    ? BigInt(parsed) * NANOSECONDS_PER_MILLISECOND + BigInt(fraction.slice(3))
    : null;
}

function withinAge(later, earlier, maximumAgeMs) {
  return later - earlier <= BigInt(maximumAgeMs) * NANOSECONDS_PER_MILLISECOND;
}

function ageMilliseconds(later, earlier) {
  const age = later - earlier;
  return age <= 0n ? 0 : Number(age / NANOSECONDS_PER_MILLISECOND);
}

function validInterval(value) {
  return Number.isInteger(value) && value >= 250 && value <= 60_000;
}

function staleAfterMs(sampleIntervalMs) {
  return Math.max(sampleIntervalMs * 3, 10_000);
}

function validAge(value) {
  return Number.isFinite(value) && value >= 0;
}

const SECTION_IDS = [
  "cache", "retrieval", "beam", "delta", "indexing", "tokenEfficiency",
  "predictiveContext", "health", "latency", "pool", "scip", "packed",
  "ppr", "auditBuffer", "postIndex", "toolOutput", "resources",
];
const DYNAMIC_KEY = /^(?:__other__|k:[A-Za-z0-9._:-]{1,64})$/;
const RECOVERY_REASONS = new Set([
  "unknownSchema", "corruptCandidates", "indeterminatePublication",
]);
const READY_STATES = new Set(["ready", "degraded", "readOnly", "capacityExceeded"]);

// The browser cannot import the server's Zod graph, so this guard mirrors the
// closed LifetimeEnvelopeV1 wire shape before any value reaches presentation.
function plainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const optional = (schema) => ({ kind: "optional", schema });
const arrayOf = (schema, maximum = 128) => ({ kind: "array", schema, maximum });
const recordOf = (schema, maximum = 128) => ({ kind: "record", schema, maximum });

// The same small schema tree drives validation and leaf inventory, so new
// compiler fields cannot silently bypass the browser trust boundary.
function validWireValue(value, schema) {
  if (typeof schema === "function") return schema(value);
  if (schema.kind === "optional") return value === undefined || validWireValue(value, schema.schema);
  if (schema.kind === "array") {
    return Array.isArray(value) && value.length <= schema.maximum
      && value.every((item) => validWireValue(item, schema.schema));
  }
  if (schema.kind === "record") {
    if (!plainRecord(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= schema.maximum && entries.every(([key, item]) =>
      key.length > 0 && key.length <= 256 && !/[\u0000-\u001f]/.test(key)
      && validWireValue(item, schema.schema));
  }
  if (!plainRecord(value)) return false;
  const keys = Object.keys(schema);
  if (Object.keys(value).some((key) => !Object.hasOwn(schema, key))) return false;
  return keys.every((key) => schema[key].kind === "optional"
    ? !Object.hasOwn(value, key) || value[key] === undefined
      || validWireValue(value[key], schema[key].schema)
    : Object.hasOwn(value, key) && validWireValue(value[key], schema[key]));
}

function wireLeafPaths(schema, path = "") {
  if (typeof schema === "function") return [path];
  if (schema.kind === "optional") return wireLeafPaths(schema.schema, path);
  if (schema.kind === "array" || schema.kind === "record") {
    return wireLeafPaths(schema.schema, `${path}[]`);
  }
  return Object.entries(schema).flatMap(([key, child]) =>
    wireLeafPaths(child, path ? `${path}.${key}` : key));
}

const finiteMetric = (value) =>
  typeof value === "number" && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const percentage = (value) => finiteMetric(value) && value <= 100;
const ratio = (value) => finiteMetric(value) && value <= 1;
const integerMetric = (value) => Number.isSafeInteger(value) && value >= 0;
const booleanValue = (value) => typeof value === "boolean";
const boundedString = (value) => typeof value === "string" && value.length <= 4_096;
const nullableString = (value) => value === null || boundedString(value);
const timestampString = (value) => timestamp(value) !== null;
const nullableTimestampString = (value) => value === null || timestampString(value);

const latencyPhaseSchema = {
  count: integerMetric,
  avgMs: finiteMetric,
  p95Ms: finiteMetric,
  maxMs: finiteMetric,
};
const tokenSavingsLayerSchema = {
  source: boundedString,
  events: integerMetric,
  realizedEvents: integerMetric,
  estimatedTokensAvoided: integerMetric,
  originalTokens: integerMetric,
  returnedTokens: integerMetric,
  savedTokens: integerMetric,
  opportunities: integerMetric,
  hits: integerMetric,
  hitRatePct: percentage,
  storedBytes: integerMetric,
};
const toolOutputMetricSchema = {
  calls: integerMetric,
  errors: integerMetric,
  rawBytesTotal: integerMetric,
  projectedBytesTotal: integerMetric,
  rawTokensTotal: integerMetric,
  projectedTokensTotal: integerMetric,
  reductionRatio: ratio,
  removedFieldTotal: integerMetric,
  handledCount: integerMetric,
  handledRate: ratio,
  truncatedCount: integerMetric,
  truncatedRate: ratio,
  detailCounts: {
    summary: optional(integerMetric),
    compact: optional(integerMetric),
    standard: optional(integerMetric),
    full: optional(integerMetric),
  },
  profileCounts: recordOf(integerMetric),
  recoveryEmittedCount: integerMetric,
  invalidRecoveryCount: integerMetric,
  p50ProjectedBytes: integerMetric,
  p95ProjectedBytes: integerMetric,
  maxProjectedBytes: integerMetric,
  p50ProjectedTokens: integerMetric,
  p95ProjectedTokens: integerMetric,
  maxProjectedTokens: integerMetric,
};

const OBSERVABILITY_SNAPSHOT_SCHEMA = {
  schemaVersion: (value) => value === 1,
  generatedAt: timestampString,
  repoId: (value) => typeof value === "string" && value.length >= 1 && value.length <= 128,
  uptimeMs: finiteMetric,
  cache: {
    overallHitRatePct: percentage,
    totalHits: integerMetric,
    totalMisses: integerMetric,
    perSource: recordOf({
      source: boundedString,
      hits: integerMetric,
      misses: integerMetric,
      hitRatePct: percentage,
      avgLatencyMs: finiteMetric,
    }),
    avgLookupLatencyMs: finiteMetric,
  },
  retrieval: {
    totalRetrievals: integerMetric,
    avgLatencyMs: finiteMetric,
    p95LatencyMs: finiteMetric,
    byMode: recordOf(integerMetric),
    candidateCountPerSource: recordOf(integerMetric),
    phaseLatencyMs: recordOf(latencyPhaseSchema),
    byRetrievalType: recordOf(integerMetric),
    emptyResultCount: integerMetric,
  },
  beam: {
    totalSliceBuilds: integerMetric,
    avgBuildMs: finiteMetric,
    p95BuildMs: finiteMetric,
    avgAccepted: finiteMetric,
    avgEvicted: finiteMetric,
    avgRejected: finiteMetric,
    avgFrontierMaxSize: finiteMetric,
    p95FrontierMaxSize: finiteMetric,
    retainedExplainHandles: integerMetric,
  },
  delta: {
    totalBlastRadiusComputations: integerMetric,
    avgBlastRadiusLatencyMs: finiteMetric,
    p95BlastRadiusLatencyMs: finiteMetric,
    avgDbRoundTripsPerChangedSymbol: finiteMetric,
    avgPathExplanationLatencyMs: finiteMetric,
    p95PathExplanationLatencyMs: finiteMetric,
    fallbackPathQueryCount: integerMetric,
  },
  indexing: {
    totalEvents: integerMetric,
    filesPerMinute: finiteMetric,
    avgPass1Ms: finiteMetric,
    avgPass2Ms: finiteMetric,
    phaseCounts: recordOf(integerMetric),
    perLanguageAvgMs: recordOf(finiteMetric),
    engineDispatch: { rust: integerMetric, ts: integerMetric },
    failures: integerMetric,
    derivedStateLagMs: (value) => value === null || finiteMetric(value),
  },
  tokenEfficiency: {
    totalUsed: integerMetric,
    totalSaved: integerMetric,
    savingsRatio: ratio,
    avgPerCall: finiteMetric,
    compressionLayers: {
      totalEvents: integerMetric,
      totalRealizedEvents: integerMetric,
      totalEstimatedTokensAvoided: integerMetric,
      totalOriginalTokens: integerMetric,
      totalReturnedTokens: integerMetric,
      totalSavedTokens: integerMetric,
      totalStoredBytes: integerMetric,
      bySource: recordOf(tokenSavingsLayerSchema),
      byTool: recordOf({ tool: boundedString, ...tokenSavingsLayerSchema }),
    },
  },
  predictiveContext: {
    policyMode: (value) => ["disabled", "observe", "safe"].includes(value),
    outcomeSamples: integerMetric,
    suppressedPrefetch: integerMetric,
    acceptedPrefetch: integerMetric,
    hitRatePct: percentage,
    wasteRatePct: percentage,
    avgLatencyReductionMs: finiteMetric,
    topStrategies: arrayOf({
      strategy: boundedString,
      resourceKind: boundedString,
      samples: integerMetric,
      hitRatePct: percentage,
      acceptedRatePct: percentage,
      wasteRatePct: percentage,
      score: finiteMetric,
      suppressed: integerMetric,
    }),
  },
  health: {
    score: percentage,
    components: {
      freshness: ratio,
      coverage: ratio,
      errorRate: ratio,
      edgeQuality: ratio,
      callResolution: ratio,
    },
    watcherRunning: booleanValue,
    watcherProvider: optional(nullableString),
    watcherConfiguredProvider: optional(nullableString),
    watcherFallbackReason: optional(nullableString),
    watcherQueueDepth: integerMetric,
    watcherStale: booleanValue,
    watcherErrors: integerMetric,
    watcherRestartCount: integerMetric,
    watcherWatchmanWarningCount: optional(integerMetric),
    watcherWatchmanWarnings: optional(arrayOf(boundedString)),
    watcherWatchmanVersion: optional(boundedString),
    watcherWatchmanWatchRoot: optional(boundedString),
    watcherWatchmanRelativePath: optional(nullableString),
    watcherWatchmanLastClock: optional(nullableString),
    watcherWatchmanRecrawlCount: optional(integerMetric),
    watcherWatchmanFreshInstanceCount: optional(integerMetric),
  },
  latency: {
    avgMs: finiteMetric,
    p50Ms: finiteMetric,
    p95Ms: finiteMetric,
    p99Ms: finiteMetric,
    maxMs: finiteMetric,
    perTool: recordOf({
      count: integerMetric,
      avgMs: finiteMetric,
      p95Ms: finiteMetric,
      errorCount: integerMetric,
      phases: optional(recordOf(latencyPhaseSchema)),
    }),
  },
  pool: {
    dispatchActive: integerMetric,
    dispatchQueued: integerMetric,
    dispatchMax: integerMetric,
    maxDispatchActive: integerMetric,
    maxDispatchQueued: integerMetric,
    avgWriteQueued: finiteMetric,
    maxWriteQueued: integerMetric,
    avgWriteActive: finiteMetric,
    avgDrainQueueDepth: finiteMetric,
    maxDrainQueueDepth: integerMetric,
    totalDrainFailures: integerMetric,
  },
  scip: {
    totalIngests: integerMetric,
    successCount: integerMetric,
    failureCount: integerMetric,
    totalEdgesCreated: integerMetric,
    totalEdgesUpgraded: integerMetric,
    avgIngestMs: finiteMetric,
    lastIngestAt: nullableTimestampString,
  },
  packed: {
    totalDecisions: integerMetric,
    packedCount: integerMetric,
    fallbackCount: integerMetric,
    packedAdoptionPct: percentage,
    packedBytesTotal: integerMetric,
    jsonBaselineBytesTotal: integerMetric,
    bytesSaved: integerMetric,
    bytesSavedRatio: ratio,
    packedTokensTotal: integerMetric,
    jsonBaselineTokensTotal: integerMetric,
    tokensSaved: integerMetric,
    tokensSavedRatio: ratio,
    axisHits: { bytes: integerMetric, tokens: integerMetric, none: integerMetric },
    perEncoder: recordOf(integerMetric),
    byEncoder: recordOf({
      totalDecisions: integerMetric,
      packedCount: integerMetric,
      fallbackCount: integerMetric,
      packedAdoptionPct: percentage,
      jsonBaselineBytesTotal: integerMetric,
      packedBytesTotal: integerMetric,
      bytesSaved: integerMetric,
      bytesSavedRatio: ratio,
      jsonBaselineTokensTotal: integerMetric,
      packedTokensTotal: integerMetric,
      tokensSaved: integerMetric,
      tokensSavedRatio: ratio,
    }),
  },
  ppr: {
    totalRuns: integerMetric,
    nativeCount: integerMetric,
    jsCount: integerMetric,
    fallbackCount: integerMetric,
    nativeRatio: ratio,
    avgComputeMs: finiteMetric,
    p95ComputeMs: finiteMetric,
    avgTouched: finiteMetric,
    avgSeedCount: finiteMetric,
  },
  resources: {
    cpuPctAvg: percentage,
    cpuPctMax: percentage,
    rssMb: finiteMetric,
    rssMbMax: finiteMetric,
    heapUsedMb: finiteMetric,
    heapTotalMb: finiteMetric,
    eventLoopLagP95Ms: finiteMetric,
    eventLoopLagMaxMs: finiteMetric,
  },
  bottleneck: {
    dominant: (value) => [
      "cpu_bound", "memory_pressure", "db_latency", "indexer_parse", "io_throughput", "balanced",
    ].includes(value),
    confidence: ratio,
    topSignals: arrayOf({
      name: boundedString,
      value: finiteMetric,
      unit: boundedString,
      weight: finiteMetric,
    }),
  },
  toolVolume: {
    totalCalls: integerMetric,
    perTool: recordOf(integerMetric),
    perToolErrors: recordOf(integerMetric),
    callsPerMinute: finiteMetric,
  },
  auditBuffer: {
    depth: integerMetric,
    maxDepth: integerMetric,
    droppedTotal: integerMetric,
    sessionActive: booleanValue,
  },
  postIndexSession: {
    totalSessions: integerMetric,
    avgDurationMs: finiteMetric,
    p50DurationMs: finiteMetric,
    p95DurationMs: finiteMetric,
    p99DurationMs: finiteMetric,
    maxDurationMs: finiteMetric,
    timeoutCount: integerMetric,
    lastDurationMs: finiteMetric,
    lastTimedOut: booleanValue,
    lastEndedAt: nullableTimestampString,
  },
  toolOutput: {
    schemaVersion: (value) => value === 1,
    overall: toolOutputMetricSchema,
    perTool: arrayOf({ tool: boundedString, ...toolOutputMetricSchema }),
  },
};

export const SNAPSHOT_VALIDATOR_PATHS = Object.freeze(
  wireLeafPaths(OBSERVABILITY_SNAPSHOT_SCHEMA),
);

export function validObservabilitySnapshot(value) {
  return validWireValue(value, OBSERVABILITY_SNAPSHOT_SCHEMA);
}

const TIMESERIES_VALUE_FIELDS = Object.freeze({
  cacheHitRate: "hitRate",
  p95LatencyMs: "p95LatencyMs",
  queueDepth: "queueDepth",
  drainQueueDepth: "drainQueueDepth",
  filesPerMinute: "filesPerMinute",
  errorRate: "errorRate",
  tokensUsedPerMin: "tokensUsedPerMin",
  tokensSavedPerMin: "tokensSavedPerMin",
  toolOutputRawBytes: "rawBytes",
  toolOutputProjectedBytes: "projectedBytes",
  toolOutputRawTokens: "rawTokens",
  toolOutputProjectedTokens: "projectedTokens",
  cpuPct: "cpuPct",
  rssMb: "rssMb",
  heapUsedMb: "heapUsedMb",
  eventLoopLagMs: "eventLoopLagMs",
});

export function validTimeseries15mResponse(value, repoId) {
  if (!plainRecord(value) || value.schemaVersion !== 1 || value.repoId !== repoId
    || value.window !== "15m" || !Number.isSafeInteger(value.resolutionMs)
    || value.resolutionMs <= 0 || !plainRecord(value.series)
    || Object.keys(value).length !== 5
    || Object.keys(value.series).length !== Object.keys(TIMESERIES_VALUE_FIELDS).length) return false;
  return Object.entries(TIMESERIES_VALUE_FIELDS).every(([seriesName, valueField]) => {
    const points = value.series[seriesName];
    if (!Array.isArray(points) || points.length > 900) return false;
    let previous = Number.NEGATIVE_INFINITY;
    return points.every((point) => {
      if (!plainRecord(point) || Object.keys(point).length !== 2
        || !Number.isSafeInteger(point.t) || point.t < 0 || point.t < previous
        || typeof point[valueField] !== "number" || !Number.isFinite(point[valueField])) return false;
      previous = point.t;
      return true;
    });
  });
}

function exactRecord(value, validators) {
  if (!plainRecord(value)) return false;
  const keys = Object.keys(validators);
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every(
    (key) => Object.hasOwn(value, key) && validators[key](value[key]),
  );
}

const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const finiteTotal = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const nullableTimestamp = (value) => value === null || timestamp(value) !== null;
const isNull = (value) => value === null;

function boundedMap(value, maximumKeys, validateValue) {
  if (!plainRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length > maximumKeys + 1 ||
    keys.filter((key) => key !== "__other__").length > maximumKeys
  ) return false;
  return keys.every(
    (key) => DYNAMIC_KEY.test(key) && validateValue(value[key]),
  );
}

const counterMap = (value) => boundedMap(value, 32, counter);
const sampleTotal = (value) => exactRecord(value, {
  count: counter,
  sum: finiteTotal,
  max: finiteTotal,
});
const sampleMap = (value) => boundedMap(value, 32, sampleTotal);

const cacheSection = (value) => exactRecord(value, {
  hits: counter,
  misses: counter,
  lookupMs: sampleTotal,
  perSource: (map) => boundedMap(map, 32, (entry) => exactRecord(entry, {
    hits: counter,
    misses: counter,
    lookupMs: sampleTotal,
  })),
});
const retrievalSection = (value) => exactRecord(value, {
  calls: counter,
  emptyResults: counter,
  latencyMs: sampleTotal,
  byMode: counterMap,
  byType: counterMap,
  candidatesBySource: counterMap,
  phaseLatencyMs: sampleMap,
});
const beamSection = (value) => exactRecord(value, {
  builds: counter,
  buildMs: sampleTotal,
  accepted: counter,
  evicted: counter,
  rejected: counter,
  frontierMax: sampleTotal,
  retainedHandlesPeak: counter,
});
const deltaSection = (value) => exactRecord(value, {
  computations: counter,
  blastRadiusMs: sampleTotal,
  dbRoundTrips: sampleTotal,
  pathExplanationMs: sampleTotal,
  fallbackPathQueries: counter,
});
const indexingSection = (value) => exactRecord(value, {
  events: counter,
  pass1Ms: sampleTotal,
  pass2Ms: sampleTotal,
  failures: counter,
  phaseCounts: counterMap,
  languageMs: sampleMap,
  engineDispatch: counterMap,
  derivedLagMs: sampleTotal,
});
const compressionSource = (value) => exactRecord(value, {
  events: counter,
  realizedEvents: counter,
  estimatedTokensAvoided: counter,
  originalTokens: counter,
  returnedTokens: counter,
  savedTokens: counter,
  opportunities: counter,
  hits: counter,
  storedBytes: counter,
});
const tokenSection = (value) => exactRecord(value, {
  calls: counter,
  usedTokens: counter,
  savedTokens: counter,
  compressionBySource: (map) => boundedMap(map, 32, compressionSource),
});
const predictiveStrategy = (value) => exactRecord(value, {
  samples: counter,
  hits: counter,
  wasted: counter,
  accepted: counter,
  suppressed: counter,
  latencyReductionMs: sampleTotal,
});
const predictiveSection = (value) => exactRecord(value, {
  outcomeSamples: counter,
  hitOutcomes: counter,
  wasteOutcomes: counter,
  accepted: counter,
  suppressed: counter,
  latencyReductionMs: sampleTotal,
  byStrategy: (map) => boundedMap(map, 32, predictiveStrategy),
});
const healthSection = (value) => exactRecord(value, {
  watcherErrors: counter,
  watcherRestarts: counter,
  watchmanWarnings: counter,
  watchmanRecrawls: counter,
  watchmanFreshInstances: counter,
});
const countSampleErrors = (value) => exactRecord(value, {
  calls: counter,
  errors: counter,
  durationMs: sampleTotal,
});
const latencySection = (value) => exactRecord(value, {
  calls: counter,
  errors: counter,
  durationMs: sampleTotal,
  perTool: (map) => boundedMap(map, 128, countSampleErrors),
});
const scipSection = (value) => exactRecord(value, {
  ingests: counter,
  successes: counter,
  failures: counter,
  edgesCreated: counter,
  edgesUpgraded: counter,
  ingestMs: sampleTotal,
});
const packedEncoder = (value) => exactRecord(value, {
  decisions: counter,
  packed: counter,
  fallback: counter,
  packedBytes: counter,
  baselineBytes: counter,
  packedTokens: counter,
  baselineTokens: counter,
});
const packedSection = (value) => exactRecord(value, {
  decisions: counter,
  packed: counter,
  fallback: counter,
  packedBytes: counter,
  baselineBytes: counter,
  packedTokens: counter,
  baselineTokens: counter,
  axisHits: counterMap,
  byEncoder: (map) => boundedMap(map, 128, packedEncoder),
});
const pprSection = (value) => exactRecord(value, {
  runs: counter,
  native: counter,
  javascript: counter,
  fallback: counter,
  computeMs: sampleTotal,
  touched: sampleTotal,
  seeds: sampleTotal,
});
const postIndexSection = (value) => exactRecord(value, {
  sessions: counter,
  durationMs: sampleTotal,
  timeouts: counter,
});
const toolOutputCounters = {
  calls: counter,
  errors: counter,
  rawBytes: counter,
  projectedBytes: counter,
  rawTokens: counter,
  projectedTokens: counter,
  removedFields: counter,
  handled: counter,
  truncated: counter,
  recoveryEmitted: counter,
  invalidRecovery: counter,
  projectedBytesMax: counter,
  projectedTokensMax: counter,
  detailCounts: counterMap,
  profileCounts: counterMap,
};
const toolOutputCounterRecord = (value) => exactRecord(value, toolOutputCounters);
const toolOutputSection = (value) => exactRecord(value, {
  ...toolOutputCounters,
  perTool: (map) => boundedMap(map, 128, toolOutputCounterRecord),
});

const sectionValidators = {
  cache: cacheSection,
  retrieval: retrievalSection,
  beam: beamSection,
  delta: deltaSection,
  indexing: indexingSection,
  tokenEfficiency: tokenSection,
  predictiveContext: predictiveSection,
  health: healthSection,
  latency: latencySection,
  pool: isNull,
  scip: scipSection,
  packed: packedSection,
  ppr: pprSection,
  auditBuffer: isNull,
  postIndex: postIndexSection,
  toolOutput: toolOutputSection,
  resources: isNull,
};

function lifetimeSections(value) {
  if (!plainRecord(value) || Object.keys(value).length !== SECTION_IDS.length) return false;
  return SECTION_IDS.every((section) => {
    if (!Object.hasOwn(value, section)) return false;
    const sectionValue = value[section];
    return sectionValue === null || sectionValidators[section](sectionValue);
  });
}

const freshnessValidators = Object.fromEntries(
  SECTION_IDS.map((section) => [section, nullableTimestamp]),
);
const freshness = (value) => exactRecord(value, freshnessValidators);
const processPeaks = (value) => exactRecord(value, {
  cpuPct: finiteTotal,
  rssMb: finiteTotal,
  heapUsedMb: finiteTotal,
  heapTotalMb: finiteTotal,
  eventLoopLagMs: finiteTotal,
});

function validReadyEnvelope(value) {
  if (!exactRecord(value, {
    schemaVersion: (field) => field === 1,
    sampleIntervalMs: validInterval,
    generatedAt: (field) => timestamp(field) !== null,
    repoId: (field) => typeof field === "string" && field.length >= 1 && field.length <= 128,
    epoch: counter,
    resetAt: nullableTimestamp,
    lastCheckpointAt: nullableTimestamp,
    persistenceState: (field) => READY_STATES.has(field),
    sessionCount: counter,
    saturated: (field) => typeof field === "boolean",
    sections: lifetimeSections,
    freshness,
    processPeaks: (field) => field === null || processPeaks(field),
  })) return false;
  if (value.persistenceState !== "capacityExceeded") return true;
  return value.epoch === 0 && value.sessionCount === 0 && value.resetAt === null
    && value.lastCheckpointAt === null && value.saturated === false
    && SECTION_IDS.every((section) => value.sections[section] === null);
}

function validRecoveryEnvelope(value) {
  return exactRecord(value, {
    schemaVersion: (field) => field === 1,
    sampleIntervalMs: validInterval,
    generatedAt: (field) => timestamp(field) !== null,
    repoId: (field) => typeof field === "string" && field.length >= 1 && field.length <= 128,
    persistenceState: (field) => field === "recoveryRequired",
    recoveryReason: (field) => RECOVERY_REASONS.has(field),
  });
}

function validLifetimeEnvelope(value) {
  if (!plainRecord(value)) return false;
  return value.persistenceState === "recoveryRequired"
    ? validRecoveryEnvelope(value)
    : validReadyEnvelope(value);
}

export function sessionPanelState(input) {
  // Receipt timestamps share performance.now()'s monotonic clock. Server ISO
  // timestamps are compared only with other timestamps from server payloads.
  const monotonicNowMs = input?.monotonicNowMs;
  const sessionTransportAgeMs = monotonicNowMs - input?.sessionReceivedAtMs;
  if (
    !validInterval(input?.sampleIntervalMs) ||
    !validAge(monotonicNowMs) ||
    !validAge(input?.sessionReceivedAtMs) ||
    !validAge(sessionTransportAgeMs) ||
    sessionTransportAgeMs > staleAfterMs(input.sampleIntervalMs)
  ) return "STALE";

  const sessionGeneratedAt = timestamp(input.sessionGeneratedAt);
  const lifetimeGeneratedAt = timestamp(input.lifetimeGeneratedAt);
  const lifetimeTransportAgeMs = monotonicNowMs - input.lifetimeReceivedAtMs;
  if (
    input.freshnessAvailable !== true ||
    !validAge(input.lifetimeReceivedAtMs) ||
    !validAge(lifetimeTransportAgeMs) ||
    lifetimeTransportAgeMs > staleAfterMs(input.sampleIntervalMs) ||
    typeof input.sessionRepoId !== "string" ||
    input.sessionRepoId.length === 0 ||
    input.sessionRepoId !== input.lifetimeRepoId ||
    sessionGeneratedAt === null ||
    lifetimeGeneratedAt === null ||
    lifetimeGeneratedAt < sessionGeneratedAt
  ) return "FRESHNESS UNAVAILABLE";

  if (input.sectionPresent !== true || input.lastEventAt === null) return "NO DATA";
  const lastEventAt = timestamp(input.lastEventAt);
  if (lastEventAt === null) return "FRESHNESS UNAVAILABLE";
  return withinAge(lifetimeGeneratedAt, lastEventAt, 60_000) ? "LIVE" : "IDLE";
}

function presentation(state, sections, processPeaks, checkpointAgeMs, warning) {
  return Object.freeze({
    state,
    sections: immutableClone(sections),
    processPeaks: immutableClone(processPeaks),
    checkpointAgeMs,
    warning,
  });
}

export function lifetimePresentation(envelope, transportAgeMs) {
  if (envelope === null || envelope === undefined) {
    return presentation("UNAVAILABLE", null, null, null, "Lifetime metrics are unavailable.");
  }
  if (!validLifetimeEnvelope(envelope)) {
    return presentation("UNAVAILABLE", null, null, null, "Lifetime metrics are unavailable.");
  }

  if (
    !validInterval(envelope.sampleIntervalMs) ||
    !validAge(transportAgeMs) ||
    timestamp(envelope.generatedAt) === null ||
    transportAgeMs > staleAfterMs(envelope.sampleIntervalMs)
  ) {
    const recovery = envelope.persistenceState === "recoveryRequired";
    const capacity = envelope.persistenceState === "capacityExceeded";
    return presentation(
      "STALE",
      recovery || capacity ? null : envelope.sections ?? null,
      recovery ? null : envelope.processPeaks ?? null,
      null,
      "Lifetime metrics are stale.",
    );
  }

  if (envelope.persistenceState === "recoveryRequired") {
    return presentation("RECOVERY REQUIRED", null, null, null, "Lifetime recovery is required.");
  }

  const generatedAt = timestamp(envelope.generatedAt);
  const lastCheckpointAt = timestamp(envelope.lastCheckpointAt);
  const checkpointAgeMs = generatedAt !== null && lastCheckpointAt !== null
    ? ageMilliseconds(generatedAt, lastCheckpointAt)
    : null;

  if (envelope.persistenceState === "readOnly") {
    return presentation("READ ONLY", envelope.sections ?? null, envelope.processPeaks ?? null, checkpointAgeMs, null);
  }
  if (envelope.persistenceState === "capacityExceeded") {
    return presentation(
      "CAPACITY EXCEEDED",
      null,
      envelope.processPeaks ?? null,
      null,
      "The per-directory repository lifetime limit is exceeded.",
    );
  }
  if (envelope.persistenceState === "degraded") {
    return presentation(
      "DEGRADED",
      envelope.sections ?? null,
      envelope.processPeaks ?? null,
      checkpointAgeMs,
      "The latest lifetime checkpoint failed.",
    );
  }
  if (envelope.persistenceState === "ready") {
    return presentation("CURRENT", envelope.sections ?? null, envelope.processPeaks ?? null, checkpointAgeMs, null);
  }
  return presentation("UNAVAILABLE", null, null, null, "Lifetime metrics are unavailable.");
}
