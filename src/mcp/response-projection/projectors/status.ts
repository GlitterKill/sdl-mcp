import type {
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";
import { redactMachinePaths } from "../../../util/redact-machine-paths.js";

type ModelRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ModelRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function entries(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function actionName(action: string): string {
  return action.startsWith("sdl.") ? action.slice(4) : action;
}

function rootAvailability(value: unknown): ModelRecord | undefined {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return {
    status: value.status,
    ...(stringValue(value.nextBestAction)
      ? { nextBestAction: value.nextBestAction }
      : {}),
  };
}

function watcherHealth(value: unknown): ModelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const actionable =
    value.enabled === false
    || value.running === false
    || value.stale === true
    || positive(value.errors) !== undefined
    || positive(value.queueDepth) !== undefined
    || stringValue(value.fallbackReason) !== undefined;
  if (!actionable) return undefined;
  return {
    ...(value.enabled === false ? { enabled: false } : {}),
    ...(value.running === false ? { running: false } : {}),
    ...(stringValue(value.fallbackReason)
      ? { fallbackReason: value.fallbackReason }
      : {}),
    ...(positive(value.errors) !== undefined ? { errors: value.errors } : {}),
    ...(positive(value.queueDepth) !== undefined
      ? { queueDepth: value.queueDepth }
      : {}),
    ...(value.stale === true ? { stale: true } : {}),
  };
}

function derivedState(value: unknown): ModelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const integrity = stringValue(value.graphIntegrityState);
  const graphBlocked = integrity !== undefined && integrity !== "verified";
  const structuralStale = value.structuralStale === true;
  const semanticStale = value.semanticStale === true;
  const includeGuidance = graphBlocked || structuralStale || semanticStale;
  const projected = {
    ...(graphBlocked && value.stale === true ? { stale: true } : {}),
    ...(structuralStale ? { structuralStale: true } : {}),
    ...(semanticStale ? { semanticStale: true } : {}),
    ...(value.clustersDirty === true ? { clustersDirty: true } : {}),
    ...(value.processesDirty === true ? { processesDirty: true } : {}),
    ...(value.algorithmsDirty === true ? { algorithmsDirty: true } : {}),
    ...(value.summariesDirty === true ? { summariesDirty: true } : {}),
    ...(value.embeddingsDirty === true ? { embeddingsDirty: true } : {}),
    ...(stringValue(value.lastError) ? { lastError: value.lastError } : {}),
    ...(integrity ? { graphIntegrityState: integrity } : {}),
    ...(includeGuidance && stringValue(value.nextBestAction)
      ? { nextBestAction: value.nextBestAction }
      : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function repoStatus(value: ModelRecord, diagnostics: boolean): ModelRecord {
  const root = rootAvailability(value.rootAvailability);
  const watcher = watcherHealth(value.watcherHealth);
  const derived = derivedState(value.derivedState);
  const operational: ModelRecord = {};
  if (diagnostics) {
    for (const key of [
      "rootPath",
      "healthScore",
      "healthComponents",
      "prefetchStats",
      "serverInfo",
      "liveIndexStatus",
    ]) {
      if (value[key] !== undefined && value[key] !== null) {
        operational[key] = value[key];
      }
    }
  }
  return {
    ...(stringValue(value.repoId) ? { repoId: value.repoId } : {}),
    ...(root ? { rootAvailability: root } : {}),
    ...(stringValue(value.latestVersionId)
      ? { latestVersionId: value.latestVersionId }
      : {}),
    ...(entries(value.indexOperations)
      ? { indexOperations: value.indexOperations }
      : {}),
    ...(positive(value.filesIndexed) !== undefined
      ? { filesIndexed: value.filesIndexed }
      : {}),
    ...(positive(value.symbolsIndexed) !== undefined
      ? { symbolsIndexed: value.symbolsIndexed }
      : {}),
    ...(value.healthAvailable === false ? { healthAvailable: false } : {}),
    ...(watcher ? { watcherHealth: watcher } : {}),
    ...(stringValue(value.watcherNote) ? { watcherNote: value.watcherNote } : {}),
    ...(derived ? { derivedState: derived } : {}),
    ...operational,
  };
}

export function projectBufferStatusForAgent(value: unknown): ModelRecord {
  if (!isRecord(value)) return {};
  const active =
    positive(value.pendingBuffers) !== undefined
    || positive(value.dirtyBuffers) !== undefined
    || positive(value.parseQueueDepth) !== undefined
    || value.checkpointPending === true
    || positive(value.reconcileQueueDepth) !== undefined
    || value.reconcileInflight === true
    || stringValue(value.lastCheckpointError) !== undefined
    || stringValue(value.reconcileLastError) !== undefined;
  return {
    ...(stringValue(value.repoId) ? { repoId: value.repoId } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    state: value.enabled === false ? "unavailable" : active ? "active" : "idle",
    ...(positive(value.pendingBuffers) !== undefined
      ? { pendingBuffers: value.pendingBuffers }
      : {}),
    ...(positive(value.dirtyBuffers) !== undefined
      ? { dirtyBuffers: value.dirtyBuffers }
      : {}),
    ...(positive(value.parseQueueDepth) !== undefined
      ? { parseQueueDepth: value.parseQueueDepth }
      : {}),
    ...(value.checkpointPending === true ? { checkpointPending: true } : {}),
    ...(stringValue(value.lastCheckpointResult)
      ? { lastCheckpointResult: value.lastCheckpointResult }
      : {}),
    ...(stringValue(value.lastCheckpointError)
      ? { lastCheckpointError: value.lastCheckpointError }
      : {}),
    ...(stringValue(value.lastCheckpointReason)
      ? { lastCheckpointReason: value.lastCheckpointReason }
      : {}),
    ...(positive(value.reconcileQueueDepth) !== undefined
      ? { reconcileQueueDepth: value.reconcileQueueDepth }
      : {}),
    ...(value.reconcileInflight === true ? { reconcileInflight: true } : {}),
    ...(stringValue(value.reconcileLastError)
      ? { reconcileLastError: value.reconcileLastError }
      : {}),
  };
}

function feedbackStatus(value: ModelRecord): ModelRecord {
  const rawRows = Array.isArray(value.feedback) ? value.feedback : [];
  const feedback = rawRows.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const row = {
      ...(entries(raw.usefulSymbols) ? { usefulSymbols: raw.usefulSymbols } : {}),
      ...(entries(raw.missingSymbols) ? { missingSymbols: raw.missingSymbols } : {}),
      ...(entries(raw.taskTags) ? { taskTags: raw.taskTags } : {}),
      ...(stringValue(raw.taskType) ? { taskType: raw.taskType } : {}),
      ...(stringValue(raw.taskText) ? { taskText: raw.taskText } : {}),
    };
    return Object.keys(row).length > 0 ? [row] : [];
  });
  const rawAggregate = isRecord(value.aggregatedStats)
    ? value.aggregatedStats
    : undefined;
  const aggregate = rawAggregate
    ? {
        ...(positive(rawAggregate.totalFeedback) !== undefined
          ? { totalFeedback: rawAggregate.totalFeedback }
          : {}),
        ...(entries(rawAggregate.topUsefulSymbols)
          ? { topUsefulSymbols: rawAggregate.topUsefulSymbols }
          : {}),
        ...(entries(rawAggregate.topMissingSymbols)
          ? { topMissingSymbols: rawAggregate.topMissingSymbols }
          : {}),
      }
    : undefined;
  return {
    ...(stringValue(value.repoId) ? { repoId: value.repoId } : {}),
    state: rawRows.length > 0 ? "available" : "empty",
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(aggregate && Object.keys(aggregate).length > 0
      ? { aggregatedStats: aggregate }
      : {}),
    ...(value.hasMore === true ? { hasMore: true } : {}),
  };
}

function metadataDiagnosticCount(metadataJson: unknown): number {
  if (typeof metadataJson !== "string") return 0;
  try {
    const metadata: unknown = JSON.parse(metadataJson);
    if (!isRecord(metadata) || !isRecord(metadata.diagnosticsBySeverity)) {
      return 0;
    }
    return Object.values(metadata.diagnosticsBySeverity).reduce<number>(
      (total, count) =>
        total + (typeof count === "number" && count > 0 ? count : 0),
      0,
    );
  } catch {
    return 0;
  }
}

function semanticRun(
  value: unknown,
  diagnostics: boolean,
): ModelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const diagnosticCount =
    positive(value.diagnosticsCount)
    ?? positive(metadataDiagnosticCount(value.metadataJson));
  return {
    ...(stringValue(value.providerType)
      ? { providerType: value.providerType }
      : {}),
    ...(stringValue(value.providerId) ? { providerId: value.providerId } : {}),
    ...(entries(value.languages) ? { languages: value.languages } : {}),
    ...(stringValue(value.status) ? { status: value.status } : {}),
    ...(positive(value.symbolsMatched) !== undefined
      ? { symbolsMatched: value.symbolsMatched }
      : {}),
    ...(positive(value.edgesCreated) !== undefined
      ? { edgesCreated: value.edgesCreated }
      : {}),
    ...(diagnosticCount !== undefined
      ? { diagnosticsCount: diagnosticCount }
      : {}),
    ...(typeof value.precisionScore === "number"
      ? { precisionScore: value.precisionScore }
      : {}),
    ...(diagnostics && stringValue(value.runId) ? { runId: value.runId } : {}),
    ...(diagnostics && stringValue(value.startedAt)
      ? { startedAt: value.startedAt }
      : {}),
    ...(diagnostics && stringValue(value.finishedAt)
      ? { finishedAt: value.finishedAt }
      : {}),
    ...(diagnostics && stringValue(value.error) ? { error: value.error } : {}),
  };
}

export function projectSemanticEnrichmentStatusForAgent(
  value: unknown,
  limit = 5,
  diagnostics = false,
): ModelRecord {
  if (!isRecord(value)) return {};
  const rawSelections = Array.isArray(value.selections) ? value.selections : [];
  const selections = rawSelections.slice(0, limit).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const selected = isRecord(raw.selected) ? raw.selected : raw;
    const languageId = stringValue(raw.languageId);
    const providerType = stringValue(selected.providerType);
    const providerId = stringValue(selected.providerId);
    return languageId && providerType && providerId
      ? [{ languageId, providerType, providerId }]
      : [];
  });
  const rawSkippedProviders = rawSelections.reduce(
    (total, raw) =>
      total
      + (isRecord(raw) && Array.isArray(raw.skipped) ? raw.skipped.length : 0),
    0,
  );
  const projectedWarnings = isRecord(value.warnings) ? value.warnings : undefined;
  const skippedProviders =
    rawSkippedProviders > 0
      ? rawSkippedProviders
      : positive(projectedWarnings?.skippedProviders) ?? 0;
  const runs = Array.isArray(value.lastRuns) ? value.lastRuns : [];
  const latestRun = semanticRun(runs[0] ?? value.latestRun, diagnostics);
  const diagnosticCount =
    positive(latestRun?.diagnosticsCount)
    ?? positive(projectedWarnings?.diagnostics);
  const projectedAvailability =
    value.availability === "available" || value.availability === "unavailable"
      ? value.availability
      : undefined;
  const availability =
    projectedAvailability
    ?? (value.enabled === true && (selections.length > 0 || latestRun !== undefined)
      ? "available"
      : "unavailable");
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    availability,
    ...(selections.length > 0 ? { selections } : {}),
    ...(latestRun && Object.keys(latestRun).length > 0 ? { latestRun } : {}),
    ...(skippedProviders > 0 || diagnosticCount !== undefined
      ? {
          warnings: {
            ...(skippedProviders > 0 ? { skippedProviders } : {}),
            ...(diagnosticCount !== undefined
              ? { diagnostics: diagnosticCount }
              : {}),
          },
        }
      : {}),
  };
}

