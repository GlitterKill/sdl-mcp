/**
 * Compact broad-mode context responses for internal accounting and response
 * limits. Final MCP text content applies the stricter model projection below.
 */

import type { TaskType } from "../agent/types.js";
import {
  getResponseProjectionRule,
  getWorkflowChildAction,
} from "./context-response-projection-registry.js";
import { CARD_WIRE_FIELD_ORDER } from "./tools/symbol-utils.js";

/** Fields kept in the compact broad response before final model-content projection.
 *  Shared with context-engine.ts for pre-truncation compaction. */
const BROAD_MODEL_VISIBLE_FIELDS = new Set([
  "taskType",
  "success",
  "summary",
  "answer",
  "finalEvidence",
  "nextBestAction",
  "error",
  "truncation",
]);

export const BROAD_VISIBLE_FIELDS = new Set([
  ...BROAD_MODEL_VISIBLE_FIELDS,
  "etag",
  "diagnostics",
  "retrievalEvidence",
]);

type ProjectionDetail = "compact" | "standard" | "full";

interface ModelContentProjectionOptions {
  detail: ProjectionDetail;
  includeDiagnostics: boolean;
  includeRetrievalEvidence: boolean;
  includeTelemetry: boolean;
  includeTrace: boolean;
  includeProcesses: boolean;
  includeResolutionMetadata: boolean;
  fileOp?: string;
}

const HIDDEN_ETAG_MODEL_FIELDS = new Set(["etag", "etagCache", "sliceEtag"]);

const ALWAYS_INTERNAL_MODEL_FIELDS = new Set([
  "_displayFooter",
  "_packedPayload",
  "_packedStats",
  "_rawContext",
  "_tokenUsage",
  "actionsTaken",
  "indexUpdate",
  "metrics",
  "packedStats",
  "preconditionSnapshot",
  "rawEquivalent",
  "serverDiagnostics",
  "taskId",
  "timings",
  "tokenEstimate",
  "totalTokens",
  "etagCache",
  "graphIntegrityError",
  "sliceEtag",
]);

const NO_OP_FALSE_FIELDS = new Set([
  "truncated",
  "truncation",
  "blastRadiusTruncated",
]);

const NO_OP_NULL_FIELDS = new Set([
  "signal",
]);

const NO_OP_EMPTY_ARRAY_FIELDS = new Set([
  "warnings",
  "quotingWarnings",
  "serverDriftWarnings",
  "filesSkipped",
  "filesSkippedByReason",
  "staleSymbols",
  "missedIdentifiers",
]);

const COMPACT_FAILURE_TRACE_FIELDS = new Set([
  "stepIndex",
  "fn",
  "action",
  "kind",
  "status",
  "message",
  "fallbackTools",
]);

const COMPACT_DEBUG_MODEL_FIELDS = new Set([
  "aggregateStats",
  "amplifiers",
  "astFingerprint",
  "bytes",
  "bytesWritten",
  "callResolution",
  "clustersHint",
  "confidenceDistribution",
  "created",
  "deduplicated",
  "detailLevel",
  "detailLevelMetadata",
  "diagnostics",
  "entryPoints",
  "expiresAt",
  "hotspots",
  "lease",
  "ledgerVersion",
  "linesWritten",
  "matchCount",
  "matchedLineNumbers",
  "mtimeMs",
  "originalLines",
  "pprBoosts",
  "processes",
  "relevance",
  "returnedLines",
  "searchedStreams",
  "sessionDelta",
  "sha256",
  "shortId",
  "sliceEtag",
  "stderrPreview",
  "stdinBytes",
  "stdinSha256",
  "stdoutPreview",
  "symbolsRecorded",
  "symbolIndex",
  "symptomType",
  "totalBytes",
  "totalLines",
  "truncationWarning",
  "versionId",
  "visibility",
  "whyApproved",
]);

const PRECONDITION_MODEL_FIELDS = new Set([
  "astFingerprint",
  "expectedAstFingerprint",
  "expectedRange",
  "mtimeMs",
  "preconditionSnapshot",
  "sha256",
]);

