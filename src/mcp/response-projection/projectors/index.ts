import { formatToolCallForUser } from "../../tool-call-formatter.js";
import { estimateTokens } from "../../../util/tokenize.js";
import { getOutputBudgetTokenLimit } from "../budgets.js";
import {
  measureProjectionPair,
  serializeProjectionValue,
} from "../measure.js";
import type {
  ModelOutputBoundaryErrorCode,
  ModelProjection,
  ModelProjectionDependencies,
  ModelProjectionInput,
  ModelValueProjectionDelegate,
} from "../types.js";
import { projectChangeAnalysisValue } from "./change-analysis.js";
import { projectRetrievalValue } from "./retrieval.js";
import { projectRuntimeValue } from "./runtime.js";
import { projectStatusValue } from "./status.js";
import { projectWorkflowValue } from "./workflow.js";

const WORKFLOW_ACTIONS = new Set([
  "workflow",
  "workflowContinuationGet",
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
]);

const RUNTIME_ACTIONS = new Set([
  "runtime.execute",
  "runtime.queryOutput",
  "response.get",
  "file.read",
  "file.write",
  "search.edit",
  "file",
  "symbol.edit",
]);

const RETRIEVAL_ACTIONS = new Set([
  "symbol.search",
  "symbol.getCard",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "code.needWindow",
  "code.getSkeleton",
  "code.getHotPath",
  "repo.overview",
  "context",
  "retrieve",
  "memory.query",
  "manual",
]);

const STATUS_ACTIONS = new Set([
  "repo.register",
  "repo.status",
  "repo.unregister",
  "index.refresh",
  "policy.get",
  "policy.set",
  "usage.stats",
  "semantic.enrichment.refresh",
  "semantic.enrichment.status",
  "agent.feedback",
  "agent.feedback.query",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "memory.store",
  "memory.remove",
  "memory.surface",
  "action.search",
  "info",
]);

const CHANGE_ANALYSIS_ACTIONS = new Set([
  "delta.get",
  "pr.risk.analyze",
]);

const PRIVATE_PROJECTION_FIELDS = new Set([
  "_rawContext",
  "_tokenUsage",
]);

export class ModelOutputBoundaryError extends Error {
  readonly code: ModelOutputBoundaryErrorCode;

  constructor(code: ModelOutputBoundaryErrorCode) {
    super({
      MODEL_PROJECTION_FAILED: "Model response projection failed.",
      MODEL_OUTPUT_MEASUREMENT_FAILED: "Model output measurement failed.",
      RESPONSE_HANDLING_FAILED: "Model response handling failed.",
    }[code]);
    this.name = "ModelOutputBoundaryError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalAction(action: string): string {
  return action.startsWith("sdl.") ? action.slice("sdl.".length) : action;
}

function stripPrivateProjectionFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPrivateProjectionFields);
  }
  if (!isRecord(value)) {
    return value;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!PRIVATE_PROJECTION_FIELDS.has(key)) {
      copy[key] = stripPrivateProjectionFields(child);
    }
  }
  return copy;
}

function projectFamilyValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const action = canonicalAction(input.action);
  if (input.profile.projector === "workflow" || WORKFLOW_ACTIONS.has(action)) {
    return projectWorkflowValue(input, projectCompatibilityValue);
  }
  if (
    input.profile.projector === "repoStatus"
    || input.profile.projector === "actionSearch"
    || input.profile.projector === "usage"
    || STATUS_ACTIONS.has(action)
  ) {
    return projectStatusValue(input, projectCompatibilityValue);
  }
  if (RUNTIME_ACTIONS.has(action)) {
    return projectRuntimeValue(input, projectCompatibilityValue);
  }
  if (RETRIEVAL_ACTIONS.has(action)) {
    return projectRetrievalValue(input, projectCompatibilityValue);
  }
  if (CHANGE_ANALYSIS_ACTIONS.has(action)) {
    return projectChangeAnalysisValue(input, projectCompatibilityValue);
  }
  if (input.profile.projector === "generic") {
    return projectStatusValue(input, projectCompatibilityValue);
  }
  if (isRecord(input.canonicalResult) && isRecord(input.canonicalResult.error)) {
    return projectCompatibilityValue(input);
  }
  throw new Error("Projection action has no projector");
}

export function projectModelValue(
  input: ModelProjectionInput,
  projectCompatibilityValue: ModelValueProjectionDelegate,
): unknown {
  const { canonicalResult } = input;
  // Conditional arms require their ETag; ordinary payloads still use family redaction.
  if (
    isRecord(canonicalResult)
    && canonicalResult.notModified === true
    && typeof canonicalResult.etag === "string"
  ) {
    return typeof canonicalResult.ledgerVersion === "string"
      ? {
        notModified: true,
        etag: canonicalResult.etag,
        ledgerVersion: canonicalResult.ledgerVersion,
      }
      : { notModified: true, etag: canonicalResult.etag };
  }
  return projectFamilyValue(input, projectCompatibilityValue);
}

function isEditAction(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return toolName === "sdl.file.write"
    || toolName === "sdl.search.edit"
    || toolName === "sdl.symbol.edit"
    || (
      toolName === "sdl.file"
      && (
        args.op === "write"
        || args.op === "searchEditPreview"
        || args.op === "searchEditApply"
        || (typeof args.op === "string" && args.op.startsWith("symbolEdit"))
      )
    );
}