function usageAggregate(value: unknown): ModelRecord | undefined {
  if (!isRecord(value)) return undefined;
  const totalSdlTokens = Number(value.totalSdlTokens ?? 0);
  const totalRawEquivalent = Number(value.totalRawEquivalent ?? 0);
  const totalSavedTokens = Number(value.totalSavedTokens ?? 0);
  const callCount = Number(value.callCount ?? value.totalCalls ?? 0);
  if (
    totalSdlTokens === 0
    && totalRawEquivalent === 0
    && totalSavedTokens === 0
    && callCount === 0
  ) return undefined;
  return {
    totalSdlTokens,
    totalRawEquivalent,
    totalSavedTokens,
    savingsPercent: Number(
      value.overallSavingsPercent ?? value.savingsPercent ?? 0,
    ),
    callCount,
  };
}

const USAGE_VOLATILE_FIELDS = new Set([
  "pid",
  "process",
  "processId",
  "sessionId",
  "startedAt",
  "timestamp",
]);

/** Remove process/session volatility recursively while preserving canonical data. */
function sanitizeUsageValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeUsageValue);
  }
  if (!isRecord(value)) return value;

  const sanitized: ModelRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (!USAGE_VOLATILE_FIELDS.has(key)) {
      sanitized[key] = sanitizeUsageValue(child);
    }
  }
  return sanitized;
}