function shouldOmitToolSpecificModelField(
  toolName: string,
  key: string,
): boolean {
  return getResponseProjectionRule(toolName)?.omitTopLevelFields?.includes(key)
    ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stripFullDetailHiddenFieldsForModel(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripFullDetailHiddenFieldsForModel);
  }
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (HIDDEN_ETAG_MODEL_FIELDS.has(key) || PRECONDITION_MODEL_FIELDS.has(key)) {
      continue;
    }
    projected[key] = stripFullDetailHiddenFieldsForModel(itemValue);
  }
  return projected;
}

function stripTopLevelToolSpecificFieldsForModel(
  toolName: string,
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (!shouldOmitToolSpecificModelField(toolName, key)) {
      projected[key] = itemValue;
    }
  }
  return projected;
}

function copyIfPresent(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (key in source) {
    target[key] = source[key];
  }
}

function projectDeps(
  source: Record<string, unknown>,
  fields: { imports?: true; calls?: true },
): Record<string, unknown> | undefined {
  if (!isRecord(source.deps)) {
    return undefined;
  }

  const deps: Record<string, unknown> = {};
  if (fields.imports) copyIfPresent(source.deps, deps, "imports");
  if (fields.calls) copyIfPresent(source.deps, deps, "calls");
  return Object.keys(deps).length > 0 ? deps : undefined;
}

export function projectCardForTask(
  card: Record<string, unknown>,
  taskType: TaskType,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const visibleFields = new Set<string>([
    "symbolId",
    "file",
    "range",
    "kind",
    "name",
    "signature",
  ]);
  let deps: Record<string, unknown> | undefined;
  if (taskType === "debug") {
    visibleFields.add("summary");
    visibleFields.add("sideEffects");
    visibleFields.add("deps");
    deps = projectDeps(card, { calls: true });
  } else if (taskType === "implement") {
    visibleFields.add("summary");
    visibleFields.add("invariants");
    visibleFields.add("deps");
    deps = projectDeps(card, { imports: true });
  } else if (taskType === "explain") {
    visibleFields.add("summary");
    visibleFields.add("summaryProvenance");
    visibleFields.add("deps");
    deps = projectDeps(card, { imports: true, calls: true });
  } else {
    visibleFields.add("summary");
    visibleFields.add("sideEffects");
    visibleFields.add("metrics");
  }

  for (const field of CARD_WIRE_FIELD_ORDER) {
    if (!visibleFields.has(field)) continue;
    if (field === "deps") {
      if (deps !== undefined) projected.deps = deps;
    } else {
      copyIfPresent(card, projected, field);
    }
  }

  if (taskType === "debug") copyIfPresent(card, projected, "canonicalTest");
  copyIfPresent(card, projected, "ref");
  copyIfPresent(card, projected, "unchanged");
  copyIfPresent(card, projected, "changedSincePrior");

  return projected;
}

export function projectSymbolCardEvidenceForTask(
  evidence: Record<string, unknown>,
  taskType: TaskType,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  copyIfPresent(evidence, projected, "type");
  copyIfPresent(evidence, projected, "reference");

  const projectedCard = projectCardForTask(evidence, taskType);
  for (const [key, value] of Object.entries(projectedCard)) {
    projected[key] = value;
  }

  return projected;
}

function projectEvidenceForModel(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      return item;
    }

    const projected: Record<string, unknown> = {};
    for (const [key, itemValue] of Object.entries(item)) {
      if (key !== "timestamp") {
        projected[key] = itemValue;
      }
    }
    return projected;
  });
}

function normalizedDetail(value: unknown): ProjectionDetail {
  return value === "full" || value === "standard" ? value : "compact";
}

function modelOptionsFromArgs(
  args: Record<string, unknown>,
): ModelContentProjectionOptions {
  const options = isRecord(args.options) ? args.options : {};
  return {
    detail: normalizedDetail(args.detail ?? options.detail),
    includeDiagnostics:
      args.includeDiagnostics === true
      || options.includeDiagnostics === true,
    includeRetrievalEvidence:
      args.includeRetrievalEvidence === true
      || options.includeRetrievalEvidence === true,
    includeTelemetry:
      args.includeTelemetry === true
      || options.includeTelemetry === true,
    includeTrace: args.trace !== undefined,
    includeProcesses: args.includeProcesses === true,
    includeResolutionMetadata: args.includeResolutionMetadata === true,
    fileOp: typeof args.op === "string" ? args.op : undefined,
  };
}

