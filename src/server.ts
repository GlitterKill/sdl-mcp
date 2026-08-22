import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ToolAnnotations,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getLadybugConn } from "./db/ladybug.js";
import {
  GraphRetrievalUnavailableError,
  IndexError,
} from "./domain/errors.js";
import { errorToMcpResponse } from "./mcp/errors.js";
import {
  runIndexRefreshAdmission,
  runToolDispatch,
} from "./mcp/dispatch-limiter.js";
import { logToolCall, type ToolCallEvent } from "./mcp/telemetry.js";
import {
  buildCompactJsonSchema,
  zodSchemaToJsonSchema,
} from "./gateway/compact-schema.js";
import {
  shouldAttachUsage,
  computeTokenUsage,
  type TokenUsageMetadata,
} from "./mcp/token-usage.js";
import { tokenAccumulator } from "./mcp/token-accumulator.js";
import { wasteLedger } from "./mcp/waste-ledger.js";
import { renderUserNotificationLine } from "./mcp/savings-meter.js";
import { formatToolCallForUser } from "./mcp/tool-call-formatter.js";
import type { LiveIndexCoordinator } from "./live-index/types.js";
import type { ContextEngine } from "./context/types.js";
import type {
  CodeModeConfig,
  GatewayConfig,
  ToolNameFormat,
} from "./config/types.js";
import { RuntimeConfigSchema } from "./config/types.js";
import { loadConfig } from "./config/loadConfig.js";
import {
  extractReferencedSymbolIds,
  normalizeToolArguments,
  resolveProjectionRequestOptions,
} from "./mcp/request-normalization.js";
import {
  buildToolPresentation,
  buildVersionedToolDescription,
  type ToolPresentation,
} from "./mcp/tool-presentation.js";
import { getPackageVersion } from "./util/package-info.js";
import {
  projectCompatibilityValue,
  projectResultForUsageAccounting,
  resolveCompatibilityProjectionProfile,
} from "./mcp/context-response-projection.js";
import {
  extractProjectionOperationalStats,
  getProjectionProfile,
} from "./mcp/response-projection/registry.js";
import {
  ModelOutputBoundaryError,
  projectModelResponse,
} from "./mcp/response-projection/projectors/index.js";
import { measureProjectionValue } from "./mcp/response-projection/measure.js";
import type {
  EffectiveProjectionRequestOptions,
  ModelOutputBoundaryErrorCode,
  ModelProjection,
  ModelProjectionDependencies,
  ProjectionProfile,
  ProjectionStats,
} from "./mcp/response-projection/types.js";
import { logger } from "./util/logger.js";
import { estimateTokens } from "./util/tokenize.js";
import {
  maybeStoreLargeResponse,
  withCentralizedResponseArtifactHandling,
} from "./runtime/response-artifacts.js";
import {
  ARTIFACT_PAGE_BYTES,
  getOutputBudgetTokenLimit,
  MODEL_VISIBLE_HARD_LIMIT_TOKENS,
} from "./mcp/response-projection/budgets.js";
import {
  attachTimingDiagnostics,
  hasTimingDiagnostics,
  ToolPhaseTimer,
  type ToolTimingDiagnostics,
} from "./mcp/timing-diagnostics.js";
import { SDL_MCP_SERVER_INSTRUCTIONS } from "./mcp/server-instructions.js";
import { markActionArgsParsed } from "./gateway/dispatch-spine.js";
import {
  classifyPublicGraphRetrieval,
  workflowHasRefreshBeforeGraph,
} from "./mcp/public-graph-retrieval-admission.js";
import { assertGraphRetrievalAvailable } from "./services/graph-retrieval-availability.js";
import { GATEWAY_ACTION_DEFINITIONS } from "./code-mode/action-catalog.js";
import {
  readyStartupReadinessSnapshot,
  StorageNotWriteReadyError,
  type StartupReadinessSnapshot,
} from "./startup/readiness.js";

export interface ToolContext {
  progressToken?: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
  signal: AbortSignal;
  /** Set from transport session for HTTP; undefined for stdio (defaults to "stdio" in hooks). */
  sessionId?: string;
  /** Stable, low-cardinality client identity for outcome-trained policies. */
  clientKey?: string;
  /** Inferred task class used to scope predictive context learning. */
  taskType?: string;
  /** Transport request metadata, kept for telemetry and policy attribution only. */
  requestInfo?: unknown;
}

export type PostDispatchHook = (
  toolName: string,
  args: unknown,
  result: unknown,
  context: ToolContext,
) => Promise<void>;

function sanitizeClientKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 80);
}

function classifyUserAgent(userAgent: string): string {
  const lower = userAgent.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("vscode") || lower.includes("visual studio code"))
    return "vscode";
  if (lower.includes("cline")) return "cline";
  const firstProduct = userAgent.split(/\s+/)[0] ?? "unknown";
  return (
    sanitizeClientKeyPart(firstProduct.split("/")[0] ?? firstProduct) ||
    "unknown"
  );
}

export function deriveClientKey(
  sessionId?: string,
  requestInfo?: unknown,
): string {
  const explicitClient = readRequestHeader(requestInfo, "x-sdl-client");
  if (explicitClient) {
    return `client:${sanitizeClientKeyPart(explicitClient)}`;
  }
  const userAgent = readRequestHeader(requestInfo, "user-agent");
  if (userAgent) {
    return `ua:${classifyUserAgent(userAgent)}`;
  }
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return `session:${sanitizeClientKeyPart(sessionId)}`;
  }
  return "stdio";
}

function readRequestHeader(
  requestInfo: unknown,
  name: string,
): string | undefined {
  if (!requestInfo || typeof requestInfo !== "object") return undefined;
  const headers = (requestInfo as { headers?: unknown }).headers;
  const lowerName = name.toLowerCase();
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() !== lowerName) continue;
      if (typeof value === "string") return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return undefined;
}

function inferTaskType(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const explicit = extractStringField(args, "taskType");
  if (explicit) return explicit;
  const normalized = toolName.replace(/^sdl\./, "");
  const root = normalized.split(".")[0];
  return (root || "general").replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 64);
}

interface ToolHandler {
  (args: unknown, context?: ToolContext): Promise<unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: z.ZodType;
  handler: ToolHandler;
  wireSchema?: Record<string, unknown>;
  outputSchema?: z.ZodType;
  /** Exhaustive projected-result validator kept separate from compact tools/list schemas. */
  validationOutputSchema?: z.ZodType;
  presentation: ToolPresentation;
  projectionProfile: Readonly<ProjectionProfile>;
}

export function attachDisplayFooter(
  result: unknown,
  footerText: string,
): unknown {
  if (
    !footerText ||
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result;
  }

  const obj = result as Record<string, unknown>;
  const existingFooter =
    typeof obj._displayFooter === "string" ? obj._displayFooter : "";
  const mergedFooter = existingFooter
    ? `${existingFooter}\n\n${footerText}`
    : footerText;

  return {
    ...obj,
    _displayFooter: mergedFooter,
  };
}

function shouldIncludeDisplayFooter(toolArgs: Record<string, unknown>): boolean {
  const options = isRecordValue(toolArgs.options) ? toolArgs.options : {};
  return toolArgs.includeTelemetry === true
    || options.includeTelemetry === true
    || toolArgs.detail === "full"
    || options.detail === "full";
}