function usageStatus(value: ModelRecord, limit: number): ModelRecord {
  const session = isRecord(value.session) ? value.session : undefined;
  const history = isRecord(value.history) ? value.history : undefined;
  const historical = history && isRecord(history.aggregate)
    ? history.aggregate
    : undefined;
  const aggregate =
    usageAggregate(value.aggregate)
    ?? usageAggregate(session)
    ?? usageAggregate(historical);
  if (!aggregate) return { status: "empty" };
  const rawTools = Array.isArray(value.topTools)
    ? value.topTools
    : session && Array.isArray(session.toolBreakdown)
      ? session.toolBreakdown
      : historical && Array.isArray(historical.topToolsBySavings)
        ? historical.topToolsBySavings
        : [];
  const topTools = rawTools
    .flatMap((raw) => {
      if (!isRecord(raw) || positive(raw.savedTokens) === undefined) return [];
      const rawEquivalent = Number(raw.rawEquivalent ?? 0);
      const sdlTokens = Number(raw.sdlTokens ?? 0);
      const savingsPercent =
        typeof raw.savingsPercent === "number"
          ? raw.savingsPercent
          : rawEquivalent > 0
            ? Math.round(((rawEquivalent - sdlTokens) / rawEquivalent) * 100)
            : 0;
      return [{
        tool: raw.tool,
        savedTokens: raw.savedTokens,
        savingsPercent,
        ...(positive(raw.callCount) !== undefined
          ? { callCount: raw.callCount }
          : {}),
      }];
    })
    .sort((left, right) =>
      Number(right.savedTokens) - Number(left.savedTokens)
      || String(left.tool).localeCompare(String(right.tool)),
    )
    .slice(0, limit);
  return { aggregate, ...(topTools.length > 0 ? { topTools } : {}) };
}