function isFullDetail(options: ModelContentProjectionOptions): boolean {
  return options.detail === "full";
}

function isNoOpTruncationObject(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.truncated === true
    || value.stdoutTruncated === true
    || value.stderrTruncated === true
  ) {
    return false;
  }
  return Object.keys(value).every((key) =>
    key === "truncated"
    || key === "stdoutTruncated"
    || key === "stderrTruncated"
    || key === "totalStdoutBytes"
    || key === "totalStderrBytes",
  );
}

function shouldDropNoOpField(key: string, value: unknown): boolean {
  if (value === false && NO_OP_FALSE_FIELDS.has(key)) {
    return true;
  }
  if (key === "truncation" && isNoOpTruncationObject(value)) {
    return true;
  }
  if (value === null && NO_OP_NULL_FIELDS.has(key)) {
    return true;
  }
  if (
    Array.isArray(value)
    && value.length === 0
    && NO_OP_EMPTY_ARRAY_FIELDS.has(key)
  ) {
    return true;
  }
  if (key === "rollback" && isRecord(value)) {
    return Object.keys(value).length === 0 || value.triggered === false;
  }
  return false;
}

const VOLATILE_STATUS_MODEL_FIELDS = new Set([
  "createdAt",
  "lastIndexedAt",
  "startedAt",
  "finishedAt",
  "graphIntegrityError",
  "updatedAt",
  "lastEventAt",
  "lastSuccessfulReindexAt",
  "lastRunAt",
  "lastBufferEventAt",
  "lastCheckpointAt",
  "lastCheckpointAttemptAt",
  "oldestReconcileAt",
  "lastReconciledAt",
]);

function isStatusToolName(toolName: string): boolean {
  return toolName.endsWith(".status") || toolName.endsWith("Status");
}

function isSemanticEnrichmentStatusToolName(toolName: string): boolean {
  return (
    toolName.endsWith("semantic.enrichment.status") ||
    toolName === "semanticEnrichmentStatus"
  );
}

function isVolatileStatusModelField(
  toolName: string,
  key: string,
): boolean {
  return (
    isStatusToolName(toolName) &&
    (VOLATILE_STATUS_MODEL_FIELDS.has(key) ||
      (isSemanticEnrichmentStatusToolName(toolName) && key === "runId"))
  );
}

function stripVolatileStatusFieldsForModel(
  toolName: string,
  value: unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      stripVolatileStatusFieldsForModel(toolName, item),
    );
  }
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (isVolatileStatusModelField(toolName, key)) {
      continue;
    }
    projected[key] = stripVolatileStatusFieldsForModel(toolName, itemValue);
  }
  return projected;
}

function shouldKeepModelField(
  toolName: string,
  key: string,
  options: ModelContentProjectionOptions,
  depth: number,
): boolean {
  const projectionRule = getResponseProjectionRule(toolName);
  if (PRECONDITION_MODEL_FIELDS.has(key)) {
    return false;
  }
  if (
    !options.includeTelemetry &&
    isVolatileStatusModelField(toolName, key)
  ) {
    return false;
  }
  if (depth === 0 && shouldOmitToolSpecificModelField(toolName, key)) {
    return false;
  }
  if (isFullDetail(options)) {
    return true;
  }

  // Direct code-window line matches are actionable; nested matches retain the
  // established generic omission behavior.
  if (key === "matchedLineNumbers") {
    return depth === 0 && projectionRule?.keepTopLevelMatchedLines === true;
  }
  if (
    key === "whyApproved"
    && depth > 0
    && projectionRule?.keepNestedWhyApproved === true
  ) {
    return true;
  }
  if (key === "trace") {
    return projectionRule?.projector === "workflow" && options.includeTrace;
  }
  if (ALWAYS_INTERNAL_MODEL_FIELDS.has(key)) {
    return false;
  }
  if (key === "repoId") {
    return projectionRule?.showRepoId === true;
  }
  if (key === "processes") {
    return options.includeProcesses;
  }
  if (key === "callResolution") {
    return options.includeResolutionMetadata;
  }
  if (
    key === "matchCount" &&
    (toolName === "sdl.file" ||
      toolName === "sdl.search.edit" ||
      toolName === "sdl.symbol.edit")
  ) {
    return true;
  }
  if (COMPACT_DEBUG_MODEL_FIELDS.has(key)) {
    return false;
  }
  if (key === "budget" && projectionRule?.omitBudget === true) {
    return false;
  }
  if (key === "symbols" && projectionRule?.omitSymbols === true) {
    return false;
  }
  if (key === "diagnostics") {
    return options.includeDiagnostics;
  }
  if (key === "retrievalEvidence") {
    return options.includeRetrievalEvidence;
  }
  if (
    key === "estimatedTokens"
    || key === "originalLines"
    || key === "generatedAt"
    || key === "tokenMetrics"
  ) {
    return false;
  }
  if (
    options.detail === "compact"
    && !options.includeTelemetry
    && (key === "prefetchStats"
      || key === "strategyMetrics"
      || key === "topStrategies"
      || key === "healthComponents")
  ) {
    return false;
  }
  return true;
}