interface ToolResponseContentBlock {
  type: "text";
  text: string;
}

export interface ToolResponseEnvelope extends Record<string, unknown> {
  content: ToolResponseContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
  _displayFooter?: string;
  /** Non-enumerable internal stats; never serialized onto the MCP wire. */
  projectionStats?: ProjectionStats;
}

export interface ResponseProjectionBoundaryOverrides
  extends ModelProjectionDependencies {
  readonly handleProjection?: (
    projection: ModelProjection,
    includeStructuredContent: boolean,
  ) => ToolResponseEnvelope;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const STRUCTURED_CONTENT_INTERNAL_KEYS = new Set([
  "_packedPayload",
  "_packedStats",
  "_rawContext",
  "_tokenUsage",
  "_displayFooter",
  "actionsTaken",
  "metrics",
  "rungs",
  "taskId",
  "tokenEstimate",
]);

function asStructuredContent(
  value: unknown,
  toolArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const optionsFromArgs = (args: Record<string, unknown>) => {
    const options = isRecordValue(args.options) ? args.options : {};
    const detail = args.detail ?? options.detail;
    const fullDetail = detail === "full";
    return {
      includeDiagnostics:
        fullDetail || args.includeDiagnostics === true || options.includeDiagnostics === true,
      includeRetrievalEvidence:
        fullDetail
        || args.includeRetrievalEvidence === true
        || options.includeRetrievalEvidence === true,
    };
  };
  const workflowSteps = Array.isArray(toolArgs.steps) ? toolArgs.steps : [];
  const activeContainers = new Set<object>();
  const sanitizedContainers = new WeakMap<
    object,
    Record<string, unknown> | unknown[]
  >();
  let visitedValues = 0;
  const recordVisitedValue = (): void => {
    visitedValues += 1;
    if (visitedValues > 100_000) {
      throw new Error("Structured content size limit exceeded");
    }
  };
  const beginContainer = (
    container: object,
    depth: number,
  ): Record<string, unknown> | unknown[] | undefined => {
    if (depth > 128) {
      throw new Error("Structured content depth limit exceeded");
    }
    recordVisitedValue();
    if (activeContainers.has(container)) {
      throw new Error("Cyclic structured content");
    }
    const cached = sanitizedContainers.get(container);
    if (cached) {
      return cached;
    }
    activeContainers.add(container);
    return undefined;
  };

  const sanitize = (
    item: unknown,
    activeOptions: ReturnType<typeof optionsFromArgs>,
    isRoot = false,
    depth = 0,
  ): unknown => {
    if (Array.isArray(item)) {
      const cached = beginContainer(item, depth);
      if (cached) {
        return cached;
      }
      const sanitizedArray: unknown[] = [];
      sanitizedContainers.set(item, sanitizedArray);
      for (const child of item) {
        sanitizedArray.push(sanitize(child, activeOptions, false, depth + 1));
      }
      activeContainers.delete(item);
      return sanitizedArray;
    }
    if (!isRecordValue(item)) {
      recordVisitedValue();
      return item;
    }

    const cached = beginContainer(item, depth);
    if (cached) {
      return cached;
    }
    const sanitized: Record<string, unknown> = {};
    sanitizedContainers.set(item, sanitized);
    for (const [key, itemValue] of Object.entries(item)) {
      if (STRUCTURED_CONTENT_INTERNAL_KEYS.has(key) || (isRoot && key === "path")) {
        continue;
      }
      if (key === "diagnostics" && !activeOptions.includeDiagnostics) {
        continue;
      }
      if (key === "retrievalEvidence" && !activeOptions.includeRetrievalEvidence) {
        continue;
      }
      if (isRoot && key === "results" && Array.isArray(itemValue)) {
        sanitized.results = itemValue.map((step, index) => {
          if (!isRecordValue(step)) {
            return sanitize(step, activeOptions, false, depth + 1);
          }
          const cachedStep = beginContainer(step, depth + 1);
          if (cachedStep) {
            return cachedStep;
          }
          const sanitizedStep: Record<string, unknown> = {};
          sanitizedContainers.set(step, sanitizedStep);
          const sourceStepIndex = typeof step.stepIndex === "number"
            ? step.stepIndex
            : index;
          const workflowStep = workflowSteps[sourceStepIndex];
          const childArgs =
            isRecordValue(workflowStep) && isRecordValue(workflowStep.args)
              ? workflowStep.args
              : {};
          const childOptions = optionsFromArgs(childArgs);
          for (const [stepKey, stepValue] of Object.entries(step)) {
            sanitizedStep[stepKey] = sanitize(
              stepValue,
              stepKey === "result" ? childOptions : activeOptions,
              false,
              depth + 2,
            );
          }
          activeContainers.delete(step);
          return sanitizedStep;
        });
        continue;
      }
      sanitized[key] = sanitize(itemValue, activeOptions, false, depth + 1);
    }
    activeContainers.delete(item);
    return sanitized;
  };

  const structured = isRecordValue(value)
    ? sanitize(value, optionsFromArgs(toolArgs), true)
    : { value };
  return structured as Record<string, unknown>;
}

export function extractDeliveredSymbolIdsFromToolResult(
  result: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  collectDeliveredSymbolIds(result, ids);
  return [...ids].sort();
}

function collectDeliveredSymbolIds(
  result: Record<string, unknown>,
  ids: Set<string>,
): void {
  if (typeof result.results === "string") {
    addSymbolIdsFromPackedPayload(result.results, ids);
  } else {
    addSymbolIdsFromRows(result.results, ids);
  }
  addSymbolIdsFromRows(result.cards, ids);
  addSymbolIdFromCard(result.card, ids);
  addSymbolIdsFromEvidence(result.evidence, ids);
  if (typeof result._packedPayload === "string") {
    addSymbolIdsFromPackedPayload(result._packedPayload, ids);
  }
  // sdl.workflow wraps each step as { fn, result } inside results[].
  if (Array.isArray(result.results)) {
    for (const step of result.results) {
      if (isRecordValue(step) && isRecordValue(step.result)) {
        collectDeliveredSymbolIds(step.result, ids);
      }
    }
  }
}

function addSymbolIdsFromPackedPayload(payload: string, ids: Set<string>): void {
  if (!payload.startsWith("#PACKED/")) return;
  for (const line of payload.split("\n")) {
    if (!line.startsWith("@ids=")) continue;
    for (const entry of line.slice("@ids=".length).split(",")) {
      const separatorAt = entry.indexOf(":");
      if (separatorAt <= 0) continue;
      const fullId = entry.slice(separatorAt + 1);
      if (fullId.length > 0) ids.add(fullId);
    }
  }
}

function addSymbolIdsFromRows(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) addSymbolIdFromCard(item, ids);
}

function addSymbolIdFromCard(value: unknown, ids: Set<string>): void {
  if (!isRecordValue(value) || value.unchanged === true) return;
  const symbolId = value.symbolId;
  if (typeof symbolId === "string" && symbolId.length > 0) {
    ids.add(symbolId);
  }
}

function addSymbolIdsFromEvidence(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecordValue(item) || item.unchanged === true) continue;
    if (typeof item.symbolId === "string" && item.symbolId.length > 0) {
      ids.add(item.symbolId);
    }
  }
}