function infoStatus(
  value: ModelRecord,
  compact: boolean,
  allowPaths: boolean,
): ModelRecord {
  const config = isRecord(value.config) ? value.config : {};
  const logging = isRecord(value.logging) ? value.logging : {};
  const ladybug = isRecord(value.ladybug) ? value.ladybug : {};
  const native = isRecord(value.native) ? value.native : {};
  const knownPaths = [
    config.path,
    logging.path,
    ladybug.activePath,
    native.sourcePath,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  const projectMessage = (raw: unknown): string | undefined => {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    return allowPaths ? raw : redactMachinePaths(raw, knownPaths);
  };
  const nativeReason = projectMessage(native.reason);
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.flatMap((warning) => projectMessage(warning) ?? [])
    : [];
  const misconfigurations = Array.isArray(value.misconfigurations)
    ? value.misconfigurations.flatMap(
        (misconfiguration) => projectMessage(misconfiguration) ?? [],
      )
    : [];
  const projectedLogging = {
    ...(!compact && typeof logging.consoleMirroring === "boolean"
      ? { consoleMirroring: logging.consoleMirroring }
      : logging.consoleMirroring === true
        ? { consoleMirroring: true }
        : {}),
    ...(!compact && typeof logging.fallbackUsed === "boolean"
      ? { fallbackUsed: logging.fallbackUsed }
      : logging.fallbackUsed === true
        ? { fallbackUsed: true }
        : {}),
    ...(allowPaths && typeof logging.path === "string"
      ? { path: logging.path }
      : {}),
  };
  return {
    ...(stringValue(value.version) ? { version: value.version } : {}),
    ...(isRecord(value.runtime) ? { runtime: value.runtime } : {}),
    config: {
      ...(allowPaths && typeof config.path === "string"
        ? { path: config.path }
        : {}),
      ...(typeof config.exists === "boolean" ? { exists: config.exists } : {}),
      ...(typeof config.loaded === "boolean" ? { loaded: config.loaded } : {}),
    },
    ...(Object.keys(projectedLogging).length > 0
      ? { logging: projectedLogging }
      : {}),
    ladybug: {
      ...(typeof ladybug.available === "boolean"
        ? { available: ladybug.available }
        : {}),
      ...(allowPaths && typeof ladybug.activePath === "string"
        ? { activePath: ladybug.activePath }
        : {}),
    },
    native: {
      ...(typeof native.available === "boolean"
        ? { available: native.available }
        : {}),
      ...(!compact && typeof native.disabledByEnv === "boolean"
        ? { disabledByEnv: native.disabledByEnv }
        : native.disabledByEnv === true
          ? { disabledByEnv: true }
          : {}),
      ...(!compact || native.available === false
        ? nativeReason
          ? { reason: nativeReason }
          : {}
        : {}),
      ...(allowPaths && typeof native.sourcePath === "string"
        ? { sourcePath: native.sourcePath }
        : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(misconfigurations.length > 0 ? { misconfigurations } : {}),
  };
}

function actionPurpose(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() || undefined;
}

function conciseAction(value: unknown): ModelRecord | undefined {
  if (!isRecord(value) || !stringValue(value.action)) return undefined;
  const action = value.action as string;
  const fn = stringValue(value.fn);
  const description = actionPurpose(value.description);
  const requiredParams = Array.isArray(value.requiredParams)
    ? value.requiredParams.filter((param): param is string => typeof param === "string")
    : [];
  return {
    action,
    ...(fn && fn !== action ? { fn } : {}),
    ...(description ? { description } : {}),
    ...(requiredParams.length > 0 ? { requiredParams } : {}),
    ...(isRecord(value.schemaSummary)
      ? { schemaSummary: value.schemaSummary }
      : {}),
    ...(value.example !== undefined ? { example: value.example } : {}),
    ...(value.disabled === true
      ? {
          disabled: true,
          ...(stringValue(value.disabledReason)
            ? { disabledReason: value.disabledReason }
            : {}),
        }
      : {}),
  };
}

function actionSearchStatus(
  value: ModelRecord,
  requestArgs: Readonly<Record<string, unknown>>,
): ModelRecord {
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (rawActions.length === 0 && isRecord(value.summary)) {
    return { summary: value.summary };
  }
  const actions: ModelRecord[] = [];
  const seen = new Set<string>();
  for (const rawAction of rawActions) {
    const action = conciseAction(rawAction);
    const name = action && stringValue(action.action);
    if (!action || !name || seen.has(name)) continue;
    seen.add(name);
    actions.push(action);
  }
  const hasMore = value.hasMore === true;
  const offset = typeof value.offset === "number"
    ? value.offset
    : typeof requestArgs.offset === "number"
      ? requestArgs.offset
      : 0;
  const autoEnabled = isRecord(value.autoEnabled) ? value.autoEnabled : undefined;
  const schemasAvailable =
    requestArgs.includeSchemas === true
    || autoEnabled?.includeSchemas === true
    || (
      rawActions.length > 0
      && rawActions.every(
        (action) => isRecord(action) && isRecord(action.schemaSummary),
      )
    );
  const nextAction = actions.length > 0 && !schemasAvailable
    ? {
        action: "sdl.manual",
        args: {
          actions: actions.map((action) => action.action),
          includeSchemas: true,
          detail: "full",
          format: "json",
        },
      }
    : undefined;
  return {
    actions,
    ...(isRecord(value.summary) ? { summary: value.summary } : {}),
    ...(typeof value.total === "number" ? { total: value.total } : {}),
    ...(isRecord(value.disabledHint) ? { disabledHint: value.disabledHint } : {}),
    ...(stringValue(value.schemaHint) ? { schemaHint: value.schemaHint } : {}),
    ...(hasMore
      ? {
          hasMore: true,
          offset,
          ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
          nextOffset: typeof value.nextOffset === "number"
            ? value.nextOffset
            : offset + rawActions.length,
        }
      : {}),
    ...(autoEnabled ? { autoEnabled } : {}),
    ...(nextAction ? { nextAction } : {}),
  };
}

/** Construct stable status-family projections without mutating canonical data. */
export function projectStatusValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const action = actionName(input.action);
  if (
    !isRecord(input.canonicalResult)
    || isRecord(input.canonicalResult.error)
  ) {
    return projectCompatibilityValue(input);
  }
  if (action === "info") {
    return infoStatus(
      input.canonicalResult,
      input.options.detail !== "full",
      input.options.includeDiagnostics
        && input.context.requestArgs.redactPaths === false,
    );
  }
  if (action === "action.search") {
    return input.options.detail === "full"
      ? input.canonicalResult
      : actionSearchStatus(
          input.canonicalResult,
          input.context.requestArgs,
        );
  }
  if (
    action === "semantic.enrichment.status"
    && input.options.detail === "full"
  ) {
    return input.canonicalResult;
  }
  if (action === "usage.stats" && input.options.detail === "full") {
    return sanitizeUsageValue(input.canonicalResult);
  }
  if (input.options.detail === "full") {
    return projectCompatibilityValue(input);
  }
  switch (action) {
    case "repo.status":
      return repoStatus(input.canonicalResult, input.options.includeDiagnostics);
    case "buffer.status":
      return projectBufferStatusForAgent(input.canonicalResult);
    case "agent.feedback.query":
      return feedbackStatus(input.canonicalResult);
    case "semantic.enrichment.status":
      return projectSemanticEnrichmentStatusForAgent(
        input.canonicalResult,
        typeof input.context.requestArgs.limit === "number"
          ? input.context.requestArgs.limit
          : 5,
        input.options.includeDiagnostics,
      );
    case "usage.stats":
      return usageStatus(
        input.canonicalResult,
        typeof input.context.requestArgs.limit === "number"
          ? input.context.requestArgs.limit
          : 5,
      );
    default:
      return projectCompatibilityValue(input);
  }
}