function projectGenericValueForModel(
  toolName: string,
  value: unknown,
  options: ModelContentProjectionOptions,
  depth = 0,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      projectGenericValueForModel(toolName, item, options, depth + 1),
    );
  }
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (HIDDEN_ETAG_MODEL_FIELDS.has(key)) {
      continue;
    }
    if (shouldDropNoOpField(key, itemValue)) {
      continue;
    }
    if (key === "diagnostics" && options.includeDiagnostics) {
      projected[key] = itemValue;
      continue;
    }
    if (key === "retrievalEvidence" && options.includeRetrievalEvidence) {
      projected[key] = itemValue;
      continue;
    }
    if (key === "policyDecision") {
      const decision = isRecord(itemValue) ? itemValue : {};
      if (Array.isArray(decision.deniedReasons) && decision.deniedReasons.length > 0) {
        projected.policyDecision = { deniedReasons: decision.deniedReasons };
      }
      continue;
    }
    if (!shouldKeepModelField(toolName, key, options, depth)) {
      continue;
    }
    const projectedValue = projectGenericValueForModel(
      toolName,
      itemValue,
      options,
      depth + 1,
    );
    if (isRecord(projectedValue) && Object.keys(projectedValue).length === 0) {
      continue;
    }
    projected[key] = projectedValue;
  }
  return projected;
}

function projectContextResultForModel(
  result: Record<string, unknown>,
  options: ModelContentProjectionOptions,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};

  copyIfPresent(result, projected, "taskType");
  copyIfPresent(result, projected, "success");
  copyIfPresent(result, projected, "answer");
  copyIfPresent(result, projected, "confidence");
  copyIfPresent(result, projected, "evidence");
  copyIfPresent(result, projected, "expand");
  copyIfPresent(result, projected, "answerFirstFallback");
  if (!("answer" in result)) {
    copyIfPresent(result, projected, "summary");
  }
  if ("finalEvidence" in result) {
    projected.finalEvidence = projectEvidenceForModel(result.finalEvidence);
  }
  copyIfPresent(result, projected, "nextBestAction");
  copyIfPresent(result, projected, "error");
  if (result.truncation !== false) {
    copyIfPresent(result, projected, "truncation");
  }

  if (options.includeRetrievalEvidence) {
    copyIfPresent(result, projected, "retrievalEvidence");
  }
  if (options.includeDiagnostics) {
    copyIfPresent(result, projected, "diagnostics");
  }

  return projected;
}

function projectCompactFailureTrace(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const projected: Record<string, unknown> = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (COMPACT_FAILURE_TRACE_FIELDS.has(key)) {
      projected[key] = itemValue;
    }
  }
  return projected;
}

function workflowStepArgsAt(
  workflowArgs: Record<string, unknown>,
  stepIndex: number,
): unknown {
  const steps = workflowArgs.steps;
  if (!Array.isArray(steps)) {
    return undefined;
  }
  const step = steps[stepIndex];
  return isRecord(step) ? step.args : undefined;
}