export function buildToolResponseContentBlocks(
  primaryPayload: unknown,
  _userDisplay: string | null,
  footerText: string,
  toolName = "",
  toolArgs: Record<string, unknown> = {},
): ToolResponseContentBlock[] {
  // Legacy display text cannot bypass the bounded, single-projection summary.
  return buildToolResponseEnvelope(
    primaryPayload,
    null,
    footerText,
    toolName,
    toolArgs,
  ).content;
}

const BOUNDARY_FAILURE_MESSAGES = Object.freeze({
  MODEL_PROJECTION_FAILED: "Model response projection failed.",
  MODEL_OUTPUT_MEASUREMENT_FAILED: "Model output measurement failed.",
  RESPONSE_HANDLING_FAILED: "Model response handling failed.",
} as const satisfies Readonly<Record<ModelOutputBoundaryErrorCode, string>>);

const DELIVERED_RESPONSE_ERROR_CODE = "DELIVERED_RESPONSE_ERROR";

const ERROR_PROJECTION_PROFILE = getProjectionProfile("info");
const ERROR_PROJECTION_OPTIONS = resolveProjectionRequestOptions({
  direct: {},
  profileDefault: ERROR_PROJECTION_PROFILE.defaultDetail,
});

function buildBoundaryFailureEnvelope(
  code: ModelOutputBoundaryErrorCode,
  includeStructuredContent: boolean,
): ToolResponseEnvelope {
  const message = BOUNDARY_FAILURE_MESSAGES[code];
  const content = [{ type: "text" as const, text: `${code}: ${message}` }];
  if (!includeStructuredContent) {
    return { content, isError: true };
  }
  return {
    content,
    structuredContent: {
      status: "error",
      error: { code, message },
    },
    isError: true,
  };
}

function asBoundaryFailureCode(
  value: unknown,
): ModelOutputBoundaryErrorCode | undefined {
  return value === "MODEL_PROJECTION_FAILED"
    || value === "MODEL_OUTPUT_MEASUREMENT_FAILED"
    || value === "RESPONSE_HANDLING_FAILED"
    ? value
    : undefined;
}

/** Audit the delivered outcome; boundary failures never expose canonical data. */
export function responseForDeliveryAudit(
  canonicalResult: Record<string, unknown>,
  envelope: ToolResponseEnvelope,
): Record<string, unknown> {
  if (envelope.isError !== true) {
    return canonicalResult;
  }

  const structuredError = isRecordValue(envelope.structuredContent?.error)
    ? envelope.structuredContent.error
    : undefined;
  const boundaryCode = asBoundaryFailureCode(structuredError?.code);
  if (boundaryCode) {
    return {
      status: "error",
      error: { code: boundaryCode },
    };
  }

  if (
    isRecordValue(canonicalResult.error)
    || canonicalResult.status === "error"
    || canonicalResult.status === "failure"
    || canonicalResult.status === "denied"
  ) {
    return canonicalResult;
  }
  return {
    status: "error",
    error: { code: DELIVERED_RESPONSE_ERROR_CODE },
  };
}

function projectionIsError(value: unknown, toolName: string): boolean {
  if (!isRecordValue(value)) {
    return false;
  }
  return isRecordValue(value.error)
    || value.status === "error"
    || value.status === "failure"
    || value.status === "denied"
    || (
      toolName === "sdl.workflow"
      && Array.isArray(value.results)
      && value.results.some(
        (result) => isRecordValue(result) && result.status === "error",
      )
    );
}

function workflowProjectionSummary(
  value: unknown,
  toolName: string,
  footerText: string,
): string | undefined {
  if (toolName !== "sdl.workflow" || !isRecordValue(value)) return undefined;
  const results = Array.isArray(value.results) ? value.results : [];
  let ok = 0;
  let error = 0;
  let skipped = 0;
  let budgetExceeded = 0;
  for (const result of results) {
    const status = isRecordValue(result) && typeof result.status === "string"
      ? result.status
      : "ok";
    if (status === "ok") ok += 1;
    else if (status === "skipped") skipped += 1;
    else if (status === "budget_exceeded") budgetExceeded += 1;
    else error += 1;
  }
  const summary = [
    `workflow -> total=${results.length}`,
    `ok=${ok}`,
    `error=${error}`,
    `skipped=${skipped}`,
    `budgetExceeded=${budgetExceeded}`,
    `truncated=${value.truncated === true}`,
  ].join(" ");
  return footerText ? `${summary}\n${footerText}` : summary;
}
function envelopeFromProjection(
  projection: ModelProjection,
  includeStructuredContent: boolean,
  toolName: string,
  visibleFooterText: string,
): ToolResponseEnvelope {
  const summary = workflowProjectionSummary(
    projection.value,
    toolName,
    visibleFooterText,
  ) ?? projection.summary;
  const content = [{ type: "text" as const, text: summary }];
  const isError = projectionIsError(projection.value, toolName);
  if (!includeStructuredContent) {
    return {
      content,
      ...(isError ? { isError: true as const } : {}),
      ...(visibleFooterText ? { _displayFooter: visibleFooterText } : {}),
    };
  }

  const structuredContent = isRecordValue(projection.value)
    ? projection.value
    : { value: projection.value };
  return {
    content,
    structuredContent,
    ...(isError ? { isError: true as const } : {}),
    ...(visibleFooterText ? { _displayFooter: visibleFooterText } : {}),
  };
}