function looksLikeSerializedJson(value: string): boolean {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function summaryRepeatsPayload(summary: string, value: unknown): boolean {
  const serialized = serializeProjectionValue(value);
  if (serialized.length > 2 && summary.includes(serialized)) {
    return true;
  }

  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const line of next.split(/\r?\n/)) {
        const candidate = line.trim();
        if (
          candidate
          && (
            candidate.startsWith("#PACKED/")
            || looksLikeSerializedJson(candidate)
          )
          && summary.includes(candidate)
        ) {
          return true;
        }
      }
      continue;
    }
    if (Array.isArray(next)) {
      pending.push(...next);
      continue;
    }
    if (isRecord(next)) {
      pending.push(...Object.values(next));
    }
  }
  return false;
}

function boundSummary(
  summary: string,
): Readonly<{ text: string; truncated: boolean }> {
  const maxTokens = getOutputBudgetTokenLimit("summary");
  if (estimateTokens(summary) <= maxTokens) {
    return { text: summary, truncated: false };
  }

  const suffix = "…";
  const characters = Array.from(summary);
  let low = 0;
  let high = characters.length;
  let best = suffix;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("").trimEnd() + suffix;
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text: best, truncated: true };
}

function summarizeProjection(
  input: ModelProjectionInput,
  value: unknown,
): Readonly<{ text: string; truncated: boolean }> {
  const args = {
    ...input.context.requestArgs,
    detail: input.options.detail,
    includeDiagnostics: input.options.includeDiagnostics,
  };
  const formatted =
    input.profile.projector === "usage"
      && isRecord(value)
      && typeof value.formattedSummary === "string"
      ? value.formattedSummary
      : formatToolCallForUser(
          input.context.toolName,
          args,
          value,
          {
            presentation: isEditAction(input.context.toolName, args)
              ? "summary"
              : "full",
          },
        );
  const fallback =
    `${input.context.toolName || input.action} -> response available in structured content`;
  let summary = formatted?.trim() || fallback;
  if (summaryRepeatsPayload(summary, value)) {
    summary = fallback;
  }
  if (input.context.footerText) {
    summary = `${summary}\n${input.context.footerText}`;
  }
  return boundSummary(summary);
}

interface MeasurementSnapshot {
  readonly value: unknown;
  readonly objectFieldCount: number;
}

function snapshotProjectionValue(value: unknown): MeasurementSnapshot {
  const activeContainers = new Set<object>();
  let visitedValues = 0;
  let objectFieldCount = 0;

  const snapshot = (item: unknown, depth: number): unknown => {
    visitedValues += 1;
    if (visitedValues > 100_000) {
      throw new Error("Projection measurement size limit exceeded");
    }
    if (!Array.isArray(item) && !isRecord(item)) {
      return item;
    }
    if (depth > 128) {
      throw new Error("Projection measurement depth limit exceeded");
    }
    if (activeContainers.has(item)) {
      throw new Error("Cyclic projection measurement");
    }

    activeContainers.add(item);
    if (Array.isArray(item)) {
      const copy = item.map((child) => snapshot(child, depth + 1));
      activeContainers.delete(item);
      return copy;
    }

    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      objectFieldCount += 1;
      copy[key] = snapshot(child, depth + 1);
    }
    activeContainers.delete(item);
    return copy;
  };

  return {
    value: snapshot(value, 0),
    objectFieldCount,
  };
}

function resultWasHandled(value: unknown): boolean {
  return isRecord(value)
    && (
      value.responseMode === "handle"
      || value.kind === "responseArtifact"
    );
}

export function projectModelResponse(
  input: ModelProjectionInput,
  dependencies: ModelProjectionDependencies = {},
): ModelProjection {
  let value: unknown;
  let summary: Readonly<{ text: string; truncated: boolean }>;
  try {
    const preparedCanonical = dependencies.prepareCanonicalValue
      ? dependencies.prepareCanonicalValue(input.canonicalResult)
      : input.canonicalResult;
    const publicInput: ModelProjectionInput = {
      ...input,
      canonicalResult: stripPrivateProjectionFields(preparedCanonical),
    };
    if (dependencies.projectValue) {
      value = dependencies.projectValue(publicInput);
    } else if (dependencies.projectCompatibilityValue) {
      value = projectModelValue(
        publicInput,
        dependencies.projectCompatibilityValue,
      );
    } else {
      throw new Error("Compatibility value projector is required");
    }
    value = snapshotProjectionValue(value).value;
    summary = summarizeProjection(publicInput, value);
  } catch {
    throw new ModelOutputBoundaryError("MODEL_PROJECTION_FAILED");
  }

  let stats: ModelProjection["stats"];
  try {
    const rawSnapshot = snapshotProjectionValue(
      input.context.measurementSource ?? input.canonicalResult,
    );
    const projectedSnapshot = snapshotProjectionValue(value);
    const measured = (dependencies.measureProjection ?? measureProjectionPair)(
      rawSnapshot.value,
      projectedSnapshot.value,
    );
    const valueRecord = isRecord(value) ? value : undefined;
    stats = Object.freeze({
      profile: input.profile,
      effectiveDetail: input.options.detail,
      diagnosticsIncluded: input.options.includeDiagnostics,
      ...measured,
      removedFieldCount: Math.max(
        0,
        rawSnapshot.objectFieldCount - projectedSnapshot.objectFieldCount,
      ),
      truncated: summary.truncated || valueRecord?.truncated === true,
      responseHandled: resultWasHandled(value),
      recoveryEmitted: valueRecord?.nextAction !== undefined,
    });
  } catch {
    throw new ModelOutputBoundaryError("MODEL_OUTPUT_MEASUREMENT_FAILED");
  }

  return Object.freeze({
    value,
    summary: summary.text,
    stats,
  });
}

export const projectResponseForModel = projectModelResponse;

export {
  projectChangeAnalysisValue,
  projectRetrievalValue,
  projectRuntimeValue,
  projectStatusValue,
  projectWorkflowValue,
};