function inferWorkflowFileOp(
  childToolName: string,
  result: unknown,
  args: unknown,
): string | undefined {
  if (isRecord(args) && typeof args.op === "string") {
    return args.op;
  }
  if (childToolName === "sdl.file" && isRecord(result) && "preconditionSnapshot" in result) {
    return "searchEditPreview";
  }
  return undefined;
}

function projectWorkflowStepResultForModel(
  fn: unknown,
  result: unknown,
  options: ModelContentProjectionOptions,
  args?: unknown,
): unknown {
  const childToolName = typeof fn === "string"
    ? getWorkflowChildAction(fn)
    : "workflow";
  const childProjectionRule = getResponseProjectionRule(childToolName);
  const childArgOptions = isRecord(args) ? modelOptionsFromArgs(args) : undefined;
  const fileOp = inferWorkflowFileOp(childToolName, result, args);
  const filterStatusTelemetry =
    !(childArgOptions?.includeTelemetry ?? options.includeTelemetry) &&
    isStatusToolName(childToolName);
  if (isFullDetail(options) && !filterStatusTelemetry) {
    return stripFullDetailHiddenFieldsForModel(result);
  }
  if (
    filterStatusTelemetry &&
    isFullDetail(options) &&
    childArgOptions?.detail !== "compact"
  ) {
    // Full workflow detail keeps actionable fields while filtering cache noise.
    return stripVolatileStatusFieldsForModel(
      childToolName,
      stripFullDetailHiddenFieldsForModel(result),
    );
  }
  const childOptions: ModelContentProjectionOptions = {
    ...options,
    detail: "compact",
    includeDiagnostics: false,
    includeRetrievalEvidence: false,
    includeTelemetry: false,
    includeTrace: false,
    ...(childArgOptions ?? {}),
    fileOp: fileOp ?? childArgOptions?.fileOp ?? options.fileOp,
  };

  if (isFullDetail(childOptions)) {
    const fullResult = stripFullDetailHiddenFieldsForModel(result);
    return filterStatusTelemetry
      ? stripVolatileStatusFieldsForModel(childToolName, fullResult)
      : fullResult;
  }

  if (childProjectionRule?.projector === "repoStatus") {
    if (childOptions.detail === "compact" && !childOptions.includeTelemetry) {
      return isRecord(result) ? projectRepoStatusForModel(result, childOptions) : result;
    }
    return projectGenericValueForModel(childToolName, result, childOptions);
  }
  if (
    childProjectionRule?.projector === "actionSearch"
    && childOptions.detail === "compact"
  ) {
    return isRecord(result) ? projectActionSearchForModel(result) : result;
  }
  if (childProjectionRule?.projector === "usage") {
    return isRecord(result) ? projectUsageStatsForModel(result) : result;
  }

  return projectGenericValueForModel(childToolName, result, childOptions);
}

function projectWorkflowResultForModel(
  result: Record<string, unknown>,
  options: ModelContentProjectionOptions,
  workflowArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const includeWorkflowTelemetry = options.includeTrace
    || options.includeDiagnostics
    || options.includeTelemetry
    || isFullDetail(options);
  const projected: Record<string, unknown> = {};
  const rawResults = Array.isArray(result.results) ? result.results : [];

  projected.results = rawResults.map((item, index) => {
    if (!isRecord(item)) {
      return item;
    }
    const status = typeof item.status === "string" ? item.status : "ok";
    const stepIndex = typeof item.stepIndex === "number" ? item.stepIndex : index;
    const stepArgs = workflowStepArgsAt(workflowArgs, stepIndex) ?? item.args;
    if (status === "ok") {
      const successStep: Record<string, unknown> = { fn: item.fn };
      if (includeWorkflowTelemetry) {
        copyIfPresent(item, successStep, "stepIndex");
        copyIfPresent(item, successStep, "tokens");
        copyIfPresent(item, successStep, "durationMs");
        copyIfPresent(item, successStep, "status");
      }
      if ("result" in item) {
        successStep.result = projectWorkflowStepResultForModel(
          item.fn,
          item.result,
          options,
          stepArgs,
        );
      }
      if (item.truncatedResponse) {
        successStep.truncatedResponse = item.truncatedResponse;
      }
      return successStep;
    }

    const failureStep: Record<string, unknown> = { fn: item.fn, status };
    copyIfPresent(item, failureStep, "error");
    copyIfPresent(item, failureStep, "fallbackTools");
    copyIfPresent(item, failureStep, "blockedByStep");
    copyIfPresent(item, failureStep, "blockedByFn");
    copyIfPresent(item, failureStep, "blockedByError");
    if ("failureTrace" in item) {
      failureStep.failureTrace = projectCompactFailureTrace(item.failureTrace);
    }
    if ("result" in item && item.result !== null && item.result !== undefined) {
      failureStep.result = projectWorkflowStepResultForModel(
        item.fn,
        item.result,
        options,
        stepArgs,
      );
    }
    return failureStep;
  });

  if (includeWorkflowTelemetry) {
    copyIfPresent(result, projected, "durationMs");
    copyIfPresent(result, projected, "totalTokens");
  }
  if (result.truncated === true) {
    projected.truncated = true;
  }
  if (options.includeTrace) {
    copyIfPresent(result, projected, "trace");
  }
  if (options.includeDiagnostics) {
    copyIfPresent(result, projected, "diagnostics");
  }
  return projected;
}