function attachProjectionStats(
  envelope: ToolResponseEnvelope,
  stats: ProjectionStats,
): ToolResponseEnvelope {
  Object.defineProperty(envelope, "projectionStats", {
    value: stats,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return envelope;
}

export function buildToolResponseEnvelope(
  primaryPayload: unknown,
  _userDisplay: string | null,
  footerText: string,
  toolName = "",
  toolArgs: Record<string, unknown> = {},
  _structuredPayload: unknown = primaryPayload,
  // MCP clients validate structured content against outputSchema even for isError results.
  includeStructuredContent = true,
  projectionProfile: Readonly<ProjectionProfile> =
    resolveCompatibilityProjectionProfile(toolName),
  projectionOptions: EffectiveProjectionRequestOptions =
    resolveProjectionRequestOptions({
      direct: toolArgs,
      profileDefault: projectionProfile.defaultDetail,
    }),
  boundaryOverrides: ResponseProjectionBoundaryOverrides = {},
  projectionAction = toolName,
): ToolResponseEnvelope {
  const visibleFooterText = shouldIncludeDisplayFooter(toolArgs) ? footerText : "";
  let projection: ModelProjection;
  try {
    projection = projectModelResponse(
      {
        canonicalResult: primaryPayload,
        action: projectionAction,
        profile: projectionProfile,
        options: projectionOptions,
        context: {
          toolName,
          requestArgs: toolArgs,
          footerText: visibleFooterText || undefined,
          measurementSource: primaryPayload,
        },
      },
      {
        projectCompatibilityValue,
        prepareCanonicalValue: (canonicalValue) =>
          asStructuredContent(canonicalValue, toolArgs),
        ...boundaryOverrides,
      },
    );
  } catch (error) {
    if (error instanceof ModelOutputBoundaryError) {
      return buildBoundaryFailureEnvelope(
        error.code,
        includeStructuredContent,
      );
    }
    throw error;
  }

  try {
    const envelope = boundaryOverrides.handleProjection
      ? boundaryOverrides.handleProjection(projection, includeStructuredContent)
      : envelopeFromProjection(
          projection,
          includeStructuredContent,
          toolName,
          visibleFooterText,
        );
    return attachProjectionStats(envelope, projection.stats);
  } catch {
    return buildBoundaryFailureEnvelope(
      "RESPONSE_HANDLING_FAILED",
      includeStructuredContent,
    );
  }
}

const PAGE_NATIVE_RESPONSE_MODE_TOOLS = new Set([
  "sdl.response.get",
  "sdl.runtime.queryOutput",
  "sdl.code.needWindow",
  "sdl.file.read",
  "sdl.search.edit",
  "sdl.file",
]);

function ownsPageNativeResponseMode(toolName: string): boolean {
  // These tools own byte, line, or plan continuations; the generic artifact
  // boundary must not replace their executable paging semantics.
  return PAGE_NATIVE_RESPONSE_MODE_TOOLS.has(toolName);
}

function combinedEnvelopeTokens(envelope: ToolResponseEnvelope): number {
  const visibleText = envelope.content.map((block) => block.text).join("\n");
  const structuredText = JSON.stringify(envelope.structuredContent ?? {});
  return estimateTokens(visibleText) + estimateTokens(structuredText);
}

type FinalProjectionFlags = Pick<
  ProjectionStats,
  "responseHandled" | "recoveryEmitted"
>;

function attachFinalProjectionStats(
  sourceEnvelope: ToolResponseEnvelope,
  finalEnvelope: ToolResponseEnvelope,
  flags: FinalProjectionFlags,
): ToolResponseEnvelope {
  if (!sourceEnvelope.projectionStats) {
    return finalEnvelope;
  }
  const finalMeasurement = measureProjectionValue(
    finalEnvelope.structuredContent,
  );
  return attachProjectionStats(
    finalEnvelope,
    Object.freeze({
      ...sourceEnvelope.projectionStats,
      projectedBytes: finalMeasurement.bytes,
      projectedTokens: finalMeasurement.tokens,
      ...flags,
    }),
  );
}

function responseArtifactEnvelope(
  envelope: ToolResponseEnvelope,
  artifact: object,
): ToolResponseEnvelope {
  const artifactEnvelope: ToolResponseEnvelope = {
    content: [
      {
        type: "text",
        text: "Response stored as an artifact. Continue with response.get.",
      },
    ],
    structuredContent: { ...artifact },
  };
  return attachFinalProjectionStats(
    envelope,
    artifactEnvelope,
    {
      responseHandled: true,
      recoveryEmitted: true,
    },
  );
}

async function enforceProjectedResponseMode(
  envelope: ToolResponseEnvelope,
  toolName: string,
  toolArgs: Readonly<Record<string, unknown>>,
  profile: ProjectionProfile,
  sessionId?: string,
): Promise<ToolResponseEnvelope> {
  const requestedMode = toolArgs.responseMode;
  if (
    requestedMode !== "inline" &&
    requestedMode !== "auto" &&
    requestedMode !== "handle"
  ) {
    return envelope;
  }
  if (
    requestedMode !== "inline" &&
    ownsPageNativeResponseMode(toolName)
  ) {
    return envelope;
  }

  const deliveredTokens = combinedEnvelopeTokens(envelope);
  const exceedsInlineBudget =
    deliveredTokens > MODEL_VISIBLE_HARD_LIMIT_TOKENS;
  const shouldStore =
    requestedMode === "handle" ||
    (requestedMode === "auto" &&
      deliveredTokens > getOutputBudgetTokenLimit(profile.budgetClass));
  if (!shouldStore && !(requestedMode === "inline" && exceedsInlineBudget)) {
    return envelope;
  }

  const repoId = toolArgs.repoId;
  if (
    typeof repoId !== "string" ||
    repoId.length === 0 ||
    !envelope.structuredContent
  ) {
    return attachFinalProjectionStats(
      envelope,
      buildBoundaryFailureEnvelope("RESPONSE_HANDLING_FAILED", true),
      {
        responseHandled: true,
        recoveryEmitted: false,
      },
    );
  }

  try {
    const runtimeConfig = RuntimeConfigSchema.parse(loadConfig().runtime ?? {});
    const stored = await maybeStoreLargeResponse({
      repoId,
      toolName,
      payload: envelope.structuredContent,
      responseMode: "handle",
      contentKind: "json",
      artifactBaseDir: runtimeConfig.artifactBaseDir,
      maxArtifactBytes: runtimeConfig.maxArtifactBytes,
      sessionId,
      requiresSameSession: sessionId !== undefined,
    });
    if (stored.responseMode !== "handle") {
      return attachFinalProjectionStats(
        envelope,
        buildBoundaryFailureEnvelope("RESPONSE_HANDLING_FAILED", true),
        {
          responseHandled: true,
          recoveryEmitted: false,
        },
      );
    }

    if (shouldStore) {
      return responseArtifactEnvelope(
        envelope,
        stored.payload,
      );
    }

    const nextAction = {
      action: "response.get" as const,
      args: {
        repoId,
        handle: stored.payload.handle,
        view: "model" as const,
        cursor: { offsetBytes: 0 },
        maxBytes: ARTIFACT_PAGE_BYTES,
      },
    };
    const structuredContent = {
      status: "error",
      error: {
        code: "INLINE_RESPONSE_TOO_LARGE",
        message: "Inline response exceeds the 8,000-token delivery limit.",
      },
      nextAction,
    };
    return attachFinalProjectionStats(
      envelope,
      {
        content: [
          {
            type: "text",
            text: "Inline response too large. Retrieve the sanitized response artifact with response.get.",
          },
        ],
        structuredContent,
        isError: true,
      },
      {
        responseHandled: true,
        recoveryEmitted: true,
      },
    );
  } catch {
    return attachFinalProjectionStats(
      envelope,
      buildBoundaryFailureEnvelope("RESPONSE_HANDLING_FAILED", true),
      {
        responseHandled: true,
        recoveryEmitted: false,
      },
    );
  }
}

export interface MCPServerOptions {
  /** OpenAI-compatible clients reject dots in tool names; keep canonical by default. */
  toolNameFormat?: ToolNameFormat;
  getStartupReadiness?: () => StartupReadinessSnapshot;
  resolveProjectionProfile?: (
    actionOrToolName: string,
  ) => Readonly<ProjectionProfile> | undefined;
  responseProjectionBoundaryOverrides?: ResponseProjectionBoundaryOverrides;
}

export class MCPServer {
  private server: Server;
  private tools: Map<string, ToolDefinition> = new Map();
  private clientToolNameToCanonical: Map<string, string> = new Map();
  private readonly toolNameFormat: ToolNameFormat;
  private readonly getStartupReadiness: () => StartupReadinessSnapshot;
  private readonly resolveProjectionProfile: (
    actionOrToolName: string,
  ) => Readonly<ProjectionProfile> | undefined;
  private readonly responseProjectionBoundaryOverrides:
    ResponseProjectionBoundaryOverrides;
  private _gatewayMode = false;
  private postDispatchHooks: PostDispatchHook[] = [];
  private activeWorkflowFunctions: Set<string> = new Set();

  constructor(options: MCPServerOptions = {}) {
    this.toolNameFormat = options.toolNameFormat ?? "canonical";
    this.getStartupReadiness =
      options.getStartupReadiness ?? readyStartupReadinessSnapshot;
    this.resolveProjectionProfile =
      options.resolveProjectionProfile ?? getProjectionProfile;
    this.responseProjectionBoundaryOverrides =
      options.responseProjectionBoundaryOverrides ?? {};
    this.server = new Server(
      {
        name: "sdl-mcp",
        version: getPackageVersion(),
      },
      {
        capabilities: {
          tools: { listChanged: true },
          logging: {},
        },
      },
    );

    // Surface transport-level errors (malformed JSON-RPC, write failures,
    // notification handler exceptions) instead of silently swallowing them.
    this.server.onerror = (error) => {
      process.stderr.write(
        `[sdl-mcp] MCP protocol error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    this.setupHandlers();
  }

  get gatewayMode(): boolean {
    return this._gatewayMode;
  }

  set gatewayMode(value: boolean) {
    this._gatewayMode = value;
  }

  registerPostDispatchHook(hook: PostDispatchHook): void {
    this.postDispatchHooks.push(hook);
  }

  /** Freeze the workflow functions recoveries may advertise for this registration. */
  setActiveWorkflowFunctions(functionNames: readonly string[]): void {
    this.activeWorkflowFunctions = new Set(functionNames);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        return {
          tools: Array.from(this.tools.values()).map((tool, index) => {
            const description =
              tool.presentation.includeVersionInDescription === false
                ? tool.description
                : buildVersionedToolDescription(tool.description);

            return {
              name: this.formatToolNameForClient(tool.name),
              title: tool.presentation.title,
              // Some clients repeat server instructions for every tool. Keep one
              // deterministic fallback copy in the first advertised catalog entry.
              description:
                index === 0
                  ? `${SDL_MCP_SERVER_INSTRUCTIONS}\n\n${description}`
                  : description,
              annotations: {
                title: tool.presentation.title,
              } satisfies ToolAnnotations,
              inputSchema:
                tool.wireSchema ??
                convertSchema(tool.inputSchema, this._gatewayMode),
              ...(tool.outputSchema
                ? {
                    outputSchema: convertOutputSchema(
                      tool.outputSchema,
                      this._gatewayMode,
                    ),
                  }
                : {}),
            };
          }),
        };
      } catch (error) {
        process.stderr.write(`[sdl-mcp] ListTools error: ${error}\n`);
        throw error;
      }
    });

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const extraContext = extra as typeof extra & {
          requestInfo?: unknown;
          sessionId?: string;
        };
        const toolContext: ToolContext = {
          progressToken: extra._meta?.progressToken,
          sendNotification: extra.sendNotification,
          signal: extra.signal,
          sessionId: extraContext.sessionId,
          clientKey: deriveClientKey(
            extraContext.sessionId,
            extraContext.requestInfo,
          ),
          requestInfo: extraContext.requestInfo,
        };

        try {
          const requestedToolName = request.params.name;
          const toolName = this.resolveCanonicalToolName(requestedToolName);
          const tool = this.tools.get(toolName);
          if (!tool) {
            const notFoundResponse = {
              error: {
                message: "Tool not found",
                code: "TOOL_NOT_FOUND",
              },
            };
            return {
              ...buildToolResponseEnvelope(
                notFoundResponse,
                null,
                "",
                toolName,
                {},
                notFoundResponse,
                true,
                ERROR_PROJECTION_PROFILE,
                ERROR_PROJECTION_OPTIONS,
                this.responseProjectionBoundaryOverrides,
              ),
              isError: true,
            };
          }

          const start = Date.now();
          const timer = new ToolPhaseTimer();
          const normalizeStartedAt = timer.start();
          const normalizedArgs = normalizeToolArguments(
            request.params.arguments,
            toolContext.sessionId,
          );
          timer.record("server.normalize", normalizeStartedAt);
          const projectionOptions = resolveProjectionRequestOptions({
            direct: normalizedArgs,
            profileDefault: tool.projectionProfile.defaultDetail,
          });
          const startupReadiness = this.getStartupReadiness();
          const writeReady = startupReadiness.state === "ready";
          const includeDiagnostics = wantsTimingDiagnostics(normalizedArgs);
          const repoId = extractStringField(normalizedArgs, "repoId");
          const symbolId = extractStringField(normalizedArgs, "symbolId");
          toolContext.taskType = inferTaskType(
            toolName,
            normalizedArgs as Record<string, unknown>,
          );

          // Centralized input validation: parse against the registered Zod schema
          // before dispatching to the handler. This ensures all tools receive
          // validated, coerced arguments regardless of individual handler logic.
          const validationStartedAt = timer.start();
          const parseResult = tool.inputSchema.safeParse(normalizedArgs);
          timer.record("server.validate", validationStartedAt);
          if (!parseResult.success) {
            const issueDetails = parseResult.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            }));
            const humanLines = issueDetails.map((d) =>
              d.path ? `  - ${d.path}: ${d.message}` : `  - ${d.message}`,
            );
            const validationError = {
              error: {
                message: `Invalid tool arguments:\n${humanLines.join("\n")}`,
                code: "VALIDATION_ERROR",
                details: issueDetails,
              },
            };
            process.stderr.write(
              `[sdl-mcp] Tool ${toolName} validation error: ${JSON.stringify(validationError)}
`,
            );
            const responseForLog = includeDiagnostics
              ? attachTimingDiagnostics(validationError, timer.snapshot())
              : validationError;
            logToolCall({
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: responseForLog,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              diagnostics: extractTimingDiagnostics(responseForLog),
            }, {
              persistAudit: writeReady,
            });
            return {
              ...buildToolResponseEnvelope(
                responseForLog,
                null,
                "",
                toolName,
                normalizedArgs as Record<string, unknown>,
                responseForLog,
                true,
                tool.projectionProfile,
                projectionOptions,
                this.responseProjectionBoundaryOverrides,
              ),
              isError: true,
            };
          }

          const parsedArgs = markActionArgsParsed(
            tool.inputSchema,
            parseResult.data,
          );
          const effectiveProjectionAction = READ_ONLY_GATEWAY_TOOLS.has(toolName)
            ? extractStringField(parsedArgs, "action") ?? toolName
            : toolName;
          const effectiveProjectionProfile =
            this.resolveProjectionProfile(effectiveProjectionAction)
            ?? tool.projectionProfile;
          const effectiveProjectionOptions = resolveProjectionRequestOptions({
            direct: normalizedArgs,
            profileDefault: effectiveProjectionProfile.defaultDetail,
          });
          const centralizesHandlerArtifacts =
            isRecordValue(parsedArgs) &&
            (parsedArgs.responseMode === "auto" ||
              parsedArgs.responseMode === "handle") &&
            !ownsPageNativeResponseMode(toolName);
          try {
            if (
              !writeReady &&
              !isReadOnlyWhenDegraded(toolName, parsedArgs)
            ) {
              throw new StorageNotWriteReadyError(startupReadiness);
            }

            const dispatchTool = async (): Promise<unknown> => {
              const graphAdmission = classifyPublicGraphRetrieval(
                toolName,
                parsedArgs,
              );
              if (graphAdmission.mode === "central") {
                if (!graphAdmission.repoId) {
                  throw new IndexError(
                    "Graph retrieval requires an explicit repoId. Provide repoId.",
                  );
                }
                const conn = await getLadybugConn();
                try {
                  await assertGraphRetrievalAvailable(
                    conn,
                    graphAdmission.repoId,
                  );
                } catch (error) {
                  if (
                    error instanceof GraphRetrievalUnavailableError
                    && toolName === "sdl.workflow"
                    && workflowHasRefreshBeforeGraph(parsedArgs)
                  ) {
                    error.message +=
                      " Run indexRefresh in one sdl.workflow, wait for it to complete, then run graph retrieval in a second sdl.workflow.";
                    throw error;
                  }
                  throw error;
                }
              }
              if (toolContext.sessionId && isRecordValue(parsedArgs)) {
                const referencedSymbolIds =
                  extractReferencedSymbolIds(parsedArgs);
                if (referencedSymbolIds.length > 0) {
                  wasteLedger.recordReferenced(
                    toolContext.sessionId,
                    referencedSymbolIds,
                  );
                }
              }
              return centralizesHandlerArtifacts
                ? withCentralizedResponseArtifactHandling(() =>
                    tool.handler(parsedArgs, toolContext),
                  )
                : tool.handler(parsedArgs, toolContext);
            };

            // Pass the parsed (validated + coerced) data to the handler
            const dispatchStartedAt = timer.start();
            const runDispatch = () =>
              shouldBypassToolDispatch(toolName, parsedArgs)
                ? dispatchTool()
                : runToolDispatch(dispatchTool, undefined, toolName);
            // Refresh admission must happen before the outer dispatch lease.
            // This also covers workflows, whose refresh step executes inside
            // the workflow's single outer lease rather than acquiring its own.
            const result = isPublicIndexRefresh(toolName, parsedArgs)
              ? await runIndexRefreshAdmission(runDispatch, toolContext.signal)
              : await runDispatch();
            timer.record("server.dispatch", dispatchStartedAt);

            // Preserve the canonical handler value for workflow piping, hooks,
            // audit, and usage. Only the model projection removes private fields.
            const responseProcessingStartedAt = timer.start();
            const canonicalResult = result;
            const handlerDurationMs = Date.now() - start;
            let tokensUsedForObs: number | undefined;
            let tokensSavedForObs: number | undefined;
            let deliveredTokenCount: number | undefined;
            let userDisplay: string | null = null;
            if (isRecordValue(canonicalResult)) {
              const usageAccountingResult = projectResultForUsageAccounting(
                toolName,
                canonicalResult,
                normalizedArgs as Record<string, unknown>,
              );
              let usage = canonicalResult._tokenUsage as
                | TokenUsageMetadata
                | undefined;
              if (
                shouldAttachUsage(toolName)
                && usageAccountingResult._rawContext
              ) {
                usage = await computeTokenUsage(usageAccountingResult);
              }

              if (usage) {
                tokenAccumulator.recordUsage(
                  toolName,
                  usage.sdlTokens,
                  usage.rawEquivalent,
                );
                tokensUsedForObs = usage.sdlTokens;
                deliveredTokenCount = usage.sdlTokens;
                tokensSavedForObs = Math.max(
                  0,
                  usage.rawEquivalent - usage.sdlTokens,
                );
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: renderUserNotificationLine(
                        usage.sdlTokens,
                        usage.rawEquivalent,
                      ),
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
              } else if (
                shouldAttachUsage(toolName)
                && typeof canonicalResult.totalTokens === "number"
                && canonicalResult.totalTokens > 0
              ) {
                tokenAccumulator.recordUsage(
                  toolName,
                  canonicalResult.totalTokens,
                  canonicalResult.totalTokens,
                );
                tokensUsedForObs = canonicalResult.totalTokens;
                deliveredTokenCount = canonicalResult.totalTokens;
                tokensSavedForObs = 0;
              }

              if (
                toolContext.sessionId
                && deliveredTokenCount !== undefined
                && deliveredTokenCount > 0
              ) {
                const deliveredSymbolIds =
                  extractDeliveredSymbolIdsFromToolResult(canonicalResult);
                if (deliveredSymbolIds.length > 0) {
                  wasteLedger.recordDelivered(
                    toolContext.sessionId,
                    toolName,
                    deliveredSymbolIds,
                    deliveredTokenCount,
                  );
                }
              }

              userDisplay = formatToolCallForUser(
                toolName,
                normalizedArgs as Record<string, unknown>,
                canonicalResult,
              );
              if (userDisplay) {
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: userDisplay,
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
              }

              if (
                toolName === "sdl.usage.stats"
                && typeof canonicalResult.formattedSummary === "string"
              ) {
                userDisplay = canonicalResult.formattedSummary;
                void toolContext
                  .sendNotification({
                    method: "notifications/message",
                    params: {
                      level: "info",
                      logger: "sdl-mcp",
                      data: canonicalResult.formattedSummary,
                    },
                  })
                  .catch(() => {
                    /* non-critical */
                  });
              }
            }

            // Post-dispatch hooks may persist learned state, so skip them while degraded.
            if (writeReady) {
              for (const hook of this.postDispatchHooks) {
                const hookAbortController = new AbortController();
                const abortHook = (): void => {
                  hookAbortController.abort();
                };
                if (toolContext.signal.aborted) {
                  hookAbortController.abort();
                } else {
                  toolContext.signal.addEventListener("abort", abortHook, {
                    once: true,
                  });
                }
                const hookContext: ToolContext = {
                  ...toolContext,
                  signal: hookAbortController.signal,
                };
                let timeoutHandle: NodeJS.Timeout | null = null;
                try {
                  const hookStartedAt = timer.start();
                  await Promise.race([
                    hook(toolName, parsedArgs, canonicalResult, hookContext),
                    new Promise((_, reject) =>
                      (timeoutHandle = setTimeout(() => {
                        hookAbortController.abort();
                        reject(new Error("Post-dispatch hook timed out"));
                      }, 5_000)).unref(),
                    ),
                  ]);
                  timer.record("server.postDispatchHook", hookStartedAt);
                } catch (err) {
                  process.stderr.write(
                    `[sdl-mcp] Post-dispatch hook failed for tool ${toolName}: ${err instanceof Error ? err.message : String(err)}\n`,
                  );
                } finally {
                  if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                  }
                  toolContext.signal.removeEventListener("abort", abortHook);
                }
              }
            }
            timer.record(
              "server.responseProcessing",
              responseProcessingStartedAt,
            );

            const responseForProjection = includeDiagnostics
              ? attachTimingDiagnostics(canonicalResult, timer.snapshot())
              : canonicalResult;
            const projectedResponseEnvelope = buildToolResponseEnvelope(
              responseForProjection,
              userDisplay,
              "",
              toolName,
              normalizedArgs as Record<string, unknown>,
              responseForProjection,
              true,
              effectiveProjectionProfile,
              effectiveProjectionOptions,
              this.responseProjectionBoundaryOverrides,
              effectiveProjectionAction,
            );
            const responseEnvelope = await enforceProjectedResponseMode(
              projectedResponseEnvelope,
              toolName,
              normalizedArgs as Record<string, unknown>,
              effectiveProjectionProfile,
              toolContext.sessionId,
            );

            if (tool.validationOutputSchema) {
              const validation = tool.validationOutputSchema.safeParse(
                responseEnvelope.structuredContent,
              );
              if (!validation.success) {
                const issues = validation.error.issues
                  .map((issue) =>
                    `${issue.path.join(".") || "<root>"}: ${issue.message}`,
                  )
                  .join("; ");
                throw new Error(
                  `Structured content does not match internal output schema: ${issues}`,
                );
              }
            }

            const toolCallEvent: ToolCallEvent = {
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: responseForDeliveryAudit(
                canonicalResult as Record<string, unknown>,
                responseEnvelope,
              ),
              durationMs: handlerDurationMs,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              tokensUsed: tokensUsedForObs,
              tokensSaved: tokensSavedForObs,
              diagnostics: extractTimingDiagnostics(responseForProjection),
              projection: responseEnvelope.projectionStats,
              operationalStats: extractProjectionOperationalStats(
                effectiveProjectionProfile,
                canonicalResult,
              ),
            };
            logToolCall(toolCallEvent, {
              persistAudit: writeReady,
            });
            return responseEnvelope;
          } catch (error) {
            process.stderr.write(
              `[sdl-mcp] Tool ${toolName} error: ${error}\n`,
            );
            const errorResponse = errorToMcpResponse(
              error,
              [...this.tools.keys()],
              [...this.activeWorkflowFunctions],
            );
            const responseForLog = includeDiagnostics
              ? attachTimingDiagnostics(errorResponse, timer.snapshot())
              : errorResponse;
            // Project and finalize the error before observability sees it.
            const errorEnvelope = buildToolResponseEnvelope(
              responseForLog,
              null,
              "",
              toolName,
              normalizedArgs as Record<string, unknown>,
              responseForLog,
              true,
              effectiveProjectionProfile,
              effectiveProjectionOptions,
              this.responseProjectionBoundaryOverrides,
              effectiveProjectionAction,
            );
            errorEnvelope.isError = true;
            logToolCall({
              tool: toolName,
              request: normalizedArgs as Record<string, unknown>,
              response: responseForLog,
              durationMs: Date.now() - start,
              repoId,
              symbolId,
              clientKey: toolContext.clientKey,
              taskType: toolContext.taskType,
              diagnostics: extractTimingDiagnostics(responseForLog),
              projection: errorEnvelope.projectionStats,
            }, {
              persistAudit: writeReady,
            });
            return errorEnvelope;
          }
        } catch (outerError) {
          process.stderr.write(
            `[sdl-mcp] CallTool outer error: ${outerError}\n`,
          );
          const outerErrorResponse = errorToMcpResponse(
            outerError,
            [...this.tools.keys()],
            [...this.activeWorkflowFunctions],
          );
          return {
            ...buildToolResponseEnvelope(
              outerErrorResponse,
              null,
              "",
              request.params.name,
              {},
              outerErrorResponse,
              false,
              ERROR_PROJECTION_PROFILE,
              ERROR_PROJECTION_OPTIONS,
              this.responseProjectionBoundaryOverrides,
            ),
            isError: true,
          };
        }
      },
    );
  }

  registerTool(
    name: string,
    description: string,
    inputSchema: z.ZodType,
    handler: ToolHandler,
    wireSchema?: Record<string, unknown>,
    presentation?: Partial<ToolPresentation>,
    outputSchema?: z.ZodType,
    validationOutputSchema?: z.ZodType,
  ): void {
    const projectionProfile = this.resolveProjectionProfile(name);
    if (!projectionProfile) {
      const action = name.startsWith("sdl.") ? name.slice("sdl.".length) : name;
      throw new Error(`Missing response projection profile: ${action}`);
    }
    if (this.tools.has(name)) {
      logger.warn("Duplicate tool registration", { name });
    }
    this.registerToolNameAlias(name);
    this.tools.set(name, {
      name,
      description,
      inputSchema,
      handler,
      wireSchema,
      outputSchema,
      validationOutputSchema,
      presentation: buildToolPresentation(name, presentation),
      projectionProfile,
    });
  }

  private formatToolNameForClient(name: string): string {
    if (this.toolNameFormat !== "openai") {
      return name;
    }
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  }

  private registerToolNameAlias(name: string): void {
    const clientName = this.formatToolNameForClient(name);
    const existing = this.clientToolNameToCanonical.get(clientName);
    if (existing && existing !== name) {
      throw new Error(
        `Tool name alias collision for ${clientName}: ${existing} and ${name}`,
      );
    }
    this.clientToolNameToCanonical.set(clientName, name);
  }

  private resolveCanonicalToolName(name: string): string {
    return this.clientToolNameToCanonical.get(name) ?? name;
  }
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    // Usage persistence is handled by the ShutdownManager's "persistUsage"
    // cleanup (registered in serve.ts) which runs while the DB is still open.
    await this.server.close();
  }

  getServer(): Server {
    return this.server;
  }

  /**
   * Clear all registered tools and notify connected clients.
   * Used when toggling gateway mode at runtime.
   */
  clearTools(): void {
    this.tools.clear();
    this.activeWorkflowFunctions.clear();
  }

  /**
   * Notify connected clients that the tool list has changed.
   * Clients that support listChanged will re-fetch tools/list.
   */
  async notifyToolListChanged(): Promise<void> {
    try {
      await this.server.sendToolListChanged();
    } catch (err) {
      // Swallow errors if no client is connected or notification fails
      logger.warn("Failed to send tool list changed notification", {
        error: err,
      });
    }
  }
}

export function isMetadataOnlyTool(name: string): boolean {
  return name === "sdl.action.search" || name === "sdl.manual";
}

const DIRECT_STATUS_TOOL_NAMES = new Set([
  "sdl.repo.status",
  "repo.status",
  "sdl.buffer.status",
  "buffer.status",
  "sdl.policy.get",
  "policy.get",
  "sdl.response.get",
  "response.get",
  "sdl.usage.stats",
  "usage.stats",
]);

const STATUS_GATEWAY_TOOL_NAMES = new Set([
  "sdl.repo",
  "sdl.agent",
  "sdl.code",
  "sdl.query",
]);

const STATUS_WORKFLOW_FNS = new Set([
  "repo.status",
  "repoStatus",
  "buffer.status",
  "bufferStatus",
  "policy.get",
  "policyGet",
  "usage.stats",
  "usageStats",
  "response.get",
  "responseGet",
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
  "workflowContinuationGet",
]);

const READ_ONLY_ACTIONS = new Set([
  "symbol.search",
  "symbol.getCard",
  "slice.spillover.get",
  "pr.risk.analyze",
  "code.getSkeleton",
  "code.getHotPath",
  "repo.status",
  "repo.overview",
  "policy.get",
  "agent.feedback.query",
  "buffer.status",
  "runtime.queryOutput",
  "response.get",
  "memory.query",
  "memory.surface",
  "usage.stats",
  "file.read",
  "semantic.enrichment.status",
]);

const READ_ONLY_METADATA_TOOLS = new Set([
  "sdl.action.search",
  "action.search",
  "sdl.manual",
  "manual",
  "sdl.info",
  "info",
  "sdl.context",
  "context",
]);

const READ_ONLY_GATEWAY_TOOLS = new Set([
  "sdl.query",
  "sdl.code",
  "sdl.repo",
  "sdl.agent",
]);

const READ_ONLY_RETRIEVE_OPS = new Set([
  "symbolSearch",
  "symbolGetCard",
  "codeSkeleton",
  "codeHotPath",
]);

const READ_ONLY_WORKFLOW_FNS = new Set([
  ...READ_ONLY_ACTIONS,
  ...GATEWAY_ACTION_DEFINITIONS.filter((definition) =>
    READ_ONLY_ACTIONS.has(definition.action),
  ).map((definition) => definition.fn),
  "dataPick",
  "dataMap",
  "dataFilter",
  "dataSort",
  "dataTemplate",
  "workflowContinuationGet",
]);

/**
 * Fail-closed admission used only while startup readiness is not ready.
 * Tool discovery stays static; calls must match this audited read-only surface.
 */
export function isReadOnlyWhenDegraded(name: string, args: unknown): boolean {
  if (READ_ONLY_METADATA_TOOLS.has(name)) return true;

  const flatAction = name.startsWith("sdl.") ? name.slice(4) : name;
  if (READ_ONLY_ACTIONS.has(flatAction)) return true;

  if (READ_ONLY_GATEWAY_TOOLS.has(name)) {
    const action = extractStringField(args, "action");
    return action !== undefined && READ_ONLY_ACTIONS.has(action);
  }

  if (name === "sdl.retrieve") {
    const op = extractStringField(args, "op");
    return op !== undefined && READ_ONLY_RETRIEVE_OPS.has(op);
  }

  if (name === "sdl.file") {
    return extractStringField(args, "op") === "read";
  }

  if (name !== "sdl.workflow" || !args || typeof args !== "object") {
    return false;
  }

  const steps = (args as { steps?: unknown }).steps;
  return (
    Array.isArray(steps) &&
    steps.length > 0 &&
    steps.every((step) => {
      if (!step || typeof step !== "object") return false;
      const fn = (step as { fn?: unknown }).fn;
      return typeof fn === "string" && READ_ONLY_WORKFLOW_FNS.has(fn);
    })
  );
}

export function shouldBypassToolDispatch(name: string, args: unknown): boolean {
  if (isMetadataOnlyTool(name) || DIRECT_STATUS_TOOL_NAMES.has(name)) {
    return true;
  }
  if (STATUS_GATEWAY_TOOL_NAMES.has(name)) {
    const action = extractStringField(args, "action");
    return action !== undefined && STATUS_WORKFLOW_FNS.has(action);
  }
  if (name !== "sdl.workflow") {
    return false;
  }
  return isStatusOnlyWorkflow(args);
}

export function isPublicIndexRefresh(name: string, args: unknown): boolean {
  if (name === "sdl.index.refresh") return true;
  if (name === "sdl.repo") {
    return extractStringField(args, "action") === "index.refresh";
  }
  if (name !== "sdl.workflow" || !args || typeof args !== "object") {
    return false;
  }
  if ((args as { dryRun?: unknown }).dryRun === true) return false;
  const steps = (args as { steps?: unknown }).steps;
  return (
    Array.isArray(steps) &&
    steps.some((step) => {
      if (step === null || typeof step !== "object") return false;
      const fn = (step as { fn?: unknown }).fn;
      return fn === "indexRefresh" || fn === "index.refresh";
    })
  );
}

function isStatusOnlyWorkflow(args: unknown): boolean {
  if (!args || typeof args !== "object") {
    return false;
  }
  const steps = (args as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return false;
  }

  // Keep read-only status workflows visible while an index refresh owns the
  // normal dispatch slot. Mutating, runtime, and context-building workflow
  // steps still go through the shared limiter.
  return steps.every((step) => {
    if (!step || typeof step !== "object") {
      return false;
    }
    const fn = (step as { fn?: unknown }).fn;
    return typeof fn === "string" && STATUS_WORKFLOW_FNS.has(fn);
  });
}

function extractStringField(args: unknown, field: string): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function wantsTimingDiagnostics(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { includeDiagnostics?: unknown }).includeDiagnostics === true
  );
}

function extractTimingDiagnostics(
  value: unknown,
): ToolTimingDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
  return hasTimingDiagnostics(diagnostics) ? diagnostics : undefined;
}

function convertSchema(
  schema: z.ZodType,
  compact = false,
): Record<string, unknown> {
  if (compact) {
    return buildCompactJsonSchema(schema);
  }
  return zodSchemaToJsonSchema(schema);
}

const GENERIC_ERROR_DETAIL_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1 },
    code: { type: "string", minLength: 1 },
    details: { type: "array" },
    classification: { type: "string" },
    retryable: { type: "boolean" },
    fallbackTools: { type: "array", items: { type: "string" } },
    fallbackRationale: { type: "string" },
  },
  required: ["message"],
  additionalProperties: true,
} as const;

function convertOutputSchema(
  schema: z.ZodType,
  compact: boolean,
): Record<string, unknown> {
  const successSchema = convertSchema(schema, compact);

  const successProperties = isRecordValue(successSchema["properties"])
    ? successSchema["properties"]
    : {};
  const existingErrorSchema = successProperties["error"];
  const errorSchema =
    existingErrorSchema === undefined
      ? GENERIC_ERROR_DETAIL_SCHEMA
      : {
          anyOf: [existingErrorSchema, GENERIC_ERROR_DETAIL_SCHEMA],
        };
  const successRequired = Array.isArray(successSchema["required"])
    ? successSchema["required"].filter(
        (field): field is string => typeof field === "string",
      )
    : [];
  const advertisedSchema: Record<string, unknown> = {};

  // Keep the advertised root composition-free while relaxing success-only
  // required fields exclusively for the server's structured error envelope.
  for (const [key, value] of Object.entries(successSchema)) {
    if (key === "required") continue;
    advertisedSchema[key] =
      key === "properties"
        ? { ...successProperties, error: errorSchema }
        : value;
  }
  if (!("properties" in advertisedSchema)) {
    advertisedSchema["properties"] = { error: errorSchema };
  }
  if (successRequired.length > 0) {
    advertisedSchema["if"] = {
      properties: {
        error: {
          type: "object",
          required: ["message"],
        },
      },
      required: ["error"],
    };
    advertisedSchema["else"] = { required: successRequired };
  }
  return advertisedSchema;
}

/**
 * Services that can be injected into an MCPServer instance.
 */
export interface MCPServerServices {
  liveIndex?: LiveIndexCoordinator;
  gatewayConfig?: GatewayConfig;
  codeModeConfig?: CodeModeConfig;
  contextEngine?: ContextEngine;
  getStartupReadiness?: () => StartupReadinessSnapshot;
}

/**
 * Factory function to create a fully-configured MCPServer with all tools registered.
 * Uses dynamic import to avoid eager loading of all tool modules at the top level.
 * Used by the HTTP transport to create per-session server instances.
 */
export async function createMCPServer(
  services: MCPServerServices = {},
): Promise<MCPServer> {
  const { registerTools } = await import("./mcp/tools/index.js");
  const server = new MCPServer({
    toolNameFormat: services.gatewayConfig?.toolNameFormat,
    getStartupReadiness: services.getStartupReadiness,
  });
  registerTools(
    server,
    {
      liveIndex: services.liveIndex,
      contextEngine: services.contextEngine,
    },
    services.gatewayConfig,
    services.codeModeConfig,
  );
  return server;
}
