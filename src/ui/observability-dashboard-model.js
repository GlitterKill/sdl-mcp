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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

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
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  return Math.max(0, lifetimeGeneratedAt - lastEventAt) <= 60_000 ? "LIVE" : "IDLE";
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
    ? Math.max(0, generatedAt - lastCheckpointAt)
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