function projectUsageStatsForModel(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || typeof result.formattedSummary !== "string") {
    return {};
  }
  return { formattedSummary: result.formattedSummary };
}

function projectDerivedStateForModel(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const projected: Record<string, unknown> = {};
  copyIfPresent(value, projected, "stale");
  for (const key of [
    "clustersDirty",
    "processesDirty",
    "algorithmsDirty",
    "summariesDirty",
    "embeddingsDirty",
  ]) {
    if (value[key] === true) {
      projected[key] = true;
    }
  }
  copyIfPresent(value, projected, "lastError");
  copyIfPresent(value, projected, "graphIntegrityState");
  copyIfPresent(value, projected, "graphIntegrityVersionId");
  copyIfPresent(value, projected, "graphIntegrityDigest");
  copyIfPresent(value, projected, "nextBestAction");
  return projected;
}

function watcherNeedsAttention(value: Record<string, unknown>): boolean {
  return value.running === false
    || value.stale === true
    || (typeof value.errors === "number" && value.errors > 0)
    || Boolean(value.fallbackReason);
}

function projectWatcherHealthForModel(value: unknown): unknown {
  if (!isRecord(value) || !watcherNeedsAttention(value)) {
    return undefined;
  }
  const projected: Record<string, unknown> = {};
  for (const key of [
    "enabled",
    "running",
    "provider",
    "fallbackReason",
    "errors",
    "queueDepth",
    "stale",
  ]) {
    copyIfPresent(value, projected, key);
  }
  return projected;
}

function projectRepoStatusForModel(
  result: Record<string, unknown>,
  options: ModelContentProjectionOptions,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of [
    "repoId",
    "rootAvailability",
    "latestVersionId",
    "filesIndexed",
    "symbolsIndexed",
  ]) {
    copyIfPresent(result, projected, key);
  }
  if ("healthAvailable" in result || result.healthScore !== undefined) {
    copyIfPresent(result, projected, "healthAvailable");
    copyIfPresent(result, projected, "healthScore");
  }
  if ("derivedState" in result) {
    projected.derivedState = projectDerivedStateForModel(result.derivedState);
  }
  const compactWatcher = projectWatcherHealthForModel(result.watcherHealth);
  if (compactWatcher !== undefined) {
    projected.watcherHealth = compactWatcher;
  }
  copyIfPresent(result, projected, "nextBestAction");
  if (options.includeDiagnostics) {
    copyIfPresent(result, projected, "diagnostics");
  }
  if (options.includeRetrievalEvidence) {
    copyIfPresent(result, projected, "retrievalEvidence");
  }
  return projected;
}

function compactSchemaSummary(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((field) => {
    if (!isRecord(field)) {
      return field;
    }
    const projected: Record<string, unknown> = {};
    for (const key of ["name", "type", "required", "default", "enumValues", "subFields"]) {
      if (key === "subFields") {
        if ("subFields" in field) {
          projected.subFields = compactSchemaSummary(field.subFields);
        }
      } else {
        copyIfPresent(field, projected, key);
      }
    }
    return projected;
  });
}

function projectActionSearchForModel(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (Array.isArray(result.actions)) {
    projected.actions = result.actions.map((action) => {
      if (!isRecord(action)) {
        return action;
      }
      const compact: Record<string, unknown> = {};
      copyIfPresent(action, compact, "action");
      copyIfPresent(action, compact, "fn");
      copyIfPresent(action, compact, "requiredParams");
      copyIfPresent(action, compact, "estTokens");
      copyIfPresent(action, compact, "disabled");
      copyIfPresent(action, compact, "disabledReason");
      if (isRecord(action.schemaSummary) && Array.isArray(action.schemaSummary.fields)) {
        compact.schemaSummary = {
          fields: compactSchemaSummary(action.schemaSummary.fields),
        };
      }
      return compact;
    });
  }
  copyIfPresent(result, projected, "summary");
  copyIfPresent(result, projected, "total");
  copyIfPresent(result, projected, "hasMore");
  copyIfPresent(result, projected, "nextCursor");
  copyIfPresent(result, projected, "disabledHint");
  copyIfPresent(result, projected, "schemaHint");
  return projected;
}

/**
 * Returns true when the result looks like a broad context response that
 * should be compacted.
 */
export function isBroadContextResult(
  toolName: string,
  result: unknown,
): boolean {
  if (getResponseProjectionRule(toolName)?.projector !== "context") {
    return false;
  }
  if (!isRecord(result)) {
    return false;
  }

  const r = result;
  return (
    "taskId" in r &&
    "actionsTaken" in r &&
    "answer" in r &&
    r.success !== undefined
  );
}

export function projectBroadContextResult(
  toolName: string,
  result: unknown,
): unknown {
  if (!isBroadContextResult(toolName, result)) {
    return result;
  }

  const r = result as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(r)) {
    if (BROAD_MODEL_VISIBLE_FIELDS.has(key)) {
      projected[key] = r[key];
    }
  }
  return projected;
}

export function projectContextResultForUsageAccounting(
  toolName: string,
  result: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const projected = projectToolResultForModelContent(toolName, result, args);
  if (!isRecord(projected)) {
    return result;
  }
  if ("_rawContext" in result) {
    return { ...projected, _rawContext: result._rawContext };
  }
  return projected;
}

/**
 * Project the payload serialized into MCP text content for the model/user.
 * Internal diagnostics, sync details, and packing stats stay
 * available to logs/debug paths, but are not duplicated into model-visible text.
 */
export function projectToolResultForModelContent(
  toolName: string,
  result: unknown,
  args: Record<string, unknown> = {},
): unknown {
  if (!isRecord(result)) {
    return result;
  }

  const options = modelOptionsFromArgs(args);
  const projectionRule = getResponseProjectionRule(toolName);
  if (projectionRule?.projector === "workflow") {
    return projectWorkflowResultForModel(result, options, args);
  }
  if (
    isFullDetail(options) &&
    !options.includeTelemetry &&
    isStatusToolName(toolName)
  ) {
    return stripVolatileStatusFieldsForModel(
      toolName,
      stripFullDetailHiddenFieldsForModel(result),
    );
  }
  if (isFullDetail(options)) {
    return stripTopLevelToolSpecificFieldsForModel(
      toolName,
      stripFullDetailHiddenFieldsForModel(result),
    );
  }
  if (
    projectionRule?.projector === "context"
    && ("answer" in result || "finalEvidence" in result)
  ) {
    return projectContextResultForModel(result, options);
  }
  if (projectionRule?.projector === "usage") {
    return projectUsageStatsForModel(result);
  }
  if (projectionRule?.projector === "repoStatus") {
    if (options.detail === "compact" && !options.includeTelemetry) {
      return projectRepoStatusForModel(result, options);
    }
  }
  if (projectionRule?.projector === "actionSearch") {
    if (options.detail === "compact") {
      return projectActionSearchForModel(result);
    }
  }

  return projectGenericValueForModel(toolName, result, options);
}
